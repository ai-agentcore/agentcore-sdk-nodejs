import { afterEach, expect, it } from 'vitest';
import { createAgent, tool } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AgentCore, AccessKeyCredential } from '../src';
import { agentCoreMemoryMiddleware } from '../src/integrations/langchain';
import { httpServer } from './helpers';

const cores: AgentCore[] = []; const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
afterEach(async () => { await Promise.all(cores.splice(0).map((c) => c.close())); await Promise.all(servers.splice(0).map((s) => s.close())); });

class ScriptedModel extends BaseChatModel {
  inputs: BaseMessage[][] = [];
  constructor(private readonly answers: AIMessage[] = [new AIMessage('Try coffee.')]) { super({}); }
  _llmType() { return 'memory-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push(messages);
    const message = this.answers.shift() ?? new AIMessage('Second answer.');
    return { generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }] };
  }
}

async function setup(status = 200) {
  const requests: Array<{ action: string; body: Record<string, unknown> }> = [];
  const endpoint = await httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const action = String(req.headers['x-acs-action']); requests.push({ action, body: JSON.parse(new URLSearchParams(raw).get('body')!) });
    res.setHeader('content-type', 'application/json'); res.statusCode = status;
    res.end(status !== 200 ? '{"Code":"Forbidden","RequestId":"memory-test-id"}' : JSON.stringify(action === 'SearchMemories'
      ? { success: true, data: { memories: [{ memory: { memoryId: 'm', content: { text: 'User likes coffee' }, scope: {} }, score: 1, similarity: 1 }] } }
      : { success: true, data: { memoryIds: ['written'] } }));
  }); servers.push(endpoint);
  const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url, accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }) }); cores.push(core);
  return { core, requests };
}
const scopes = { read: { agentId: 'agent' }, write: { agentId: 'agent', sessionId: 'session' } };

it.each([{ userId: 'user' }, { sessionId: 'session' }, { agentId: 'agent' }])('preserves independent scopes through middleware state and write-back: %j', async (scope) => {
  const { core, requests } = await setup();
  const model = new ScriptedModel();
  const agent = createAgent({ model, middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), {
    scopeResolver: () => ({ read: scope, write: scope }), writeBack: true,
  })] });
  await agent.invoke({ messages: [new HumanMessage('Drink?')] });
  expect(requests.map(r => r.action)).toEqual(['SearchMemories', 'AddMemories']);
  expect(requests[0]!.body.scope).toEqual(scope);
  expect(requests[1]!.body).toEqual({ scope, messages: [{ role: 'user', content: 'Drink?' }, { role: 'assistant', content: 'Try coffee.' }] });
  expect(String(model.inputs[0]![0]!.content)).toContain('User likes coffee');
});

it('runs createAgent through tools and records only fresh user input and the final answer', async () => {
  const { core, requests } = await setup();
  const model = new ScriptedModel([
    new AIMessage({ content: '', tool_calls: [{ name: 'lookup', args: {}, id: 'call-1' }] }), new AIMessage('Try coffee.'),
  ]);
  const system = new SystemMessage({ id: 'system-id', content: [{ type: 'text', text: 'Original instruction' }], additional_kwargs: { preserved: true } });
  const agent = createAgent({ model, systemPrompt: system,
    tools: [tool(() => 'Private tool output', { name: 'lookup', description: 'Look up', schema: z.object({}) })],
    middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), {
      contextSchema: z.object({ read: z.object({ agentId: z.string() }), write: z.object({ agentId: z.string(), sessionId: z.string() }) }),
      scopeResolver: (context) => context, writeBack: true,
    })],
    checkpointer: new MemorySaver(),
  });
  const result = await agent.invoke({ messages: [new HumanMessage('Old question'), new AIMessage('Old answer'), new HumanMessage('Drink?')] }, { context: scopes, configurable: { thread_id: 'test' } });
  expect(requests.map((r) => r.action)).toEqual(['SearchMemories', 'AddMemories']);
  expect(requests[0]!.body).toEqual({ query: 'Drink?', scope: scopes.read, topK: 5 });
  expect(requests[1]!.body).toEqual({ scope: scopes.write, messages: [{ role: 'user', content: 'Drink?' }, { role: 'assistant', content: 'Try coffee.' }] });
  expect(model.inputs).toHaveLength(2);
  for (const input of model.inputs) {
    const injected = input[0]!;
    expect(injected.id).toBe('system-id'); expect(injected.additional_kwargs).toEqual({ preserved: true });
    expect(JSON.stringify(injected.content)).toContain('User likes coffee'); expect(injected.content).toHaveLength(2);
  }
  expect(system.content).toHaveLength(1);
  expect(JSON.stringify(result.messages)).not.toContain('User likes coffee');
  expect(result.agentcoreMemoryText).toBe(''); expect(result.agentcoreMemoryInput).toEqual([]); expect(result.agentcoreMemoryWriteScope).toBeNull();
  await agent.invoke({ messages: [new HumanMessage('Another question')] }, { context: { read: { agentId: 'other' }, write: { agentId: 'other', sessionId: 'another' } }, configurable: { thread_id: 'test' } });
  expect(requests[2]!.body.query).toBe('Another question');
  expect(requests[3]!.body).toEqual({ scope: { agentId: 'other', sessionId: 'another' }, messages: [{ role: 'user', content: 'Another question' }, { role: 'assistant', content: 'Second answer.' }] });
});

it('is read-only by default and extracts only text blocks from trailing human messages', async () => {
  const { core, requests } = await setup(); const model = new ScriptedModel();
  const agent = createAgent({ model, middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => ({ read: scopes.read }) })] });
  await agent.invoke({ messages: [new HumanMessage('First'), new HumanMessage({ content: [{ type: 'text', text: 'Second' }, { type: 'image_url', image_url: 'data:image/png;base64,a' }] })] });
  expect(requests).toHaveLength(1); expect(requests[0]!.body.query).toBe('First\nSecond');
});

it.each([new AIMessage('Continuation'), new ToolMessage({ content: 'Tool result', tool_call_id: 'old' })])('does not treat assistant/tool-ended history as a new turn', async (last) => {
  const { core, requests } = await setup();
  const agent = createAgent({ model: new ScriptedModel(), middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true })] });
  await agent.invoke({ messages: [new HumanMessage('Old'), last] });
  expect(requests).toHaveLength(0);
});

it.each(['length', 'max_tokens'])('does not record a truncated answer (%s)', async (finish_reason) => {
  const { core, requests } = await setup();
  const agent = createAgent({ model: new ScriptedModel([new AIMessage({ content: 'partial', response_metadata: { finish_reason } })]),
    middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true })] });
  await agent.invoke({ messages: [new HumanMessage('Question')] });
  expect(requests.map((r) => r.action)).toEqual(['SearchMemories']);
});

it('tolerates Memory service failures but not an invalid application scope', async () => {
  const { core, requests } = await setup(403); const model = new ScriptedModel();
  const agent = createAgent({ model, middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true })] });
  const result = await agent.invoke({ messages: [new HumanMessage('Question')] });
  expect(result.messages.at(-1)!.content).toBe('Try coffee.'); expect(requests).toHaveLength(2);
  const invalid = createAgent({ model, middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => ({ read: scopes.read }), writeBack: true })] });
  await expect(invalid.invoke({ messages: [new HumanMessage('Question')] })).rejects.toThrow('scope requires');
  expect(requests).toHaveLength(2); expect(model.inputs).toHaveLength(1);
});

it('does not record an unfinished turn when the model fails', async () => {
  const { core, requests } = await setup();
  class FailingModel extends ScriptedModel {
    override async _generate(): Promise<never> { throw new Error('model unavailable'); }
  }
  const agent = createAgent({ model: new FailingModel(), middleware: [agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => scopes, writeBack: true })] });
  await expect(agent.invoke({ messages: [new HumanMessage('Question')] })).rejects.toThrow('model unavailable');
  expect(requests.map((r) => r.action)).toEqual(['SearchMemories']);
});
