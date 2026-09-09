import { MemoryContractError, MemoryValidationError } from '../errors';
import type { Logger } from '../logging';
import { MemoryTransport, pathComponent, record, type MemoryRuntime, type MemoryOperation } from './transport';
import type { AddMemoriesOptions, AddMemoriesResult, ListMemoriesOptions, ListMemorySessionsOptions, ListMemorySessionMessagesOptions, Memory, MemoryMessage, MemoryScope, MemorySession,
  Page, PageOptions, SearchMemoriesOptions, SearchMemoriesResult, UpdateMemoryOptions } from './models';

/** A local binding to an existing MemoryStore. No lookup or creation at construction. */
export class MemoryStore {
  readonly memoryStoreName: string;
  private readonly transport: MemoryTransport;
  constructor(name: string, options: { runtime: () => Promise<MemoryRuntime>; logger?: Logger }) {
    this.memoryStoreName = required(name, 'memoryStoreName');
    this.transport = new MemoryTransport(name, options.runtime, options.logger);
  }
  async addMemories(options: AddMemoriesOptions): Promise<AddMemoriesResult> {
    const scope = validateScope(options.scope);
    const hasText = options.text !== undefined; const hasMessages = options.messages !== undefined;
    if (hasText === hasMessages) throw new MemoryValidationError('exactly one of text or messages must be provided');
    const text = hasText ? required(options.text, 'text') : undefined;
    let messages: MemoryMessage[] | undefined;
    if (hasMessages) {
      if (!Array.isArray(options.messages) || !options.messages.length) throw new MemoryValidationError('messages must be a non-empty array');
      messages = options.messages.map((message) => ({ role: required(message?.role, 'messages[].role'), content: required(message?.content, 'messages[].content') }));
    }
    const metadata = validateMetadata(options.metadata);
    return this.transport.request('AddMemories', 'POST', '/memories', (body) => Object.freeze({ memoryIds: Object.freeze(array(record(body.data).memories, 'AddMemories', 'data.memories').map((item) =>
      string(record(item).memoryId, 'AddMemories', 'data.memories[].memoryId', true))) }), { scope, text, messages, metadata });
  }
  async searchMemories(query: string, options: SearchMemoriesOptions = {}): Promise<SearchMemoriesResult> {
    required(query, 'query'); const scope = validateScope(options.scope);
    bounded(options.topK, 'topK', 50); const metadata = validateMetadata(options.metadata);
    if (options.enableRerank !== undefined && typeof options.enableRerank !== 'boolean') throw new MemoryValidationError('enableRerank must be a boolean');
    for (const key of ['minScore', 'minSimilarity'] as const) if (options[key] !== undefined && (typeof options[key] !== 'number' || !Number.isFinite(options[key]))) throw new MemoryValidationError(`${key} must be a finite number`);
    return this.transport.request('SearchMemories', 'POST', '/memories/search', (body) => Object.freeze({ memories: Object.freeze(array(record(body.data).memories, 'SearchMemories', 'data.memories').map((item) => {
      const hit = record(item);
      if (typeof hit.score !== 'number' || typeof hit.similarity !== 'number') throw new MemoryContractError('SearchMemories', 'score and similarity must be numbers');
      return Object.freeze({ memory: parseMemory(hit.memory, 'SearchMemories'), score: hit.score, similarity: hit.similarity });
    })) }), { query, scope, topK: options.topK, metadata, enableRerank: options.enableRerank, minScore: options.minScore, minSimilarity: options.minSimilarity });
  }
  async listMemories(options: ListMemoriesOptions = {}): Promise<Page<Memory>> {
    optionalScopeString(options.userId, 'userId'); optionalScopeString(options.agentId, 'agentId'); optionalScopeString(options.sessionId, 'sessionId');
    validatePage(options);
    return this.transport.request('ListMemories', 'GET', '/memories', (body) => page(body, 'ListMemories', (item) => parseMemory(item, 'ListMemories')),
      undefined, { userId: options.userId, agentId: options.agentId, sessionId: options.sessionId, maxResults: options.maxResults, nextToken: options.nextToken });
  }
  async getMemory(memoryId: string): Promise<Memory> {
    required(memoryId, 'memoryId');
    return this.transport.request('GetMemory', 'GET', `/memories/${pathComponent(memoryId)}`, (body) => parseMemory(body.data, 'GetMemory'));
  }
  async updateMemory(memoryId: string, options: UpdateMemoryOptions): Promise<Memory> {
    required(memoryId, 'memoryId');
    if (options.text === undefined && options.metadata === undefined) throw new MemoryValidationError('at least one of text or metadata must be provided');
    optional(options.text, 'text'); const metadata = validateMetadata(options.metadata);
    return this.transport.request('UpdateMemory', 'PUT', `/memories/${pathComponent(memoryId)}`, (body) => parseMemory(body.data, 'UpdateMemory'), { text: options.text, metadata });
  }
  async deleteMemory(memoryId: string): Promise<void> {
    required(memoryId, 'memoryId');
    return this.transport.request('DeleteMemory', 'DELETE', `/memories/${pathComponent(memoryId)}`, () => undefined);
  }
  async listMemorySessions(options: ListMemorySessionsOptions = {}): Promise<Page<MemorySession>> {
    optionalScopeString(options.userId, 'userId'); optionalScopeString(options.agentId, 'agentId'); validatePage(options);
    return this.transport.request('ListMemorySessions', 'GET', '/sessions', (body) => page(body, 'ListMemorySessions', (item) => {
      const session = Object.freeze({
        agentId: optionalString(record(item).agentId, 'ListMemorySessions', 'items[].agentId'),
        sessionId: optionalString(record(item).sessionId, 'ListMemorySessions', 'items[].sessionId'),
        userId: optionalString(record(item).userId, 'ListMemorySessions', 'items[].userId'),
      });
      if (session.userId === undefined && session.agentId === undefined && session.sessionId === undefined) throw new MemoryContractError('ListMemorySessions', 'items[] must contain at least one scope field');
      return session;
    }), undefined, { userId: options.userId, agentId: options.agentId, maxResults: options.maxResults, nextToken: options.nextToken });
  }
  async listMemorySessionMessages(sessionId: string, options: ListMemorySessionMessagesOptions = {}): Promise<Page<MemoryMessage>> {
    required(sessionId, 'sessionId'); optionalScopeString(sessionId, 'sessionId');
    optionalScopeString(options.userId, 'userId'); optionalScopeString(options.agentId, 'agentId');
    if (options.userId === undefined && options.agentId === undefined) throw new MemoryValidationError('at least one of userId or agentId must be provided');
    validatePage(options);
    return this.transport.request('ListMemorySessionMessages', 'GET', '/messages',
      (body) => page(body, 'ListMemorySessionMessages', (item) => Object.freeze({
        role: string(record(item).role, 'ListMemorySessionMessages', 'items[].role', true),
        content: string(record(item).content, 'ListMemorySessionMessages', 'items[].content', true),
      })), undefined, { userId: options.userId, agentId: options.agentId, sessionId, maxResults: options.maxResults, nextToken: options.nextToken });
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MemoryValidationError(`${field} must be a non-empty string`);
  return value;
}
function optional(value: unknown, field: string): void { if (value !== undefined) required(value, field); }
function bounded(value: unknown, field: string, maximum: number): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum)) throw new MemoryValidationError(`${field} must be an integer from 1 to ${maximum}`);
}
function optionalScopeString(value: unknown, field: string): void {
  if (value === undefined) return;
  if (['*', '__default__'].includes(required(value, field).trim())) throw new MemoryValidationError(`${field} must not use a reserved scope value`);
}
export function validateScope(scope: MemoryScope | undefined): MemoryScope | undefined {
  if (scope === undefined) return undefined;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new MemoryValidationError('scope must be a MemoryScope');
  optionalScopeString(scope.userId, 'scope.userId'); optionalScopeString(scope.agentId, 'scope.agentId'); optionalScopeString(scope.sessionId, 'scope.sessionId');
  return { userId: scope.userId, agentId: scope.agentId, sessionId: scope.sessionId };
}
function validateMetadata(value: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, item]) => !key.trim() || typeof item !== 'string')) throw new MemoryValidationError('metadata must contain non-empty string keys and string values');
  return { ...value };
}
function validatePage(options: PageOptions): void {
  bounded(options.maxResults, 'maxResults', 100);
  if (options.nextToken !== undefined && typeof options.nextToken !== 'string') throw new MemoryValidationError('nextToken must be a string');
}
function array(value: unknown, operation: MemoryOperation, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MemoryContractError(operation, `${path} must be an array`);
  return value;
}
function string(value: unknown, operation: MemoryOperation, path: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) throw new MemoryContractError(operation, `${path} must be ${nonEmpty ? 'a non-empty' : 'a'} string`);
  return value;
}
function optionalString(value: unknown, operation: MemoryOperation, path: string): string | undefined { return value === undefined || value === null ? undefined : string(value, operation, path); }
function parseMemory(value: unknown, operation: MemoryOperation): Memory {
  const item = record(value); const scope = record(item.scope);
  const memoryId = string(item.memoryId, operation, 'memory.memoryId', true);
  const text = string(record(item.content).text, operation, 'memory.content.text');
  if (!item.scope || typeof item.scope !== 'object' || Array.isArray(item.scope)) throw new MemoryContractError(operation, 'memory.scope must be an object');
  let metadata: Readonly<Record<string, string>> | undefined;
  if (item.metadata !== undefined && item.metadata !== null) {
    if (typeof item.metadata !== 'object' || Array.isArray(item.metadata) || Object.entries(item.metadata).some(([key, value]) => !key.trim() || typeof value !== 'string')) throw new MemoryContractError(operation, 'memory.metadata must contain string keys and values');
    metadata = Object.freeze({ ...item.metadata as Record<string, string> });
  }
  return Object.freeze({ memoryId, content: Object.freeze({ text }), scope: Object.freeze({ agentId: optionalString(scope.agentId, operation, 'memory.scope.agentId'), sessionId: optionalString(scope.sessionId, operation, 'memory.scope.sessionId'), userId: optionalString(scope.userId, operation, 'memory.scope.userId') }),
    metadata, createdAt: optionalString(item.createdAt, operation, 'memory.createdAt'), updatedAt: optionalString(item.updatedAt, operation, 'memory.updatedAt') });
}
function page<T>(body: Record<string, unknown>, operation: MemoryOperation, parse: (item: unknown) => T): Page<T> {
  for (const key of ['maxResults', 'totalCount']) if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== 'number' || !Number.isInteger(body[key]))) throw new MemoryContractError(operation, `body.${key} must be an integer`);
  return Object.freeze({ items: Object.freeze(array(body.items, operation, 'body.items').map(parse)), maxResults: body.maxResults == null ? undefined : body.maxResults as number,
    totalCount: body.totalCount == null ? undefined : body.totalCount as number, nextToken: optionalString(body.nextToken, operation, 'body.nextToken') || undefined });
}
