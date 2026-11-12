import { AgentCore, ContextEvent, MemoryType, type MemoryScope, type SourceEvent } from 'alibabacloud-agentcore-sdk';

/** The caller supplies authenticated scope and events from its persisted transcript. */
export async function useContextMemory(
  core: AgentCore,
  options: {
    memoryStoreName: string;
    scope: MemoryScope;
    persistedEvents: readonly SourceEvent[];
    query: string;
    endpoint?: string;
    signal?: AbortSignal;
  },
) {
  const memory = core.contextMemory(options.memoryStoreName, { endpoint: options.endpoint });
  const events: readonly ContextEvent[] = options.persistedEvents.map(ContextEvent.fromSource);
  const created = await memory.createEvents(events, { scope: options.scope, timeoutMs: 1500, signal: options.signal });
  const recalled = await memory.searchMemories(options.query, {
    scope: options.scope,
    types: [MemoryType.Semantic, MemoryType.SessionSummary],
    topK: 20,
    timeoutMs: 1500,
    signal: options.signal,
  });
  const page = await memory.listEvents({
    scope: options.scope,
    maxResults: 100,
    timeoutMs: 1500,
    signal: options.signal,
  });
  return { created, recalled, page };
}
