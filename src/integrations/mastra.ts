import { createTool } from '@mastra/core/tools';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { ProcessInputArgs, ProcessLLMRequestArgs, ProcessLLMRequestResult, ProcessOutputResultArgs } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import type { ModelClient, ProviderModelClient } from '../model';
import type { MemoryStore, MemoryMessage, MemoryScope } from '../memory';
import type { Logger } from '../logging';
import { ConfigError } from '../errors';
import type { Tool } from './common';
import { skillTools as canonicalSkillTools, type Skill, type SkillToolsOptions } from '../skill';
import { recallMemory, recordMemory, referenceText, validateTopK, validateScope, type MemoryScopes } from './memory/common';

export type { MemoryScopes } from './memory/common';

/** Model dependencies are loaded only when needed; Core retains ownership. */
export async function model(client: ModelClient | ProviderModelClient, options: { api?: 'chat' | 'responses' } = {}) {
  return (await import('./ai-sdk')).languageModel(client, options);
}

export function tools(values: readonly Tool[]): ToolsInput {
  const result: ToolsInput = Object.create(null);
  for (const value of values) {
    if (Object.hasOwn(result, value.name)) throw new ConfigError(`duplicate tool name: ${value.name}`);
    result[value.name] = createTool({ id: value.name, description: value.description,
      inputSchema: structuredClone(value.parameters), execute: input => value.invoke(input as Record<string, unknown>),
    });
  }
  return result;
}
export function skillTools(values: readonly Skill[], options: SkillToolsOptions = {}): ToolsInput {
  return tools(canonicalSkillTools(values, options));
}

export interface AgentCoreMemoryProcessorOptions {
  /** Resolve trusted application identity, not model-supplied arguments. */
  scopeResolver: (context: RequestContext | undefined) => MemoryScopes;
  writeBack?: boolean;
  topK?: number;
  logger?: Logger;
}
interface TurnMemory { input: MemoryMessage[]; reference: string; writeScope?: MemoryScope; }

/** Register the same processor in inputProcessors and outputProcessors to enable write-back. */
export class AgentCoreMemoryProcessor {
  readonly id = 'agentcore-memory';
  private readonly topK: number;
  constructor(private readonly store: MemoryStore, private readonly options: AgentCoreMemoryProcessorOptions) {
    this.topK = options.topK ?? 5; validateTopK(this.topK);
  }
  async processInput({ messages, state, requestContext }: ProcessInputArgs) {
    const scopes = this.options.scopeResolver(requestContext);
    if (this.options.writeBack) validateScope(scopes.write);
    const input = incomingMessages(messages);
    const reference = referenceText(await recallMemory(this.store, input.map(m => m.content).join('\n'), scopes.read,
      { topK: this.topK, logger: this.options.logger, bestEffort: true }));
    state.turnMemory = { input, reference, writeScope: this.options.writeBack ? { ...scopes.write! } : undefined } satisfies TurnMemory;
    return messages;
  }
  processLLMRequest({ prompt, state }: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const turn = state.turnMemory as TurnMemory | undefined;
    if (!turn?.reference) return;
    this.options.logger?.info('agentcore.memory.adapter.injected', { framework: 'mastra' });
    return { prompt: [{ role: 'system' as const, content: turn.reference }, ...prompt] };
  }
  async processOutputResult({ messages, state, result, abortSignal }: ProcessOutputResultArgs) {
    const turn = state.turnMemory as TurnMemory | undefined;
    const final = result.steps.at(-1);
    if (!abortSignal?.aborted && turn?.writeScope && turn.input.length && result.finishReason === 'stop'
      && final?.text.trim() && !final.toolCalls.length) {
      await recordMemory(this.store, [...turn.input, { role: 'assistant', content: final.text }], turn.writeScope,
        { logger: this.options.logger, bestEffort: true });
    }
    return messages;
  }
}

function incomingMessages(messages: readonly MastraDBMessage[]): MemoryMessage[] {
  const result: MemoryMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user') break;
    const content = message.content.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (content.trim()) result.unshift({ role: 'user', content });
  }
  return result;
}
export { MastraEventConverter as AgentCoreConverter } from './event-converters';
