import { describe, expect, it } from 'vitest';
import { streamText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool as langchainTool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { END, START, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { AgentCoreServer } from '../src/server';
import { AgentCoreConverter as LangChain } from '../src/integrations/langchain';
import { AgentCoreConverter as LangGraph } from '../src/integrations/langgraph';
import { AgentCoreConverter as ADK } from '../src/integrations/google-adk';
import { AgentCoreConverter as AISDK } from '../src/integrations/ai-sdk';
import { AgentCoreConverter as Mastra } from '../src/integrations/mastra';

function sequence(framework: string): [any, Record<string, any>[]] {
  if (framework === 'langchain' || framework === 'langgraph') return [
    framework === 'langchain' ? new LangChain() : new LangGraph(), [
      { event: 'on_chat_model_stream', run_id: 'first', data: { chunk: { content: 'checking' } } },
      { event: 'on_chat_model_end', run_id: 'first', data: { output: { content: 'checking', tool_calls: [
        { id: 'call', name: 'lookup', args: { value: 1 } }] } } },
      { event: 'on_tool_end', run_id: 'not-call', name: 'lookup', data: { output: { tool_call_id: 'call', content: 'result' } } },
      { event: 'on_chat_model_end', run_id: 'last', data: { output: { content: 'answer' } } },
    ],
  ];
  if (framework === 'adk') return [new ADK(), [
    { author: 'agent', partial: true, content: { parts: [{ text: 'checking' }] } },
    { author: 'agent', content: { parts: [{ text: 'checking' }, { functionCall: { id: 'call', name: 'lookup', args: { value: 1 } } }] } },
    { author: 'agent', content: { parts: [{ functionResponse: { id: 'call', name: 'lookup', response: 'result' } }] } },
    { author: 'agent', content: { parts: [{ text: 'answer' }] } },
  ]];
  const parts = [
    { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', text: 'checking' },
    { type: 'text-end', id: '0' },
    { type: 'tool-call', toolCallId: 'call', toolName: 'lookup', input: { value: 1 } },
    { type: 'tool-result', toolCallId: 'call', toolName: 'lookup', output: 'result' },
    { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', text: 'answer' }, { type: 'text-end', id: '0' },
  ];
  return framework === 'ai-sdk' ? [new AISDK(), parts] : [new Mastra(), parts.map(({ type, input, output, ...p }) => ({
    type, payload: { ...p, args: input, result: output },
  }))];
}

async function wire(events: any[], protocol: string) {
  const app = new AgentCoreServer({ invoke: async function* () { yield* events; } });
  const payload = protocol === 'agui' ? { threadId: 't', runId: 'r', messages: [], tools: [], context: [], state: {}, forwardedProps: {} }
    : { model: 'app', messages: [], stream: true };
  const response = await app.app.request(protocol === 'agui' ? '/ag-ui/agent' : '/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
  await app.close(); return data;
}

it('preserves parallel model identities and closes only the completed message', async () => {
  const converter = new LangChain(), events = [];
  for (const [run, text] of [['a', 'A1'], ['b', 'B1'], ['a', 'A2']]) events.push(...converter.convert({
    event: 'on_chat_model_stream', run_id: run, data: { chunk: { content: text } },
  }));
  events.push(...converter.convert({ event: 'on_chat_model_end', run_id: 'a', data: { output: { content: 'A1A2' } } }));
  events.push(...converter.convert({ event: 'on_chat_model_stream', run_id: 'b', data: { chunk: { content: 'B2' } } }));
  events.push(...converter.convert({ event: 'on_chat_model_end', run_id: 'b', data: { output: { content: 'B1B2' } } }));
  const data = await wire(events, 'agui');
  const starts = data.filter(e => e.type === 'TEXT_MESSAGE_START');
  expect(starts).toHaveLength(2);
  expect(starts.map(s => data.filter(e => e.type === 'TEXT_MESSAGE_CONTENT' && e.messageId === s.messageId)
    .map(e => e.delta).join(''))).toEqual(['A1A2', 'B1B2']);
  for (const start of starts) {
    const end = data.find(e => e.type === 'TEXT_MESSAGE_END' && e.messageId === start.messageId);
    expect(end).toBeDefined();
    for (const delta of data.filter(e => e.type === 'TEXT_MESSAGE_CONTENT' && e.messageId === start.messageId)) {
      expect(data.indexOf(delta)).toBeGreaterThan(data.indexOf(start));
      expect(data.indexOf(delta)).toBeLessThan(data.indexOf(end));
    }
  }
});

it('forwards an actual ToolNode handled error once, without replaying history', async () => {
  const lookup = langchainTool(async () => { throw new Error('lookup failed'); }, {
    name: 'lookup', description: 'Lookup', schema: z.object({ value: z.number() }),
  });
  const call = { id: 'failed-call', name: 'lookup', args: { value: 1 }, type: 'tool_call' as const };
  const node = new ToolNode([lookup], { handleToolErrors: true });
  const graph = new StateGraph(MessagesAnnotation).addNode('custom_tool_node', node)
    .addEdge(START, 'custom_tool_node').addEdge('custom_tool_node', END).compile();
  const converter = new LangChain();
  const events = converter.convert({ event: 'on_chat_model_end', run_id: 'model', data: {
    output: new AIMessage({ content: 'checking', tool_calls: [call] }),
  } });
  let output: any;
  for await (const native of graph.streamEvents({ messages: [new AIMessage({ content: '', tool_calls: [call] })] }, { version: 'v2' })) {
    events.push(...converter.convert(native));
    if (native.event === 'on_chain_end') output = native.data.output;
  }
  events.push(...converter.convert({ event: 'on_chain_end', data: { output: {
    messages: [new ToolMessage({ content: 'old', tool_call_id: 'old-call' }), ...output.messages],
  } } }));
  expect(events.filter(e => e.type === 'TOOL_RESULT').map(e => e.data.id)).toEqual(['failed-call']);
  const data = await wire(events, 'agui');
  expect(data.filter(e => e.type === 'TOOL_CALL_RESULT').map(e => e.toolCallId)).toEqual(['failed-call']);
});

it('keeps real LangGraph parallel model runs separate', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Model extends BaseChatModel {
    constructor(private label: string) { super({}); }
    _llmType() { return 'controlled-parallel'; }
    async _generate(): Promise<never> { throw new Error('stream expected'); }
    async *_streamResponseChunks(_messages: any, _options: any, runManager?: any) {
      for (const suffix of ['1', '2']) {
        const text = this.label + suffix;
        const chunk = new ChatGenerationChunk({ text, message: new AIMessageChunk(text) });
        yield chunk;
        await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
        if (suffix === '1') await gate;
      }
    }
  }
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('a', async (s, config) => ({ messages: [await new Model('A').invoke(s.messages, config)] }))
    .addNode('b', async (s, config) => ({ messages: [await new Model('B').invoke(s.messages, config)] }))
    .addEdge(START, 'a').addEdge(START, 'b').addEdge('a', END).addEdge('b', END).compile();
  const converter = new LangChain(), events = [], started = new Set<string>();
  for await (const native of graph.streamEvents({ messages: [new HumanMessage('run')] }, { version: 'v2' })) {
    if (native.event === 'on_chat_model_stream') {
      started.add(native.run_id);
      if (started.size === 2) release();
    }
    events.push(...converter.convert(native));
  }
  const data = await wire(events, 'agui');
  const messages = new Map<string, string>();
  for (const event of data.filter(e => e.type === 'TEXT_MESSAGE_CONTENT')) {
    messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.delta);
  }
  expect([...messages.values()].sort()).toEqual(['A1A2', 'B1B2']);
});

it('closes alternating text and reasoning segments without reopening an ended ID', async () => {
  const converter = new LangChain(), events = [];
  for (const block of [{ type: 'text', text: 'checking' }, { type: 'reasoning', reasoning: 'thought' }, { type: 'text', text: 'answer' }]) {
    events.push(...converter.convert({ event: 'on_chat_model_stream', run_id: 'r', data: { chunk: { content: [block] } } }));
  }
  events.push(...converter.convert({ event: 'on_chat_model_end', run_id: 'r', data: {} }));
  const data = await wire(events, 'agui');
  const starts = data.filter(e => ['TEXT_MESSAGE_START', 'REASONING_MESSAGE_START'].includes(e.type));
  const ends = data.filter(e => ['TEXT_MESSAGE_END', 'REASONING_MESSAGE_END'].includes(e.type));
  expect(new Set(starts.map(e => e.messageId)).size).toBe(3);
  expect(ends.map(e => e.messageId)).toEqual(starts.map(e => e.messageId));
  expect(data.indexOf(ends[0])).toBeLessThan(data.indexOf(starts[1]));
  expect(data.indexOf(ends[1])).toBeLessThan(data.indexOf(starts[2]));
});

describe.each(['langchain', 'langgraph', 'adk', 'ai-sdk', 'mastra'])('%s execution events', framework => {
  it.each(['agui', 'openai'])('preserves IDs and boundaries within %s expression limits', async protocol => {
    const [converter, native] = sequence(framework);
    const data = await wire(native.flatMap(event => converter.convert(event)), protocol);
    if (protocol === 'openai') {
      expect(data.map(e => e.choices[0].delta.content ?? '').join('')).toBe('checkinganswer');
      expect(data.flatMap(e => e.choices[0].delta.tool_calls ?? []).filter(c => c.id).map(c => c.id)).toEqual(['call']);
      return;
    }
    const starts = data.filter(e => e.type === 'TEXT_MESSAGE_START'), results = data.filter(e => e.type === 'TOOL_CALL_RESULT');
    expect(new Set(starts.map(e => e.messageId)).size).toBe(2);
    expect(data.filter(e => e.type === 'TEXT_MESSAGE_END').map(e => e.messageId)).toEqual(starts.map(e => e.messageId));
    expect(results.map(e => e.toolCallId)).toEqual(['call']);
    expect(data.filter(e => e.type === 'TOOL_CALL_START').map(e => e.toolCallId)).toEqual(['call']);
    expect(data.indexOf(starts[1])).toBeGreaterThan(data.indexOf(results[0]));
    expect(data.at(-1).type).toBe('RUN_FINISHED');
  });
});

it('converts the actual AI SDK fullStream across a tool execution and repeated provider block IDs', async () => {
  let step = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    const first = step++ === 0;
    const parts: any[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: first ? 'checking' : 'answer' },
      { type: 'text-end', id: '0' },
      ...(first ? [{ type: 'tool-call', toolCallId: 'call', toolName: 'lookup', input: '{"value":1}' }] : []),
      { type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ];
    return { stream: new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }) };
  } });
  const output = streamText({ model, prompt: 'lookup', stopWhen: stepCountIs(3), tools: {
    lookup: tool({ inputSchema: z.object({ value: z.number() }), execute: async () => 'result' }),
  } });
  const events = [];
  for await (const e of new AISDK().stream(output.fullStream)) events.push(e);
  const data = await wire(events, 'agui');
  expect(data.filter(e => e.type === 'TEXT_MESSAGE_START')).toHaveLength(2);
  expect(data.filter(e => e.type === 'TOOL_CALL_RESULT').map(e => e.content)).toEqual(['result']);
  expect(data.at(-1).type).toBe('RUN_FINISHED');
});
it('keeps explicit reasoning without dropping a non-streamed final text snapshot', async () => {
  const converter = new LangChain();
  const events = [
    ...converter.convert({ event: 'on_chat_model_stream', run_id: 'model', data: {
      chunk: { contentBlocks: [{ type: 'reasoning', reasoning: 'thought' }] },
    } }),
    ...converter.convert({ event: 'on_chat_model_end', run_id: 'model', data: {
      output: { contentBlocks: [{ type: 'reasoning', reasoning: 'thought' }, { type: 'text', text: 'answer' }] },
    } }),
  ];
  const data = await wire(events, 'agui');
  expect(data.filter(e => e.type === 'REASONING_MESSAGE_CONTENT').map(e => e.delta)).toEqual(['thought']);
  expect(data.filter(e => e.type === 'TEXT_MESSAGE_CONTENT').map(e => e.delta)).toEqual(['answer']);
});
