import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { stringify } from 'yaml';
import IdentityClient from '@alicloud/agentidentitydata20251127';
import ControlClient from '@alicloud/agentcore20260804';
import { AgentCoreControlPlane } from '../src/controlplane/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentCore, AccessKeyCredential, CredentialExchangeError, WorkloadAccessTokenRejectedError } from '../src';
import { BoundCredential, BoundCredentials } from '../src/auth';
import { configMapping, httpServer } from './helpers';
import type { Logger } from '../src/logging';

const cores: AgentCore[] = []; const directories: string[] = []; const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];

it.each([
  ['apiKey', 'ALL', []], ['mcpHeader', '', []], ['mcpHeader', 'SPECIFIED', []],
  ['mcpHeader', 'SPECIFIED', [{ resourceType: 'mcpServer', resourceId: 'other' }]],
])('rejects an inapplicable MCP credential before fetching its secret', async (kind, scope, refs) => {
  const metadata = { credentialId: 'id', name: 'key', credentialType: kind as string, resourceScope: scope as string,
    resourceRefs: refs as Array<{ resourceType: string; resourceId: string }> };
  const resolve = vi.spyOn(AgentCoreControlPlane.prototype, 'resolveCredential').mockResolvedValue(metadata);
  const get = vi.fn();
  const controlPlane = new AgentCoreControlPlane({ workspaceId: 'ws', regionId: 'cn-hangzhou', accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) });
  const bound = new BoundCredentials(async () => ({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlane,
    workloadAccessToken: { get, invalidate: vi.fn() }, resourceSTS: { get } }));
  await expect(bound.getForMCP('key', 'mcp-1')).rejects.toThrow();
  expect(resolve).toHaveBeenCalledWith('key'); expect(get).not.toHaveBeenCalled();
  controlPlane.close();
});

it('parses explicit MCP Header credentials and keeps their payload redacted', () => {
  const metadata = { credentialId: 'id', name: 'key', credentialType: 'mcpHeader', resourceScope: 'ALL', resourceRefs: [] };
  const credential = new BoundCredential('provider', '{"headers":[{"name":"X-Key","value":"private"}]}', metadata);
  expect(credential.asHeaders()).toEqual({ 'x-key': 'private' });
  expect(JSON.stringify(credential)).not.toContain('private');
  for (const payload of ['not-json', '{"headers":[]}', '{"headers":[{"name":"X-Key"}]}',
    '{"headers":[{"name":"X-Key","value":"a"},{"name":"x-key","value":"b"}]}']) {
    expect(() => new BoundCredential('provider', payload, metadata).asHeaders()).toThrow();
  }
  expect(() => new BoundCredential('provider', 'raw-key', { ...metadata, credentialType: 'apiKey' }).asHeaders()).toThrow();
});
afterEach(async () => { await Promise.all(cores.splice(0).map((core) => core.close())); await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); vi.restoreAllMocks(); });

async function setup(handler: Parameters<typeof httpServer>[0], logger?: Logger) {
  vi.spyOn(AgentCoreControlPlane.prototype, 'resolveCredential').mockImplementation(async (name) => ({
    credentialId: 'cred-1', name, credentialType: 'apiKey', resourceScope: 'ALL', resourceRefs: [],
  }));
  const operations: string[] = []; let tokens = 0;
  const controller = await httpServer((req, res) => {
    expect(req.headers.authorization).toBe('Bearer test-sa');
    operations.push(req.url!); res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/api/v1/workload/token')) res.end(JSON.stringify({ workloadAccessToken: `wat-${++tokens}` }));
    else res.end(JSON.stringify({ access_key_id: 'test-ak', access_key_secret: 'test-sk', security_token: 'test-sts', expiration: new Date(Date.now() + 3600000).toISOString() }));
  }); servers.push(controller);
  const identity = await httpServer(handler); servers.push(identity);
  const realCall = IdentityClient.prototype.callApi;
  vi.spyOn(IdentityClient.prototype, 'callApi').mockImplementation(function (this: IdentityClient, params, request, options) {
    expect(this._endpoint).toBe('agentidentitydata.cn-hangzhou.aliyuncs.com');
    // Route the official signing/serialization transport to a local server only in this test.
    this._endpoint = new URL(identity.url).host; this._protocol = 'http';
    return realCall.call(this, params, request, options);
  });
  const dir = await mkdtemp(join(tmpdir(), 'agentcore-bound-')); directories.push(dir);
  const configPath = join(dir, 'agent.yaml'); const envPath = join(dir, 'env'); const saPath = join(dir, 'sa');
  await writeFile(configPath, stringify(configMapping())); await writeFile(saPath, 'test-sa');
  await writeFile(envPath, `export AGENTCORE_CONTROLLER_URL='${controller.url}'\nexport AGENTCORE_AUTH_TOKEN_FILE='${saPath}'\n`);
  const core = new AgentCore({ configPath, envPath, logger }); cores.push(core);
  return { core, operations };
}

it('resolves named API keys with WAT and identity STS using official signed RPC requests, without caching API keys', async () => {
  let calls = 0;
  const { core, operations } = await setup(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    expect(req.method).toBe('POST'); expect(req.headers.authorization).toBeDefined();
    expect(req.headers['x-acs-action']).toBe('GetResourceAPIKey'); expect(req.headers['x-acs-security-token']).toBe('test-sts');
    expect(params.get('ResourceCredentialProviderName')).toBe('ws-test-service-key'); expect(params.get('WorkloadAccessToken')).toBe('wat-1');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ APIKey: `key-${++calls}`, RequestId: 'request-test' }));
  });
  expect(core.config).toBeUndefined();
  const first = await core.credentials.get(' service-key '); const second = await core.credentials.get('service-key');
  expect(first).toBeInstanceOf(BoundCredential); expect(first.providerName).toBe('ws-test-service-key');
  expect(first.value).toBe('key-1'); expect(second.value).toBe('key-2');
  expect(operations).toEqual(['/api/v1/credentials/sts?purpose=agentidentitydata', '/api/v1/workload/token']);
  expect(inspect(first)).not.toContain('key-1'); expect(JSON.stringify(first)).not.toContain('key-1');
});

it.each(['apiKey', 'mcpHeader'])('uses List metadata and the workspace-name Provider, never GetCredential or redacted secrets (%s)', async (credentialType) => {
  const actions: string[] = [];
  const secret = credentialType === 'apiKey' ? 'real-api-key' : JSON.stringify({ headers: [{ name: 'X-API-Key', value: 'real-header-value' }] });
  const { core } = await setup(async (req, res) => {
    actions.push(String(req.headers['x-acs-action']));
    let body = ''; for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    expect(params.get('ResourceCredentialProviderName')).toBe('ws-test-my-key');
    expect(params.get('WorkloadAccessToken')).toBe('wat-1');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ APIKey: secret }));
  });
  // Exercise the real metadata resolver and signing/serialization, not its unit-test stub.
  vi.mocked(AgentCoreControlPlane.prototype.resolveCredential).mockRestore();
  const endpoint = await httpServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    actions.push(String(req.headers['x-acs-action']));
    expect(req.headers.authorization).toBeDefined();
    expect(req.headers['x-acs-security-token']).toBe('test-sts');
    expect(url.pathname).toBe('/workspaces/ws-test/credentials');
    expect(url.searchParams.get('name')).toBe('my-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items: [{ workspaceId: 'ws-test', credentialId: 'credential-id-not-provider-name', name: 'my-key', credentialType,
      credentialMetadata: JSON.stringify(credentialType === 'apiKey' ? { apiKey: '********' } : { headers: [{ name: 'X-API-Key' }] }),
      resourceScope: credentialType === 'mcpHeader' ? 'SPECIFIED' : 'ALL',
      resourceRefs: credentialType === 'mcpHeader' ? [{ resourceType: 'mcpServer', resourceId: 'mcp-1', resourceName: 'search' }] : [],
      boundAgentsCounts: 1,
    }] }));
  }); servers.push(endpoint);
  const callApi = ControlClient.prototype.callApi;
  vi.spyOn(ControlClient.prototype, 'callApi').mockImplementation(function (this: ControlClient, params, request, options) {
    this._endpoint = new URL(endpoint.url).host; this._protocol = 'http';
    return callApi.call(this, params, request, options);
  });
  const result = credentialType === 'apiKey' ? await core.credentials.get(' my-key ') : await core.credentials.getForMCP(' my-key ', 'mcp-1');
  expect(result.providerName).toBe('ws-test-my-key'); expect(result.value).toBe(secret);
  if (credentialType === 'mcpHeader') expect(result.asHeaders()).toEqual({ 'x-api-key': 'real-header-value' });
  expect(actions).toEqual(['ListCredentials', 'GetResourceAPIKey']);
  expect(inspect(result)).not.toContain(secret);
});

it.each(['ALL', 'SPECIFIED'])('fetches a permitted MCP Header credential through the signed identity API (%s)', async (resourceScope) => {
  const { core } = await setup((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ APIKey: JSON.stringify({ headers: [{ name: 'X-API-Key', value: 'header-secret' }] }) }));
  });
  vi.mocked(AgentCoreControlPlane.prototype.resolveCredential).mockResolvedValue({ credentialId: 'id', name: 'key',
    credentialType: 'mcpHeader', resourceScope, resourceRefs: [{ resourceType: 'mcpServer', resourceId: 'mcp-1' }] });
  const result = await core.credentials.getForMCP('key', 'mcp-1');
  expect(result.asHeaders()).toEqual({ 'x-api-key': 'header-secret' });
});

it('refreshes WAT once on an explicit WAT expiration rejection and retries with the new token', async () => {
  const seen: Array<string | null> = [];
  const { core, operations } = await setup(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push(new URLSearchParams(body).get('WorkloadAccessToken'));
    res.setHeader('content-type', 'application/json');
    if (seen.length === 1) { res.statusCode = 400; res.end(JSON.stringify({ Code: 'WORKLOAD_ACCESS_TOKEN_EXPIRED', Message: 'expired', RequestId: 'expired-1' })); }
    else res.end('{"APIKey":"fresh-api-key"}');
  });
  expect((await core.credentials.get('name')).value).toBe('fresh-api-key');
  expect(seen).toEqual(['wat-1', 'wat-2']); expect(operations.filter((s) => s.includes('workload/token'))).toHaveLength(2);
});

it('does not keep retrying when the new WAT is also rejected', async () => {
  let calls = 0;
  const { core, operations } = await setup((_req, res) => { calls++; res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end('{"Code":"WORKLOAD_ACCESS_TOKEN_INVALID","Message":"invalid"}'); });
  await expect(core.credentials.get('name')).rejects.toBeInstanceOf(WorkloadAccessTokenRejectedError);
  expect(calls).toBe(2); expect(operations.filter((s) => s.includes('workload/token'))).toHaveLength(2);
});

it('does not refresh WAT on a general permission denial', async () => {
  let calls = 0;
  const { core, operations } = await setup((_req, res) => { calls++; res.statusCode = 403; res.setHeader('content-type', 'application/json'); res.end('{"Code":"Forbidden","Message":"not allowed"}'); });
  await expect(core.credentials.get('name')).rejects.toBeInstanceOf(CredentialExchangeError);
  expect(calls).toBe(1); expect(operations.filter((s) => s.includes('workload/token'))).toHaveLength(1);
});

it.each(['{}', '{"APIKey":""}', '{"APIKey":null}'])('rejects missing or empty API keys: %s', async (body) => {
  const { core } = await setup((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
  await expect(core.credentials.get('name')).rejects.toBeInstanceOf(CredentialExchangeError);
});

it('does not treat explicit AK/SK alone as a workload identity and validates names before loading config', async () => {
  const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) }); cores.push(core);
  await expect(core.credentials.get('name')).rejects.toThrow('runtime is not configured');
  const unconfigured = new AgentCore({ configPath: '/missing/agent.yaml' }); cores.push(unconfigured);
  await expect(unconfigured.credentials.get(' ')).rejects.toThrow('name must not be empty');
  await core.close(); await expect(core.credentials.get('name')).rejects.toThrow('closed');
});

it('logs failed API address and RequestId without credential-bearing messages or causes', async () => {
  const entries: unknown[] = []; const log = (...args: unknown[]) => { entries.push(args); };
  const logger: Logger = { debug: log, info: log, warn: log, error: log };
  const { core } = await setup((_req, res) => {
    res.statusCode = 403; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Code: 'Forbidden', Message: 'rejected wat-1 test-sts test-sk private-api-key', RequestId: 'identity-denied-123' }));
  }, logger);
  const error = await core.credentials.get('name').catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CredentialExchangeError); expect((error as Error).cause).toBeUndefined();
  const output = JSON.stringify(entries);
  expect(output).toContain('https://agentidentitydata.cn-hangzhou.aliyuncs.com/'); expect(output).toContain('identity-denied-123');
  for (const secret of ['wat-1', 'test-sts', 'test-sk', 'private-api-key', 'test-sa']) expect(output).not.toContain(secret);
});
