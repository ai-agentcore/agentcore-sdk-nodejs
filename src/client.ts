import { createHash } from 'node:crypto';
import { AccessKeyCredential } from './auth/access-key';
import { ResourceSTSProvider } from './auth/resource-sts';
import { WorkloadAccessTokenProvider } from './auth/workload-access-token';
import { AgentCoreControlPlane } from './controlplane/client';
import { ConfigError, ResourceNotConfiguredError } from './errors';
import { nullLogger, type Logger } from './logging';
import { ModelClient, type DirectModelOptions } from './model/client';
import { ProviderModelClient, type DirectProviderOptions } from './model/provider';
import { MCPClient, type DirectMCPOptions, type ManagedMCPOptions } from './mcp/client';
import { mergeMCPHeaders } from './mcp/headers';
import { createRuntimeSource, DebugRuntimeSource } from './runtime/debug';
import { requiredString, type AgentConfig } from './runtime/config';
import type { ManagedRuntimeOptions, RuntimeBindings, RuntimeSource } from './runtime/managed';
import { Skills } from './skill/loader';
import { BoundCredentials } from './auth/bound-credentials';
import { MemoryStore } from './memory/client';
import { CollaborationClient } from './collaboration/client';

export interface AgentCoreOptions extends ManagedRuntimeOptions {
  workspaceId?: string;
  regionId?: string;
  accessKeyCredential?: AccessKeyCredential;
  skillWorkspaceDir?: string;
  teamsPath?: string;
  collaborationWorkspaceDir?: string;
}
interface ResourceContext {
  workspaceId: string;
  regionId: string;
  controlPlane?: AgentCoreControlPlane;
  resourceSTS?: ResourceSTSProvider;
  workloadAccessToken?: WorkloadAccessTokenProvider;
}

/** A single asynchronous Core. Direct resources do not require runtime files. */
export class AgentCore {
  readonly skills: Skills;
  readonly credentials: BoundCredentials;
  private readonly runtimeSource?: RuntimeSource;
  private runtime?: RuntimeBindings;
  private context?: ResourceContext;
  private initializing?: Promise<RuntimeBindings>;
  private readonly models = new Map<string, Promise<ModelClient>>();
  private readonly mcps = new Map<string, Promise<MCPClient>>();
  private readonly directResources: Array<{ close(): void | Promise<void> }> = [];
  private readonly logger: Logger;
  private closed = false;
  private closing?: Promise<void>;
  private collaborationClient?: CollaborationClient;

  constructor(private readonly options: AgentCoreOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.credentials = new BoundCredentials(async () => {
      this.ensureOpen();
      if (!this.context) await this.ensureRuntime();
      return { ...this.context!, controlPlane: this.requireControlPlane() };
    }, this.logger);
    this.skills = new Skills({ workspaceDir: options.skillWorkspaceDir, logger: this.logger, runtime: async () => {
      this.ensureOpen();
      if (!this.context) await this.ensureRuntime();
      return { workspaceId: this.context!.workspaceId, provider: this.requireControlPlane() };
    } });
    if (options.workspaceId !== undefined || options.regionId !== undefined) {
      const workspaceId = requiredString(options.workspaceId, 'workspaceId and regionId must be provided together');
      const regionId = requiredString(options.regionId, 'workspaceId and regionId must be provided together');
      if (options.configPath || options.envPath || process.env.AGENTCORE_DEBUG_TOKEN?.trim()) throw new ConfigError('workspaceId and regionId cannot be combined with runtime file paths or a debug token');
      this.context = this.createContext(workspaceId, regionId, options.controlPlaneEndpoint);
    } else this.runtimeSource = createRuntimeSource(options);
  }
  static auto(options: AgentCoreOptions = {}): AgentCore { return new AgentCore(options); }
  get config(): AgentConfig | undefined { return this.runtime?.config; }
  get collaboration(): CollaborationClient {
    this.ensureOpen();
    return this.collaborationClient ??= new CollaborationClient({ teamsPath: this.options.teamsPath,
      envPath: this.options.envPath, workspaceDir: this.options.collaborationWorkspaceDir, logger: this.logger,
      debugSource: this.runtimeSource instanceof DebugRuntimeSource ? this.runtimeSource : undefined });
  }

  memoryStore(name: string): MemoryStore {
    this.ensureOpen();
    return new MemoryStore(name, { logger: this.logger, runtime: async () => {
      this.ensureOpen();
      if (!this.context) await this.ensureRuntime();
      return { ...this.context!, endpoint: this.runtime?.controlPlaneEndpoint ?? this.options.controlPlaneEndpoint, accessKeyCredential: this.options.accessKeyCredential };
    } });
  }

  async model(resourceName: string, options: { model?: string; timeoutMs?: number } = {}): Promise<ModelClient> {
    this.ensureOpen();
    const runtime = await this.ensureRuntime();
    const control = this.requireControlPlane();
    const key = JSON.stringify([resourceName, options.model, options.timeoutMs]);
    const cached = this.models.get(key);
    if (cached) return cached;
    const request = (async () => {
      const descriptor = await control.resolveModel(resourceName, options.model);
      this.ensureOpen();
      return ModelClient.platform(runtime.config, descriptor, { timeoutMs: options.timeoutMs, logger: this.logger });
    })();
    this.models.set(key, request);
    try { return await request; } catch (error) { this.models.delete(key); throw error; }
  }
  directModel(options: DirectModelOptions): ModelClient;
  directModel(options: DirectProviderOptions): ProviderModelClient;
  directModel(options: DirectModelOptions | DirectProviderOptions): ModelClient | ProviderModelClient {
    this.ensureOpen();
    const client = 'languageModel' in options
      ? new ProviderModelClient({ ...options, logger: options.logger ?? this.logger })
      : ModelClient.direct({ ...options, logger: options.logger ?? this.logger });
    this.directResources.push(client); return client;
  }
  async mcp(name: string, options: ManagedMCPOptions = {}): Promise<MCPClient> {
    this.ensureOpen();
    const { headers, credentialName: suppliedCredentialName, ...timeouts } = options;
    const credentialName = suppliedCredentialName?.trim();
    if (credentialName !== undefined && !credentialName) throw new TypeError('credential name must not be empty');
    const customHeaders = mergeMCPHeaders({}, headers);
    const runtime = await this.ensureRuntime();
    const control = this.requireControlPlane();
    // Cache keys must not expose header values when the Core object is inspected.
    const headerKey = createHash('sha256').update(JSON.stringify(
      Object.entries(customHeaders).sort(([left], [right]) => left.localeCompare(right)),
    )).digest('hex');
    const key = JSON.stringify([name, credentialName, timeouts.sessionMs, timeouts.metadataMs, timeouts.toolMs, headerKey]);
    const cached = this.mcps.get(key);
    if (cached) return cached;
    const request = (async () => {
      const descriptor = await control.resolveMCP(name);
      this.ensureOpen();
      return MCPClient.platform(runtime.config, descriptor, { ...timeouts, headers: customHeaders, logger: this.logger,
        credentialHeadersProvider: credentialName === undefined ? undefined : async () =>
          (await this.credentials.getForMCP(credentialName, descriptor.mcpServerId)).asHeaders(),
      });
    })();
    this.mcps.set(key, request);
    try { return await request; } catch (error) { this.mcps.delete(key); throw error; }
  }
  directMCP(options: DirectMCPOptions): MCPClient {
    this.ensureOpen();
    const client = MCPClient.direct({ ...options, logger: options.logger ?? this.logger });
    this.directResources.push(client); return client;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.collaborationClient?.close();
      await this.runtimeSource?.close();
      const resources = await Promise.allSettled([...this.models.values(), ...this.mcps.values()]);
      await this.initializing?.catch(() => undefined);
      const completed = resources.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const failures = await Promise.allSettled([...completed, ...this.directResources].map((resource) => resource.close()));
      this.context?.controlPlane?.close(); this.context?.resourceSTS?.close(); this.context?.workloadAccessToken?.close();
      this.models.clear(); this.mcps.clear(); this.directResources.length = 0;
      const error = failures.find((result) => result.status === 'rejected');
      if (error?.status === 'rejected') throw error.reason;
    })();
    return this.closing;
  }

  private ensureOpen(): void { if (this.closed) throw new Error('AgentCore client is closed'); }
  private requireControlPlane(): AgentCoreControlPlane {
    if (!this.context?.controlPlane) throw new ResourceNotConfiguredError('AgentCore control-plane runtime is not configured');
    return this.context.controlPlane;
  }
  private async ensureRuntime(): Promise<RuntimeBindings> {
    this.ensureOpen();
    if (this.runtime) return this.runtime;
    if (this.initializing) return this.initializing;
    if (!this.runtimeSource) throw new ResourceNotConfiguredError('managed model and MCP require runtime gateway configuration');
    const source = this.runtimeSource;
    const request = (async () => {
      const runtime = await source.resolve();
      this.ensureOpen();
      const context = this.createContext(runtime.config.workspaceId, runtime.config.regionId, runtime.controlPlaneEndpoint, runtime);
      this.context = context; this.runtime = runtime;
      return runtime;
    })();
    this.initializing = request;
    try { return await request; } finally { this.initializing = undefined; }
  }
  private createContext(workspaceId: string, regionId: string, endpoint?: string, runtime?: RuntimeBindings): ResourceContext {
    let resourceSTS: ResourceSTSProvider | undefined;
    let workloadAccessToken: WorkloadAccessTokenProvider | undefined;
    try {
      if (runtime?.controllerEndpoint && runtime.agentSATokens) {
        resourceSTS = new ResourceSTSProvider(runtime.controllerEndpoint, runtime.agentSATokens, { logger: this.logger });
        workloadAccessToken = new WorkloadAccessTokenProvider(runtime.controllerEndpoint, runtime.agentSATokens, { logger: this.logger });
      }
      const controlPlane = resourceSTS || this.options.accessKeyCredential ? new AgentCoreControlPlane({ workspaceId, regionId, endpoint,
        resourceSTSProvider: resourceSTS, accessKeyCredential: this.options.accessKeyCredential, logger: this.logger,
      }) : undefined;
      return { workspaceId, regionId, controlPlane, resourceSTS, workloadAccessToken };
    } catch (error) { resourceSTS?.close(); workloadAccessToken?.close(); throw error; }
  }
}
