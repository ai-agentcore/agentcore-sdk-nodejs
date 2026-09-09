import { afterEach, expect, it } from 'vitest';
import { generateText, stepCountIs, streamText } from 'ai';
import { languageModel, tools } from '../src/integrations/ai-sdk';
import { ModelClient } from '../src/model/client';
import { Tool } from '../src/integrations/common';
import { parseAgentConfigMapping } from '../src/runtime/config';
import { configMapping, httpServer } from './helpers';

const servers: Awaited<ReturnType<typeof httpServer>>[] = [];
const clients: ModelClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function server(handler: Parameters<typeof httpServer>[0]) {
  const result = await httpServer(handler); servers.push(result); return result;
}
function managed(url: string, protocol = 'OpenAI/v1') {
  const config = configMapping(); config.spec.model.gatewayUrl = url + '/model-connection';
  const client = ModelClient.platform(parseAgentConfigMapping(config), {
    connectionId: 'mc-1', connectionName: 'test-mc', modelId: 'm-1',
    modelName: 'custom-model', protocol, providerType: 'custom', maxTokens: 1024, capabilities: {},
  });
  clients.push(client); return client;
}
const chat = (content = 'hello') => ({ id: 'chat-1', object: 'chat.completion', created: 1, model: 'custom-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });

it('executes a real AI SDK model/tool loop with Consumer auth and original tool schema', async () => {
  const requests: Record<string, any>[] = []; const headers: (string | undefined)[] = [];
  const endpoint = await server((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      requests.push(JSON.parse(body)); headers.push(req.headers.authorization);
      expect(req.url).toBe('/model-connection/mc-1/v1/chat/completions');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(requests.length === 1 ? { ...chat(), choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"city":"杭州"}' } }] } }] } : chat('finished')));
    });
  });
  const calls: unknown[] = [];
  const toolkit = tools([new Tool({ name: 'lookup', description: 'Lookup city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }, invoke: (args) => { calls.push(args); return { timezone: 'Asia/Shanghai' }; } })]);
  const result = await generateText({ model: languageModel(managed(endpoint.url)), prompt: 'Find timezone', tools: toolkit, stopWhen: stepCountIs(3), maxRetries: 0 });
  expect(result.text).toBe('finished'); expect(result.steps).toHaveLength(2);
  expect(calls).toEqual([{ city: '杭州' }]); expect(headers).toEqual(['Bearer consumer-secret', 'Bearer consumer-secret']);
  expect(requests[0]).toMatchObject({ model: 'custom-model', max_tokens: 1024, tools: [{ function: { name: 'lookup', parameters: { required: ['city'], additionalProperties: false } } }] });
  expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: 'tool', content: '{"timezone":"Asia/Shanghai"}' }));
});

it('uses real chat SSE for arbitrary model names', async () => {
  const endpoint = await server((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (const delta of [{ content: 'one' }, { content: 'two' }]) res.write(`data: ${JSON.stringify({ id: 's1', model: 'custom-model', created: 1, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 's1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const chunks: string[] = [];
  const result = streamText({ model: languageModel(managed(endpoint.url)), prompt: 'hello', maxRetries: 0 });
  for await (const text of result.textStream) chunks.push(text);
  expect(chunks).toEqual(['one', 'two']); expect(await result.finishReason).toBe('stop');
});

it('selects Responses explicitly and preserves backend unsupported errors', async () => {
  const endpoint = await server((req, res) => {
    expect(req.url).toBe('/model-connection/mc-1/v1/responses');
    res.setHeader('content-type', 'application/json');
    res.statusCode = 400; res.end('{"error":{"message":"model does not support responses","type":"invalid_request_error","code":"unsupported_model"}}');
  });
  await expect(generateText({ model: languageModel(managed(endpoint.url), { api: 'responses' }), prompt: 'hello', maxRetries: 0 })).rejects.toThrow('model does not support responses');
});

it('consumes Responses JSON and SSE using the native provider', async () => {
  const item = { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'response text', annotations: [] }] };
  const endpoint = await server((req, res) => {
    let data = ''; req.on('data', (chunk) => { data += chunk; }); req.on('end', () => {
      const body = JSON.parse(data); expect(body.model).toBe('custom-model');
      if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'r1', created_at: 1, model: 'custom-model', output: [item], usage: { input_tokens: 2, output_tokens: 1 } })); return; }
      res.setHeader('content-type', 'text/event-stream');
      const events = [
        { type: 'response.created', response: { id: 'r1', model: 'custom-model', created_at: 1 } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'response text', output_index: 0, content_index: 0 },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } },
      ];
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  const model = languageModel(managed(endpoint.url), { api: 'responses' });
  expect((await generateText({ model, prompt: 'hello', maxRetries: 0 })).text).toBe('response text');
  const result = streamText({ model, prompt: 'hello', maxRetries: 0 }); const chunks = [];
  for await (const text of result.textStream) chunks.push(text);
  expect(chunks).toEqual(['response text']); expect(await result.finishReason).toBe('stop');
});

it('uses Anthropic protocol with Consumer auth and respects explicit output limits', async () => {
  let body: Record<string, unknown> | undefined;
  const endpoint = await server((req, res) => {
    expect(req.url).toBe('/model-connection/mc-1/v1/messages');
    expect(req.headers.authorization).toBe('Bearer consumer-secret'); expect(req.headers['x-api-key']).toBeUndefined();
    let data = ''; req.on('data', (chunk) => { data += chunk; }); req.on('end', () => {
      body = JSON.parse(data); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'msg-1', type: 'message', role: 'assistant', model: 'custom-model', content: [{ type: 'text', text: 'anthropic' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } }));
    });
  });
  const client = managed(endpoint.url, 'Anthropic');
  const result = await generateText({ model: languageModel(client), prompt: 'hello', maxOutputTokens: 50, maxRetries: 0 });
  expect(result.text).toBe('anthropic'); expect(body).toMatchObject({ model: 'custom-model', max_tokens: 50 });
  expect(() => languageModel(client, { api: 'responses' })).toThrow('Responses');
});

it('shares dynamic credentials, Request headers and close lifecycle with the native client', async () => {
  const auth: (string | undefined)[] = []; const custom: unknown[] = [];
  const endpoint = await server((req, res) => {
    auth.push(req.headers.authorization); custom.push(req.headers['x-custom']);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chat()));
  });
  let key = 'first'; const client = ModelClient.direct({ model: 'direct', baseURL: endpoint.url + '/v1', apiKeyProvider: () => key }); clients.push(client);
  const model = languageModel(client);
  await generateText({ model, prompt: 'one', maxRetries: 0 }); key = 'second';
  await generateText({ model, prompt: 'two', maxRetries: 0 });
  await client.httpFetch(new Request(endpoint.url + '/v1/chat/completions', { method: 'POST', body: '{}', headers: { 'x-custom': 'kept', authorization: 'discarded' } }));
  expect(auth).toEqual(['Bearer first', 'Bearer second', 'Bearer second']); expect(custom[2]).toBe('kept');
  client.close(); await expect(generateText({ model, prompt: 'closed', maxRetries: 0 })).rejects.toThrow(); expect(auth).toHaveLength(3);
});

it('applies the client timeout to framework calls and rejects duplicate tool names', async () => {
  const endpoint = await server(() => {});
  const client = ModelClient.direct({ model: 'slow', baseURL: endpoint.url + '/v1', timeoutMs: 30 }); clients.push(client);
  await expect(generateText({ model: languageModel(client), prompt: 'hello', maxRetries: 0 })).rejects.toThrow();
  const item = new Tool({ name: 'same', description: '', parameters: { type: 'object', properties: {} }, invoke: () => '' });
  expect(() => tools([item, item])).toThrow('duplicate');
});

it('forwards an explicit output schema instead of silently degrading to JSON mode', async () => {
  const bodies: Record<string, unknown>[] = [];
  const endpoint = await server(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw));
    res.statusCode = 400; res.setHeader('content-type', 'application/json');
    res.end('{"error":{"message":"structured output unsupported by this model"}}');
  });
  const schema = { type: 'object' as const, properties: { city: { type: 'string' as const } }, required: ['city'] };
  await expect(languageModel(managed(endpoint.url)).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'City?' }] }],
    responseFormat: { type: 'json', schema },
  })).rejects.toThrow('structured output unsupported');
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema } });
});
