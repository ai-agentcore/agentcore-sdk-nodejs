import { setTimeout as sleep } from 'node:timers/promises';
import { AuthenticationError, CredentialExchangeError } from '../errors';
import { nullLogger, type Logger } from '../logging';
import { httpUrl } from '../runtime/config';
import { getAgentSAToken, refreshAgentSAToken, type AgentSATokenSource } from './agent-sa-token';

export interface ControllerOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  logger?: Logger;
}
interface ControllerResponse {
  status: number;
  payload: unknown;
  message?: string;
}

// Shared transport only for the Controller's idempotent credential exchanges.
export class ControllerClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly logger: Logger;
  private readonly lifetime = new AbortController();

  constructor(endpoint: string, private readonly saTokens: AgentSATokenSource, options: ControllerOptions = {}) {
    this.endpoint = httpUrl(endpoint, 'Controller endpoint');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new TypeError('timeoutMs and maxAttempts must be positive');
    }
    this.logger = options.logger ?? nullLogger;
  }

  async post(path: string, purpose?: string | Readonly<Record<string, string>>): Promise<ControllerResponse> {
    let token = await getAgentSAToken(this.saTokens);
    let response = await this.request(path, token, purpose);
    if (response.status === 401) {
      const rotated = await refreshAgentSAToken(this.saTokens, token);
      this.logger.warn('agentcore.controller.sa_rejected', { rotated: rotated !== token });
      if (rotated !== token) {
        token = rotated;
        response = await this.request(path, token, purpose);
      }
    }
    if (response.status === 401) throw new AuthenticationError('Controller rejected the Agent SA token');
    return response;
  }

  close(): void { this.lifetime.abort(); }

  private async request(path: string, token: string, purpose?: string | Readonly<Record<string, string>>): Promise<ControllerResponse> {
    const url = new URL(`${this.endpoint}${path}`);
    const query = typeof purpose === 'string' ? { purpose } : purpose;
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const fields = { url: `${url.origin}${url.pathname}`, purpose: query?.purpose ?? 'default' };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.lifetime.signal.throwIfAborted();
      this.logger.debug('agentcore.controller.request.started', { ...fields, attempt });
      let response: Response;
      let text: string;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
      const signal = AbortSignal.any([this.lifetime.signal, timeout.signal]);
      try {
        response = await fetch(url, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '',
          redirect: 'manual', signal,
        });
        text = await response.text();
      } catch (cause) {
        this.lifetime.signal.throwIfAborted();
        this.logger.warn('agentcore.controller.request.failed', { ...fields, attempt, reason: 'transport_error' });
        if (attempt === this.maxAttempts) throw new CredentialExchangeError('cannot reach the AgentCore Controller', { cause });
        await sleep(50 * 2 ** (attempt - 1), undefined, { signal: this.lifetime.signal });
        continue;
      } finally { clearTimeout(timer); }
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = undefined; }
      // Never log a successful credential response, headers, or arbitrary JSON fields.
      const rawMessage = payload && typeof payload === 'object' && 'message' in payload ? payload.message : undefined;
      const message = typeof rawMessage === 'string'
        ? rawMessage.split(token).join('<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/\s+/g, ' ').slice(0, 1024)
        : undefined;
      const result = { status: response.status, payload, message };
      if (response.ok) {
        this.logger.debug('agentcore.controller.request.succeeded', { ...fields, status: response.status });
        return result;
      }
      this.logger.warn('agentcore.controller.request.failed', {
        ...fields, status: response.status, attempt, message,
        requestId: response.headers.get('x-acs-request-id') ?? response.headers.get('x-request-id') ?? undefined,
      });
      if (![500, 502, 503, 504].includes(response.status) || attempt === this.maxAttempts) return result;
      await sleep(50 * 2 ** (attempt - 1), undefined, { signal: this.lifetime.signal });
    }
    throw new CredentialExchangeError('Controller request did not complete');
  }
}
