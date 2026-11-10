import {
  MemoryPlugin,
  type MemoryBinding,
  type SourceRecord,
} from "../src/index";

/** Identity comes from the authenticated application; records come from its durable transcript. */
export async function processTurn(options: {
  endpoint: string;
  tokenProvider: () => string | Promise<string>;
  binding: MemoryBinding;
  sessionId: string;
  query: string;
  persistedRecords: readonly SourceRecord[];
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}) {
  const plugin = MemoryPlugin.fromEnvironment(
    {
      endpoint: options.endpoint,
      tokenProvider: options.tokenProvider,
    },
    options.environment,
  );
  const session = plugin.session(options.binding, options.sessionId);
  const recalled = await session.recall(options.query, {
    signal: options.signal,
  });
  // Supply recalled.context to the business framework as reference data.
  const receipts = await session.capture(
    options.persistedRecords,
    options.signal,
  );
  return { recalled, receipts };
}
