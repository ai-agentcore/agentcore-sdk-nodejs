import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import {
  ContextMemoryClient,
  CreateEventsOutcomeUnknownError,
  MemoryAPIError,
  MemoryContractError,
  MemoryRequestAbortedError,
  MemoryRequestTimeoutError,
  MemoryValidationError,
  type MemoryType,
} from '../src';
import { credential, deferred, event, memory, scope, setup } from './context-memory-helpers';

it('sends signed CreateEvents, paginated ListEvents and SearchMemories requests with four-dimensional scope', async () => {
  const requests: Array<{
    action: string | string[] | undefined;
    method: string | undefined;
    path: string;
    query: object;
    body: unknown;
  }> = [];
  const { client } = await setup(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({
      action: req.headers['x-acs-action'],
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(new URLSearchParams(raw).get('body') ?? '') : undefined,
    });
    expect(req.headers.authorization).toBeDefined();
    expect(req.headers['x-acs-version']).toBe('2026-08-04');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-acs-request-id', 'req-header');
    if (req.headers['x-acs-action'] === 'CreateEvents') {
      res.end(
        JSON.stringify({
          success: true,
          requestId: 'req-create',
          data: {
            results: [
              { inputIndex: 1, status: 'REJECTED', code: 'InvalidEvent', message: 'unsupported' },
              { inputIndex: 0, status: 'STORED', eventId: 'event-1' },
            ],
          },
        }),
      );
    } else if (req.headers['x-acs-action'] === 'ListEvents') {
      res.end(
        JSON.stringify({
          success: true,
          items: url.searchParams.has('nextToken')
            ? []
            : [{ eventId: 'event-1', event, extra: { retained: true } }],
          nextToken: url.searchParams.has('nextToken') ? '' : 'cursor',
          maxResults: 1,
          totalCount: 1,
        }),
      );
    } else {
      res.end(
        JSON.stringify({ success: true, data: { memories: [{ memory, score: 0.9, similarity: 0.8 }] } }),
      );
    }
  });
  expect(await client.createEvents([event, event], { scope })).toEqual({
    requestId: 'req-create',
    results: [
      { kind: 'other', inputIndex: 1, status: 'REJECTED', code: 'InvalidEvent', message: 'unsupported' },
      { kind: 'stored', inputIndex: 0, status: 'STORED', eventId: 'event-1' },
    ],
  });
  const page = await client.listEvents({ scope, maxResults: 1 });
  expect(page).toEqual({
    items: [{ eventId: 'event-1', event, extra: { retained: true } }],
    nextToken: 'cursor',
    maxResults: 1,
    totalCount: 1,
    requestId: 'req-header',
  });
  expect(await client.listEvents({ scope, maxResults: 1, nextToken: page.nextToken })).toEqual({
    items: [],
    nextToken: '',
    maxResults: 1,
    totalCount: 1,
    requestId: 'req-header',
  });
  const search = {
    scope,
    types: ['semantic', 'skill', 'user_profile', 'session_summary'] satisfies MemoryType[],
    topK: 4,
    metadata: { source: 'chat' },
    enableRerank: false,
    minScore: 0,
    minSimilarity: 0.1,
  };
  expect(await client.searchMemories('tea', search)).toEqual({
    memories: [{ memory, score: 0.9, similarity: 0.8 }],
    requestId: 'req-header',
  });
  const base = '/workspaces/ws-test/memorystores/test-memory';
  expect(requests).toEqual([
    {
      action: 'CreateEvents',
      method: 'POST',
      path: base + '/events',
      query: {},
      body: { events: [event, event], scope },
    },
    {
      action: 'ListEvents',
      method: 'GET',
      path: base + '/events',
      query: { ...scope, maxResults: '1' },
      body: undefined,
    },
    {
      action: 'ListEvents',
      method: 'GET',
      path: base + '/events',
      query: { ...scope, maxResults: '1', nextToken: 'cursor' },
      body: undefined,
    },
    {
      action: 'SearchMemories',
      method: 'POST',
      path: base + '/memories/search',
      query: {},
      body: { query: 'tea', ...search },
    },
  ]);
  expect(Object.isFrozen(page.items[0]?.extra)).toBe(true);
});

it.each(['semantic', 'skill', 'user_profile', 'session_summary'] satisfies MemoryType[])(
  'accepts and preserves %s search results',
  async (type) => {
    const { client } = await setup((_req, res) =>
      res.end(
        JSON.stringify({
          success: true,
          data: { memories: [{ memory: { ...memory, type }, score: 1, similarity: 1 }] },
        }),
      ),
    );
    const result = await client.searchMemories('tea', { scope, types: [type] });
    expect(result.memories[0]?.memory).toEqual({ ...memory, type });
    expect(Object.isFrozen(result.memories[0]?.memory.sourceEventIds)).toBe(true);
  },
);

it.each([
  { bodyId: 'req-body', headerId: 'req-header', expected: 'req-body' },
  { bodyId: undefined, headerId: 'req-header', expected: 'req-header' },
  { bodyId: undefined, headerId: undefined, expected: undefined },
])(
  'logs the same requestId as a malformed search error ($expected)',
  async ({ bodyId, headerId, expected }) => {
    const { client, logger } = await setup((_req, res) => {
      if (headerId) res.setHeader('x-acs-request-id', headerId);
      res.end(JSON.stringify({ success: true, requestId: bodyId, data: { memories: [{}] } }));
    });
    const error = await client.searchMemories('PRIVATE_QUERY').catch((error) => error);
    expect(error).toBeInstanceOf(MemoryContractError);
    expect(error).toMatchObject({ operation: 'SearchMemories', requestId: expected });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'agentcore.memory.request.failed',
      expect.objectContaining({
        request_id: expected ?? '-',
        error_type: 'MemoryContractError',
        operation: 'SearchMemories',
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/PRIVATE_QUERY|test-sk/);
  },
);

it.each([
  { inputIndex: 0, status: 'STORED' },
  { inputIndex: 1, status: 'STORED', eventId: 'event-1' },
])('treats malformed write receipts as unknown without retry ($inputIndex)', async (receipt) => {
  let requests = 0;
  const { client, logger } = await setup((_req, res) => {
    requests++;
    res.setHeader('x-acs-request-id', 'req-write');
    res.end(JSON.stringify({ success: true, data: { results: [receipt] } }));
  });
  await expect(client.createEvents([event])).rejects.toMatchObject({
    code: 'CREATE_EVENTS_OUTCOME_UNKNOWN',
    outcomeUnknown: true,
    requestId: 'req-write',
  });
  expect(logger.warn).toHaveBeenCalledWith(
    'agentcore.memory.request.failed',
    expect.objectContaining({ request_id: 'req-write' }),
  );
  expect(requests).toBe(1);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_CONTENT');
});

it.each([400, 503])('classifies HTTP %s writes without retrying', async (status) => {
  let requests = 0;
  const { client } = await setup((_req, res) => {
    requests++;
    res.statusCode = status;
    res.end(JSON.stringify({ Code: 'Denied', Message: 'Denied', RequestId: 'req-error' }));
  });
  const error = await client.createEvents([event]).catch((error) => error);
  expect(error).toBeInstanceOf(status === 503 ? CreateEventsOutcomeUnknownError : MemoryAPIError);
  expect(error).toMatchObject({
    httpStatusCode: status,
    requestId: 'req-error',
    outcomeUnknown: status === 503,
  });
  expect(requests).toBe(1);
});

it.each(
  [
    { operation: 'CreateEvents', call: (client: ContextMemoryClient) => client.createEvents([event]) },
    { operation: 'ListEvents', call: (client: ContextMemoryClient) => client.listEvents() },
    {
      operation: 'SearchMemories',
      call: (client: ContextMemoryClient) => client.searchMemories('PRIVATE_QUERY'),
    },
  ].flatMap((test) => [403, 503].map((status) => ({ ...test, status }))),
)(
  'preserves HTTP 200 business error $status for $operation without retrying',
  async ({ operation, call, status }) => {
    let requests = 0;
    const serviceCode = status === 503 ? 'ServiceUnavailable' : 'Forbidden';
    const requestId = `req-business-${status}`;
    const message = 'Memory service unavailable';
    const { client, logger } = await setup((_req, res) => {
      requests++;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ success: false, httpStatusCode: status, code: serviceCode, message, requestId }),
      );
    });
    const error = await call(client).catch((error) => error);
    const uncertain = operation === 'CreateEvents' && status === 503;
    expect(error).toBeInstanceOf(uncertain ? CreateEventsOutcomeUnknownError : MemoryAPIError);
    expect(error).toMatchObject({
      operation,
      code: uncertain ? 'CREATE_EVENTS_OUTCOME_UNKNOWN' : 'MEMORY_API_FAILED',
      httpStatusCode: status,
      serviceCode,
      requestId,
      serviceMessage: message,
      outcomeUnknown: uncertain,
    });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'agentcore.memory.request.failed',
      expect.objectContaining({
        operation,
        status,
        service_code: serviceCode,
        request_id: requestId,
        message,
      }),
    );
    expect(requests).toBe(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/PRIVATE_QUERY|PRIVATE_CONTENT|test-sk/);
  },
);

it('uses context-purpose credentials for the native client', async () => {
  const { options } = await setup((_req, res) => res.end('{"success":true,"items":[]}'));
  const get = vi.fn(() => credential);
  const client = ContextMemoryClient.fromCredentials({
    ...options,
    accessKeyCredential: undefined,
    resourceSTSProvider: { get },
  });
  await client.listEvents();
  expect(get).toHaveBeenCalledExactlyOnceWith('context');
});

it('validates scope, batch size, types and bounds before acquiring credentials', async () => {
  const { options } = await setup(() => {
    throw new Error('unexpected dispatch');
  });
  const get = vi.fn(() => credential);
  const client = ContextMemoryClient.fromCredentials({
    ...options,
    accessKeyCredential: undefined,
    resourceSTSProvider: { get },
  });
  for (const call of [
    () => client.createEvents([]),
    () => client.listEvents({ scope: { userId: '*' } }),
    () => client.listEvents({ maxResults: 101 }),
    () => client.searchMemories('tea', { types: ['unsupported'] as never }),
    () => client.searchMemories('tea', { topK: 201 }),
  ])
    await expect(call()).rejects.toBeInstanceOf(MemoryValidationError);
  expect(get).not.toHaveBeenCalled();
});

it.each(['abort', 'timeout'] as const)(
  'prevents late dispatch after %s during credential acquisition',
  async (mode) => {
    let requests = 0;
    const { options } = await setup((_req, res) => {
      requests++;
      res.end('{"success":true,"items":[]}');
    });
    const credentials = deferred<typeof credential>();
    const acquiring = deferred<void>();
    const get = vi.fn(() => {
      acquiring.resolve();
      return credentials.promise;
    });
    const client = ContextMemoryClient.fromCredentials({
      ...options,
      accessKeyCredential: undefined,
      resourceSTSProvider: { get },
    });
    const controller = new AbortController();
    const pending = client.createEvents([event], { signal: controller.signal, timeoutMs: 30 });
    const rejection = expect(pending).rejects.toMatchObject({
      code: mode === 'abort' ? 'MEMORY_REQUEST_ABORTED' : 'MEMORY_REQUEST_TIMEOUT',
      outcomeUnknown: false,
    });
    await acquiring.promise;
    if (mode === 'abort') controller.abort('cancelled');
    await rejection;
    credentials.resolve(credential);
    await setImmediate();
    expect(requests).toBe(0);
  },
);

it('does not acquire credentials or dispatch a write with an already aborted signal', async () => {
  const { options } = await setup(() => {
    throw new Error('unexpected dispatch');
  });
  const get = vi.fn(() => credential);
  const client = ContextMemoryClient.fromCredentials({
    ...options,
    accessKeyCredential: undefined,
    resourceSTSProvider: { get },
  });
  const controller = new AbortController();
  controller.abort('cancelled');
  await expect(client.createEvents([event], { signal: controller.signal })).rejects.toMatchObject({
    code: 'MEMORY_REQUEST_ABORTED',
    outcomeUnknown: false,
    cause: 'cancelled',
  });
  expect(get).not.toHaveBeenCalled();
});

it.each(['abort', 'timeout'] as const)('keeps read outcomes known after dispatch on %s', async (mode) => {
  const arrived = deferred<() => void>();
  const { client } = await setup((_req, res) => {
    arrived.resolve(() => res.end('{"success":true,"items":[]}'));
  });
  const controller = new AbortController();
  const pending = client.listEvents({ signal: controller.signal, timeoutMs: 250 });
  const rejection = expect(pending).rejects.toMatchObject({
    code: mode === 'abort' ? 'MEMORY_REQUEST_ABORTED' : 'MEMORY_REQUEST_TIMEOUT',
    outcomeUnknown: false,
  });
  const respond = await arrived.promise;
  if (mode === 'abort') controller.abort();
  await rejection;
  respond();
});

it.each([
  { ...memory, scope: { ...scope, userId: 'another-user' } },
  { ...memory, type: 'skill' },
])('rejects search results outside the requested scope or types (%j)', async (returned) => {
  const { client } = await setup((_req, res) =>
    res.end(
      JSON.stringify({
        success: true,
        data: { memories: [{ memory: returned, score: 1, similarity: 1 }] },
      }),
    ),
  );
  await expect(client.searchMemories('tea', { scope, types: ['semantic'] })).rejects.toBeInstanceOf(
    MemoryContractError,
  );
});

it.each(['abort', 'timeout'] as const)(
  'reports an unknown write outcome after dispatch on %s without replaying',
  async (mode) => {
    const arrived = deferred<() => void>();
    let requests = 0;
    const { client } = await setup((_req, res) => {
      requests++;
      arrived.resolve(() =>
        res.end(
          '{"success":true,"data":{"results":[{"inputIndex":0,"status":"STORED","eventId":"event-1"}]}}',
        ),
      );
    });
    const controller = new AbortController();
    const pending = client.createEvents([event], { signal: controller.signal, timeoutMs: 250 });
    const rejection = expect(pending).rejects.toBeInstanceOf(
      mode === 'abort' ? MemoryRequestAbortedError : MemoryRequestTimeoutError,
    );
    const error = pending.catch((error) => error);
    const respond = await arrived.promise;
    if (mode === 'abort') controller.abort('cancelled');
    await rejection;
    expect(await error).toMatchObject({ operation: 'CreateEvents', outcomeUnknown: true });
    respond();
    await setImmediate();
    expect(requests).toBe(1);
  },
);
