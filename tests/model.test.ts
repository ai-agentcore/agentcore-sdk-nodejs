import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelClient, modelBaseURL } from '../src/model/client';
import { parseAgentConfigMapping } from '../src/runtime/config';
import { InvocationError } from '../src/errors';
import type { ModelDescriptor } from '../src/controlplane/client';
import { configMapping, httpServer } from './helpers';

const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const clients: ModelClient[] = [];
afterEach(async () => { clients.splice(0).forEach((c) => c.close()); await Promise.all(servers.splice(0).map((s) => s.close())); });
async function server(handler: Parameters<typeof httpServer>[0]) { const result = await httpServer(handler); servers.push(result); return result; }
const descriptor = (protocol = 'OpenAI/v1'): ModelDescriptor => ({ connectionId: 'mc-1', connectionName: 'test-mc', modelId: 'm-1', modelName: 'model-not-in-a-catalog', protocol, providerType: 'custom', maxTokens: 8192, capabilities: {} });
function managed(url: string, protocol = 'OpenAI/v1') {
  const value = configMapping(); value.spec.model.gatewayUrl = `${url}/model-connection`;
  const model = ModelClient.platform(parseAgentConfigMapping(value), descriptor(protocol)); clients.push(model); return model;
}
const messages = [{ role: 'user', content: 'hello' }];

describe('native OpenAI model', () => {
  it('normalizes gateway prefixes and sends the resolved model with Consumer auth', async () => {
    const calls: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
    const endpoint = await server((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        calls.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'chat-1', choices: [{ message: { role: 'assistant', content: 'hello' } }] }));
      });
    });
    const model = managed(endpoint.url); const result = await model.completion(messages, { temperature: 0.5 });
    expect(result.id).toBe('chat-1'); expect(calls).toEqual([{ path: '/model-connection/mc-1/v1/chat/completions', authorization: 'Bearer consumer-secret', body: { messages, model: 'model-not-in-a-catalog', stream: false, temperature: 0.5 } }]);
    for (const prefix of ['', '/v1', '/model-connection', '/model-connection/v1']) expect(modelBaseURL(endpoint.url + prefix, 'mc-1', 'OpenAI/v1')).toBe(`${endpoint.url}/model-connection/mc-1/v1`);
  });
  it('preserves native streamed chat chunks and Responses events for unknown model names', async () => {
    const paths: string[] = [];
    const endpoint = await server((req, res) => {
      paths.push(req.url!); res.setHeader('content-type', 'text/event-stream');
      if (req.url!.endsWith('/responses')) res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"response text"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n');
      else res.end('data: {"id":"chat","choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
    });
    const model = managed(endpoint.url);
    const chunks = []; for await (const chunk of model.stream(messages)) chunks.push(chunk);
    const events = []; for await (const event of model.responsesStream('hello')) events.push(event);
    expect(chunks).toHaveLength(1); expect(events.map((event) => event.type)).toEqual(['response.output_text.delta', 'response.completed']);
    expect(paths).toEqual(['/model-connection/mc-1/v1/chat/completions', '/model-connection/mc-1/v1/responses']);
  });
  it('supports Responses JSON, while managed embedding remains unsupported', async () => {
    const endpoint = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"id":"response-1"}'); });
    const model = managed(endpoint.url);
    expect((await model.responses('hello')).id).toBe('response-1');
    await expect(model.embedding('hello')).rejects.toThrow('does not publish Embedding');
    await expect(model.completion(messages, { model: 'override' })).rejects.toThrow('reserved');
  });
  it('does not follow redirects or retry a model error', async () => {
    let calls = 0; let targetCalls = 0;
    const target = await server((_req, res) => { targetCalls++; res.end('{}'); });
    const endpoint = await server((_req, res) => { calls++; res.statusCode = 307; res.setHeader('Location', target.url); res.end('{}'); });
    await expect(managed(endpoint.url).completion(messages)).rejects.toBeInstanceOf(InvocationError);
    expect(calls).toBe(1); expect(targetCalls).toBe(0);
  });
  it('aborts the HTTP stream when the consumer stops iterating', async () => {
    let disconnected = false;
    const endpoint = await server((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n'); res.on('close', () => { disconnected = true; }); });
    for await (const _event of managed(endpoint.url).stream(messages)) break;
    await sleep(30); expect(disconnected).toBe(true);
  });
});

describe('native Anthropic model', () => {
  it('uses /v1/messages and Bearer Consumer, lifting system messages and applying max_tokens', async () => {
    let request: Record<string, unknown> | undefined; let path: string | undefined; let auth: string | undefined; let apiKey: string | undefined;
    const endpoint = await server((req, res) => {
      path = req.url; auth = req.headers.authorization; apiKey = req.headers['x-api-key'] as string | undefined;
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { request = JSON.parse(body) as Record<string, unknown>; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'anthropic-1', type: 'message', content: [{ type: 'text', text: 'hello' }] })); });
    });
    const result = await managed(endpoint.url, 'Anthropic').completion([{ role: 'system', content: 'one' }, { role: 'system', content: 'two' }, ...messages]);
    expect(result.id).toBe('anthropic-1'); expect(path).toBe('/model-connection/mc-1/v1/messages');
    expect(auth).toBe('Bearer consumer-secret'); expect(apiKey).toBeUndefined();
    expect(request).toMatchObject({ system: 'one\n\ntwo', max_tokens: 8192, messages });
  });
  it('passes native Anthropic SSE events and rejects unavailable Responses API', async () => {
    const endpoint = await server((_req, res) => {
      res.setHeader('content-type', 'text/event-stream'); res.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const model = managed(endpoint.url, 'Anthropic'); const events = [];
    for await (const event of model.stream(messages)) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['content_block_delta', 'message_stop']);
    await expect(model.responses('hello')).rejects.toThrow('does not publish Responses');
  });
});

it('direct models do not need runtime configuration and resolve credentials at each actual request', async () => {
  const auth: Array<string | undefined> = []; let key = 'first';
  const endpoint = await server((req, res) => { auth.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end(req.url!.endsWith('/embeddings') ? '{"data":[{"embedding":[1,2]}]}' : '{"id":"direct"}'); });
  const model = ModelClient.direct({ model: 'direct-model', baseURL: endpoint.url + '/v1', apiKeyProvider: async () => key }); clients.push(model);
  await model.completion(messages); key = 'second'; await model.responses('hello'); await model.embedding('hello', { encoding_format: 'float' });
  expect(auth).toEqual(['Bearer first', 'Bearer second', 'Bearer second']);
});

it('direct Anthropic uses the user API key, not Consumer Bearer', async () => {
  let key: string | undefined;
  const endpoint = await server((req, res) => { key = req.headers['x-api-key'] as string; res.setHeader('content-type', 'application/json'); res.end('{"id":"direct-anthropic"}'); });
  const model = ModelClient.direct({ model: 'claude', provider: 'anthropic', baseURL: endpoint.url, apiKey: 'user-key' }); clients.push(model);
  await model.completion(messages, { max_tokens: 100 }); expect(key).toBe('user-key');
});
