import Client, * as models from '@alicloud/agentcore20260804';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RuntimeOptions } from '@darabonba/typescript';
import { AccessKeyCredential, type CredentialProvider } from '../auth/access-key';
import { HIGH_CODE_SDK_PURPOSE } from '../auth/resource-sts';
import { ConfigError, InvocationError, MCPServerNotFoundError, ModelConnectionNotFoundError, ResourceNotConfiguredError } from '../errors';
import { readBytes } from '../http';
import { nullLogger, type Logger } from '../logging';
import { httpUrl, requiredString } from '../runtime/config';

// The generated package is CJS: native ESM sees module.exports as the default.
const GeneratedClient = typeof Client === 'function' ? Client : (Client as unknown as { default: typeof Client }).default;

export interface ModelDescriptor {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly protocol: string;
  readonly providerType: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly contextSize?: number;
  readonly maxTokens?: number;
  readonly capabilities: Readonly<Record<string, boolean>>;
}
export interface MCPDescriptor {
  readonly mcpServerId: string;
  readonly name: string;
  readonly protocol: string;
  readonly type: string;
  readonly status: string;
}
export interface SkillArtifact { version: string; archive: Uint8Array; }
export interface CredentialMetadata {
  readonly credentialId: string;
  readonly name: string;
  readonly credentialType: string;
  readonly resourceScope: string;
  readonly resourceRefs: ReadonlyArray<{ resourceType: string; resourceId: string }>;
}
export interface ControlPlaneOptions {
  workspaceId: string;
  regionId: string;
  accessKeyCredential?: AccessKeyCredential;
  resourceSTSProvider?: CredentialProvider;
  endpoint?: string;
  logger?: Logger;
}

function exact<T>(items: T[], field: keyof T, name: string, label: string, ErrorType: typeof ResourceNotConfiguredError = ResourceNotConfiguredError): T {
  const matches = items.filter((item) => item[field] === name);
  if (!matches.length) throw new ErrorType(`${label} ${JSON.stringify(name)} does not exist`);
  if (matches.length !== 1) throw new ConfigError(`${label} ${JSON.stringify(name)} is not unique`);
  return matches[0]!;
}

function errorField(error: unknown, key: string): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
}
function responseBody<T>(body: T | undefined): T {
  if (body === undefined) throw new ConfigError('AgentCore returned an empty control-plane response');
  return body;
}
function endpointFailure(error: unknown): boolean {
  const status = errorField(error, 'statusCode');
  const code = errorField(error, 'code');
  return (typeof status === 'number' && status >= 500 && status < 600) ||
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(String(code)) ||
    errorField(error, 'name') === 'TimeoutError';
}

export class AgentCoreControlPlane {
  readonly workspaceId: string;
  readonly regionId: string;
  private readonly endpoint?: string;
  private readonly protocol?: string;
  private discoveredEndpoint?: string;
  private readonly logger: Logger;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: ControlPlaneOptions) {
    this.workspaceId = requiredString(options.workspaceId, 'workspaceId');
    this.regionId = requiredString(options.regionId, 'regionId');
    if (!options.accessKeyCredential && !options.resourceSTSProvider) throw new ConfigError('AgentCore control plane requires an AccessKey credential source');
    if (options.endpoint !== undefined) {
      const value = options.endpoint.trim();
      const url = new URL(httpUrl(value.includes('://') ? value : `https://${value}`, 'AgentCore control endpoint'));
      if (url.pathname !== '/') throw new ConfigError('AgentCore control endpoint must not contain a path');
      this.endpoint = url.host; this.protocol = url.protocol.slice(0, -1);
    }
    this.logger = options.logger ?? nullLogger;
  }

  async resolveModel(connectionName: string, modelName?: string): Promise<ModelDescriptor> {
    const client = await this.client();
    const connections: models.ListModelConnectionsResponseBodyItems[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.invoke(client, 'ListModelConnections', () => client.listModelConnectionsWithOptions(this.workspaceId,
        new models.ListModelConnectionsRequest({ name: connectionName, searchType: 'accurate', maxResults: 100, nextToken }), {}, this.runtimeOptions()));
      const body = responseBody(response.body);
      connections.push(...(body.items ?? [])); nextToken = body.nextToken;
    } while (nextToken);
    const connection = exact(connections, 'name', connectionName, 'model connection', ModelConnectionNotFoundError);
    const connectionId = requiredString(connection.connectionId, 'connectionId');
    const available: models.ListModelsResponseBodyItems[] = [];
    do {
      const response = await this.invoke(client, 'ListModels', () => client.listModelsWithOptions(this.workspaceId,
        new models.ListModelsRequest({ connectionId, modelName, maxResults: 100, nextToken }), {}, this.runtimeOptions()));
      const body = responseBody(response.body);
      available.push(...(body.items ?? [])); nextToken = body.nextToken;
    } while (nextToken);
    let model: models.ListModelsResponseBodyItems;
    if (modelName !== undefined) model = exact(available, 'modelName', modelName, 'model');
    else {
      if (available.length !== 1) throw new ResourceNotConfiguredError(`model connection ${JSON.stringify(connectionName)} requires an explicit model name`);
      model = available[0]!;
    }
    const capabilities = Object.fromEntries(Object.entries(model.capabilities ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
    const descriptor = Object.freeze({ connectionId, connectionName: requiredString(connection.name, 'connection name'),
      protocol: connection.protocol ?? '', providerType: connection.providerType ?? '',
      modelId: requiredString(model.modelId, 'modelId'), modelName: requiredString(model.modelName, 'modelName'),
      contextSize: model.contextSize, maxTokens: model.maxTokens, capabilities: Object.freeze(capabilities),
    });
    this.logger.info('agentcore.control_plane.model.resolve.succeeded', { connectionName, connectionId, modelName: descriptor.modelName });
    return descriptor;
  }

  async resolveMCP(name: string): Promise<MCPDescriptor> {
    const client = await this.client();
    const items: models.ListMcpsResponseBodyItems[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.invoke(client, 'ListMcps', () => client.listMcpsWithOptions(this.workspaceId,
        new models.ListMcpsRequest({ name, searchType: 'accurate', maxResults: 100, nextToken }), {}, this.runtimeOptions()));
      const body = responseBody(response.body);
      items.push(...(body.items ?? [])); nextToken = body.nextToken;
    } while (nextToken);
    const item = exact(items, 'name', name, 'MCP server', MCPServerNotFoundError);
    const descriptor = Object.freeze({ mcpServerId: requiredString(item.mcpServerId, 'mcpServerId'),
      name: requiredString(item.name, 'MCP name'), protocol: item.protocol ?? '', type: item.type ?? '', status: item.status ?? '',
    });
    this.logger.info('agentcore.control_plane.mcp.resolve.succeeded', { name, mcpServerId: descriptor.mcpServerId, protocol: descriptor.protocol });
    return descriptor;
  }

  async getSkill(name: string, version?: string): Promise<SkillArtifact> {
    const client = await this.client();
    if (version === undefined) {
      const detail = await this.invoke(client, 'GetSkillDetail', () => client.getSkillDetailWithOptions(this.workspaceId, name, new models.GetSkillDetailRequest({}), {}, this.runtimeOptions()));
      version = latestVersion(responseBody(detail.body).data);
    }
    const resolvedVersion = version;
    const response = await this.invoke(client, 'DownloadSkillVersionViaOss', () => client.downloadSkillVersionViaOssWithOptions(this.workspaceId, name, resolvedVersion,
      new models.DownloadSkillVersionViaOssRequest({}), {}, this.runtimeOptions()));
    const downloadURL = responseBody(response.body).data;
    if (typeof downloadURL !== 'string') throw new ConfigError('AgentCore returned an invalid Skill download URL');
    return { version: resolvedVersion, archive: await this.downloadSkill(downloadURL) };
  }

  close(): void { this.lifetime.abort(); }

  async resolveCredential(name: string): Promise<CredentialMetadata> {
    const client = await this.client();
    const params = new $OpenApiUtil.Params({ action: 'ListCredentials', version: '2026-08-04', protocol: 'HTTPS',
      pathname: `/workspaces/${encodeURIComponent(this.workspaceId)}/credentials`, method: 'GET', authType: 'AK',
      style: 'ROA', reqBodyType: 'json', bodyType: 'json' });
    const items: Record<string, unknown>[] = [];
    let nextToken: string | undefined;
    do {
      const request = new $OpenApiUtil.OpenApiRequest({ query: { name, maxResults: '100', ...(nextToken ? { nextToken } : {}) } });
      const response = await this.invoke(client, 'ListCredentials', () => client.callApi(params, request, this.runtimeOptions()));
      const body = responseBody(response.body);
      items.push(...(body.items ?? [])); nextToken = body.nextToken;
    } while (nextToken);
    const item = exact(items, 'name', name, 'credential');
    const refs = (item.resourceRefs ?? []) as Array<Record<string, unknown>>;
    return {
      credentialId: requiredString(item.credentialId, 'credentialId'), name: requiredString(item.name, 'name'),
      credentialType: requiredString(item.credentialType, 'credentialType'), resourceScope: String(item.resourceScope ?? ''),
      resourceRefs: refs.map((ref) => ({ resourceType: requiredString(ref.resourceType, 'resourceType'), resourceId: requiredString(ref.resourceId, 'resourceId') })),
    };
  }

  private runtimeOptions(): RuntimeOptions { return new RuntimeOptions({ autoretry: false, connectTimeout: 10_000, readTimeout: 30_000 }); }
  private async client(): Promise<Client> {
    this.lifetime.signal.throwIfAborted();
    const credential = this.options.accessKeyCredential ?? await this.options.resourceSTSProvider!.get(HIGH_CODE_SDK_PURPOSE);
    return new GeneratedClient(new $OpenApiUtil.Config({
      accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret, securityToken: credential.securityToken,
      regionId: this.regionId, endpoint: this.endpoint ?? this.discoveredEndpoint, protocol: this.protocol,
    }));
  }
  private async invoke<T>(client: Client, operation: string, call: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    const invoke = async () => {
      this.logger.debug('agentcore.control_plane.request.started', { operation, host: client._endpoint });
      try { return await call(); }
      catch (cause) {
        const data = errorField(cause, 'data');
        this.logger.warn('agentcore.control_plane.request.failed', { operation, host: client._endpoint,
          status: String(errorField(cause, 'statusCode') ?? '-'), code: String(errorField(cause, 'code') ?? '-'),
          requestId: String(errorField(cause, 'requestId') ?? errorField(data, 'RequestId') ?? errorField(data, 'requestId') ?? '-'),
        });
        throw new InvocationError('AgentCore control-plane request failed', { cause });
      }
    };
    try { return await invoke(); }
    catch (error) {
      if (!(error instanceof InvocationError) || this.endpoint || client._endpoint !== `agentcore.${this.regionId}.aliyuncs.com` || !endpointFailure(error.cause)) throw error;
      const host = `agentcore-vpc.${this.regionId}.aliyuncs.com`;
      this.logger.warn('agentcore.control_plane.endpoint.fallback', { operation, fromHost: client._endpoint, toHost: host });
      client._endpoint = host;
      const result = await invoke(); this.discoveredEndpoint = host; return result;
    }
  }

  private async downloadSkill(value: string): Promise<Uint8Array> {
    let original: URL;
    try { original = new URL(value); } catch { throw new ConfigError('AgentCore returned an invalid Skill download URL'); }
    if (!['http:', 'https:'].includes(original.protocol) || original.username || original.password) throw new ConfigError('AgentCore returned an invalid Skill download URL');
    let candidate = original;
    for (;;) {
      this.lifetime.signal.throwIfAborted();
      let status: number | undefined;
      try {
        const response = await fetch(candidate, { redirect: 'manual', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]) });
        if (response.ok) {
          const archive = await readBytes(response, 10 * 1024 * 1024, 'Skill archive');
          if (!archive.length) throw new ConfigError('Skill package is empty');
          return archive;
        }
        status = response.status; await response.body?.cancel();
      } catch (error) {
        this.lifetime.signal.throwIfAborted();
        if (error instanceof ConfigError) throw error;
      }
      this.logger.warn('agentcore.control_plane.skill.download.failed', { host: candidate.host, path: candidate.pathname, status });
      const fallback = candidate === original && (status === undefined || status >= 500 && status < 600) ? internalOSSURL(original) : undefined;
      if (!fallback) throw new InvocationError(status ? `Skill package download failed with HTTP ${status}` : 'Skill package download failed');
      this.logger.warn('agentcore.control_plane.skill.download.fallback', { fromHost: candidate.host, toHost: fallback.host });
      candidate = fallback;
    }
  }
}

function latestVersion(data?: models.GetSkillDetailResponseBodyData): string {
  if (!data) throw new ResourceNotConfiguredError('AgentCore Skill does not exist');
  for (const [label, value] of Object.entries(data.labels ?? {})) if (label.toLowerCase() === 'latest' && value) return value;
  const online = (data.versions ?? []).filter((v) => v.status?.toLowerCase() === 'online' && v.version);
  online.sort((a, b) => (b.updateTime ?? -1) - (a.updateTime ?? -1) || (b.version ?? '').localeCompare(a.version ?? ''));
  if (!online[0]?.version) throw new ResourceNotConfiguredError('AgentCore Skill has no online version');
  return online[0].version;
}

export function internalOSSURL(url: URL): URL | undefined {
  const match = /^([a-z0-9-]+)\.(oss-[a-z]+-[a-z0-9-]+)\.aliyuncs\.com$/.exec(url.hostname);
  if (!match || match[2]!.endsWith('-internal') || match[2]!.startsWith('oss-accelerate') || url.username || url.password) return undefined;
  if (url.searchParams.getAll('x-oss-additional-headers').some((v) => v.split(';').includes('host'))) return undefined;
  const result = new URL(url); result.hostname = `${match[1]}.${match[2]}-internal.aliyuncs.com`; return result;
}
