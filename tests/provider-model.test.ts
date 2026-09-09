import { afterEach, expect, it } from 'vitest';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, stepCountIs } from 'ai';
import { Agent } from '@mastra/core/agent';
import { createAgent } from 'langchain';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { model as chainModel, tools as chainTools } from '../src/integrations/langchain';
import { model as graphModel } from '../src/integrations/langgraph';
import { AgentCore, Tool } from '../src';
import { languageModel, tools } from '../src/integrations/ai-sdk';
import { model as mastraModel } from '../src/integrations/mastra';
import { model as adkModel } from '../src/integrations/google-adk';
import { httpServer } from './helpers';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const item of input) out.push(item); return out; }
async function fixture(options: { toolLoop?: boolean; status?: number; stall?: boolean; timeoutMs?: number; grounding?: boolean } = {}) {
  const requests: { url: string; key: unknown; body: any }[] = [];
  let received!: () => void; const firstRequest = new Promise<void>(resolve => { received = resolve; });
  let disconnected!: () => void; const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const endpoint = await httpServer(async (req, res) => {
    res.on('close', disconnected);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: req.url!, key: req.headers['x-goog-api-key'], body }); received();
    res.setHeader('content-type', 'application/json');
    if (options.status) { res.statusCode = options.status; res.end(JSON.stringify({ error: { code: options.status, message: 'provider rejected', status: 'UNAVAILABLE' } })); return; }
    if (req.url!.includes(':batchEmbedContents')) { res.end(JSON.stringify({ embeddings: body.requests.map(() => ({ values: [1, 2, 3] })) })); return; }
    if (req.url!.includes(':embedContent')) { res.end('{"embedding":{"values":[1,2,3]}}'); return; }
    const call = options.toolLoop && !body.contents.some((c: any) => c.parts.some((p: any) => p.functionResponse));
    const value = { responseId: 'r1', candidates: [{ content: { role: 'model', parts: call
      ? [{ text: 'Check the city.', thought: true, thoughtSignature: 'reason-signature' }, { functionCall: { name: body.tools[0].functionDeclarations[0].name, args: { city: '杭州' } }, thoughtSignature: 'fixture-signature' }] : [{ text: 'Google result' }] }, finishReason: 'STOP',
      ...(options.grounding ? { groundingMetadata: { groundingChunks: [{ web: { uri: 'https://docs.example/page', title: 'Document' } }] } } : {}) }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } };
    if (req.url!.includes(':streamGenerateContent')) {
      res.setHeader('content-type', 'text/event-stream'); res.write(`data: ${JSON.stringify(value)}\n\n`);
      if (!options.stall) res.end(); return;
    }
    if (!options.stall) res.end(JSON.stringify(value));
  }); cleanup.push(() => endpoint.close());
  const core = new AgentCore(); cleanup.push(() => core.close());
  const provider = createGoogleGenerativeAI({ baseURL: endpoint.url + '/v1beta', apiKey: 'local-test-key' });
  const client = core.directModel({ languageModel: provider('gemini-test'), embeddingModel: provider.embeddingModel('embedding-test'), timeoutMs: options.timeoutMs });
  return { core, client, requests, firstRequest, closed };
}

it('runs a non-OpenAI provider through Core without runtime configuration', async () => {
  const env = await fixture();
  const result = await env.client.invoke([{ role: 'user', content: 'hello' }], { temperature: 0.2, maxOutputTokens: 50 });
  expect(result.text).toBe('Google result'); expect(result.usage.totalTokens).toBe(5);
  expect(env.requests).toHaveLength(1);
  expect(env.requests[0]).toMatchObject({ url: '/v1beta/models/gemini-test:generateContent', key: 'local-test-key',
    body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 50 } } });
  expect(JSON.stringify(env.client)).not.toContain('local-test-key');
});

it.each([false, true])('executes provider tool loops (stream=%s) without translating tool results by hand', async streaming => {
  const env = await fixture({ toolLoop: true }); const calls: unknown[] = [];
  const toolkit = tools([new Tool({ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    invoke: args => { calls.push(args); return { timezone: 'Asia/Shanghai' }; } })]);
  const parameters = { tools: toolkit, stopWhen: stepCountIs(3) };
  if (streaming) {
    const parts = await collect(env.client.stream([{ role: 'user', content: 'lookup' }], parameters));
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Google result');
    expect(parts.some(p => p.type === 'tool-result')).toBe(true);
  } else expect((await env.client.completion([{ role: 'user', content: 'lookup' }], parameters)).text).toBe('Google result');
  expect(calls).toEqual([{ city: '杭州' }]); expect(env.requests).toHaveLength(2);
  expect(JSON.stringify(env.requests[1]!.body.contents)).toContain('Asia/Shanghai');
  expect(JSON.stringify(env.requests[1]!.body.contents)).toContain('fixture-signature');
});

it('uses the explicitly configured embedding model for single and batch input', async () => {
  const env = await fixture();
  expect((await env.client.embedding('one')).embeddings).toEqual([[1, 2, 3]]);
  expect((await env.client.embedding(['one', 'two'])).embeddings).toEqual([[1, 2, 3], [1, 2, 3]]);
  expect(env.requests.map(r => r.url)).toEqual(['/v1beta/models/embedding-test:embedContent', '/v1beta/models/embedding-test:batchEmbedContents']);
});

it.each([false, true])('propagates provider errors without implicit retries (stream=%s)', async streaming => {
  const env = await fixture({ status: 503 });
  await expect(streaming ? collect(env.client.stream([{ role: 'user', content: 'hello' }]))
    : env.client.invoke([{ role: 'user', content: 'hello' }])).rejects.toThrow('provider rejected');
  expect(env.requests).toHaveLength(1);
});

it('cancels the real provider stream when the consumer stops iterating', async () => {
  const env = await fixture({ stall: true });
  for await (const part of env.client.stream([{ role: 'user', content: 'hello' }])) if (part.type === 'text-delta') break;
  await env.closed; expect(env.requests).toHaveLength(1);
});

it('applies timeouts and caller cancellation to actual HTTP requests', async () => {
  const timed = await fixture({ stall: true, timeoutMs: 50 });
  await expect(timed.client.invoke([{ role: 'user', content: 'hello' }])).rejects.toThrow();
  const env = await fixture({ stall: true }); const abort = new AbortController();
  const request = env.client.invoke([{ role: 'user', content: 'hello' }], {}, { signal: abort.signal });
  const assertion = expect(request).rejects.toThrow(); await env.firstRequest; abort.abort(); await assertion; await env.closed;
});

it('Core close cancels in-flight framework requests and disallows later requests', async () => {
  const env = await fixture({ stall: true }); const adapted = languageModel(env.client);
  const request = generateText({ model: adapted, prompt: 'hello', maxRetries: 0 });
  const assertion = expect(request).rejects.toThrow(); await env.firstRequest; await env.core.close(); await assertion;
  await expect(generateText({ model: adapted, prompt: 'again', maxRetries: 0 })).rejects.toThrow();
  expect(env.requests).toHaveLength(1);
});

it('runs the configured provider through Mastra and ADK adapters', async () => {
  const env = await fixture();
  const agent = new Agent({ id: 'provider-agent', name: 'provider-agent', instructions: 'Answer', model: await mastraModel(env.client) });
  expect((await agent.generate('hello', { modelSettings: { maxRetries: 0 } })).text).toBe('Google result');
  const adk = await adkModel(env.client);
  const events = await collect(adk.generateContentAsync({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], toolsDict: {}, liveConnectConfig: {} }));
  expect(events.at(-1)?.content?.parts).toContainEqual({ text: 'Google result' });
  expect(env.requests).toHaveLength(2);
});

it.each([false, true])('runs a LangChain Agent with provider tools and preserved signature (stream=%s)', async streaming => {
  const env = await fixture({ toolLoop: true }); let calls = 0;
  const toolkit = chainTools([new Tool({ name: 'lookup', description: 'Lookup a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    invoke: args => { expect(args).toEqual({ city: '杭州' }); calls++; return { timezone: 'Asia/Shanghai' }; } })]);
  const native = await chainModel(env.client, { maxOutputTokens: 128, temperature: 0.2 });
  const agent = createAgent({ model: native, tools: toolkit });
  const input = { messages: [new HumanMessage('hello')] }; let text: string;
  if (streaming) {
    const parts = await collect(await agent.stream(input, { streamMode: 'messages' }));
    text = parts.map(([message]) => message.text).join('');
    expect(parts.some(([message]) => AIMessageChunk.isInstance(message) && message.tool_calls?.length)).toBe(true);
  } else text = (await agent.invoke(input)).messages.at(-1)!.text;
  expect(text).toContain('Google result'); expect(calls).toBe(1); expect(env.requests).toHaveLength(2);
  expect(env.requests[0]!.body).toMatchObject({ generationConfig: { maxOutputTokens: 128, temperature: 0.2 } });
  expect(JSON.stringify(env.requests[1]!.body.contents)).toContain('fixture-signature');
  expect(JSON.stringify(env.requests[1]!.body.contents)).toContain('Asia/Shanghai');
  expect(JSON.stringify(env.requests[1]!.body.contents)).toContain('reason-signature');
});

it('runs a LangGraph node, LangChain callbacks, and per-call generation options', async () => {
  const env = await fixture(); const native = await graphModel(env.client, { temperature: 0.1 }); const tokens: string[] = [];
  const graph = new StateGraph(MessagesAnnotation).addNode('reply', async state => ({ messages: [await native.invoke(state.messages)] }))
    .addEdge(START, 'reply').addEdge('reply', END).compile();
  expect((await graph.invoke({ messages: [new HumanMessage('hello')] })).messages.at(-1)!.text).toBe('Google result');
  const chunks = await collect(await native.stream('hello', { temperature: 0.4, stop: ['END'], callbacks: [{ handleLLMNewToken: token => { tokens.push(token); } }] }));
  const message = chunks.reduce((a, b) => a.concat(b));
  expect(message.text).toBe('Google result'); expect(message.usage_metadata).toMatchObject({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  expect(tokens.join('')).toBe('Google result'); expect(env.requests[1]!.body.generationConfig).toMatchObject({ temperature: 0.4, stopSequences: ['END'] });
});

it('retains LangChain structured output through the native bindTools contract', async () => {
  const env = await fixture({ toolLoop: true }); const native = await chainModel(env.client);
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const result = await native.withStructuredOutput(schema, { name: 'extract_city' }).invoke('city?');
  expect(result).toEqual({ city: '杭州' });
  expect(env.requests[0]!.body.tools[0].functionDeclarations[0].name).toBe('extract_city');
});

it('sends LangChain inline images as native Google media parts', async () => {
  const env = await fixture(); const native = await chainModel(env.client);
  await native.invoke([new HumanMessage({ content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: 'data:image/png;base64,AQID' }] })]);
  expect(env.requests[0]!.body.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'AQID' } });
});

it('cancels a LangChain provider stream on consumer exit and obeys Core close', async () => {
  const env = await fixture({ stall: true }); const native = await chainModel(env.client);
  for await (const chunk of await native.stream('hello')) if (chunk.text) break;
  await env.closed; await env.core.close();
  await expect(native.invoke('closed')).rejects.toThrow(); expect(env.requests).toHaveLength(1);
});

it.each([false, true])('does not retry or hide provider errors in LangChain (stream=%s)', async streaming => {
  const env = await fixture({ status: 503 }); const native = await chainModel(env.client);
  await expect(streaming ? (async () => collect(await native.stream('hello')))() : native.invoke('hello')).rejects.toThrow('provider rejected');
  expect(env.requests).toHaveLength(1);
});

it.each([false, true])('keeps grounding sources as response metadata across conversation turns (stream=%s)', async streaming => {
  const env = await fixture({ grounding: true }); const native = await chainModel(env.client);
  const answer = streaming ? (await collect(await native.stream('hello'))).reduce((a, b) => a.concat(b)) : await native.invoke('hello');
  expect(answer.response_metadata.sources).toContainEqual(expect.objectContaining({ type: 'source', url: 'https://docs.example/page' }));
  await native.invoke([new HumanMessage('hello'), answer, new HumanMessage('continue')]);
  expect(env.requests).toHaveLength(2);
});
