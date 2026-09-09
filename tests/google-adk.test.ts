import { afterEach, expect, it } from 'vitest';
import { LlmAgent, Runner, InMemorySessionService, PRELOAD_MEMORY, StreamingMode, createEvent, createSession,
  isFinalResponse, type LlmRequest } from '@google/adk';
import { AgentCore, AccessKeyCredential, Tool, MemoryValidationError, MemoryAPIError } from '../src';
import { ModelClient } from '../src/model';
import { model, tools, AgentCoreMemoryService } from '../src/integrations/google-adk';
import { parseAgentConfigMapping } from '../src/runtime/config';
import { httpServer, configMapping } from './helpers';
import { Type, FunctionCallingConfigMode } from '@google/genai';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of source) result.push(value); return result; }
const request = (contents: LlmRequest['contents'], config?: LlmRequest['config']): LlmRequest => ({ contents, config, liveConnectConfig: {}, toolsDict: {} });

async function fixture(protocol: string, status = 200) {
  const requests: { path: string; auth?: string; key?: string; body: Record<string, any> }[] = [];
  const memories: { action: string; body: Record<string, any> }[] = [];
  const endpoint = await httpServer((req, res) => {
    void (async () => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.headers['x-acs-action']) {
        const action = String(req.headers['x-acs-action']); memories.push({ action, body: JSON.parse(new URLSearchParams(raw).get('body')!) });
        res.setHeader('content-type', 'application/json'); res.statusCode = status;
        res.end(status !== 200 ? '{"Code":"Forbidden","RequestId":"adk-memory-test"}' : JSON.stringify(action === 'SearchMemories'
          ? { success: true, data: { memories: [{ memory: { memoryId: 'm1', content: { text: 'User likes coffee' }, scope: {}, createdAt: '2026-09-07T00:00:00Z' }, score: 1, similarity: 1 }] } }
          : { success: true, data: { memoryIds: ['written'] } })); return;
      }
      const body = JSON.parse(raw); requests.push({ path: req.url!, auth: req.headers.authorization, key: req.headers['x-api-key'] as string, body });
      const first = requests.length === 1 && Boolean(body.tools?.length);
      const id = `answer-${requests.length}`;
      if (protocol === 'OpenAI/v1') {
        const message = first ? { role: 'assistant', content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"city":"杭州"}' } }] }
          : { role: 'assistant', content: 'Try coffee in 杭州.' };
        const reason = first ? 'tool_calls' : 'stop';
        const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
        if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id, model: 'custom-model', choices: [{ index: 0, message, finish_reason: reason }], usage })); return; }
        res.setHeader('content-type', 'text/event-stream');
        const delta = first ? { ...message, tool_calls: message.tool_calls!.map((call, index) => ({ index, ...call })) } : message;
        res.end([{ id, model: 'custom-model', choices: [{ index: 0, delta, finish_reason: null }] },
          { id, model: 'custom-model', choices: [{ index: 0, delta: {}, finish_reason: reason }], usage },
        ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'); return;
      }
      const content = first ? [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { city: '杭州' } }]
        : [{ type: 'text', text: 'Try coffee in 杭州.' }];
      const message = { id, type: 'message', role: 'assistant', model: 'custom-model', content, stop_reason: first ? 'tool_use' : 'end_turn',
        stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } };
      if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
      res.setHeader('content-type', 'text/event-stream');
      const events = [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: first ? { ...content[0], input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: '{"city":"杭州"}' } : { type: 'text_delta', text: 'Try coffee in 杭州.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
      ]; res.end(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
    })().catch(error => { res.statusCode = 500; res.end(String(error)); });
  }); cleanup.push(() => endpoint.close());
  const mapping = configMapping(); mapping.spec.model.gatewayUrl = endpoint.url;
  const client = ModelClient.platform(parseAgentConfigMapping(mapping), { connectionId: 'mc-1', connectionName: 'test-mc', modelId: 'm-1',
    modelName: 'custom-model', protocol, providerType: 'custom', maxTokens: 1024, capabilities: {} }); cleanup.push(() => client.close());
  const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }) }); cleanup.push(() => core.close());
  const partitions: string[][] = [];
  const memory = new AgentCoreMemoryService(core.memoryStore('test-memory'), { partitionResolver: (app, user) => { partitions.push([app, user]); return `${app}:${user}`; } });
  return { endpoint, client, core, requests, memories, memory, partitions };
}

it.each(['OpenAI/v1', 'Anthropic'].flatMap(protocol => [false, true].map(stream => ({ protocol, stream }))))(
  'runs native ADK model/tool/Memory through $protocol (stream=$stream)', async ({ protocol, stream }) => {
    const { client, memory, requests, memories, partitions } = await fixture(protocol);
    const calls: unknown[] = [];
    const agent = new LlmAgent({ name: 'agent', model: await model(client), instruction: 'Answer the user.',
      generateContentConfig: { temperature: 0.2, maxOutputTokens: 64 },
      tools: [PRELOAD_MEMORY, ...tools([new Tool({ name: 'lookup', description: 'Lookup city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
        invoke: args => { calls.push(args); return { timezone: 'Asia/Shanghai' }; } })])],
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({ agent, appName: 'app', sessionService, memoryService: memory });
    await sessionService.createSession({ appName: 'app', userId: 'user', sessionId: 'session' });
    const events = await collect(runner.runAsync({ userId: 'user', sessionId: 'session', newMessage: { role: 'user', parts: [{ text: 'Drink?' }] },
      runConfig: { streamingMode: stream ? StreamingMode.SSE : StreamingMode.NONE } }));
    const final = events.filter(event => isFinalResponse(event) && !event.partial).at(-1)!;
    expect(final.content?.parts).toEqual([{ text: 'Try coffee in 杭州.' }]);
    expect(events.some(event => event.partial)).toBe(stream);
    expect(calls).toEqual([{ city: '杭州' }]); expect(requests).toHaveLength(2);
    for (const entry of requests) {
      expect(entry).toMatchObject({ auth: 'Bearer consumer-secret', key: undefined,
        path: '/model-connection/mc-1/v1/' + (protocol === 'Anthropic' ? 'messages' : 'chat/completions'), body: { model: 'custom-model', max_tokens: 64, temperature: 0.2 } });
      expect(JSON.stringify(entry.body)).toContain('User likes coffee');
    }
    expect(JSON.stringify(requests[1]!.body)).toContain('Asia/Shanghai'); expect(JSON.stringify(requests[1]!.body)).toContain('call-1');
    const session = (await sessionService.getSession({ appName: 'app', userId: 'user', sessionId: 'session' }))!;
    expect(JSON.stringify(session.events)).not.toContain('User likes coffee');
    await memory.addSessionToMemory(session);
    expect(memories.filter(entry => entry.action === 'AddMemories').map(entry => entry.body)).toEqual([
      { scope: { agentId: 'app:user', sessionId: 'session' }, messages: [{ role: 'user', content: 'Drink?' }, { role: 'assistant', content: 'Try coffee in 杭州.' }] },
    ]);
    expect(partitions.every(pair => pair[0] === 'app' && pair[1] === 'user')).toBe(true);
  },
);

it('maps native Memory searches and explicit event deltas without tools, thoughts, partials or errors', async () => {
  const { memory, memories } = await fixture('OpenAI/v1');
  expect(await memory.searchMemory({ appName: 'app', userId: 'user', query: 'Drink?' })).toEqual({ memories: [
    { content: { parts: [{ text: 'User likes coffee' }] }, timestamp: '2026-09-07T00:00:00Z' },
  ] });
  const events = [
    createEvent({ author: 'user', content: { role: 'user', parts: [{ text: 'Hello' }] } }),
    createEvent({ author: 'agent', content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] } }),
    createEvent({ author: 'agent', content: { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { result: 'private' } } }] } }),
    createEvent({ author: 'agent', partial: true, content: { role: 'model', parts: [{ text: 'partial' }] } }),
    createEvent({ author: 'agent', errorCode: 'FAILED', content: { role: 'model', parts: [{ text: 'error' }] } }),
    createEvent({ author: 'agent', content: { role: 'model', parts: [{ text: 'secret thought', thought: true }, { text: 'Final' }] } }),
  ];
  await memory.addEventsToMemory({ appName: 'app', userId: 'user', sessionId: 'delta', events, customMetadata: { source: 'test' } });
  expect(memories.at(-1)!.body).toEqual({ scope: { agentId: 'app:user', sessionId: 'delta' },
    messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Final' }], metadata: { source: 'test' } });
  await memory.addEventsToMemory({ appName: 'app', userId: 'user', sessionId: 'delta', events: events.slice(1, 5) });
  expect(memories).toHaveLength(2);
  await memory.addEventsToMemory({ appName: 'app', userId: 'user', events });
  expect(memories.at(-1)!.body).toEqual({ scope: { agentId: 'app:user' },
    messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Final' }] });
});

it('keeps Memory failures visible and validates application partition/session before any call', async () => {
  const { core, memory, memories } = await fixture('OpenAI/v1', 403);
  await expect(memory.searchMemory({ appName: 'app', userId: 'user', query: 'q' })).rejects.toBeInstanceOf(MemoryAPIError);
  const invalid = new AgentCoreMemoryService(core.memoryStore('mem'), { partitionResolver: () => '' });
  await expect(invalid.searchMemory({ appName: 'app', userId: 'user', query: 'q' })).rejects.toBeInstanceOf(MemoryValidationError);
  await expect(memory.addSessionToMemory(createSession({ appName: 'app', id: '', userId: 'user', events: [] }))).rejects.toBeInstanceOf(MemoryValidationError);
  expect(memories).toHaveLength(1);
  expect(() => new AgentCoreMemoryService(core.memoryStore('mem'), { partitionResolver: () => 'p', topK: 0 })).toThrow(MemoryValidationError);
});

it('preserves canonical JSON Schema and tool results without exposing credentials in the declaration', async () => {
  const parameters = { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['value'], additionalProperties: false };
  const canonical = new Tool({ name: 'echo', description: 'Echo', parameters, invoke: args => args });
  const [native] = tools([canonical]);
  expect(native!._getDeclaration()).toEqual({ name: 'echo', description: 'Echo', parametersJsonSchema: parameters });
  expect(await native!.runAsync({ args: { value: 42 }, toolContext: undefined! })).toEqual({ value: 42 });
});

it('supports inline images, system instructions and function history without model-call IDs', async () => {
  const { client, requests } = await fixture('OpenAI/v1');
  const native = await model(client);
  await collect(native.generateContentAsync(request([
    { role: 'user', parts: [{ text: 'Look' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
    { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { city: '杭州' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { timezone: 'Asia/Shanghai' } } }] },
  ], { systemInstruction: { parts: [{ text: 'First' }, { text: 'Second' }] }, responseMimeType: 'application/json' })));
  expect(requests[0]!.body.messages).toMatchObject([
    { role: 'system', content: 'First\nSecond' },
    { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
    { role: 'assistant', tool_calls: [{ id: 'call-1-0', function: { name: 'lookup' } }] },
    { role: 'tool', tool_call_id: 'call-1-0' },
  ]);
  expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
  await expect(native.connect(request([]))).rejects.toThrow('live');
});

it('borrows direct model credentials and aborts streaming HTTP when the consumer stops', async () => {
  const headers: (string | undefined)[] = []; let key = 'first'; let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const endpoint = await httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    headers.push(req.headers.authorization);
    if (JSON.parse(raw).stream) {
      res.once('close', closed); res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"id":"c1","model":"direct","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}\n\n'); return;
    }
    res.setHeader('content-type', 'application/json'); res.end('{"id":"c1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}');
  }); cleanup.push(() => endpoint.close());
  const client = ModelClient.direct({ model: 'direct', baseURL: endpoint.url + '/v1', apiKeyProvider: () => key }); cleanup.push(() => client.close());
  const native = await model(client); const input = request([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  await collect(native.generateContentAsync(input)); key = 'second'; await collect(native.generateContentAsync(input));
  const stream = native.generateContentAsync(input, true);
  expect((await stream.next()).value).toMatchObject({ partial: true, content: { parts: [{ text: 'first' }] } });
  await stream.return(); await disconnected;
  expect(headers).toEqual(['Bearer first', 'Bearer second', 'Bearer second']);
  client.close(); await expect(collect(native.generateContentAsync(input))).rejects.toThrow(); expect(headers).toHaveLength(3);
});

it('applies the Core timeout and ADK abort signal without retrying generation', async () => {
  let calls = 0;
  const endpoint = await httpServer(() => { calls++; }); cleanup.push(() => endpoint.close());
  const input = request([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  const timed = ModelClient.direct({ model: 'slow', baseURL: endpoint.url + '/v1', timeoutMs: 30 }); cleanup.push(() => timed.close());
  await expect(collect((await model(timed)).generateContentAsync(input))).rejects.toThrow();
  expect(calls).toBe(1);
  const client = ModelClient.direct({ model: 'slow', baseURL: endpoint.url + '/v1' }); cleanup.push(() => client.close());
  await expect(collect((await model(client)).generateContentAsync(input, false, AbortSignal.timeout(30)))).rejects.toThrow();
  expect(calls).toBe(2);
});

it('translates GenAI schemas and tool selection without changing the fixed ModelClient identity', async () => {
  const { client, requests } = await fixture('OpenAI/v1');
  const native = await model(client);
  const schema = { type: Type.OBJECT, properties: { city: { type: Type.STRING, nullable: true, minLength: '1' } }, required: ['city'], propertyOrdering: ['city'] };
  const input = request([{ role: 'user', parts: [{ text: 'Lookup' }] }], {
    tools: [{ functionDeclarations: [{ name: 'lookup', parameters: schema }, { name: 'excluded', parameters: { type: Type.OBJECT } }] }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['lookup'] } },
    responseSchema: schema,
  }); input.model = 'not-the-bound-model';
  await collect(native.generateContentAsync(input));
  expect(requests[0]!.body).toMatchObject({ model: 'custom-model', max_tokens: 1024, tool_choice: 'required', tools: [{ function: { name: 'lookup',
    parameters: { type: 'object', properties: { city: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] } }, required: ['city'] },
  } }] });
  expect(requests[0]!.body.tools).toHaveLength(1);
  expect(requests[0]!.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: { type: 'object' } } });
  expect(schema.properties.city).toEqual({ type: Type.STRING, nullable: true, minLength: '1' });
});
