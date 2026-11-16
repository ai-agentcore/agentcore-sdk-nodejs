import { ConfigError, MemoryContractError, MemoryValidationError, type MemoryErrorDetails } from '../errors';
import type { Logger } from '../logging';
import { MemoryTransport, record, type MemoryRuntime, type MemoryOperation } from './transport';
import type { MemoryScope } from './models';
import type {
  ContextMemory,
  ContextMemoryClientOptions,
  ContextMemorySearchOptions,
  ContextMemorySearchResult,
  ContextEvent,
  ContextEventRecord,
  CreateEventsResult,
  EventPage,
  EventReceipt,
  JsonValue,
  ListEventsOptions,
  MemoryCallOptions,
  MemoryType,
} from './context-models';
import { immutableJson, parseContextEvent } from './source-events';

type Runtime = () => Promise<MemoryRuntime>;
export let bindContextMemory: (name: string, runtime: Runtime, logger?: Logger) => ContextMemoryClient;

/** A binding to one native store. Each operation dispatches at most one POP request. */
export class ContextMemoryClient {
  readonly memoryStoreName: string;
  private readonly transport: MemoryTransport;
  private constructor(name: string, runtime: Runtime, logger?: Logger) {
    this.memoryStoreName = required(name, 'memoryStoreName');
    this.transport = new MemoryTransport(this.memoryStoreName, runtime, logger, 'context');
  }
  static {
    bindContextMemory = (name, runtime, logger) => new ContextMemoryClient(name, runtime, logger);
  }

  static fromCredentials(options: ContextMemoryClientOptions): ContextMemoryClient {
    const workspaceId = required(options.workspaceId, 'workspaceId');
    const regionId = required(options.regionId, 'regionId');
    const endpoint = contextEndpoint(options.endpoint ?? process.env.AGENTCORE_MEMORY_ENDPOINT, regionId);
    if (Boolean(options.accessKeyCredential) === Boolean(options.resourceSTSProvider))
      throw new ConfigError('Context Memory requires exactly one AccessKey credential or provider');
    return new ContextMemoryClient(
      options.memoryStoreName,
      async () => ({
        workspaceId,
        regionId,
        endpoint,
        accessKeyCredential: options.accessKeyCredential,
        resourceSTS: options.resourceSTSProvider,
      }),
      options.logger,
    );
  }

  async createEvents(
    events: readonly ContextEvent[],
    options: MemoryCallOptions & { readonly scope?: MemoryScope } = {},
  ): Promise<CreateEventsResult> {
    if (!Array.isArray(events) || events.length < 1 || events.length > 100)
      throw new MemoryValidationError('events must contain 1..100 entries');
    const scope = validateContextScope(options.scope);
    const input = events.map(parseContextEvent);
    return this.transport.request(
      'CreateEvents',
      'POST',
      '/events',
      (body, details) => {
        const operation = 'CreateEvents';
        const rows = array(record(body.data).results, operation, 'data.results');
        if (rows.length !== input.length) fail(operation, 'data.results must contain one receipt per input');
        const seen = new Set<number>();
        const results: EventReceipt[] = rows.map((value) => {
          const row = record(value);
          const index = integer(row.inputIndex, operation, 'results[].inputIndex');
          if (index < 0 || index >= input.length || seen.has(index))
            fail(operation, 'receipt inputIndex must be unique and in range');
          seen.add(index);
          const status = string(row.status, operation, 'results[].status');
          const extra = {
            ...optionalField(row.eventId, 'eventId', (value) => string(value, operation, 'results[].eventId')),
            ...optionalField(row.code, 'code', (value) => string(value, operation, 'results[].code')),
            ...optionalField(row.message, 'message', (value) => string(value, operation, 'results[].message', false)),
          };
          return status === 'STORED'
            ? Object.freeze({
                ...extra,
                kind: 'stored',
                inputIndex: index,
                status,
                eventId: string(row.eventId, operation, 'STORED.eventId'),
              })
            : Object.freeze({ ...extra, kind: 'other', inputIndex: index, status });
        });
        return Object.freeze({ results: Object.freeze(results), ...requestId(details) });
      },
      { ...(scope ? { scope } : {}), events: input },
      undefined,
      options,
    );
  }

  async listEvents(options: ListEventsOptions & MemoryCallOptions = {}): Promise<EventPage> {
    const scope = validateContextScope(options.scope);
    bounded(options.maxResults, 'maxResults', 100);
    if (options.nextToken !== undefined && typeof options.nextToken !== 'string')
      throw new MemoryValidationError('nextToken must be a string');
    return this.transport.request(
      'ListEvents',
      'GET',
      '/events',
      (body, details) => {
        const operation = 'ListEvents';
        const items = array(body.items, operation, 'items').map((value) => {
          let row: JsonValue;
          try {
            row = immutableJson(value);
          } catch {
            return fail(operation, 'items[] must be JSON objects');
          }
          if (!eventRecord(row)) return fail(operation, 'items[] must be objects');
          return row;
        });
        return Object.freeze({
          items: Object.freeze(items),
          ...requestId(details),
          ...optionalField(body.nextToken, 'nextToken', (value) => string(value, operation, 'nextToken', false)),
          ...optionalField(body.maxResults, 'maxResults', (value) => nonnegative(value, operation, 'maxResults')),
          ...optionalField(body.totalCount, 'totalCount', (value) => nonnegative(value, operation, 'totalCount')),
        });
      },
      undefined,
      { ...scope, maxResults: options.maxResults, nextToken: options.nextToken },
      options,
    );
  }

  async searchMemories(
    query: string,
    options: ContextMemorySearchOptions & MemoryCallOptions = {},
  ): Promise<ContextMemorySearchResult> {
    required(query, 'query');
    const scope = validateContextScope(options.scope);
    bounded(options.topK, 'topK', 200);
    const types = options.types === undefined ? undefined : validateTypes(options.types);
    let metadata: Readonly<Record<string, string>> | undefined;
    if (options.metadata !== undefined) {
      if (
        !options.metadata ||
        typeof options.metadata !== 'object' ||
        Array.isArray(options.metadata) ||
        Object.values(options.metadata).some((value) => typeof value !== 'string')
      )
        throw new MemoryValidationError('metadata must map strings to strings');
      metadata = Object.freeze({ ...options.metadata });
    }
    if (options.enableRerank !== undefined && typeof options.enableRerank !== 'boolean')
      throw new MemoryValidationError('enableRerank must be boolean');
    for (const [key, value] of [
      ['minScore', options.minScore],
      ['minSimilarity', options.minSimilarity],
    ]) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new MemoryValidationError(`${key} must be finite`);
    }
    return this.transport.request(
      'SearchMemories',
      'POST',
      '/memories/search',
      (body, details) => {
        const memories = array(record(body.data).memories, 'SearchMemories', 'data.memories').map((value) => {
          const row = record(value);
          const memory = parseMemory(row.memory);
          for (const [key, expected] of Object.entries(scope ?? {})) {
            if (Reflect.get(memory.scope, key) !== expected)
              fail('SearchMemories', `memory.scope.${key} does not match the requested scope`);
          }
          if (types?.length && memory.type !== undefined && !types.includes(memory.type))
            fail('SearchMemories', 'memory.type does not match requested types');
          return Object.freeze({
            memory,
            score: finite(row.score, 'SearchMemories', 'score'),
            similarity: finite(row.similarity, 'SearchMemories', 'similarity'),
          });
        });
        return Object.freeze({ memories: Object.freeze(memories), ...requestId(details) });
      },
      {
        query,
        ...(scope ? { scope } : {}),
        ...(types?.length ? { types } : {}),
        topK: options.topK,
        metadata,
        enableRerank: options.enableRerank,
        minScore: options.minScore,
        minSimilarity: options.minSimilarity,
      },
      undefined,
      options,
    );
  }
}

export function contextEndpoint(value: string | undefined, regionId: string): string {
  if (value === undefined) return `https://agentcore.${regionId}.aliyuncs.com`;
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new ConfigError('Context Memory endpoint must be an HTTP origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new ConfigError('Context Memory endpoint must be an HTTP origin');
  }
  return url.origin;
}
function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MemoryValidationError(`${field} must be a nonempty string`);
  return value;
}
const dimensions = ['userId', 'teamId', 'agentId', 'sessionId'] as const;
export function validateContextScope(scope: MemoryScope | undefined): MemoryScope | undefined {
  if (scope === undefined) return undefined;
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).some((key) => !dimensions.some((dimension) => dimension === key))
  ) {
    throw new MemoryValidationError('scope must contain only userId, teamId, agentId and sessionId');
  }
  const result: Record<string, string> = {};
  for (const dimension of dimensions) {
    const value = scope[dimension];
    if (value === undefined) continue;
    required(value, `scope.${dimension}`);
    if (['*', '__default__'].includes(value.trim()))
      throw new MemoryValidationError(`scope.${dimension} must not use a reserved scope value`);
    result[dimension] = value;
  }
  return Object.freeze(result);
}
function bounded(value: number | undefined, field: string, max: number): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > max))
    throw new MemoryValidationError(`${field} must be an integer in 1..${max}`);
}
function memoryType(value: unknown): value is MemoryType {
  return value === 'semantic' || value === 'skill' || value === 'user_profile' || value === 'session_summary';
}
function validateTypes(values: readonly MemoryType[]): readonly MemoryType[] {
  if (!Array.isArray(values) || values.some((value) => !memoryType(value)))
    throw new MemoryValidationError('types must contain semantic, skill, user_profile or session_summary');
  return Object.freeze([...new Set(values)]);
}
function fail(operation: MemoryOperation, detail: string): never {
  throw new MemoryContractError(operation, detail);
}
function string(value: unknown, operation: MemoryOperation, field: string, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && !value.trim()))
    return fail(operation, `${field} must be a ${nonempty ? 'nonempty ' : ''}string`);
  return value;
}
function finite(value: unknown, operation: MemoryOperation, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(operation, `${field} must be finite`);
  return value;
}
function integer(value: unknown, operation: MemoryOperation, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return fail(operation, `${field} must be a safe integer`);
  return value;
}
function nonnegative(value: unknown, operation: MemoryOperation, field: string): number {
  const result = integer(value, operation, field);
  if (result < 0) return fail(operation, `${field} must be nonnegative`);
  return result;
}
function array(value: unknown, operation: MemoryOperation, field: string): unknown[] {
  if (!Array.isArray(value)) return fail(operation, `${field} must be an array`);
  return value;
}
function optionalField<K extends string, T>(
  value: unknown,
  key: K,
  parse: (value: unknown) => T,
): Partial<Record<K, T>> {
  if (value === undefined || value === null) return {};
  const result: Partial<Record<K, T>> = {};
  result[key] = parse(value);
  return result;
}
function eventRecord(value: JsonValue): value is ContextEventRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requestId(details: MemoryErrorDetails): { requestId?: string } {
  return details.requestId === undefined ? {} : { requestId: details.requestId };
}
function parseMemory(value: unknown): ContextMemory {
  const operation = 'SearchMemories';
  const row = record(value);
  const rawScope = row.scope;
  if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope))
    return fail(operation, 'memory.scope must be an object');
  const scope: Record<string, string> = {};
  for (const key of dimensions) {
    const value = Reflect.get(rawScope, key);
    if (value !== undefined && value !== null) scope[key] = string(value, operation, `memory.scope.${key}`);
  }
  return Object.freeze({
    memoryId: string(row.memoryId, operation, 'memory.memoryId'),
    content: Object.freeze({ text: string(record(row.content).text, operation, 'memory.content.text', false) }),
    scope: Object.freeze(scope),
    ...optionalField(row.type, 'type', (value) => {
      if (!memoryType(value)) return fail(operation, 'memory.type is unsupported');
      return value;
    }),
    ...optionalField(row.source, 'source', (value) => string(value, operation, 'memory.source')),
    ...optionalField(row.valid, 'valid', (value) => {
      if (typeof value !== 'boolean') return fail(operation, 'memory.valid must be boolean');
      return value;
    }),
    ...optionalField(row.sourceEventIds, 'sourceEventIds', (value) =>
      Object.freeze(
        array(value, operation, 'memory.sourceEventIds').map((id) => string(id, operation, 'sourceEventIds[]')),
      ),
    ),
    ...optionalField(row.version, 'version', (value) => {
      if (typeof value === 'string') return value;
      return integer(value, operation, 'memory.version');
    }),
    ...optionalField(row.createdAt, 'createdAt', (value) => string(value, operation, 'memory.createdAt')),
    ...optionalField(row.updatedAt, 'updatedAt', (value) => string(value, operation, 'memory.updatedAt')),
    ...optionalField(row.metadata, 'metadata', (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail(operation, 'memory.metadata must be an object');
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, string(item, operation, `metadata.${key}`, false)]),
        ),
      );
    }),
  });
}
