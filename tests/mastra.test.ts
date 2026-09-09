import { afterEach, expect, it } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { Tool as MastraTool } from '@mastra/core/tools';
import { AgentCore, AccessKeyCredential } from '../src';
import { Tool } from '../src/integrations/common';
import { AgentCoreMemoryProcessor, model, tools } from '../src/integrations/mastra';
import { httpServer } from './helpers';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(options: { memoryStatus?: number; modelStatus?: number; finishReason?: string; toolLoop?: boolean; stall?: boolean } = {}) {
  const requests: Array<{ action: string; body: any }> = [];
  const inputs: any[] = []; let toolCalls = 0;
  const endpoint = await httpServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-acs-action']) {
      const action = String(req.headers['x-acs-action']); const body = JSON.parse(new URLSearchParams(raw).get('body')!);
      requests.push({ action, body });
      res.statusCode = options.memoryStatus ?? 200;
      res.end(res.statusCode !== 200 ? '{"Code":"Forbidden","RequestId":"memory-test"}' : JSON.stringify(action === 'SearchMemories'
        ? { success: true, data: { memories: [{ memory: { memoryId: 'm', content: { text: `Likes coffee: ${body.scope.agentId}` }, scope: {} }, score: 1, similarity: 1 }] } }
        : { success: true, data: { memoryIds: ['saved'] } })); return;
    }
    const input = JSON.parse(raw); inputs.push(input);
    expect(req.headers.authorization).toBe('Bearer test-key'); expect(req.url).toBe('/v1/chat/completions');
    res.statusCode = options.modelStatus ?? 200;
    if (res.statusCode !== 200) { res.end('{"error":{"message":"model rejected"}}'); return; }
    const calls = options.toolLoop && !input.messages.some((m: any) => m.role === 'tool')
      ? [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"city":"杭州"}' } }] : undefined;
    const text = calls ? 'Let me check.' : 'Try coffee.';
    const finish = calls ? 'tool_calls' : options.finishReason ?? 'stop';
    if (input.stream) {
      res.setHeader('content-type', 'text/event-stream');
      if (options.stall) {
        res.write(`data: ${JSON.stringify({ id: 'r', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`); return;
      }
      res.end(`data: ${JSON.stringify({ id: 'r', model: 'm', created: 1, choices: [{ index: 0, delta: { content: text, tool_calls: calls?.map((c, index) => ({ ...c, index })) }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: 'r', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    } else res.end(JSON.stringify({ id: 'r', model: 'm', created: 1, choices: [{ index: 0, message: { role: 'assistant', content: text, tool_calls: calls }, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
  }); cleanup.push(() => endpoint.close());
  const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }) }); cleanup.push(() => core.close());
  const client = core.directModel({ model: 'm', baseURL: endpoint.url + '/v1', apiKey: 'test-key' });
  const canonical = new Tool({ name: 'lookup', description: 'Look up a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    invoke: args => { expect(args).toEqual({ city: '杭州' }); toolCalls++; return { text: 'Private tool output' }; } });
  return { core, client, requests, inputs, canonical, toolCalls: () => toolCalls };
}
const scopes = { read: { agentId: 'agent' }, write: { agentId: 'agent', sessionId: 'session' } };

it('preserves a user-only scope in Mastra recall and write-back', async () => {
  const env = await setup();
  const scope = { userId: 'alice' };
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => ({ read: scope, write: scope }), writeBack: true });
  const agent = new Agent({ id: 'agent', name: 'agent', instructions: 'Answer', model: await model(env.client), inputProcessors: [memory], outputProcessors: [memory] });
  expect((await agent.generate('Drink?')).text).toBe('Try coffee.');
  expect(env.requests.map(r => r.action)).toEqual(['SearchMemories', 'AddMemories']);
  expect(env.requests.map(r => r.body.scope)).toEqual([scope, scope]);
});

it.each(['generate', 'stream'] as const)('runs Mastra %s through a native tool loop and writes only the current turn', async mode => {
  const env = await setup({ toolLoop: true });
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true });
  const agent = new Agent({ id: 'agent', name: 'agent', instructions: 'Original instruction', model: await model(env.client),
    tools: tools([env.canonical]), inputProcessors: [memory], outputProcessors: [memory] });
  const messages = [{ role: 'user' as const, content: 'Old question' }, { role: 'assistant' as const, content: 'Old answer' }, { role: 'user' as const, content: 'Drink?' }];
  const result = mode === 'generate' ? await agent.generate(messages, { maxSteps: 4, modelSettings: { maxRetries: 0 } })
    : await (await agent.stream(messages, { maxSteps: 4, modelSettings: { maxRetries: 0 } })).getFullOutput();
  expect(result.text).toContain('Try coffee.'); expect(env.toolCalls()).toBe(1); expect(env.inputs).toHaveLength(2);
  expect(env.requests.map(r => r.action)).toEqual(['SearchMemories', 'AddMemories']);
  expect(env.requests[0]!.body.query).toBe('Drink?');
  expect(env.requests[1]!.body).toEqual({ scope: scopes.write, messages: [{ role: 'user', content: 'Drink?' }, { role: 'assistant', content: 'Try coffee.' }] });
  for (const input of env.inputs) { expect(JSON.stringify(input.messages)).toContain('Likes coffee: agent'); expect(JSON.stringify(input.messages)).toContain('Original instruction'); }
  expect(JSON.stringify(result.response.messages)).not.toContain('Likes coffee: agent');
});

it('isolates simultaneous requests using native processor state and trusted RequestContext', async () => {
  const env = await setup();
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: context => {
    const agentId = context!.get('user') as string; return { read: { agentId }, write: { agentId, sessionId: agentId + '-session' } };
  }, writeBack: true });
  const agent = new Agent({ id: 'shared', name: 'shared', instructions: 'Answer', model: await model(env.client), inputProcessors: [memory], outputProcessors: [memory] });
  await Promise.all(['alice', 'bob'].map(async user => {
    const requestContext = new RequestContext(); requestContext.set('user', user);
    await agent.generate('Question from ' + user, { requestContext });
  }));
  expect(env.requests).toHaveLength(4);
  for (const input of env.inputs) {
    const user = input.messages.at(-1).content.endsWith('alice') ? 'alice' : 'bob';
    const wire = JSON.stringify(input.messages); expect(wire).toContain('Likes coffee: ' + user); expect(wire).not.toContain('Likes coffee: ' + (user === 'alice' ? 'bob' : 'alice'));
  }
  for (const { body } of env.requests.filter(r => r.action === 'AddMemories')) expect(body.messages[0].content).toBe('Question from ' + body.scope.agentId);
});

it('defaults to recall only and does not persist truncated or tool-limited runs', async () => {
  for (const [writeBack, finishReason, toolLoop] of [[false, 'stop', false], [true, 'length', false], [true, 'stop', true]] as const) {
    const env = await setup({ finishReason, toolLoop });
    const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack });
    const agent = new Agent({ id: 'agent', name: 'agent', instructions: 'Answer', model: await model(env.client), tools: tools([env.canonical]), inputProcessors: [memory], outputProcessors: [memory] });
    await agent.generate('Question', { maxSteps: 1 }); expect(env.requests.map(r => r.action)).toEqual(['SearchMemories']);
  }
});

it('keeps Memory failures best-effort but rejects invalid scopes before model execution', async () => {
  const env = await setup({ memoryStatus: 403 });
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true });
  const agent = new Agent({ id: 'agent', name: 'agent', instructions: 'Answer', model: await model(env.client), inputProcessors: [memory], outputProcessors: [memory] });
  expect((await agent.generate('Question')).text).toBe('Try coffee.'); expect(env.requests).toHaveLength(2);
  const invalid = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => ({ read: {} }) });
  const other = new Agent({ id: 'invalid', name: 'invalid', instructions: 'Answer', model: await model(env.client), inputProcessors: [invalid] });
  // Mastra wraps processor exceptions; the underlying error remains in its workflow logs.
  await expect(other.generate('Question')).rejects.toThrow('Input processor error'); expect(env.inputs).toHaveLength(1);
});

it('preserves canonical schemas and uses Mastra native tool validation', async () => {
  const env = await setup(); const converted = tools([env.canonical]);
  const lookup = converted.lookup;
  expect(lookup).toBeInstanceOf(MastraTool);
  if (!(lookup instanceof MastraTool)) throw new Error('expected native Mastra Tool');
  expect(await lookup.execute!({ city: '杭州' }, {})).toEqual({ text: 'Private tool output' });
  const rejected = await lookup.execute!({}, {});
  expect(JSON.stringify(rejected)).toContain('city'); expect(env.toolCalls()).toBe(1);
  expect(env.canonical.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
  expect(() => tools([env.canonical, env.canonical])).toThrow('duplicate tool name');
});

it('does not write a failed model turn', async () => {
  const env = await setup({ modelStatus: 400 });
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true });
  const agent = new Agent({ id: 'failed', name: 'failed', instructions: 'Answer', model: await model(env.client), inputProcessors: [memory], outputProcessors: [memory] });
  const output = await agent.stream('Question', { modelSettings: { maxRetries: 0 } });
  const parts = []; for await (const part of output.fullStream) parts.push(part);
  expect(parts.some(part => part.type === 'error')).toBe(true);
  expect(env.inputs).toHaveLength(1); expect(env.requests.map(r => r.action)).toEqual(['SearchMemories']);
});

it('does not write a cancelled partial stream or close a borrowed Core', async () => {
  const env = await setup({ stall: true });
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true });
  const agent = new Agent({ id: 'cancelled', name: 'cancelled', instructions: 'Answer', model: await model(env.client), inputProcessors: [memory], outputProcessors: [memory] });
  const abort = new AbortController();
  const output = await agent.stream('Question', { abortSignal: abort.signal, modelSettings: { maxRetries: 0 } });
  let text = '';
  for await (const part of output.fullStream) if (part.type === 'text-delta') { text += part.payload.text; abort.abort(); }
  expect(text).toBe('partial'); expect(env.requests.map(r => r.action)).toEqual(['SearchMemories']);
  // A later standalone resource operation remains usable after the framework run ends.
  await env.core.memoryStore('mem').searchMemories('Still usable', { scope: scopes.read });
  expect(env.requests.map(r => r.action)).toEqual(['SearchMemories', 'SearchMemories']);
});

it('does not ingest old input when resuming assistant-ended history', async () => {
  const env = await setup();
  const memory = new AgentCoreMemoryProcessor(env.core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true });
  const agent = new Agent({ id: 'resume', name: 'resume', instructions: 'Continue', model: await model(env.client), inputProcessors: [memory], outputProcessors: [memory] });
  await agent.generate([{ role: 'user', content: 'Old question' }, { role: 'assistant', content: 'Previous answer' }]);
  expect(env.requests).toHaveLength(0); expect(env.inputs).toHaveLength(1);
});
