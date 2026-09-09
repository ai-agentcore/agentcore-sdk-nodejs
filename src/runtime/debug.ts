import { inspect } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuthenticationError, ConfigError } from '../errors';
import { nullLogger, type Logger } from '../logging';
import { ControllerClient, type ControllerOptions } from '../auth/controller';
import type { AgentSATokenSource } from '../auth/agent-sa-token';
import { httpUrl, object, requiredString, type AgentConfig } from './config';
import { ControlConfigLoader } from './control-config';
import { ManagedRuntimeSource, type ManagedRuntimeOptions, type RuntimeBindings, type RuntimeSource } from './managed';

export class DebugToken {
  readonly product = 'agentcore';
  #jwtToken: string;
  constructor(jwtToken: string, readonly controllerUrl: string, readonly modelGatewayUrl: string, readonly matrixUrl: string) { this.#jwtToken = jwtToken; }
  get jwtToken(): string { return this.#jwtToken; }
  [inspect.custom](): string { return 'DebugToken(product=agentcore, <redacted>)'; }
  toJSON(): string { return this[inspect.custom](); }
}

export function parseDebugToken(value: string): DebugToken {
  try {
    const encoded = value.trim();
    if (!encoded || encoded.length > 350_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('base64');
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length > 256 * 1024) throw new Error('size');
    const data = object(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)), 'debug token');
    if (data.product !== 'agentcore') throw new Error('product');
    const controller = httpUrl(data.controllerUrl, 'controllerUrl');
    if (new URL(controller).pathname !== '/') throw new Error('controllerUrl path');
    return new DebugToken(requiredString(data.jwtToken, 'jwtToken'), controller,
      httpUrl(data.modelGatewayUrl, 'modelGatewayUrl'), httpUrl(data.matrixUrl, 'matrixUrl'));
  } catch { throw new ConfigError('AGENTCORE_DEBUG_TOKEN is invalid'); }
}

class DebugTokenExchangeUnavailable extends AuthenticationError {}

export interface DebugRuntimeOptions extends ControllerOptions { controlPlaneEndpoint?: string; }

export class DebugRuntimeSource implements RuntimeSource, AgentSATokenSource {
  #jwtToken: string;
  #saToken?: string;
  private saExpiresAt = 0;
  private jwtExpiresAt = 0;
  private bindings?: RuntimeBindings;
  private resolving?: Promise<RuntimeBindings>;
  private exchanging?: Promise<string>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly lifetime = new AbortController();
  private readonly configLoader: ControlConfigLoader;
  private readonly controller: ControllerClient;
  private readonly logger: Logger;

  constructor(private readonly token: DebugToken, private readonly options: DebugRuntimeOptions = {}) {
    this.#jwtToken = token.jwtToken;
    this.configLoader = new ControlConfigLoader(token.controllerUrl, this, options);
    this.controller = new ControllerClient(token.controllerUrl, this, options);
    this.logger = options.logger ?? nullLogger;
  }
  get matrixUrl(): string { return this.token.matrixUrl; }

  async resolve(): Promise<RuntimeBindings> {
    this.lifetime.signal.throwIfAborted();
    if (this.bindings) return this.bindings;
    if (this.resolving) return this.resolving;
    const request = this.load();
    this.resolving = request;
    try { this.bindings = await request; return this.bindings; }
    finally { this.resolving = undefined; }
  }
  async get(): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    if (this.#saToken && this.saExpiresAt > Date.now() + 60_000) return this.#saToken;
    return this.exchange();
  }
  async refresh(current: string): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    if (this.#saToken && this.#saToken !== current) return this.#saToken;
    return this.exchange();
  }
  async loadTeamsConfig(): Promise<Uint8Array | undefined> { await this.resolve(); return this.configLoader.loadTeams(); }
  async exchangeMatrixToken(): Promise<string> {
    const response = await this.controller.post('/api/v1/credentials/matrix-token');
    if (response.status < 200 || response.status >= 300) throw new AuthenticationError(`Controller Matrix token request failed with HTTP ${response.status}`);
    try { return requiredString(object(response.payload, 'Matrix token').access_token, 'access_token'); }
    catch { throw new AuthenticationError('Controller returned an invalid Matrix token response'); }
  }
  close(): void {
    this.lifetime.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.configLoader.close(); this.controller.close(); this.#saToken = undefined; this.#jwtToken = '';
  }
  [inspect.custom](): string { return 'DebugRuntimeSource(<redacted>)'; }
  toJSON(): string { return this[inspect.custom](); }

  private async load(): Promise<RuntimeBindings> {
    const config = await this.configLoader.load();
    this.lifetime.signal.throwIfAborted();
    const override = (mounted: string) => {
      const gateway = new URL(this.token.modelGatewayUrl);
      const runtime = new URL(mounted);
      if (runtime.pathname !== '/') gateway.pathname = runtime.pathname;
      return gateway.toString().replace(/\/+$/, '');
    };
    const projected: AgentConfig = Object.freeze({ ...config,
      modelGatewayUrl: override(config.modelGatewayUrl), mcpGatewayUrl: override(config.mcpGatewayUrl),
    });
    this.logger.info('agentcore.runtime.source.resolved', { mode: 'debug', workspaceId: config.workspaceId });
    return { config: projected, controllerEndpoint: this.token.controllerUrl,
      controlPlaneEndpoint: this.options.controlPlaneEndpoint, agentSATokens: this };
  }

  private async exchange(): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    if (this.exchanging) return this.exchanging;
    const request = this.requestToken().then((data) => {
      this.lifetime.signal.throwIfAborted();
      this.#saToken = data.token; this.saExpiresAt = data.expiresAt;
      this.#jwtToken = data.jwtToken; this.jwtExpiresAt = data.jwtExpiresAt;
      this.scheduleRefresh();
      this.logger.info('agentcore.runtime.debug.sa_exchange.succeeded', {
        expiration: new Date(this.saExpiresAt).toISOString(), jwtExpiration: new Date(this.jwtExpiresAt).toISOString(),
      });
      return this.#saToken;
    });
    this.exchanging = request;
    try { return await request; } finally { this.exchanging = undefined; }
  }

  private scheduleRefresh(delay = Math.max(1000, this.jwtExpiresAt - Date.now() - 300_000)): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.lifetime.signal.aborted) return;
    this.refreshTimer = setTimeout(() => { void this.backgroundRefresh(); }, delay);
    this.refreshTimer.unref();
  }
  private async backgroundRefresh(): Promise<void> {
    if (this.lifetime.signal.aborted || this.jwtExpiresAt <= Date.now()) return;
    try { await this.exchange(); }
    catch (error) {
      if (this.lifetime.signal.aborted) return;
      const remaining = this.jwtExpiresAt - Date.now();
      this.logger.warn('agentcore.runtime.debug.jwt_refresh.failed', { reason: error instanceof DebugTokenExchangeUnavailable ? 'temporarily_unavailable' : 'authentication_failed' });
      if (error instanceof DebugTokenExchangeUnavailable && remaining > 1000) this.scheduleRefresh(Math.min(30_000, remaining / 2));
    }
  }

  private async requestToken(): Promise<{ token: string; expiresAt: number; jwtToken: string; jwtExpiresAt: number }> {
    const url = `${this.token.controllerUrl}/api/v1/edge/token`;
    for (let attempt = 1; attempt <= (this.options.maxAttempts ?? 3); attempt++) {
      let response: Response;
      let payload: unknown;
      try {
        response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jwtToken: this.#jwtToken }), redirect: 'manual',
          signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.options.timeoutMs ?? 10_000)]),
        });
        const text = await response.text();
        try { payload = JSON.parse(text); } catch { payload = undefined; }
      } catch {
        this.lifetime.signal.throwIfAborted();
        if (attempt === (this.options.maxAttempts ?? 3)) throw new DebugTokenExchangeUnavailable('cannot reach the AgentCore Controller');
        this.logger.warn('agentcore.runtime.debug.sa_exchange.retry', { url, attempt, reason: 'transport_error' });
        await sleep(50 * 2 ** (attempt - 1), undefined, { signal: this.lifetime.signal }); continue;
      }
      if ([500, 502, 503, 504].includes(response.status)) {
        if (attempt === (this.options.maxAttempts ?? 3)) throw new DebugTokenExchangeUnavailable('Controller debug token service is unavailable');
        this.logger.warn('agentcore.runtime.debug.sa_exchange.retry', { url, attempt, status: response.status });
        await sleep(50 * 2 ** (attempt - 1), undefined, { signal: this.lifetime.signal }); continue;
      }
      if ([401, 403].includes(response.status)) throw new AuthenticationError('Controller rejected the AgentCore debug token');
      if (!response.ok) throw new AuthenticationError(`Controller debug token exchange failed with HTTP ${response.status}`);
      try {
        const data = object(payload, 'debug token response');
        const token = requiredString(data.token, 'token'); const jwtToken = requiredString(data.jwtToken, 'jwtToken');
        const expiresAt = Date.parse(requiredString(data.expiresAt, 'expiresAt'));
        const jwtExpiresAt = Date.parse(requiredString(data.jwtExpiresAt, 'jwtExpiresAt'));
        if (!(expiresAt > Date.now()) || !(jwtExpiresAt > Date.now())) throw new Error('expiry');
        return { token, jwtToken, expiresAt, jwtExpiresAt };
      } catch { throw new AuthenticationError('Controller returned an invalid debug token response'); }
    }
    throw new DebugTokenExchangeUnavailable('Controller debug token service is unavailable');
  }
}

export function createRuntimeSource(options: ManagedRuntimeOptions = {}): RuntimeSource {
  const raw = process.env.AGENTCORE_DEBUG_TOKEN?.trim();
  if (raw) return new DebugRuntimeSource(parseDebugToken(raw), {
    controlPlaneEndpoint: options.controlPlaneEndpoint ?? process.env.AGENTCORE_CONTROL_ENDPOINT,
    logger: options.logger,
  });
  return new ManagedRuntimeSource(options);
}
