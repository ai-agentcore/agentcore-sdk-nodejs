import { BaseTool, isFinalResponse, type BaseLlm, type BaseMemoryService, type Event,
  type RunAsyncToolRequest, type SearchMemoryRequest, type SearchMemoryResponse, type Session } from '@google/adk';
import type { ModelClient, ProviderModelClient } from '../model';
import type { MemoryStore, MemoryMessage } from '../memory';
import type { Tool } from './common';
import { skillTools as canonicalSkillTools, type Skill, type SkillToolsOptions } from '../skill';
import { validateScope, validateTopK } from './memory/common';

/** Load model-provider dependencies only when a model is requested. */
export async function model(client: ModelClient | ProviderModelClient): Promise<BaseLlm> {
  const { AgentCoreLlm } = await import('./google-adk-model');
  return new AgentCoreLlm(client);
}

class SchemaTool extends BaseTool {
  constructor(private readonly value: Tool) { super({ name: value.name, description: value.description }); }
  override _getDeclaration() {
    return { name: this.name, description: this.description, parametersJsonSchema: structuredClone(this.value.parameters) };
  }
  async runAsync({ args }: RunAsyncToolRequest): Promise<unknown> { return this.value.invoke(args); }
}
export function tools(values: readonly Tool[]): BaseTool[] { return values.map(value => new SchemaTool(value)); }
export function skillTools(values: readonly Skill[], options: SkillToolsOptions = {}): BaseTool[] {
  return tools(canonicalSkillTools(values, options));
}

export interface AgentCoreMemoryServiceOptions {
  /** Map the application's trusted ADK app/user pair to an AgentCore logical partition. */
  partitionResolver: (appName: string, userId: string) => string;
  topK?: number;
}
export interface AddEventsToMemoryRequest {
  appName: string;
  userId: string;
  sessionId?: string;
  events: readonly Event[];
  customMetadata?: Readonly<Record<string, string>>;
}

/** Borrows the MemoryStore; ADK's SessionService continues to own conversation history. */
export class AgentCoreMemoryService implements BaseMemoryService {
  private readonly topK: number;
  constructor(private readonly store: MemoryStore, private readonly options: AgentCoreMemoryServiceOptions) {
    this.topK = options.topK ?? 5; validateTopK(this.topK);
  }
  async searchMemory({ appName, userId, query }: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const scope = { agentId: this.options.partitionResolver(appName, userId) }; validateScope(scope);
    const result = await this.store.searchMemories(query, { scope, topK: this.topK });
    return { memories: result.memories.map(({ memory }) => ({ content: { parts: [{ text: memory.content.text }] }, timestamp: memory.createdAt })) };
  }
  async addSessionToMemory(session: Session): Promise<void> {
    await this.addEventsToMemory({ appName: session.appName, userId: session.userId, sessionId: session.id, events: session.events });
  }
  /** Explicit delta ingestion, avoiding repeated ingestion of the entire Session. */
  async addEventsToMemory(request: AddEventsToMemoryRequest): Promise<void> {
    const scope = { agentId: this.options.partitionResolver(request.appName, request.userId), sessionId: request.sessionId }; validateScope(scope);
    const messages: MemoryMessage[] = [];
    for (const event of request.events) {
      if (!event.content || event.partial || event.errorCode) continue;
      const role = event.author === 'user' ? 'user' : event.content.role === 'model' && isFinalResponse(event) ? 'assistant' : undefined;
      if (!role) continue;
      const content = (event.content.parts ?? []).filter(part => part.text && !part.thought).map(part => part.text!).join('\n');
      if (content.trim()) messages.push({ role, content });
    }
    if (messages.length) await this.store.addMemories({ scope, messages, metadata: request.customMetadata });
  }
}
export { GoogleADKEventConverter as AgentCoreConverter } from './event-converters';
