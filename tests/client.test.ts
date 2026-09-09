import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentCore, AccessKeyCredential } from '../src';
import { ResourceNotConfiguredError } from '../src/errors';
import { httpServer, configMapping } from './helpers';

const clients: AgentCore[] = [];
const endpoints: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(clients.splice(0).map((c) => c.close())); await Promise.all(endpoints.splice(0).map((s) => s.close())); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const credential = new AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' });
it('separates MCP cache entries by case-insensitive fixed headers', async () => {
  const endpoint = await httpServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items: [{ name: 'test', mcpServerId: 'mcp-1' }] }));
  }); endpoints.push(endpoint);
  const core = new AgentCore({ configPath: await config(endpoint.url), controlPlaneEndpoint: endpoint.url, accessKeyCredential: credential }); clients.push(core);
  const [a, same, b, plain] = await Promise.all([
    core.mcp('test', { headers: { 'X-User': 'a' } }), core.mcp('test', { headers: { 'x-user': 'a' } }),
    core.mcp('test', { headers: { 'X-User': 'b' } }), core.mcp('test'),
  ]);
  expect(a).toBe(same); expect(a).not.toBe(b); expect(a).not.toBe(plain);
  const boundA = await core.mcp('test', { credentialName: 'key-a' });
  const boundB = await core.mcp('test', { credentialName: 'key-b' });
  expect(boundA).not.toBe(boundB); expect(boundA).not.toBe(plain);
  expect(await core.mcp('test', { credentialName: ' key-a ' })).toBe(boundA);
});
async function config(url: string) {
  const dir = await mkdtemp(join(tmpdir(), 'agentcore-core-')); dirs.push(dir);
  const path = join(dir, 'agent.yaml');
  const mapping = configMapping(); mapping.spec.model.gatewayUrl = `${url}/v1`;
  await writeFile(path, stringify(mapping)); return path;
}

it('lazily resolves local runtime, caches one model client per effective request, and performs native model calls', async () => {
  let connections = 0; let modelLookups = 0; let invocations = 0;
  const endpoint = await httpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url!, 'http://localhost');
    if (path.pathname.endsWith('/model-connections')) { connections++; res.end(JSON.stringify({ items: [{ connectionId: 'mc-1', name: 'test-mc', protocol: 'OpenAI/v1' }] })); }
    else if (path.pathname.endsWith('/models')) { modelLookups++; res.end(JSON.stringify({ items: [{ modelId: 'm1', modelName: path.searchParams.get('modelName') || 'model-a' }] })); }
    else { invocations++; res.end('{"id":"reply"}'); }
  }); endpoints.push(endpoint);
  const core = new AgentCore({ configPath: await config(endpoint.url), controlPlaneEndpoint: endpoint.url, accessKeyCredential: credential }); clients.push(core);
  expect(core.config).toBeUndefined(); expect(connections).toBe(0);
  const [first, same] = await Promise.all([core.model('test-mc', { model: 'model-a' }), core.model('test-mc', { model: 'model-a' })]);
  expect(first).toBe(same); expect(await core.model('test-mc', { model: 'model-a' })).toBe(first);
  expect((await first.completion([{ role: 'user', content: 'hello' }])).id).toBe('reply');
  expect(connections).toBe(1); expect(modelLookups).toBe(1); expect(invocations).toBe(1);
  expect(core.config!.workspaceId).toBe('ws-test');
  expect(await core.model('test-mc', { model: 'model-b' })).not.toBe(first); expect(connections).toBe(2);
});

it('does not read an explicitly missing YAML for direct resources', async () => {
  const endpoint = await httpServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"id":"direct"}'); }); endpoints.push(endpoint);
  const core = AgentCore.auto({ configPath: '/does-not-exist/agent.yaml' }); clients.push(core);
  const model = core.directModel({ model: 'custom', baseURL: endpoint.url, apiKey: 'user-key' });
  expect((await model.completion([{ role: 'user', content: 'test' }])).id).toBe('direct');
  expect(core.config).toBeUndefined();
  await core.close(); await expect(model.completion([])).rejects.toThrow();
  expect(() => core.directModel({ model: 'no', baseURL: endpoint.url })).toThrow('closed');
});

it('fails a managed call without a Consumer gateway even with explicit AK workspace context', async () => {
  const core = new AgentCore({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', accessKeyCredential: credential }); clients.push(core);
  await expect(core.model('test')).rejects.toBeInstanceOf(ResourceNotConfiguredError);
  expect(() => new AgentCore({ workspaceId: 'ws' })).toThrow('together');
  expect(() => new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', configPath: 'agent.yaml' })).toThrow('cannot be combined');
});

it('can retry failed runtime initialization without publishing a partial runtime', async () => {
  vi.stubEnv('AGENTCORE_CONFIG_WAIT_TIMEOUT', '0');
  const dir = await mkdtemp(join(tmpdir(), 'agentcore-core-')); dirs.push(dir); const path = join(dir, 'agent.yaml');
  const endpoint = await httpServer((_req, res) => res.end(JSON.stringify({ items: [{ connectionId: 'mc-1', name: 'mc', protocol: 'OpenAI/v1', modelId: 'm1', modelName: 'model' }] }))); endpoints.push(endpoint);
  const core = new AgentCore({ configPath: path, controlPlaneEndpoint: endpoint.url, accessKeyCredential: credential }); clients.push(core);
  await expect(core.model('mc')).rejects.toThrow('cannot read agent.yaml'); expect(core.config).toBeUndefined();
  await writeFile(path, stringify(configMapping()));
  expect((await core.model('mc')).descriptor!.connectionName).toBe('mc');
});

it('does not cache a failed named resource lookup', async () => {
  let found = false;
  const endpoint = await httpServer((_req, res) => res.end(JSON.stringify({ items: found ? [{ name: 'test', mcpServerId: 'mcp-1' }] : [] })));
  endpoints.push(endpoint);
  const core = new AgentCore({ configPath: await config(endpoint.url), controlPlaneEndpoint: endpoint.url, accessKeyCredential: credential }); clients.push(core);
  await expect(core.mcp('test')).rejects.toThrow('does not exist');
  found = true; expect((await core.mcp('test')).descriptor!.mcpServerId).toBe('mcp-1');
});
