import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentCore, AccessKeyCredential, MemoryValidationError, MemoryContractError, MemoryAPIError, AddMemoriesOutcomeUnknownError } from '../src';
import type { MemoryStore } from '../src/memory';
import type { Logger } from '../src/logging';
import GeneratedSDK from '@alicloud/agentcore20260804';
import { configMapping, httpServer } from './helpers';

const cores: AgentCore[] = []; const dirs: string[] = []; const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
afterEach(async () => { await Promise.all(cores.splice(0).map((c) => c.close())); await Promise.all(servers.splice(0).map((s) => s.close())); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const scope = { agentId: 'agent-test', sessionId: 'session-test' };
const memory = { memoryId: 'memory-1', content: { text: 'likes coffee' }, scope, metadata: { source: 'chat' }, createdAt: '2026-09-07T00:00:00Z' };
async function setup(handler: Parameters<typeof httpServer>[0], logger?: Logger) {
  const endpoint = await httpServer(handler); servers.push(endpoint);
  const core = new AgentCore({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }), logger }); cores.push(core);
  return { core, store: core.memoryStore('test-memory') };
}

it('uses the eight Python Memory wire contracts with signed requests and typed results, without local YAML', async () => {
  const requests: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }> = [];
  const { core, store } = await setup(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://localhost');
    const body = raw ? JSON.parse(new URLSearchParams(raw).get('body')!) : undefined;
    requests.push({ method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    expect(req.headers.authorization).toBeDefined(); expect(req.headers['x-acs-version']).toBe('2026-08-04');
    expect(req.headers['x-acs-security-token']).toBeUndefined();
    res.setHeader('content-type', 'application/json');
    switch (req.headers['x-acs-action']) {
      case 'AddMemories': res.end(JSON.stringify({ success: true, data: { memories: [{ memoryId: 'memory-1' }] } })); break;
      case 'SearchMemories': res.end(JSON.stringify({ success: true, data: { memories: [{ memory, score: 0.9, similarity: 0.8 }] } })); break;
      case 'ListMemories': res.end(JSON.stringify({ success: true, items: [memory], nextToken: 'next', maxResults: 10, totalCount: 11 })); break;
      case 'GetMemory': case 'UpdateMemory': res.end(JSON.stringify({ success: true, data: memory })); break;
      case 'DeleteMemory': res.end('{"success":true}'); break;
      case 'ListMemorySessions': res.end(JSON.stringify({ success: true, items: [scope] })); break;
      case 'ListMemorySessionMessages': res.end(JSON.stringify({ success: true, items: [{ role: 'user', content: 'hello' }] })); break;
      default: throw new Error('unexpected operation');
    }
  });
  expect(core.config).toBeUndefined(); expect(requests).toHaveLength(0);
  expect(await store.addMemories({ scope, text: 'likes coffee', metadata: { source: 'chat' } })).toEqual({ memoryIds: ['memory-1'] });
  const search = await store.searchMemories('coffee', { scope: { agentId: scope.agentId }, topK: 3, metadata: { source: 'chat' }, enableRerank: false, minSimilarity: 0, minScore: 0.1 });
  expect(search.memories[0]).toEqual({ memory, score: 0.9, similarity: 0.8 }); expect(Object.isFrozen(search.memories[0]!.memory.metadata)).toBe(true);
  expect(await store.listMemories({ agentId: scope.agentId, sessionId: scope.sessionId, maxResults: 10, nextToken: 'cursor' })).toMatchObject({ items: [memory], nextToken: 'next', maxResults: 10, totalCount: 11 });
  expect(await store.getMemory('memory-1')).toEqual(memory);
  expect(await store.updateMemory('memory-1', { metadata: {} })).toEqual(memory);
  await store.deleteMemory('memory-1');
  expect(await store.listMemorySessions({ agentId: scope.agentId })).toMatchObject({ items: [scope] });
  expect(await store.listMemorySessionMessages(scope.sessionId, { agentId: scope.agentId, maxResults: 10 })).toMatchObject({ items: [{ role: 'user', content: 'hello' }] });
  const base = '/workspaces/ws-test/memorystores/test-memory';
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `POST ${base}/memories`, `POST ${base}/memories/search`, `GET ${base}/memories`, `GET ${base}/memories/memory-1`,
    `PUT ${base}/memories/memory-1`, `DELETE ${base}/memories/memory-1`, `GET ${base}/sessions`, `GET ${base}/messages`,
  ]);
  expect(requests[0]!.body).toEqual({ scope, text: 'likes coffee', metadata: { source: 'chat' } });
  expect(requests[1]!.body).toEqual({ query: 'coffee', scope: { agentId: scope.agentId }, topK: 3, metadata: { source: 'chat' }, enableRerank: false, minSimilarity: 0, minScore: 0.1 });
  expect(requests[2]!.query).toEqual({ agentId: scope.agentId, sessionId: scope.sessionId, maxResults: '10', nextToken: 'cursor' });
  expect(requests[4]!.body).toEqual({ metadata: {} }); expect(core.config).toBeUndefined();
  expect(requests[7]!.query).toEqual({ agentId: scope.agentId, sessionId: scope.sessionId, maxResults: '10' });
  await core.close(); await expect(store.getMemory('memory-1')).rejects.toThrow('closed');
});

it('supports messages input, optional empty search results and empty pages', async () => {
  const { store } = await setup(async (req, res) => {
    if (req.headers['x-acs-action'] === 'AddMemories') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      expect(JSON.parse(new URLSearchParams(raw).get('body')!)).toEqual({ scope, messages: [{ role: 'user', content: 'hello' }] });
    }
    res.end('{"success":true,"nextToken":""}');
  });
  expect(await store.addMemories({ scope, messages: [{ role: 'user', content: 'hello' }] })).toEqual({ memoryIds: [] });
  expect(await store.searchMemories('hello')).toEqual({ memories: [] });
  expect(await store.listMemories()).toMatchObject({ items: [], nextToken: undefined });
});

it('loads runtime lazily and requests highcode_sdk STS, not WAT or consumer credentials', async () => {
  const operations: string[] = [];
  const endpoint = await httpServer((req, res) => {
    operations.push(req.url!); res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/api/v1/credentials/sts')) {
      expect(req.headers.authorization).toBe('Bearer sa-test');
      res.end(JSON.stringify({ access_key_id: 'test-ak', access_key_secret: 'test-sk', security_token: 'test-sts', expiration: new Date(Date.now() + 3600000).toISOString() }));
    } else { expect(req.headers['x-acs-security-token']).toBe('test-sts'); res.end('{"success":true,"items":[]}'); }
  }); servers.push(endpoint);
  const dir = await mkdtemp(join(tmpdir(), 'agentcore-memory-')); dirs.push(dir);
  const configPath = join(dir, 'agent.yaml'); const envPath = join(dir, 'env'); const tokenPath = join(dir, 'token');
  await writeFile(configPath, stringify(configMapping())); await writeFile(tokenPath, 'sa-test');
  await writeFile(envPath, `export AGENTCORE_CONTROLLER_URL='${endpoint.url}'\nexport AGENTCORE_AUTH_TOKEN_FILE='${tokenPath}'\n`);
  const core = new AgentCore({ configPath, envPath, controlPlaneEndpoint: endpoint.url }); cores.push(core);
  const store = core.memoryStore('name'); expect(core.config).toBeUndefined();
  await store.listMemories(); await store.listMemorySessions();
  expect(operations).toEqual(['/api/v1/credentials/sts?purpose=highcode_sdk', '/workspaces/ws-test/memorystores/name/memories', '/workspaces/ws-test/memorystores/name/sessions']);
});

const invalidCalls: Array<[string, (store: MemoryStore) => Promise<unknown>]> = [
  ['no content', (s) => s.addMemories({ scope } as never)],
  ['two content inputs', (s) => s.addMemories({ scope, text: 'x', messages: [{ role: 'user', content: 'y' }] } as never)],
  ['empty messages', (s) => s.addMemories({ scope, messages: [] })],
  ['reserved userId', (s) => s.addMemories({ scope: { userId: '*' }, text: 'x' })],
  ['reserved agentId', (s) => s.searchMemories('x', { scope: { agentId: '__default__' } })],
  ['invalid role', (s) => s.addMemories({ scope, messages: [{ role: '', content: 'x' }] })],
  ['empty query', (s) => s.searchMemories(' ')],
  ['topK out of bounds', (s) => s.searchMemories('x', { topK: 51 })],
  ['invalid metadata', (s) => s.searchMemories('x', { metadata: { k: 12 } } as never)],
  ['reserved session', (s) => s.listMemories({ sessionId: '*' })],
  ['page out of bounds', (s) => s.listMemories({ maxResults: 101 })],
  ['empty memory id', (s) => s.getMemory('')],
  ['no update', (s) => s.updateMemory('id', {})],
  ['empty text update', (s) => s.updateMemory('id', { text: '' })],
  ['invalid cursor', (s) => s.listMemorySessions({ nextToken: 1 } as never)],
  ['empty session', (s) => s.listMemorySessionMessages('', { agentId: 'agent' })],
  ['missing message identity', (s) => s.listMemorySessionMessages('session')],
  ['reserved message identity', (s) => s.listMemorySessionMessages('session', { userId: '__default__' })],
];
it.each(invalidCalls)('validates before loading runtime: %s', async (_label, call) => {
  const core = new AgentCore({ configPath: '/missing/agent.yaml' }); cores.push(core);
  await expect(call(core.memoryStore('name'))).rejects.toBeInstanceOf(MemoryValidationError); expect(core.config).toBeUndefined();
});

it.each([400, 500, 503])('classifies AddMemories HTTP %s without replaying writes', async (status) => {
  let calls = 0;
  const { store } = await setup((_req, res) => { calls++; res.statusCode = status; res.end(JSON.stringify({ code: 'MemoryFailure', message: 'private memory text', requestId: 'req-failed' })); });
  const error = await store.addMemories({ scope, text: 'sensitive' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(status >= 500 ? AddMemoriesOutcomeUnknownError : MemoryAPIError);
  expect(error).toMatchObject({ operation: 'AddMemories', httpStatusCode: status, requestId: 'req-failed' });
  expect(calls).toBe(1); expect(String(error)).not.toContain('private memory text');
});

it('marks a disconnected AddMemories as outcome unknown and never replays it', async () => {
  let calls = 0; const { store } = await setup((req) => { calls++; req.socket.destroy(); });
  await expect(store.addMemories({ scope, text: 'fact' })).rejects.toBeInstanceOf(AddMemoriesOutcomeUnknownError); expect(calls).toBe(1);
});

it.each(['{}', '{"success":true,"data":{"memories":[{}]}}', 'not-json'])('marks malformed AddMemories responses as unknown: %s', async (body) => {
  const { store } = await setup((_req, res) => res.end(body));
  await expect(store.addMemories({ scope, text: 'fact' })).rejects.toBeInstanceOf(AddMemoriesOutcomeUnknownError);
});

it('detects success=false and does not turn failed reads into empty results', async () => {
  const { store } = await setup((_req, res) => res.end('{"success":false,"httpStatusCode":404,"code":"NotFound","requestId":"missing"}'));
  await expect(store.listMemories()).rejects.toMatchObject({ operation: 'ListMemories', serviceCode: 'NotFound', httpStatusCode: 404, requestId: 'missing' });
});

it.each(['{}', '{"success":true,"data":{}}', '{"success":true,"data":{"memoryId":"m","content":{"text":7},"scope":{}}}'])('rejects malformed memory objects: %s', async (body) => {
  const { store } = await setup((_req, res) => res.end(body));
  await expect(store.getMemory('id')).rejects.toBeInstanceOf(MemoryContractError);
});

it('encodes path components and logs error identifiers without content or credentials', async () => {
  const entries: unknown[] = []; const log = (...values: unknown[]) => entries.push(values); const logger: Logger = { debug: log, info: log, warn: log, error: log };
  const { core } = await setup((req, res) => {
    expect(req.url).toBe('/workspaces/ws-test/memorystores/store%2Fname/memories/id%2Fpart');
    res.statusCode = 403; res.end('{"code":"Denied","requestId":"trace-123","message":"sensitive-content test-sk"}');
  }, logger);
  await expect(core.memoryStore('store/name').getMemory('id/part')).rejects.toMatchObject({ requestId: 'trace-123' });
  const output = JSON.stringify(entries); expect(output).toContain('trace-123'); expect(output).toContain('GetMemory');
  expect(output).not.toContain('sensitive-content'); expect(output).not.toContain('test-sk');
});

it('waits for an AddMemories response beyond the HTTP transport default timeout without replaying it', async () => {
  let calls = 0;
  const { store } = await setup((_req, res) => {
    calls++;
    setTimeout(() => res.end('{"success":true,"data":{"memories":[{"memoryId":"memory-1"}]}}'), 4500);
  });
  expect(await store.addMemories({ scope, text: 'fact' })).toEqual({ memoryIds: ['memory-1'] });
  expect(calls).toBe(1);
}, 10000);

it('sets a 120 second write timeout and explicitly disables generated SDK retries', async () => {
  const call = vi.spyOn(GeneratedSDK.prototype, 'callApi');
  const { store } = await setup((_req, res) => res.end('{"success":true}'));
  await store.addMemories({ scope, text: 'fact' });
  const options = call.mock.calls[0]![2]; expect(options).toMatchObject({ autoretry: false, maxAttempts: 1, connectTimeout: 120000, readTimeout: 120000 });
});

it('normalizes null pagination fields and allows empty memory content', async () => {
  const { store } = await setup((_req, res) => res.end(JSON.stringify({ success: true, items: [{ ...memory, content: { text: '' } }], maxResults: null, totalCount: null, nextToken: null })));
  const result = await store.listMemories(); expect(result.items[0]!.content.text).toBe('');
  expect(result.maxResults).toBeUndefined(); expect(result.totalCount).toBeUndefined(); expect(result.nextToken).toBeUndefined();
});

it('takes a snapshot of scope, metadata and messages before awaiting credentials', async () => {
  const { store } = await setup(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    expect(JSON.parse(new URLSearchParams(raw).get('body')!)).toEqual({ scope, metadata: { source: 'original' }, messages: [{ role: 'user', content: 'original' }] });
    res.end('{"success":true}');
  });
  const writeScope = { ...scope }; const metadata = { source: 'original' }; const messages = [{ role: 'user', content: 'original' }];
  const call = store.addMemories({ scope: writeScope, metadata, messages });
  writeScope.agentId = 'other'; metadata.source = 'changed'; messages[0]!.content = 'changed'; await call;
});

it('keeps an explicit business rejection distinct from an uncertain write', async () => {
  const { store } = await setup((_req, res) => res.end('{"success":false,"code":"Rejected","requestId":"rejected-1"}'));
  const error = await store.addMemories({ scope, text: 'fact' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MemoryAPIError); expect(error).not.toBeInstanceOf(AddMemoriesOutcomeUnknownError);
});

it.each([
  ['items not array', '{"success":true,"items":{}}', (s: MemoryStore) => s.listMemories()],
  ['invalid pagination', '{"success":true,"maxResults":"10"}', (s: MemoryStore) => s.listMemories()],
  ['invalid score', '{"success":true,"data":{"memories":[{"score":true,"similarity":0.8}]}}', (s: MemoryStore) => s.searchMemories('q')],
  ['invalid session', '{"success":true,"items":[{"agentId":2}]}', (s: MemoryStore) => s.listMemorySessions()],
  ['invalid message', '{"success":true,"items":[{"role":"user","content":2}]}', (s: MemoryStore) => s.listMemorySessionMessages('s', { agentId: 'a' })],
])('rejects malformed results: %s', async (_label, body, call) => {
  const { store } = await setup((_req, res) => res.end(body)); await expect(call(store)).rejects.toBeInstanceOf(MemoryContractError);
});

it.each([undefined, {}, { userId: 'u' }, { agentId: 'a' }, { sessionId: 's' }, { userId: 'u', agentId: 'a', sessionId: 's' }])(
  'preserves independent scope fields in writes and searches: %j', async (scope) => {
    const bodies: unknown[] = [];
    const { store } = await setup(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      bodies.push(JSON.parse(new URLSearchParams(raw).get('body')!));
      res.end('{"success":true}');
    });
    await store.addMemories({ scope, text: 'fact' });
    await store.searchMemories('query', { scope });
    expect(bodies).toEqual([JSON.parse(JSON.stringify({ scope, text: 'fact' })), JSON.parse(JSON.stringify({ query: 'query', scope }))]);
  });

it.each([{ userId: 'u' }, { agentId: 'a' }, { sessionId: 's' }])('lists independent scopes and preserves omitted response fields: %j', async (scope) => {
  const queries: unknown[] = [];
  const { store } = await setup((req, res) => {
    queries.push(Object.fromEntries(new URL(req.url!, 'http://localhost').searchParams));
    res.end(JSON.stringify({ success: true, items: req.headers['x-acs-action'] === 'ListMemories' ? [{ ...memory, scope }] : [scope] }));
  });
  expect((await store.listMemories(scope)).items[0]!.scope).toEqual(scope);
  const filter = { userId: scope.userId, agentId: scope.agentId };
  expect((await store.listMemorySessions(filter)).items[0]).toEqual(scope);
  expect(queries).toEqual([scope, JSON.parse(JSON.stringify(filter))]);
});

it.each([{ userId: 'u' }, { agentId: 'a' }, { userId: 'u', agentId: 'a' }])('queries messages with identity in query parameters: %j', async (identity) => {
  const { store } = await setup((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    expect(url.pathname).toBe('/workspaces/ws-test/memorystores/test-memory/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...identity, sessionId: 's/1', maxResults: '10' });
    res.end('{"success":true,"items":[]}');
  });
  expect((await store.listMemorySessionMessages('s/1', { ...identity, maxResults: 10 })).items).toEqual([]);
});
