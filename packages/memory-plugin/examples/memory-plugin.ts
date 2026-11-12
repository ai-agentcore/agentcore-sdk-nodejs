import { MemoryPlugin, type SourceRecord } from '../src/index';
import type { ContextMemoryClient, MemoryScope } from 'alibabacloud-agentcore-sdk';

/** Identity comes from the authenticated application; records come from its durable transcript. */
export async function processTurn(options: {
  memory: ContextMemoryClient;
  scope: MemoryScope;
  query: string;
  persistedRecords: readonly SourceRecord[];
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}) {
  const plugin = MemoryPlugin.fromNative(options.memory, { environment: options.environment });
  const recalled = await plugin.recall(options.query, {
    scope: options.scope,
    signal: options.signal,
  });
  // Supply recalled.context to the business framework as reference data.
  const captured = await plugin.capture(options.persistedRecords, { scope: options.scope, signal: options.signal });
  return { recalled, captured };
}
