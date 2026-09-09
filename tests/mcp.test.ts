import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient, mcpServerURL } from '../src/mcp/client';
import { parseAgentConfigMapping } from '../src/runtime/config';
import { configMapping, httpServer } from './helpers';
import { nullLogger } from '../src/logging';

const endpoints: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const servers: Server[] = [];
const clients: MCPClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); await Promise.all(servers.splice(0).map((s) => s.close())); await Promise.all(endpoints.splice(0).map((s) => s.close())); });

function mcpServer(options: { metadataDelay?: number; toolDelay?: number } = {}) {
  const server = new Server({ name: 'real-test-mcp', version: '1' }, { capabilities: { tools: {} } }); servers.push(server);
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (options.metadataDelay) await sleep(options.metadataDelay);
    return { tools: [{ name: request.params?.cursor ? 'second' : 'echo', description: 'Echo arguments', inputSchema: { type: 'object' as const } }], nextCursor: request.params?.cursor ? undefined : 'next' };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (options.toolDelay) await sleep(options.toolDelay);
    if (request.params.name === 'invalid') throw new McpError(ErrorCode.InvalidParams, 'bad arguments');
    return { content: [{ type: 'text' as const, text: JSON.stringify(request.params.arguments) }], isError: request.params.name === 'business-error' };
  });
  return server;
}

async function fixture(options: { metadataDelay?: number; toolDelay?: number } = {}) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const calls: Array<{ path: string; method?: string; authorization?: string; rpc?: string; custom?: string | string[] }> = [];
  let initialized = 0;
  let rejectSession = false;
  const endpoint = await httpServer((req, res) => {
    void (async () => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const message = body ? JSON.parse(body) as { method?: string } : undefined;
      calls.push({ path: req.url!, method: req.method, authorization: req.headers.authorization, rpc: message?.method, custom: req.headers['x-api-key'] });
      const id = req.headers['mcp-session-id'] as string | undefined;
      if (id && (rejectSession || !sessions.has(id))) { res.statusCode = 404; res.end('session missing'); return; }
      let transport = id ? sessions.get(id) : undefined;
      if (!transport) {
        if (message?.method !== 'initialize') { res.statusCode = 400; res.end(); return; }
        initialized++;
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: (sessionId) => { sessions.set(sessionId, transport!); } });
        await mcpServer(options).connect(transport);
      }
      await transport.handleRequest(req, res, message);
    })().catch((error: unknown) => { if (!res.headersSent) res.statusCode = 500; res.end(String(error)); });
  }); endpoints.push(endpoint);
  return { url: endpoint.url, calls, initialized: () => initialized, rejectSession: (reject: boolean) => { rejectSession = reject; } };
}

describe('official MCP Streamable HTTP', () => {
  it('fetches bound headers once per session and refetches on reconnect', async () => {
    const endpoint = await fixture(); const mapping = configMapping(); mapping.spec.mcp.gatewayUrl = endpoint.url;
    let fetches = 0;
    const client = MCPClient.platform(parseAgentConfigMapping(mapping),
      { name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'HTTP', type: 'CUSTOM', status: 'RUNNING' },
      { credentialHeadersProvider: async () => ({ 'X-API-Key': `key-${++fetches}` }), headers: { 'X-Business': 'app' } });
    clients.push(client);
    await Promise.all([client.listTools(), client.callTool('echo', {})]);
    expect(fetches).toBe(1);
    endpoint.rejectSession(true);
    await expect(client.callTool('echo', {})).rejects.toThrow();
    endpoint.rejectSession(false);
    await client.callTool('echo', {});
    expect(fetches).toBe(2);
    expect(endpoint.calls.filter((c) => c.rpc === 'initialize').map((c) => c.custom)).toEqual(['key-1', 'key-2']);
    expect(endpoint.calls.every((c) => c.authorization === 'Bearer consumer-secret')).toBe(true);
  });
  it.each<Record<string, string>>([{ Authorization: 'replace' }, { 'X-API-Key': 'bound' }])('rejects credential header collisions before network I/O', async (bound) => {
    const endpoint = await fixture(); const mapping = configMapping(); mapping.spec.mcp.gatewayUrl = endpoint.url;
    const client = MCPClient.platform(parseAgentConfigMapping(mapping),
      { name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'HTTP', type: 'CUSTOM', status: 'RUNNING' },
      { credentialHeadersProvider: async () => bound, headers: { 'x-api-key': 'custom' } });
    clients.push(client);
    await expect(client.listTools()).rejects.toThrow('protected');
    expect(endpoint.calls).toHaveLength(0);
  });
  it('sends copied managed headers for initialize/list/call without mixing concurrent clients', async () => {
    const endpoint = await fixture(); const mapping = configMapping(); mapping.spec.mcp.gatewayUrl = endpoint.url;
    const config = parseAgentConfigMapping(mapping);
    const descriptor = { name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'SSE', type: 'CUSTOM', status: 'RUNNING' };
    const headers = { 'X-API-Key': 'a' };
    const a = MCPClient.platform(config, descriptor, { headers });
    const b = MCPClient.platform(config, descriptor, { headers: { 'x-api-key': 'b' } });
    const plain = MCPClient.platform(config, descriptor); clients.push(a, b, plain);
    headers['X-API-Key'] = 'mutated';
    await Promise.all([a.listTools(), b.listTools()]);
    await Promise.all([a.callTool('echo', {}), b.callTool('echo', {})]);
    await plain.callTool('echo', {});
    for (const rpc of ['initialize', 'tools/call']) {
      expect(endpoint.calls.filter((call) => call.rpc === rpc).map((call) => call.custom)).toEqual(expect.arrayContaining(['a', 'b', undefined]));
    }
    expect(endpoint.calls.filter((call) => call.rpc === 'tools/list').map((call) => call.custom)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(endpoint.calls.every((call) => call.authorization === 'Bearer consumer-secret')).toBe(true);
    expect(endpoint.calls.some((call) => call.custom === 'mutated')).toBe(false);
    expect(endpoint.initialized()).toBe(3);
  });
  it.each<Record<string, string>>([
    { aUtHoRiZaTiOn: 'replacement' }, { 'MCP-Session-ID': 'replacement' }, { Host: 'other' },
    { 'X-Test': 'one', 'x-test': 'two' }, { 'X-Test': 'unsafe\r\nvalue' },
  ])('rejects invalid managed headers %j', (headers) => {
    expect(() => MCPClient.platform(parseAgentConfigMapping(configMapping()),
      { name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'HTTP', type: 'CUSTOM', status: 'RUNNING' },
      { headers })).toThrow();
  });
  it('logs real connection failures but not errors caused by intentional close', async () => {
    const endpoint = await fixture(); const warnings: string[] = [];
    const client = MCPClient.direct({ url: endpoint.url, logger: { ...nullLogger, warn: (event) => { warnings.push(event); } } }); clients.push(client);
    await client.listTools(); await client.close(); await sleep(10);
    expect(warnings).not.toContain('agentcore.mcp.session.error');
    const broken = MCPClient.direct({ url: endpoint.url, logger: { ...nullLogger, warn: (event) => { warnings.push(event); } } }); clients.push(broken);
    await broken.listTools(); endpoint.rejectSession(true);
    await expect(broken.callTool('echo', {})).rejects.toThrow();
    expect(warnings).toContain('agentcore.mcp.session.error');
    expect(warnings).toContain('agentcore.mcp.request.failed');
  });
  it('reuses a persistent session, follows tool pages, and calls canonical tools', async () => {
    const endpoint = await fixture();
    const client = MCPClient.direct({ url: endpoint.url + '/mcp', headersProvider: () => ({ Authorization: 'Bearer direct-token' }) }); clients.push(client);
    const [tools, same] = await Promise.all([client.listTools(), client.listTools()]);
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'second']); expect(same).toHaveLength(2);
    expect(await tools[0]!.invoke({ hello: 'world' })).toMatchObject({ content: [{ type: 'text', text: '{"hello":"world"}' }] });
    expect(endpoint.initialized()).toBe(1);
    expect(endpoint.calls.every((call) => call.authorization === 'Bearer direct-token')).toBe(true);
  });
  it('defaults managed resources to Streamable HTTP even if their upstream protocol is SSE', async () => {
    const endpoint = await fixture(); const config = configMapping(); config.spec.mcp.gatewayUrl = `${endpoint.url}/mcp-servers`;
    const client = MCPClient.platform(parseAgentConfigMapping(config), { name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'SSE', type: 'CUSTOM', status: 'RUNNING' }); clients.push(client);
    await client.listTools();
    expect(endpoint.calls[0]).toMatchObject({ method: 'POST', rpc: 'initialize', path: '/mcp-servers/mcp-1', authorization: 'Bearer consumer-secret' });
    for (const prefix of ['', '/mcp', '/mcp-servers']) expect(mcpServerURL(endpoint.url + prefix, 'mcp-1')).toBe(`${endpoint.url}/mcp-servers/mcp-1`);
  });
  it('invalidates a lost session and resolves new direct credentials on the next call without replaying the failed call', async () => {
    const endpoint = await fixture(); let key = 'old';
    const client = MCPClient.direct({ url: endpoint.url, headersProvider: () => ({ Authorization: `Bearer ${key}` }) }); clients.push(client);
    await client.listTools(); endpoint.rejectSession(true); key = 'new';
    await expect(client.callTool('echo', {})).rejects.toThrow();
    expect(endpoint.initialized()).toBe(1);
    endpoint.rejectSession(false); await client.callTool('echo', {});
    expect(endpoint.initialized()).toBe(2);
    expect(endpoint.calls.filter((c) => c.rpc === 'initialize').map((c) => c.authorization)).toEqual(['Bearer old', 'Bearer new']);
  });
  it('keeps a usable session after tool application errors', async () => {
    const endpoint = await fixture(); const client = MCPClient.direct({ url: endpoint.url }); clients.push(client);
    await expect(client.callTool('invalid', {})).rejects.toBeInstanceOf(McpError);
    expect((await client.callTool('business-error', {})).isError).toBe(true);
    await client.listTools(); expect(endpoint.initialized()).toBe(1);
  });
  it('applies a metadata deadline separately from tool calls', async () => {
    const endpoint = await fixture({ metadataDelay: 50 });
    const client = MCPClient.direct({ url: endpoint.url, metadataMs: 15, toolMs: 500 }); clients.push(client);
    await expect(client.listTools()).rejects.toThrow();
    await client.callTool('echo', {}); expect(endpoint.initialized()).toBe(2);
  });
  it('bounds initialization independently from the metadata timeout', async () => {
    let calls = 0;
    const endpoint = await httpServer(() => { calls++; }); endpoints.push(endpoint);
    const client = MCPClient.direct({ url: endpoint.url, sessionMs: 30, metadataMs: 10_000 }); clients.push(client);
    await expect(client.listTools()).rejects.toThrow(); expect(calls).toBe(1);
  });
  it('does not retry a timed-out tool call and creates a fresh session for the next operation', async () => {
    const endpoint = await fixture({ toolDelay: 50 });
    const client = MCPClient.direct({ url: endpoint.url, toolMs: 15 }); clients.push(client);
    await expect(client.callTool('echo', { effect: 'must-not-replay' })).rejects.toThrow();
    await client.listTools();
    expect(endpoint.initialized()).toBe(2);
    expect(endpoint.calls.filter((call) => call.rpc === 'tools/call')).toHaveLength(1);
  });
  it('waits for in-flight operations on close and never starts another call after close', async () => {
    const endpoint = await fixture({ toolDelay: 50 }); const client = MCPClient.direct({ url: endpoint.url }); clients.push(client);
    await client.listTools();
    const call = client.callTool('echo', { once: true });
    await sleep(10);
    await client.close(); expect(await call).toMatchObject({ isError: false });
    await expect(client.listTools()).rejects.toThrow('closed');
  });
});

it('supports legacy SSE including authenticated GET handshake and POST messages', async () => {
  const transports = new Map<string, SSEServerTransport>();
  const authorizations: Array<string | undefined> = [];
  const endpoint = await httpServer((req, res) => {
    void (async () => {
      authorizations.push(req.headers.authorization);
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res); transports.set(transport.sessionId, transport);
        await mcpServer().connect(transport);
      } else {
        const transport = transports.get(url.searchParams.get('sessionId')!);
        if (!transport) { res.statusCode = 404; res.end(); return; }
        let body = ''; for await (const chunk of req) body += String(chunk);
        await transport.handlePostMessage(req, res, JSON.parse(body));
      }
    })().catch((error: unknown) => res.end(String(error)));
  }); endpoints.push(endpoint);
  const client = MCPClient.direct({ url: endpoint.url + '/sse', transport: 'sse', headersProvider: () => ({ Authorization: 'Bearer sse-key' }) }); clients.push(client);
  expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo', 'second']);
  await client.callTool('echo', { value: 1 });
  expect(authorizations.every((auth) => auth === 'Bearer sse-key')).toBe(true);
});

it('supports a real stdio server process', async () => {
  const client = MCPClient.direct({ transport: 'stdio', server: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] } }); clients.push(client);
  expect((await client.listTools())[0]!.name).toBe('echo');
  expect(await client.callTool('echo', { value: 'stdio' })).toMatchObject({ content: [{ text: '{"value":"stdio"}' }] });
}, 10_000);
