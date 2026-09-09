import { CredentialExchangeError } from '../errors';
import { ResourceCredential } from './access-key';
import type { AgentSATokenSource } from './agent-sa-token';
import { ControllerClient, type ControllerOptions } from './controller';

export const HIGH_CODE_SDK_PURPOSE = 'highcode_sdk';
export const AGENT_IDENTITY_DATA_PURPOSE = 'agentidentitydata';

export class ResourceSTSProvider {
  private readonly controller: ControllerClient;
  private readonly cache = new Map<string | undefined, ResourceCredential>();
  private readonly pending = new Map<string | undefined, Promise<ResourceCredential>>();

  constructor(endpoint: string, source: AgentSATokenSource, options: ControllerOptions = {}) {
    this.controller = new ControllerClient(endpoint, source, options);
  }
  async get(purpose?: string): Promise<ResourceCredential> {
    if (purpose !== undefined) {
      purpose = purpose.trim();
      if (!purpose) throw new TypeError('purpose must not be empty');
    }
    const cached = this.cache.get(purpose);
    if (cached && cached.expiration.getTime() > Date.now() + 300_000) return cached;
    const current = this.pending.get(purpose);
    if (current) return current;
    const request = this.exchange(purpose);
    this.pending.set(purpose, request);
    try {
      const credential = await request;
      this.cache.set(purpose, credential);
      return credential;
    } finally { this.pending.delete(purpose); }
  }
  close(): void { this.controller.close(); this.cache.clear(); }

  private async exchange(purpose?: string): Promise<ResourceCredential> {
    const response = await this.controller.post('/api/v1/credentials/sts', purpose);
    if (response.status < 200 || response.status >= 300) {
      throw new CredentialExchangeError(`Controller STS request failed with HTTP ${response.status}${response.message ? `: ${response.message}` : ''}`);
    }
    try {
      const value = response.payload as Record<string, unknown>;
      const read = (key: string): string => {
        const item = value[key];
        if (typeof item !== 'string' || !item.trim()) throw new Error('invalid field');
        return item.trim();
      };
      const expiration = new Date(read('expiration'));
      if (!(expiration.getTime() > Date.now())) throw new Error('expired STS');
      return new ResourceCredential({
        accessKeyId: read('access_key_id'), accessKeySecret: read('access_key_secret'),
        securityToken: read('security_token'), expiration,
      });
    } catch { throw new CredentialExchangeError('Controller returned an invalid STS response'); }
  }
}
