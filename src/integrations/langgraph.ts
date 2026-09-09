import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { MemoryValidationError } from '../errors';
import type { MemoryStore, MemoryScope, MemoryMessage } from '../memory';
import type { Logger } from '../logging';
import { recallMemory, recordMemory, referenceText, validateTopK } from './memory/common';
export { model, tools, skillTools } from './langchain-adapter';
export type { LangChainModelOptions, LangChainProviderOptions } from './langchain-adapter';

export interface MemoryNodeState {
  memoryQuery?: string;
  memoryReadScope?: MemoryScope;
  memoryWriteScope?: MemoryScope;
  memoryMessages?: readonly MemoryMessage[];
  memoryText?: string;
}

/** Explicit graph nodes: the application owns state, turn boundaries and edges. */
export class AgentCoreMemoryNodes {
  private readonly topK: number;
  constructor(private readonly store: MemoryStore, private readonly options: { topK?: number; logger?: Logger } = {}) {
    this.topK = options.topK ?? 5; validateTopK(this.topK);
  }
  async recall(state: MemoryNodeState): Promise<{ memoryText: string }> {
    if (state.memoryQuery === undefined) throw new MemoryValidationError('memoryQuery is required');
    return { memoryText: await recallMemory(this.store, state.memoryQuery, state.memoryReadScope, { topK: this.topK, logger: this.options.logger }) };
  }
  async record(state: MemoryNodeState): Promise<{ memoryMessages: MemoryMessage[] }> {
    if (!Array.isArray(state.memoryMessages)) throw new MemoryValidationError('memoryMessages must be an array');
    await recordMemory(this.store, state.memoryMessages, state.memoryWriteScope, { logger: this.options.logger });
    return { memoryMessages: [] };
  }
}

/** Add reference data to model input without persisting it in graph history. */
export function withMemory(messages: readonly BaseMessage[], memoryText: string): BaseMessage[] {
  const result = [...messages]; const note = referenceText(memoryText);
  if (!note) return result;
  const first = result[0];
  if (SystemMessage.isInstance(first)) {
    result[0] = new SystemMessage({ id: first.id, name: first.name, additional_kwargs: first.additional_kwargs, response_metadata: first.response_metadata,
      content: typeof first.content === 'string' ? `${first.content}\n\n${note}` : [...first.content, { type: 'text', text: note }] });
  } else result.unshift(new SystemMessage(note));
  return result;
}
export { LangChainEventConverter as AgentCoreConverter } from './event-converters';
