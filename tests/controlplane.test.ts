import { afterEach, describe, expect, it, vi } from 'vitest';
import GeneratedSDK from '@alicloud/agentcore20260804';
import { AgentCoreControlPlane, internalOSSURL } from '../src/controlplane/client';
import { AccessKeyCredential } from '../src/auth/access-key';
import { ConfigError, InvocationError, MCPServerNotFoundError, ModelConnectionNotFoundError, ResourceNotConfiguredError } from '../src/errors';
import type { Logger } from '../src/logging';
import { httpServer } from './helpers';

const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const clients: AgentCoreControlPlane[] = [];
afterEach(async () => { vi.restoreAllMocks(); clients.splice(0).forEach((c) => c.close()); await Promise.all(servers.splice(0).map((s) => s.close())); });
async function server(handler: Parameters<typeof httpServer>[0]) { const result = await httpServer(handler); servers.push(result); return result; }
function client(endpoint: string, logger?: Logger) {
  const core = new AgentCoreControlPlane({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', endpoint,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk', securityToken: 'test-sts' }), logger,
  }); clients.push(core); return core;
}

describe('official AgentCore OpenAPI client', () => {
  it('sends ListCredentials name through CommonRequest and preserves scope metadata', async () => {
    const queries: URL[] = [];
    const endpoint = await server((req, res) => {
      const url = new URL(req.url!, 'http://localhost'); queries.push(url);
      expect(url.pathname).toBe('/workspaces/ws-test/credentials');
      expect(req.headers['x-acs-action']).toBe('ListCredentials');
      expect(req.headers.authorization).toBeDefined();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(url.searchParams.has('nextToken')
        ? { items: [{ name: 'key', credentialId: 'cred-1', credentialType: 'mcpHeader', resourceScope: 'SPECIFIED', resourceRefs: [{ resourceType: 'mcpServer', resourceId: 'mcp-1' }] }] }
        : { items: [{ name: 'key-other' }], nextToken: 'page2' }));
    });
    const metadata = await client(endpoint.url).resolveCredential('key');
    expect(metadata).toMatchObject({ credentialType: 'mcpHeader', resourceScope: 'SPECIFIED', resourceRefs: [{ resourceId: 'mcp-1' }] });
    expect(queries.map((url) => url.searchParams.get('name'))).toEqual(['key', 'key']);
    expect(queries[1]!.searchParams.get('nextToken')).toBe('page2');
    expect(queries.every((url) => !url.searchParams.has('nameLike'))).toBe(true);
  });
  it.each([{ items: [] }, { items: [{ name: 'key-other' }] }, { items: [{ name: 'key' }, { name: 'key' }] }])('rejects absent or ambiguous credential names', async ({ items }) => {
    const endpoint = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items })); });
    await expect(client(endpoint.url).resolveCredential('key')).rejects.toThrow();
  });
  it('tries the private endpoint on default public transport failure and remembers success', async () => {
    const hosts: string[] = [];
    vi.spyOn(GeneratedSDK.prototype, 'callApi').mockImplementation(async function (this: GeneratedSDK) {
      hosts.push(this._endpoint);
      if (this._endpoint === 'agentcore.cn-hangzhou.aliyuncs.com') throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      return { body: { items: [{ name: 'test', mcpServerId: 'mcp-1' }] } };
    });
    const core = new AgentCoreControlPlane({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) }); clients.push(core);
    await core.resolveMCP('test'); await core.resolveMCP('test');
    expect(hosts).toEqual(['agentcore.cn-hangzhou.aliyuncs.com', 'agentcore-vpc.cn-hangzhou.aliyuncs.com', 'agentcore-vpc.cn-hangzhou.aliyuncs.com']);
  });
  it('does not replace an explicitly configured endpoint on transport failure', async () => {
    const hosts: string[] = [];
    vi.spyOn(GeneratedSDK.prototype, 'callApi').mockImplementation(async function (this: GeneratedSDK) {
      hosts.push(this._endpoint); throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    });
    await expect(client('https://agentcore-pre.aliyuncs.com').resolveMCP('test')).rejects.toBeInstanceOf(InvocationError);
    expect(hosts).toEqual(['agentcore-pre.aliyuncs.com']);
  });
  it('signs exact model queries, follows pagination, then resolves the model within the connection', async () => {
    const calls: Array<{ url: string; authorization?: string; token?: string | string[] }> = [];
    const endpoint = await server((req, res) => {
      calls.push({ url: req.url!, authorization: req.headers.authorization, token: req.headers['x-acs-security-token'] });
      const url = new URL(req.url!, 'http://localhost');
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/model-connections')) res.end(JSON.stringify(url.searchParams.has('nextToken')
        ? { items: [{ name: 'test-mc', connectionId: 'mc-1', protocol: 'OpenAI/v1', providerType: 'qwen' }] }
        : { items: [{ name: 'test-mc-other', connectionId: 'mc-other' }], nextToken: 'page2' }));
      else res.end(JSON.stringify({ items: [{ modelId: 'model-1', modelName: 'qwen3.8-max', contextSize: 128000, maxTokens: 8192, capabilities: { toolCall: true } }] }));
    });
    const result = await client(endpoint.url).resolveModel('test-mc', 'qwen3.8-max');
    expect(result.connectionId).toBe('mc-1'); expect(result.capabilities.toolCall).toBe(true); expect(result.maxTokens).toBe(8192);
    expect(calls).toHaveLength(3);
    const first = new URL(calls[0]!.url, endpoint.url);
    expect(first.pathname).toBe('/workspaces/ws-test/model-connections');
    expect(first.searchParams.get('name')).toBe('test-mc'); expect(first.searchParams.get('searchType')).toBe('accurate');
    const last = new URL(calls[2]!.url, endpoint.url);
    expect(last.searchParams.get('connectionId')).toBe('mc-1'); expect(last.searchParams.get('modelName')).toBe('qwen3.8-max');
    expect(calls.every((call) => call.authorization?.includes('Signature=') && call.token === 'test-sts')).toBe(true);
  });
  it('only reports ModelConnectionNotFound for a missing connection, not a missing model', async () => {
    let connectionExists = false;
    const endpoint = await server((req, res) => {
      res.end(JSON.stringify({ items: connectionExists && req.url!.includes('/model-connections') ? [{ name: 'test-mc', connectionId: 'mc-1' }] : [] }));
    });
    const core = client(endpoint.url);
    await expect(core.resolveModel('test-mc', 'missing-model')).rejects.toBeInstanceOf(ModelConnectionNotFoundError);
    connectionExists = true;
    try { await core.resolveModel('test-mc', 'missing-model'); throw new Error('expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(ResourceNotConfiguredError); expect(error).not.toBeInstanceOf(ModelConnectionNotFoundError); }
  });
  it('requires a model name when there is more than one model and rejects duplicate exact names', async () => {
    let duplicate = false;
    const endpoint = await server((req, res) => res.end(JSON.stringify({ items: req.url!.includes('/model-connections')
      ? Array.from({ length: duplicate ? 2 : 1 }, () => ({ name: 'mc', connectionId: 'mc-1' }))
      : [{ modelId: 'm1', modelName: 'first' }, { modelId: 'm2', modelName: 'second' }] })));
    const core = client(endpoint.url);
    await expect(core.resolveModel('mc')).rejects.toThrow('explicit model name');
    duplicate = true; await expect(core.resolveModel('mc')).rejects.toBeInstanceOf(ConfigError);
  });
  it('resolves MCP by exact name with highcode_sdk STS and preserves its protocol', async () => {
    const purposes: Array<string | undefined> = []; let query: URL | undefined;
    const endpoint = await server((req, res) => {
      query = new URL(req.url!, 'http://localhost');
      res.end(JSON.stringify({ items: [{ name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'SSE', type: 'CUSTOM', status: 'RUNNING' }] }));
    });
    const core = new AgentCoreControlPlane({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', endpoint: endpoint.url,
      resourceSTSProvider: { get(purpose) { purposes.push(purpose); return new AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }); } },
    }); clients.push(core);
    expect((await core.resolveMCP('test-mcp')).mcpServerId).toBe('mcp-1');
    expect(query!.searchParams.get('searchType')).toBe('accurate'); expect(purposes).toEqual(['highcode_sdk']);
    await expect(core.resolveMCP('other')).rejects.toBeInstanceOf(MCPServerNotFoundError);
  });
  it('propagates an authenticated control-plane error with RequestId in logs, not a not-found fallback', async () => {
    const logs: unknown[] = [];
    const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args: unknown[]) => logs.push(args)])) as unknown as Logger;
    let calls = 0;
    const endpoint = await server((_req, res) => {
      calls++; res.statusCode = 403; res.end(JSON.stringify({ Code: 'Forbidden', Message: 'permission denied', RequestId: 'upstream-123' }));
    });
    await expect(client(endpoint.url, logger).resolveMCP('test-mcp')).rejects.toBeInstanceOf(InvocationError);
    expect(calls).toBe(1); const output = JSON.stringify(logs);
    expect(output).toContain('upstream-123'); expect(output).toContain('Forbidden');
    expect(output).not.toContain('test-sk'); expect(output).not.toContain('test-sts');
  });
});

describe('Skill download', () => {
  it('retries a regional OSS transport failure once on the private host with the original signature', async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('oss-cn-hangzhou')) return originalFetch(input, init);
      urls.push(url);
      if (!url.includes('-internal')) throw new TypeError('fetch failed');
      return new Response('archive');
    });
    const endpoint = await server((_req, res) => res.end(JSON.stringify({ data: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/key?x-oss-signature=unchanged' })));
    await client(endpoint.url).getSkill('skill', '1');
    expect(urls).toEqual(['https://bucket.oss-cn-hangzhou.aliyuncs.com/key?x-oss-signature=unchanged', 'https://bucket.oss-cn-hangzhou-internal.aliyuncs.com/key?x-oss-signature=unchanged']);
  });
  it('resolves the latest label once and downloads the presigned archive without forwarding AK or Consumer credentials', async () => {
    let authorization: string | undefined; const paths: string[] = [];
    const oss = await server((req, res) => { authorization = req.headers.authorization; res.end('archive-bytes'); });
    const endpoint = await server((req, res) => {
      paths.push(req.url!);
      res.end(JSON.stringify({ data: req.url!.endsWith('/actions/download-via-oss') ? `${oss.url}/object.zip?signature=secret` : { labels: { latest: '1.2.3' } } }));
    });
    const artifact = await client(endpoint.url).getSkill('test-skill');
    expect(artifact.version).toBe('1.2.3'); expect(Buffer.from(artifact.archive).toString()).toBe('archive-bytes');
    expect(authorization).toBeUndefined();
    expect(paths).toEqual(['/workspaces/ws-test/skills/test-skill', '/workspaces/ws-test/skills/test-skill/versions/1.2.3/actions/download-via-oss']);
  });
  it('skips detail resolution for a pinned version and does not leak a failing presigned URL', async () => {
    const paths: string[] = [];
    const oss = await server((_req, res) => { res.statusCode = 403; res.end('denied'); });
    const endpoint = await server((req, res) => { paths.push(req.url!); res.end(JSON.stringify({ data: `${oss.url}/object.zip?signature=do-not-log` })); });
    try { await client(endpoint.url).getSkill('test-skill', '1.0'); throw new Error('expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(InvocationError); expect(String(error)).not.toContain('do-not-log'); }
    expect(paths).toEqual(['/workspaces/ws-test/skills/test-skill/versions/1.0/actions/download-via-oss']);
  });
  it('uses latest online timestamp when no label is present', async () => {
    const oss = await server((_req, res) => res.end('zip'));
    const endpoint = await server((req, res) => res.end(JSON.stringify({ data: req.url!.endsWith('/actions/download-via-oss') ? oss.url : {
      versions: [{ status: 'offline', version: '3', updateTime: 100 }, { status: 'online', version: '2', updateTime: 2 }, { status: 'online', version: '1', updateTime: 1 }],
    } })));
    expect((await client(endpoint.url).getSkill('test')).version).toBe('2');
  });
  it('does not change a V4 URL that signs host, or a nonregional OSS domain', () => {
    expect(internalOSSURL(new URL('https://bucket.oss-cn-hangzhou.aliyuncs.com/key?x-oss-additional-headers=host'))).toBeUndefined();
    expect(internalOSSURL(new URL('https://bucket.oss-accelerate.aliyuncs.com/key'))).toBeUndefined();
    const before = new URL('https://bucket.oss-cn-hangzhou.aliyuncs.com/a%2Fb?x-oss-signature=a%2Bb%3D');
    const after = internalOSSURL(before)!;
    expect(after.hostname).toBe('bucket.oss-cn-hangzhou-internal.aliyuncs.com');
    expect(after.pathname).toBe(before.pathname); expect(after.search).toBe(before.search);
  });
});
