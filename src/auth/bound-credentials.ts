import { inspect } from 'node:util';
import Client, { GetResourceAPIKeyRequest } from '@alicloud/agentidentitydata20251127';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RuntimeOptions } from '@darabonba/typescript';
import { ConfigError, CredentialExchangeError, WorkloadAccessTokenRejectedError } from '../errors';
import type { AgentCoreControlPlane, CredentialMetadata } from '../controlplane/client';
import { nullLogger, type Logger } from '../logging';
import type { AccessKeyCredential, CredentialProvider } from './access-key';
import { AGENT_IDENTITY_DATA_PURPOSE } from './resource-sts';

const GeneratedClient = typeof Client === 'function' ? Client : (Client as unknown as { default: typeof Client }).default;
const WAT_ERRORS = new Set(['WORKLOAD_ACCESS_TOKEN_EXPIRED', 'WORKLOAD_ACCESS_TOKEN_INVALID']);
interface CredentialRuntime {
  workspaceId: string;
  regionId: string;
  controlPlane: AgentCoreControlPlane;
  resourceSTS?: CredentialProvider;
  workloadAccessToken?: { get(): Promise<string>; invalidate(token: string): Promise<void> };
}

export class BoundCredential {
  readonly providerName: string;
  #value: string;
  constructor(providerName: string, value: string, readonly metadata: CredentialMetadata) { this.providerName = providerName; this.#value = value; }
  get value(): string { return this.#value; }
  get credentialType(): string { return this.metadata.credentialType; }
  asHeaders(): Record<string, string> {
    if (this.credentialType !== 'mcpHeader') throw new ConfigError('Credential must have type mcpHeader to read headers');
    let data: unknown;
    try { data = JSON.parse(this.#value); } catch { throw new ConfigError('Invalid MCP Header credential payload'); }
    const entries = fields(data).headers;
    if (!Array.isArray(entries) || !entries.length) throw new ConfigError('MCP Header credential must contain a non-empty headers array');
    const headers: Record<string, string> = {};
    for (const entry of entries) {
      const { name, value } = fields(entry);
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new ConfigError('Invalid credential header name');
      if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new ConfigError('Invalid credential header value');
      const folded = name.toLowerCase();
      if (Object.hasOwn(headers, folded)) throw new ConfigError('Duplicate credential header name');
      Object.defineProperty(headers, folded, { value, enumerable: true, configurable: true, writable: true });
    }
    return headers;
  }
  [inspect.custom](): string { return `BoundCredential(providerName=${JSON.stringify(this.providerName)}, <redacted>)`; }
  toJSON(): string { return this[inspect.custom](); }
}

/** Resolve metadata by name, then fetch the secret from AgentIdentity. WAT/STS cache independently. */
export class BoundCredentials {
  constructor(private readonly runtime: () => Promise<CredentialRuntime>, private readonly logger: Logger = nullLogger) {}
  async get(credentialName: string): Promise<BoundCredential> {
    return this.resolve(credentialName);
  }
  /** @internal Bind only after validating the credential's MCP application scope. */
  async getForMCP(credentialName: string, serverId: string): Promise<BoundCredential> {
    return this.resolve(credentialName, serverId);
  }
  private async resolve(credentialName: string, serverId?: string): Promise<BoundCredential> {
    credentialName = credentialName.trim();
    if (!credentialName) throw new TypeError('credential name must not be empty');
    const { workspaceId, regionId, workloadAccessToken: wat, resourceSTS: sts, controlPlane } = await this.runtime();
    if (!wat || !sts) throw new CredentialExchangeError('AgentCore credential runtime is not configured');
    const metadata = await controlPlane.resolveCredential(credentialName);
    if (serverId !== undefined) {
      if (metadata.credentialType !== 'mcpHeader') throw new ConfigError('MCP credential must have type mcpHeader');
      if (!(metadata.resourceScope === 'ALL' || (metadata.resourceScope === 'SPECIFIED' &&
        metadata.resourceRefs.some((ref) => ref.resourceType === 'mcpServer' && ref.resourceId === serverId)))) {
        throw new ConfigError('MCP credential does not allow the selected MCP server');
      }
    }
    // Matches the control plane's CreateCredential provider naming contract.
    const providerName = `${workspaceId}-${credentialName}`;
    this.logger.info('agentcore.credential.resolve.started', { workspace_id: workspaceId, credential_name: credentialName });
    const credential = await sts.get(AGENT_IDENTITY_DATA_PURPOSE);
    let token = await wat.get(); let value: string;
    try { value = await this.getAPIKey(regionId, credential, providerName, token); }
    catch (error) {
      if (!(error instanceof WorkloadAccessTokenRejectedError)) throw error;
      this.logger.warn('agentcore.credential.resolve.wat_rejected', { workspace_id: workspaceId, credential_name: credentialName, retry: true });
      await wat.invalidate(token); token = await wat.get();
      value = await this.getAPIKey(regionId, credential, providerName, token);
    }
    this.logger.info('agentcore.credential.resolve.succeeded', { workspace_id: workspaceId, credential_name: credentialName });
    return new BoundCredential(providerName, value, metadata);
  }
  private async getAPIKey(regionId: string, credential: AccessKeyCredential, providerName: string, token: string): Promise<string> {
    const endpoint = `agentidentitydata.${regionId}.aliyuncs.com`;
    const client = new GeneratedClient(new $OpenApiUtil.Config({
      accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret, securityToken: credential.securityToken,
      regionId, endpoint, protocol: 'https',
    }));
    try {
      const response = await client.getResourceAPIKeyWithOptions(new GetResourceAPIKeyRequest({
        resourceCredentialProviderName: providerName, workloadAccessToken: token,
      }), new RuntimeOptions({ autoretry: false, connectTimeout: 10_000, readTimeout: 30_000 }));
      const value = response.body?.APIKey;
      if (typeof value !== 'string' || !value) throw new CredentialExchangeError('Agent Identity Data returned an empty or invalid API key');
      return value;
    } catch (error) {
      if (watRejection(error)) throw new WorkloadAccessTokenRejectedError('Agent Identity Data rejected the Workload Access Token');
      const details = fields(error); const data = fields(details.data);
      this.logger.warn('agentcore.credential.api.failed', { endpoint: `https://${endpoint}/`, provider_name: providerName,
        error_type: error instanceof Error ? error.name : 'Error', request_id: String(details.requestId ?? data.RequestId ?? data.requestId ?? '') });
      if (error instanceof CredentialExchangeError) throw error;
      // Generated SDK errors may contain a credential-bearing request; do not attach them.
      throw new CredentialExchangeError('Agent Identity Data API key request failed');
    }
  }
}
function fields(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function watRejection(error: unknown): boolean {
  let current = fields(error);
  for (let depth = 0; depth < 3; depth++) {
    const data = fields(current.data);
    if ([current.code, data.Code, data.code].some((code) => typeof code === 'string' && WAT_ERRORS.has(code.toUpperCase()))) return true;
    if (!current.innerException) return false;
    current = fields(current.innerException);
  }
  return false;
}
