import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, McpError, ErrorCode, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { inspect } from 'node:util';
import { ConfigError } from '../errors';
import { nullLogger, type Logger } from '../logging';
import type { MCPDescriptor } from '../controlplane/client';
import type { AgentConfig } from '../runtime/config';
import type { HeadersProvider } from '../model/client';
import { Tool, type ToolArguments } from '../integrations/common';
import { mergeMCPHeaders } from './headers';

export interface MCPTimeouts { sessionMs?: number; metadataMs?: number; toolMs?: number; }
export interface ManagedMCPOptions extends MCPTimeouts { headers?: Readonly<Record<string, string>>; credentialName?: string; }
export type DirectMCPOptions = ({ url: string; transport?: 'streamable-http' | 'sse'; headersProvider?: HeadersProvider } |
  { transport: 'stdio'; server: StdioServerParameters }) & MCPTimeouts & { logger?: Logger };
export interface MCPCallOptions { signal?: AbortSignal; }
interface Session {
  client: Client;
  transport: Transport;
  abort: AbortController;
  invalid: boolean;
  active: Set<Promise<unknown>>;
  closing?: Promise<void>;
}

export function mcpServerURL(gatewayURL: string, id: string): string {
  const gateway = gatewayURL.replace(/\/+$/, '').replace(/\/(?:mcp|mcp-servers)$/, '');
  return `${gateway}/mcp-servers/${encodeURIComponent(id)}`;
}

export class MCPClient {
  readonly descriptor?: MCPDescriptor;
  private readonly logger: Logger;
  private state?: Session;
  private opening?: Promise<Session>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly timeouts: Required<MCPTimeouts>;

  private constructor(private readonly options: DirectMCPOptions, descriptor?: MCPDescriptor) {
    this.descriptor = descriptor;
    this.logger = options.logger ?? nullLogger;
    this.timeouts = { sessionMs: options.sessionMs ?? 30_000, metadataMs: options.metadataMs ?? 60_000, toolMs: options.toolMs ?? 600_000 };
    if (Object.values(this.timeouts).some((timeout) => !Number.isFinite(timeout) || timeout <= 0)) throw new ConfigError('MCP operation timeouts must be positive');
    if (options.transport !== 'stdio') {
      let url: URL;
      try { url = new URL(options.url); } catch { throw new ConfigError('Direct MCP URL must be HTTP(S)'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError('Direct MCP URL must be HTTP(S)');
      if (options.transport !== undefined && !['streamable-http', 'sse'].includes(options.transport)) throw new ConfigError('MCP transport must be streamable-http, sse, or stdio');
    }
    this.logger.info('agentcore.mcp.client.created', { mode: descriptor ? 'managed' : 'direct', transport: options.transport ?? 'streamable-http', url: this.safeURL });
  }
  static platform(config: AgentConfig, descriptor: MCPDescriptor, options: Omit<ManagedMCPOptions, 'credentialName'> & {
    logger?: Logger; credentialHeadersProvider?: () => Promise<Record<string, string>>;
  } = {}): MCPClient {
    const { headers: custom, credentialHeadersProvider, ...connectionOptions } = options;
    const customHeaders = mergeMCPHeaders({}, custom);
    const headers = mergeMCPHeaders(config.gatewayHeaders, custom);
    return new MCPClient({ ...connectionOptions, url: mcpServerURL(config.mcpGatewayUrl, descriptor.mcpServerId), transport: 'streamable-http', headersProvider: async () => {
      if (!credentialHeadersProvider) return headers;
      const bound = mergeMCPHeaders(config.gatewayHeaders, await credentialHeadersProvider());
      return mergeMCPHeaders(bound, customHeaders);
    } }, descriptor);
  }
  static direct(options: DirectMCPOptions): MCPClient { return new MCPClient(options); }

  async listTools(options: MCPCallOptions = {}): Promise<Tool[]> {
    return this.withSession('list_tools', async (session) => {
      const definitions: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
      let cursor: string | undefined;
      const deadline = AbortSignal.timeout(this.timeouts.metadataMs);
      const signal = AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]);
      do {
        const result = await session.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: this.timeouts.metadataMs });
        definitions.push(...result.tools); cursor = result.nextCursor;
      } while (cursor);
      return definitions.map((definition) => new Tool({ name: definition.name, description: definition.description ?? '', parameters: definition.inputSchema,
        invoke: (arguments_) => this.callTool(definition.name, arguments_),
      }));
    });
  }
  async tools(options: MCPCallOptions = {}): Promise<Tool[]> { return this.listTools(options); }
  async callTool(name: string, arguments_: ToolArguments, options: MCPCallOptions = {}): Promise<CallToolResult> {
    return this.withSession('call_tool', (session) => session.client.callTool({ name, arguments: arguments_ }, CallToolResultSchema,
      { timeout: this.timeouts.toolMs, signal: options.signal }) as Promise<CallToolResult>);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      if (this.opening && this.state) this.state.abort.abort();
      await this.opening?.catch(() => undefined);
      if (this.state) await this.retire(this.state);
    })();
    return this.closing;
  }
  [inspect.custom](): string { return `MCPClient(url=${this.safeURL}, <redacted>)`; }
  toJSON(): string { return this[inspect.custom](); }

  private get safeURL(): string {
    if (this.options.transport === 'stdio') return 'stdio';
    const url = new URL(this.options.url); return `${url.origin}${url.pathname}`;
  }
  private async acquire(): Promise<Session> {
    for (;;) {
      if (this.closed) throw new Error('MCP client is closed');
      if (this.opening) return this.opening;
      if (this.state?.invalid) { await this.retire(this.state); continue; }
      if (this.state) return this.state;
      const request = this.open(); this.opening = request;
      try { return await request; } finally { this.opening = undefined; }
    }
  }
  private async open(): Promise<Session> {
    const client = new Client({ name: 'agentcore-sdk', version: '0.1.0' });
    const abort = new AbortController();
    let transport: Transport;
    if (this.options.transport === 'stdio') transport = new StdioClientTransport(this.options.server);
    else {
      const headers = await this.options.headersProvider?.() ?? {};
      const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
      transport = this.options.transport === 'sse'
        ? new SSEClientTransport(new URL(this.options.url), { requestInit: { headers }, fetch })
        : new StreamableHTTPClientTransport(new URL(this.options.url), { requestInit: { headers }, fetch });
    }
    const session: Session = { client, transport, abort, invalid: false, active: new Set() };
    this.state = session;
    const timer = setTimeout(() => abort.abort(new Error('MCP session open timed out')), this.timeouts.sessionMs);
    client.onclose = () => { session.invalid = true; };
    client.onerror = (error) => {
      if (this.closed || session.closing) return;
      session.invalid = true;
      this.logger.warn('agentcore.mcp.session.error', { url: this.safeURL, errorType: error.name });
    };
    this.logger.info('agentcore.mcp.session.open.started', { url: this.safeURL, timeoutMs: this.timeouts.sessionMs });
    try {
      await client.connect(transport, { signal: abort.signal, timeout: this.timeouts.sessionMs });
      abort.signal.throwIfAborted();
      if (this.closed) throw new Error('MCP client is closed');
      this.logger.info('agentcore.mcp.session.open.succeeded', { url: this.safeURL });
      return session;
    } catch (error) { await this.retire(session); throw error; }
    finally { clearTimeout(timer); }
  }

  private async withSession<T>(operation: string, call: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.acquire();
    if (this.closed) throw new Error('MCP client is closed');
    const request = call(session); session.active.add(request);
    this.logger.info('agentcore.mcp.request.started', { operation, url: this.safeURL });
    try { const result = await request; this.logger.info('agentcore.mcp.request.succeeded', { operation, url: this.safeURL }); return result; }
    catch (error) {
      if (!(error instanceof McpError) || [ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code)) session.invalid = true;
      this.logger.warn('agentcore.mcp.request.failed', { operation, url: this.safeURL, errorType: error instanceof Error ? error.name : 'unknown' });
      throw error;
    } finally { session.active.delete(request); }
  }
  private retire(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    session.invalid = true;
    session.closing = (async () => {
      await Promise.allSettled([...session.active]);
      session.abort.abort();
      try { await session.client.close(); }
      catch (error) { this.logger.warn('agentcore.mcp.session.close.failed', { errorType: error instanceof Error ? error.name : 'unknown', url: this.safeURL }); }
      if (this.state === session) this.state = undefined;
    })();
    return session.closing;
  }
}
