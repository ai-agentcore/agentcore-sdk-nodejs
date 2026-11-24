import { afterEach, expect, it } from 'vitest';
import { AgentCore, AccessKeyCredential, InvocationError } from '../src';
import { httpServer } from './helpers';

const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const cores: AgentCore[] = [];
afterEach(async () => { await Promise.all(cores.splice(0).map(c => c.close())); await Promise.all(servers.splice(0).map(s => s.close())); });
async function setup(response: unknown, status = 200) {
  const calls: Array<{ path: string; body: any; headers: any }> = [];
  const server = await httpServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    calls.push({ path: req.url!, body: JSON.parse(Buffer.concat(parts).toString()), headers: req.headers });
    res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
  }); servers.push(server);
  const core = AgentCore.auto({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', controlPlaneEndpoint: server.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk', securityToken: 'test-sts' }) });
  cores.push(core); return { core, calls };
}

it('sends signed search requests and preserves sources, scores and per-call options', async () => {
  const data = { chunks: [{ content: '产品说明', assetId: 'a-1', fileName: 'guide.pdf', chunkSeq: 2,
    chunkToken: 'ct-1', score: 0.032, scores: { fusion: 0.032 } }], timeSpent: 12, scoreType: 'rrf' };
  const { core, calls } = await setup({ success: true, data });
  const kb = core.knowledgeBase('kb /中文'); expect(calls).toHaveLength(0);
  expect(await kb.search('产品', { topK: 5, rerank: false, vectorWeight: 0, metadataFilter: '{}' })).toEqual(data);
  await kb.search('second');
  expect(calls[0]!.path).toBe('/workspaces/ws-test/knowledge-bases/kb%20%2F%E4%B8%AD%E6%96%87/search');
  expect(calls[0]!.headers['x-acs-action']).toBe('SearchKnowledgeBase');
  expect(calls[0]!.headers.authorization).toContain('Signature=');
  expect(calls[0]!.headers['x-acs-security-token']).toBe('test-sts');
  expect(calls[0]!.body).toEqual({ query: '产品', topK: 5, rerank: false, vectorWeight: 0, metadataFilter: '{}' });
  expect(calls[1]!.body).toEqual({ query: 'second' });
  await core.close(); await expect(kb.search('closed')).rejects.toThrow('closed');
});

it('preserves empty results', async () => {
  const { core } = await setup({ success: true, data: { chunks: [], timeSpent: 1, scoreType: 'keyword' } });
  expect((await core.knowledgeBase('kb').search('no match')).chunks).toEqual([]);
});

it.each([200, 403])('propagates service errors at HTTP %s', async status => {
  const { core } = await setup({ success: false, code: 'Forbidden', Code: 'Forbidden', requestId: 'req-kb', RequestId: 'req-kb' }, status);
  await expect(core.knowledgeBase('kb').search('query')).rejects.toBeInstanceOf(InvocationError);
});

it('rejects missing results rather than inventing an empty list', async () => {
  const { core } = await setup({ success: true, data: {} });
  await expect(core.knowledgeBase('kb').search('query')).rejects.toBeInstanceOf(InvocationError);
});
