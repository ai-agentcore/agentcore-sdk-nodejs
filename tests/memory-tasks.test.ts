import { afterEach, expect, expectTypeOf, it } from 'vitest';
import { AgentCore, AccessKeyCredential, AddMemoriesOutcomeUnknownError, MemoryContractError } from '../src';
import type { AddMemoriesResult, AddMemoriesSubmission } from '../src/memory';
import { httpServer } from './helpers';

const cores: AgentCore[] = [];
const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map(core => core.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
});
async function setup(handler: Parameters<typeof httpServer>[0]) {
  const server = await httpServer(handler); servers.push(server);
  const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: server.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }) });
  cores.push(core); return core.memoryStore('store');
}

it.each([undefined, false, true])('submits writes with sync=%s without polling', async sync => {
  const requests: unknown[] = [];
  const store = await setup(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(new URLSearchParams(raw).get('body')!); requests.push(body);
    expect(req.headers['x-acs-action']).toBe('AddMemories'); expect(req.headers.authorization).toBeDefined();
    res.end(JSON.stringify({ success: true, data: body.sync ? { memories: [{ memoryId: 'm' }] } : { taskId: 'task-1' } }));
  });
  const result = await store.addMemories({ text: 'fact', sync });
  expect(result).toEqual(sync ? { memoryIds: ['m'] } : { taskId: 'task-1' });
  expect(requests).toEqual([{ text: 'fact', sync: sync ?? false }]);
});

it.each(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'])('queries %s tasks without writing or polling', async status => {
  let calls = 0;
  const store = await setup((req, res) => {
    calls++; expect(req.method).toBe('GET'); expect(req.headers['x-acs-action']).toBe('GetMemoryTask');
    expect(req.url).toBe('/workspaces/ws/memorystores/store/memory-tasks/task%2F1');
    expect(req.headers.authorization).toBeDefined();
    res.end(JSON.stringify({ success: true, data: { taskId: 'task/1', status,
      ...(status === 'SUCCEEDED' ? { memories: [{ memoryId: 'm' }] } : {}),
      ...(['FAILED', 'UNKNOWN'].includes(status) ? { error: { code: 'ExtractionFailed', message: 'Try reviewing input' } } : {}),
    } }));
  });
  const result = await store.getMemoryTask('task/1');
  expect(result).toMatchObject({ taskId: 'task/1', status });
  expect(result.memoryIds).toEqual(status === 'SUCCEEDED' ? ['m'] : []);
  if (status === 'FAILED' || status === 'UNKNOWN') expect(result.error?.code).toBe('ExtractionFailed');
  expect(calls).toBe(1);
});

it('infers the return type from the requested write mode', async () => {
  const store = await setup(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(new URLSearchParams(raw).get('body')!);
    res.end(JSON.stringify({ success: true, data: body.sync ? { memories: [] } : { taskId: 't' } }));
  });
  expectTypeOf(await store.addMemories({ text: 'fact' })).toEqualTypeOf<AddMemoriesSubmission>();
  expectTypeOf(await store.addMemories({ text: 'fact', sync: false })).toEqualTypeOf<AddMemoriesSubmission>();
  expectTypeOf(await store.addMemories({ text: 'fact', sync: true })).toEqualTypeOf<AddMemoriesResult>();
});

it('rejects an accepted write without a task ID as unknown without retrying', async () => {
  let calls = 0;
  const store = await setup((_req, res) => { calls++; res.end('{"success":true,"requestId":"req-add","data":{}}'); });
  await expect(store.addMemories({ text: 'fact' })).rejects.toMatchObject({ name: 'AddMemoriesOutcomeUnknownError', requestId: 'req-add' });
  expect(calls).toBe(1);
});

it('keeps a missing task distinct from an unknown write', async () => {
  const store = await setup((_req, res) => { res.statusCode = 404; res.end('{"Code":"NotFound","RequestId":"req-task"}'); });
  const error = await store.getMemoryTask('task-1').catch(error => error);
  expect(error).toMatchObject({ operation: 'GetMemoryTask', httpStatusCode: 404, requestId: 'req-task' });
  expect(error).not.toBeInstanceOf(AddMemoriesOutcomeUnknownError);
});

it.each([{}, { taskId: 't', status: 'SUCCEEDED' }, { taskId: 't', status: 'FAILED' }])('rejects incomplete task results: %j', async data => {
  const store = await setup((_req, res) => res.end(JSON.stringify({ success: true, data })));
  await expect(store.getMemoryTask('t')).rejects.toBeInstanceOf(MemoryContractError);
});
