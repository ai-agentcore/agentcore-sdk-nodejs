import { inspect } from 'node:util';
import GeneratedSDK from '@alicloud/agentcore20260804';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentCore, AccessKeyCredential, MemoryAPIError, AddMemoriesOutcomeUnknownError } from '../src';
import { recallMemory, recordMemory } from '../src/integrations/memory/common';
import { httpServer } from './helpers';

const cores: AgentCore[] = [];
const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map(core => core.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
});
function client(endpoint = 'http://unused.example.com') {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const core = new AgentCore({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }), logger });
  cores.push(core);
  return { store: core.memoryStore('test-memory'), logger };
}

it.each([
  'Authorization: Bearer PRIVATE_TOKEN', 'apiKey=PRIVATE_TOKEN', 'access_key_secret=PRIVATE_TOKEN',
  'SecurityToken=PRIVATE_TOKEN', 'password=PRIVATE_TOKEN', 'Bearer PRIVATE_TOKEN', 'Basic PRIVATE_TOKEN',
  'content=PRIVATE_TOKEN', 'query=PRIVATE_TOKEN', 'messages=PRIVATE_TOKEN', 'metadata=PRIVATE_TOKEN',
  'https://example.com/?signature=PRIVATE_TOKEN', 'LTAIPRIVATE_TOKEN'.replace('_', ''),
  'eyJPRIVATE.TOKEN.VALUE',
])('retains diagnostic text and redacts sensitive message suffix: %s', (secret) => {
  const error = new MemoryAPIError('SearchMemories', { httpStatusCode: 403, serviceCode: 'Forbidden',
    requestId: 'req-unit', serviceMessage: `Access denied; ${secret}` });
  expect(error.serviceMessage).toContain('Access denied');
  for (const output of [String(error), inspect(error), JSON.stringify(error)]) {
    expect(output).toContain('req-unit');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('PRIVATE_TOKEN');
  }
  expect(error.message).toContain('403');
  expect(error.message).toContain('Forbidden');
});

it('bounds error messages and keeps absent diagnostics optional', () => {
  const error = new MemoryAPIError('GetMemory', { serviceMessage: `Not found\r\n${'x'.repeat(1000)}` });
  expect(error.serviceMessage).toHaveLength(512);
  expect(error.serviceMessage).not.toMatch(/[\r\n]/);
  const missing = new MemoryAPIError('GetMemory');
  expect(missing.message).toBe('AgentCore Memory operation GetMemory failed');
  expect(missing.serviceMessage).toBeUndefined();
});

it.each([
  [200, false], [200, true], [403, false], [403, true], [503, false], [503, true],
] as const)('keeps real OpenAPI HTTP %s diagnostics (header-only RequestId: %s)', async (status, headerOnly) => {
  let requests = 0;
  const server = await httpServer((req, res) => {
    requests++;
    expect(req.headers.authorization).toBeDefined();
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-ACS-REQUEST-ID', 'req-header');
    const message = 'Memory access denied; token=PRIVATE_TOKEN';
    res.end(JSON.stringify(status === 200
      ? { success: false, httpStatusCode: 403, code: 'MemoryDenied', message, ...(headerOnly ? {} : { requestId: 'req-body' }) }
      : { Code: 'MemoryDenied', Message: message, ...(headerOnly ? {} : { RequestId: 'req-body' }) }));
  });
  servers.push(server);
  const { store, logger } = client(server.url);
  // The generated client drops response headers on HTTP errors. Do not invent an ID.
  const expectedId = headerOnly ? (status === 200 ? 'req-header' : undefined) : 'req-body';
  const error = await store.searchMemories('PRIVATE_QUERY').catch(error => error);
  expect(error).toBeInstanceOf(MemoryAPIError);
  expect(error).toMatchObject({ httpStatusCode: status === 200 ? 403 : status,
    serviceCode: 'MemoryDenied', requestId: expectedId });
  for (const output of [String(error), JSON.stringify(logger.warn.mock.calls)]) {
    expect(output).toContain('Memory access denied');
    if (expectedId) expect(output).toContain(expectedId);
    else expect(output).not.toContain('request_id=undefined');
    expect(output).not.toContain('PRIVATE_QUERY');
    expect(output).not.toContain('PRIVATE_TOKEN');
    expect(output).not.toContain('test-sk');
  }
  expect(logger.warn).toHaveBeenCalledWith('agentcore.memory.request.failed', expect.objectContaining({
    operation: 'SearchMemories', memory_store_name: 'test-memory', service_code: 'MemoryDenied',
    request_id: expectedId ?? '-',
    status: status === 200 ? 403 : status, message: expect.stringContaining('Memory access denied'),
  }));
  expect(requests).toBe(1);
  if (status === 503) {
    const unknown = await store.addMemories({ text: 'PRIVATE_CONTENT' }).catch(error => error);
    expect(unknown).toBeInstanceOf(AddMemoriesOutcomeUnknownError);
    expect(unknown.message).toContain('outcome is unknown; the write may have succeeded');
    expect(unknown.message).toContain('Memory access denied');
    if (expectedId) expect(unknown.message).toContain(expectedId);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_CONTENT');
    expect(requests).toBe(2);
  }
});

it.each(['data', 'response'])('reads mixed-case RequestId from wrapped error %s.headers', async (source) => {
  vi.spyOn(GeneratedSDK.prototype, 'callApi').mockRejectedValue({ innerException: {
    code: 'Forbidden', statusCode: 403, message: 'Denied; headers=PRIVATE_TOKEN',
    [source]: { headers: { 'X-aCs-ReQuEsT-iD': 'req-wrapped' } },
  } });
  const { store, logger } = client();
  const error = await store.listMemories().catch(error => error);
  expect(error).toMatchObject({ requestId: 'req-wrapped', serviceCode: 'Forbidden', httpStatusCode: 403 });
  expect(error.message).toContain('Denied');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_TOKEN');
});

it('keeps the invalid-response reason when a write outcome is unknown', async () => {
  const server = await httpServer((_req, res) => res.end('{"success":true,"requestId":"req-invalid","data":{"memories":[{}]}}'));
  servers.push(server);
  const { store, logger } = client(server.url);
  const error = await store.addMemories({ text: 'PRIVATE_CONTENT' }).catch(error => error);
  expect(error).toBeInstanceOf(AddMemoriesOutcomeUnknownError);
  expect(error.serviceMessage).toContain('memoryId');
  expect(error.message).toContain('req-invalid');
  expect(logger.warn).toHaveBeenCalledWith('agentcore.memory.request.failed', expect.objectContaining({
    request_id: 'req-invalid', message: error.serviceMessage,
  }));
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_CONTENT');
});

it.each([true, false])('logs diagnostics for framework recall and write (bestEffort: %s)', async (bestEffort) => {
  const { store, logger } = client();
  const details = { serviceCode: 'Forbidden', httpStatusCode: 403, requestId: 'req-adapter', serviceMessage: 'Access denied; token=PRIVATE_TOKEN' };
  vi.spyOn(store, 'searchMemories').mockRejectedValue(new MemoryAPIError('SearchMemories', details));
  vi.spyOn(store, 'addMemories').mockRejectedValue(new AddMemoriesOutcomeUnknownError('AddMemories', { ...details, httpStatusCode: 503 }));
  const scope = { userId: 'test-user' };
  const recall = recallMemory(store, 'PRIVATE_QUERY', scope, { topK: 5, bestEffort, logger });
  if (bestEffort) expect(await recall).toBe('');
  else await expect(recall).rejects.toBeInstanceOf(MemoryAPIError);
  const write = recordMemory(store, [{ role: 'user', content: 'PRIVATE_CONTENT' }], scope, { bestEffort, logger });
  if (bestEffort) await expect(write).resolves.toBeUndefined();
  else await expect(write).rejects.toBeInstanceOf(AddMemoriesOutcomeUnknownError);
  for (const [operation, apiOperation, status] of [['search', 'SearchMemories', 403], ['write', 'AddMemories', 503]] as const) {
    expect(logger.warn).toHaveBeenCalledWith(`agentcore.memory.adapter.${operation}.failed`, expect.objectContaining({
      store: 'test-memory', upstream_request_id: 'req-adapter', api_operation: apiOperation,
      status, service_code: 'Forbidden', message: expect.stringContaining('Access denied'),
    }));
  }
  const logs = JSON.stringify(logger.warn.mock.calls);
  for (const value of ['PRIVATE_TOKEN', 'PRIVATE_QUERY', 'PRIVATE_CONTENT']) expect(logs).not.toContain(value);
  expect(store.addMemories).toHaveBeenCalledTimes(1);
});
