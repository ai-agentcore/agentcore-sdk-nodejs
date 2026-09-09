import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { MemoryStore, MemoryMessage } from '../memory';
import { nullLogger, type Logger } from '../logging';
import { recallMemory, recordMemory, validateTopK, validateScope, type MemoryScopes } from './memory/common';
import { withMemory } from './langgraph';
export { model, tools, skillTools } from './langchain-adapter';
export type { LangChainModelOptions, LangChainProviderOptions } from './langchain-adapter';

export type { MemoryScopes } from './memory/common';
export interface AgentCoreMemoryMiddlewareOptions<TContextSchema extends z.ZodObject = z.ZodObject<{}>> {
  contextSchema?: TContextSchema;
  scopeResolver: (context: z.output<TContextSchema>) => MemoryScopes;
  writeBack?: boolean;
  topK?: number;
  logger?: Logger;
}

const memoryState = z.object({
  agentcoreMemoryText: z.string().default(''),
  agentcoreMemoryInput: z.array(z.object({ role: z.string(), content: z.string() })).default([]),
  agentcoreMemoryWriteScope: z.object({ agentId: z.string().optional(), sessionId: z.string().optional(), userId: z.string().optional() }).nullable().default(null),
});

/** Recall per agent invocation; history/checkpoints and identity remain application-owned. */
export function agentCoreMemoryMiddleware<TContextSchema extends z.ZodObject = z.ZodObject<{}>>(store: MemoryStore, options: AgentCoreMemoryMiddlewareOptions<TContextSchema>) {
  const topK = options.topK ?? 5; validateTopK(topK);
  const logger = options.logger ?? nullLogger;
  return createMiddleware({
    name: 'AgentCoreMemory', stateSchema: memoryState, contextSchema: options.contextSchema,
    async beforeAgent(state, runtime) {
      const scopes = options.scopeResolver(runtime.context as z.output<TContextSchema>);
      if (options.writeBack) validateScope(scopes.write);
      const writeScope = options.writeBack ? { ...scopes.write! } : null;
      const incoming = incomingMessages(state.messages);
      const text = await recallMemory(store, incoming.map((m) => m.content).join('\n'), scopes.read, { topK, logger, bestEffort: true });
      return { agentcoreMemoryText: text, agentcoreMemoryInput: incoming,
        agentcoreMemoryWriteScope: writeScope };
    },
    async wrapModelCall(request, handler) {
      if (!request.state.agentcoreMemoryText) return handler(request);
      logger.info('agentcore.memory.adapter.injected', { framework: 'langchain' });
      return handler({ ...request, systemMessage: withMemory([request.systemMessage], request.state.agentcoreMemoryText)[0] as SystemMessage });
    },
    async afterAgent(state) {
      const incoming = state.agentcoreMemoryInput ?? []; const scope = state.agentcoreMemoryWriteScope;
      const final = state.messages.at(-1);
      if (incoming.length && scope && AIMessage.isInstance(final) && !final.tool_calls?.length
        && !['length', 'max_tokens'].includes(String(final.response_metadata.finish_reason))) {
        const text = messageText(final);
        if (text.trim()) await recordMemory(store, [...incoming, { role: 'assistant', content: text }], scope, { logger, bestEffort: true });
      }
      return { agentcoreMemoryText: '', agentcoreMemoryInput: [], agentcoreMemoryWriteScope: null };
    },
  });
}

function messageText(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n');
}
function incomingMessages(messages: readonly BaseMessage[]): MemoryMessage[] {
  const incoming: MemoryMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!HumanMessage.isInstance(message)) break;
    const content = messageText(message);
    if (content.trim()) incoming.unshift({ role: 'user', content });
  }
  return incoming;
}
export { LangChainEventConverter as AgentCoreConverter } from './event-converters';
