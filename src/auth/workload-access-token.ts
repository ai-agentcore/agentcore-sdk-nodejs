import { AuthenticationError, WorkloadIdentityNotConfiguredError } from '../errors';
import type { AgentSATokenSource } from './agent-sa-token';
import { ControllerClient, type ControllerOptions } from './controller';

export class WorkloadAccessTokenProvider {
  private readonly controller: ControllerClient;
  #token?: string;
  private pending?: Promise<string>;

  constructor(endpoint: string, source: AgentSATokenSource, options: ControllerOptions = {}) {
    this.controller = new ControllerClient(endpoint, source, options);
  }
  async get(): Promise<string> {
    if (this.#token !== undefined) return this.#token;
    if (this.pending) return this.pending;
    const request = this.exchange();
    this.pending = request;
    try { this.#token = await request; return this.#token; }
    finally { this.pending = undefined; }
  }
  async invalidate(token?: string): Promise<void> {
    // Serialize invalidation after an exchange, including an initially empty cache.
    if (this.pending) await this.pending.catch(() => undefined);
    if (token === undefined || token === this.#token) this.#token = undefined;
  }
  close(): void { this.controller.close(); this.#token = undefined; }

  private async exchange(): Promise<string> {
    const response = await this.controller.post('/api/v1/workload/token');
    if (response.status === 404) throw new WorkloadIdentityNotConfiguredError('the current Agent has no configured Workload Identity');
    if (response.status < 200 || response.status >= 300) throw new AuthenticationError(`Controller workload token request failed with HTTP ${response.status}`);
    const payload = response.payload;
    const token = payload && typeof payload === 'object' && 'workloadAccessToken' in payload ? payload.workloadAccessToken : undefined;
    if (typeof token !== 'string' || !token.trim()) throw new AuthenticationError('Controller returned an empty workload access token');
    return token.trim();
  }
}
