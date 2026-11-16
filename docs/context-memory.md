# Native Context Memory

Core SDK 0.1.9 adds `AgentCore.contextMemory(name, { endpoint? })` and the public `ContextMemoryClient`. This API binds an existing store and exposes three native operations. It uses the generated POP signer and requests resource STS with purpose `context`. Existing `memoryStore()` extraction and CRUD calls keep purpose `highcode_sdk`.

```typescript
import { AgentCore, ContextEvent, MemoryType } from 'alibabacloud-agentcore-sdk';

const core = AgentCore.auto();
try {
  const memory = core.contextMemory(existingStore);
  const scope = { agentId: trustedAgent, sessionId: nativeSession };
  const created = await memory.createEvents(
    persistedEvents.map(ContextEvent.fromSource),
    { scope, timeoutMs: 1500, signal },
  );
  for (const receipt of created.results) {
    if (receipt.kind === 'stored') recordCloudEventId(receipt.inputIndex, receipt.eventId);
    else recordServiceReceipt(receipt.inputIndex, receipt.status, receipt.code);
  }
  const result = await memory.searchMemories(query, {
    scope, types: [MemoryType.Semantic, MemoryType.SessionSummary], topK: 20, signal,
  });
  useMemories(result.memories, result.requestId);
} finally {
  await core.close();
}
```

The variables and callbacks above belong to the authenticated host. The [complete function example](../examples/context-memory.ts) receives those inputs explicitly. `ContextMemoryClient.fromCredentials({ workspaceId, regionId, memoryStoreName, accessKeyCredential, endpoint? })` also accepts an existing public `resourceSTSProvider` in place of the AccessKey credential. Provide exactly one credential source. An injected provider remains caller-owned.

Endpoint precedence is the explicit factory option, `AGENTCORE_MEMORY_ENDPOINT` from the managed runtime environment projection or process environment, then `https://agentcore.{regionId}.aliyuncs.com`. Standalone credential construction reads the process variable. Endpoints are HTTP origins without credentials, paths, queries or fragments. The Context client does not inherit a Controller or control-plane endpoint and does not retry against another endpoint.

`userId`, `teamId`, `agentId` and `sessionId` are independent optional scope dimensions. Empty strings and reserved `*`/`__default__` scope values are rejected. The host chooses its authorization scope. Search verifies only the scope dimensions actually sent. `types` accepts `semantic`, `skill`, `user_profile` and `session_summary`; omitted or empty means all types. `auto` is rejected. Explicit `topK` accepts 1 through 200. Omission leaves the service default unchanged. Native hits retain score, similarity, scope, optional type/source/validity/sourceEventIds/version/timestamps and metadata. Missing optional fields stay absent.

`ContextEvent.fromSource()` is the shared conversion for message, tool_call, tool_result, model_request and model_response source events. It preserves timestamps, maps tool results to role `tool` with the real callId, and maps other structured variants to assistant messages with an opaque `harness.<type>;encoding=json` content block. Opaque values use compact JSON with sorted object keys. `ContextEvent.typed()` validates an explicit native event for deployments that support that event format. No format fallback resubmits a write. Source IDs remain host correlation IDs and are never assigned as cloud event IDs.

`createEvents()` accepts 1 through 100 events. It requires one unique, in-range inputIndex per input and requires eventId for every STORED receipt. Other service statuses remain inspectable as `kind: 'other'`. A malformed, missing or incomplete receipt is an uncertain write. STORED confirms event storage; it does not confirm extraction or search visibility.

```typescript
let nextToken: string | undefined;
do {
  const page = await memory.listEvents({ scope, nextToken, maxResults: 100, signal });
  reconcilePersistedRecords(page.items);
  nextToken = page.nextToken;
} while (nextToken);
```

`listEvents()` returns the service's top-level items and pagination fields. Each item keeps its complete event envelope and additional JSON fields. It does not wrap a row in an invented nested event shape. Optional maxResults accepts 1 through 100. Reconciliation, ambiguity handling, deduplication and replay policy belong to the host.

All three operations issue one POP request with automatic retries disabled. A successful empty search is distinct from a failed or malformed read. Errors preserve operation, service code, HTTP status and requestId when available. HTTP 200 with success=false and explicit 4xx rejection are known failures. CreateEvents transport loss, 5xx and malformed receipts raise `CreateEventsOutcomeUnknownError` with `outcomeUnknown=true`. Reconcile through ListEvents before deciding whether to replay.

`timeoutMs` covers runtime resolution, credential acquisition and request execution. AbortSignal stops waiting and prevents a later dispatch if cancellation was observed during credential acquisition. The generated POP transport cannot abort an in-flight request; after dispatch, a write timeout or `MemoryRequestAbortedError` has `outcomeUnknown=true`. Abort errors have name `AbortError` and preserve the signal reason as cause. The underlying request may continue after the caller stops waiting. No SDK queue or retry ledger is created.

The [optional plugin](../packages/memory-plugin/README.md) adds environment gates, source-ID correlation and bounded reference context. Runtime lifecycle, multi-store/type orchestration, prompt placement, hooks and a durable outbox remain host responsibilities. This change has build and type validation only; native cloud end-to-end acceptance has not been performed.
