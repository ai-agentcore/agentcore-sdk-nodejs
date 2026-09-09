import { afterEach, expect, it } from 'vitest';
import { createAgent } from 'langchain';
import { AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { model, tools } from '../src/integrations/langchain';
import { model as graphModel, tools as graphTools } from '../src/integrations/langgraph';
import { ModelClient } from '../src/model';
import { Tool } from '../src/integrations/common';
import { parseAgentConfigMapping } from '../src/runtime/config';
import { configMapping, httpServer } from './helpers';

const clients: ModelClient[] = [];
const endpoints: Awaited<ReturnType<typeof httpServer>>[] = [];
afterEach(async () => { clients.splice(0).forEach(c => c.close()); await Promise.all(endpoints.splice(0).map(e => e.close())); });
async function server(handler: Parameters<typeof httpServer>[0]) {
  const endpoint = await httpServer(handler); endpoints.push(endpoint); return endpoint;
}
function managed(url: string, protocol = 'OpenAI/v1') {
  const config = configMapping(); config.spec.model.gatewayUrl = url + '/model-connection';
  const client = ModelClient.platform(parseAgentConfigMapping(config), {
    connectionId: 'mc-1', connectionName: 'test-mc', modelId: 'm-1', modelName: 'custom-model',
    protocol, providerType: 'custom', maxTokens: 1024, capabilities: {},
  }); clients.push(client); return client;
}
const chat = (content = 'finished') => ({ id: 'c1', object: 'chat.completion', created: 1, model: 'custom-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

it('runs a native LangChain agent/tool loop through managed ChatOpenAI', async () => {
  const requests: { path: string; auth?: string; body: Record<string, any> }[] = [];
  const endpoint = await server(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(requests.length === 1 ? { ...chat(), choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"city":"杭州"}' } }],
    } }] } : { ...chat(), id: `c${requests.length}` }));
  });
  const calls: unknown[] = [];
  const toolkit = tools([new Tool({ name: 'lookup', description: 'Lookup timezone', parameters: { type: 'object',
    properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    invoke: args => { calls.push(args); return { timezone: 'Asia/Shanghai' }; },
  })]);
  const native = await model(managed(endpoint.url), { streaming: false, temperature: 0.25 });
  const result = await createAgent({ model: native, tools: toolkit }).invoke({ messages: [new HumanMessage('Timezone?')] });
  expect(result.messages.at(-1)!.content).toBe('finished'); expect(calls).toEqual([{ city: '杭州' }]);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request).toMatchObject({ path: '/model-connection/mc-1/v1/chat/completions', auth: 'Bearer consumer-secret',
      body: { model: 'custom-model', max_tokens: 1024, temperature: 0.25 } });
  }
  expect(requests[0]!.body.tools[0].function.parameters).toMatchObject({ required: ['city'], additionalProperties: false });
  expect(requests[1]!.body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: '{"timezone":"Asia/Shanghai"}' }));
});

it('preserves native streaming chunks and can be used directly in a LangGraph node', async () => {
  const bodies: Record<string, unknown>[] = [];
  const endpoint = await server(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw));
    if (!bodies.at(-1)!.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chat('onetwo'))); return; }
    res.setHeader('content-type', 'text/event-stream');
    for (const content of ['one', 'two']) res.write(`data: ${JSON.stringify({ id: 'c1', model: 'custom-model', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  expect(graphModel).toBe(model); expect(graphTools).toBe(tools);
  const native = await graphModel(managed(endpoint.url)); const chunks: AIMessageChunk[] = [];
  for await (const chunk of await native.stream('Hello')) chunks.push(chunk);
  expect(chunks.every(c => AIMessageChunk.isInstance(c))).toBe(true);
  expect(chunks.map(c => c.content).join('')).toBe('onetwo'); expect(bodies[0]).toMatchObject({ stream: true });
  const graph = new StateGraph(MessagesAnnotation).addNode('reply', async state => ({ messages: [await native.invoke(state.messages)] }))
    .addEdge(START, 'reply').addEdge('reply', END).compile();
  expect((await graph.invoke({ messages: [new HumanMessage('Hello')] })).messages.at(-1)!.content).toBe('onetwo');
  expect(bodies[1]!.stream).toBeFalsy();
});

it.each([false, true])('uses native Anthropic messages and Consumer auth (streaming=%s)', async streaming => {
  const requests: Record<string, any>[] = [];
  const endpoint = await server(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], body: JSON.parse(raw) });
    const message = { id: 'm1', type: 'message', role: 'assistant', model: 'custom-model', content: [{ type: 'text', text: 'Anthropic answer' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } };
    if (!streaming) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.setHeader('content-type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic answer' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const native = await model(managed(endpoint.url, 'Anthropic'), { streaming, maxTokens: 64 });
  const result = await native.invoke('Hello');
  expect(JSON.stringify(result.content)).toContain('Anthropic answer');
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ path: '/model-connection/mc-1/v1/messages', auth: 'Bearer consumer-secret', key: undefined,
    body: { model: 'custom-model', max_tokens: 64 } });
});

it('uses native tool validation, ToolMessage conversion and error propagation', async () => {
  const calls: unknown[] = [];
  const [lookup] = tools([new Tool({ name: 'lookup', description: 'Lookup city', parameters: { type: 'object',
    properties: { city: { type: 'string' } }, required: ['city'] }, invoke: args => { calls.push(args); return { found: args.city }; } })]);
  await expect(lookup!.invoke({ city: 42 })).rejects.toThrow(); expect(calls).toEqual([]);
  const output = await lookup!.invoke({ type: 'tool_call', id: 'call-1', name: 'lookup', args: { city: '杭州' } });
  expect(ToolMessage.isInstance(output)).toBe(true); expect(output).toMatchObject({ tool_call_id: 'call-1', content: '{"found":"杭州"}' });
  const [broken] = tools([new Tool({ name: 'broken', description: '', parameters: { type: 'object' }, invoke: () => { throw new Error('service failed'); } })]);
  await expect(broken!.invoke({})).rejects.toThrow('service failed');
});

it('runs an Anthropic tool loop with native input_schema and tool_result messages', async () => {
  const bodies: Record<string, any>[] = [];
  const endpoint = await server(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw));
    const first = bodies.length === 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `m${bodies.length}`, type: 'message', role: 'assistant', model: 'custom-model',
      content: first ? [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { city: '杭州' } }] : [{ type: 'text', text: 'finished' }],
      stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } }));
  });
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const canonical = new Tool({ name: 'lookup', description: 'Lookup city', parameters: schema, invoke: () => 'Asia/Shanghai' });
  const agent = createAgent({ model: await model(managed(endpoint.url, 'Anthropic')), tools: tools([canonical]) });
  expect((await agent.invoke({ messages: [new HumanMessage('Timezone?')] })).messages.at(-1)!.content).toBe('finished');
  expect(bodies).toHaveLength(2); expect(bodies[0]!.tools[0]).toMatchObject({ name: 'lookup', input_schema: schema });
  expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Asia/Shanghai' }] });
  expect(canonical.parameters).toEqual(schema); expect(Object.getOwnPropertyNames(canonical.parameters)).not.toContain('__absolute_uri__');
});

it('allows explicit native Responses and preserves unsupported backend errors without fallback', async () => {
  const paths: string[] = [];
  const endpoint = await server((req, res) => {
    paths.push(req.url!); res.statusCode = 400; res.setHeader('content-type', 'application/json');
    res.end('{"error":{"message":"model does not support responses","type":"invalid_request_error"}}');
  });
  await expect((await model(managed(endpoint.url), { useResponsesApi: true })).invoke('Hello')).rejects.toThrow('model does not support responses');
  expect(paths).toEqual(['/model-connection/mc-1/v1/responses']);
});

it('borrows ModelClient dynamic credentials and lifetime without reading YAML', async () => {
  const headers: (string | undefined)[] = []; let key = 'first';
  const endpoint = await server((req, res) => { headers.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chat())); });
  const client = ModelClient.direct({ model: 'direct', baseURL: endpoint.url + '/v1', apiKeyProvider: () => key }); clients.push(client);
  const native = await model(client, { streaming: false });
  await native.invoke('one'); key = 'second'; await native.invoke('two');
  expect(headers).toEqual(['Bearer first', 'Bearer second']);
  client.close(); await expect(native.invoke('closed')).rejects.toThrow(); expect(headers).toHaveLength(2);
});

it('applies ModelClient timeout and caller cancellation to framework requests', async () => {
  const endpoint = await server(() => {});
  const client = ModelClient.direct({ model: 'slow', baseURL: endpoint.url + '/v1', timeoutMs: 30 }); clients.push(client);
  await expect((await model(client)).invoke('timeout')).rejects.toThrow();
  const other = ModelClient.direct({ model: 'slow', baseURL: endpoint.url + '/v1' }); clients.push(other);
  await expect((await model(other)).invoke('cancel', { signal: AbortSignal.timeout(30) })).rejects.toThrow();
});
