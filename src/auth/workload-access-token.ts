import { AuthenticationError, WorkloadIdentityNotConfiguredError } from '../errors';
import type { AgentSATokenSource } from './agent-sa-token';
import { ControllerClient, ControllerTransportError, isRetryableControllerStatus, type ControllerOptions } from './controller';

const REFRESH_BEFORE_SECONDS = 30;

class WorkloadTokenUnavailable extends AuthenticationError {}

function tokenExpiry(token: string): number | undefined {
  // The unverified claim is a cache hint only.
  const parts = token.split('.', 4);
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;
  const payload = parts[1]!;
  if (/[^A-Za-z0-9_-]/.test(payload) || payload.length % 4 === 1) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = claims && typeof claims === 'object' && 'exp' in claims ? claims.exp : undefined;
    return typeof exp === 'number' && Number.isSafeInteger(exp) && exp > 0 ? exp : undefined;
  } catch {
    return undefined;
  }
}

export class WorkloadAccessTokenProvider {
  private readonly controller: ControllerClient;
  #cached?: { token: string; expiresAt?: number; refreshAt?: number };
  private pending?: Promise<string>;

  constructor(endpoint: string, source: AgentSATokenSource, options: ControllerOptions = {}) {
    this.controller = new ControllerClient(endpoint, source, options);
  }
  async get(): Promise<string> {
    const cached = this.#cached;
    if (cached && (cached.refreshAt === undefined || cached.refreshAt > Date.now() / 1000)) {
      return cached.token;
    }
    if (this.pending) return this.pending;
    const request = this.refresh();
    this.pending = request;
    try { return await request; }
    finally { this.pending = undefined; }
  }
  private async refresh(): Promise<string> {
    try {
      const token = await this.exchange();
      const expiresAt = tokenExpiry(token);
      this.#cached = { token, expiresAt, refreshAt: expiresAt === undefined ? undefined : expiresAt - REFRESH_BEFORE_SECONDS };
      return token;
    } catch (error) {
      const cached = this.#cached;
      if ((error instanceof ControllerTransportError || error instanceof WorkloadTokenUnavailable) &&
          cached?.expiresAt !== undefined && cached.expiresAt > Date.now() / 1000) {
        cached.refreshAt = cached.expiresAt;
        return cached.token;
      }
      throw error;
    }
  }
  async invalidate(token?: string): Promise<void> {
    // Drop the rejected token before a pending refresh can fall back to it.
    this.clearCachedToken(token);
    if (this.pending) await this.pending.catch(() => undefined);
    this.clearCachedToken(token);
  }
  private clearCachedToken(token?: string): void {
    if (token === undefined || token === this.#cached?.token) this.#cached = undefined;
  }
  close(): void { this.controller.close(); this.#cached = undefined; }

  private async exchange(): Promise<string> {
    const response = await this.controller.post('/api/v1/workload/token');
    if (response.status === 404) throw new WorkloadIdentityNotConfiguredError('the current Agent has no configured Workload Identity');
    if (response.status < 200 || response.status >= 300) {
      const Failure = isRetryableControllerStatus(response.status) ? WorkloadTokenUnavailable : AuthenticationError;
      throw new Failure(`Controller workload token request failed with HTTP ${response.status}`);
    }
    const payload = response.payload;
    const token = payload && typeof payload === 'object' && 'workloadAccessToken' in payload ? payload.workloadAccessToken : undefined;
    if (typeof token !== 'string' || !token.trim()) throw new AuthenticationError('Controller returned an empty workload access token');
    return token.trim();
  }
}
