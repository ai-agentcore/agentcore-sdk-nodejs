import { access, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError } from '../errors';
import { AgentSATokenProvider, type AgentSATokenSource } from '../auth/agent-sa-token';
import { nullLogger, type Logger } from '../logging';
import { DEFAULT_CONFIG_PATH, parseAgentConfig, type AgentConfig } from './config';
import { DEFAULT_ENV_PATH, RuntimeEnvironmentProvider } from './environment';

export interface RuntimeBindings {
  config: AgentConfig;
  controllerEndpoint?: string;
  controlPlaneEndpoint?: string;
  agentSATokens?: AgentSATokenSource;
}
export interface RuntimeSource {
  resolve(): Promise<RuntimeBindings>;
  close(): void | Promise<void>;
}
export interface ManagedRuntimeOptions {
  configPath?: string;
  envPath?: string;
  controlPlaneEndpoint?: string;
  logger?: Logger;
}

export class ManagedRuntimeSource implements RuntimeSource {
  private bindings?: RuntimeBindings;
  private pending?: Promise<RuntimeBindings>;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: ManagedRuntimeOptions = {}) {}

  async resolve(): Promise<RuntimeBindings> {
    this.lifetime.signal.throwIfAborted();
    if (this.bindings) return this.bindings;
    if (this.pending) return this.pending;
    const request = this.load();
    this.pending = request;
    try { this.bindings = await request; return this.bindings; }
    finally { this.pending = undefined; }
  }
  close(): void { this.lifetime.abort(); }

  private async load(): Promise<RuntimeBindings> {
    const configPath = this.options.configPath || process.env.AGENTCORE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
    const rawTimeout = process.env.AGENTCORE_CONFIG_WAIT_TIMEOUT ?? '10';
    if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(Number(rawTimeout))) {
      throw new ConfigError('AGENTCORE_CONFIG_WAIT_TIMEOUT must be a non-negative integer');
    }
    const deadline = performance.now() + Number(rawTimeout) * 1000;
    let config: AgentConfig;
    const logger = this.options.logger ?? nullLogger;
    for (;;) {
      this.lifetime.signal.throwIfAborted();
      let data: Buffer;
      try { data = await readFile(configPath); } catch (cause) {
        const remaining = deadline - performance.now();
        if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') || remaining <= 0) {
          throw new ConfigError('cannot read agent.yaml', { cause });
        }
        logger.info('agentcore.runtime.config.waiting_for_mount', { path: configPath, retryInMs: Math.min(500, remaining) });
        await sleep(Math.min(500, remaining), undefined, { signal: this.lifetime.signal });
        continue;
      }
      config = parseAgentConfig(data);
      break;
    }
    const configuredEnv = this.options.envPath || process.env.AGENTCORE_ENV_PATH;
    const envPath = configuredEnv || DEFAULT_ENV_PATH;
    let hasEnvironment = Boolean(configuredEnv);
    if (!hasEnvironment) {
      try { await access(envPath); hasEnvironment = true; } catch (cause) {
        if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
          throw new ConfigError('cannot access AgentCore runtime env', { cause });
        }
      }
    }
    const environment = hasEnvironment ? await new RuntimeEnvironmentProvider(envPath).snapshot() : undefined;
    const bindings = {
      config,
      controllerEndpoint: environment?.controllerUrl,
      controlPlaneEndpoint: this.options.controlPlaneEndpoint ?? environment?.controlPlaneEndpoint ?? process.env.AGENTCORE_CONTROL_ENDPOINT,
      agentSATokens: environment ? new AgentSATokenProvider(environment.agentSATokenFile) : undefined,
    };
    this.lifetime.signal.throwIfAborted();
    logger.info('agentcore.runtime.source.resolved', { mode: 'managed', envLoaded: hasEnvironment, workspaceId: config.workspaceId });
    return bindings;
  }
}
