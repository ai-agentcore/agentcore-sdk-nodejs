export interface MemoryScope { readonly agentId?: string; readonly sessionId?: string; readonly userId?: string; }
export interface MemoryMessage { readonly role: string; readonly content: string; }
export interface MemoryContent { readonly text: string; }
export interface Memory {
  readonly memoryId: string;
  readonly content: MemoryContent;
  readonly scope: MemoryScope;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}
export interface MemorySearchHit { readonly memory: Memory; readonly score: number; readonly similarity: number; }
export interface AddMemoriesResult { readonly memoryIds: readonly string[]; }
export interface SearchMemoriesResult { readonly memories: readonly MemorySearchHit[]; }
export interface MemorySession { readonly agentId?: string; readonly sessionId?: string; readonly userId?: string; }
export interface Page<T> { readonly items: readonly T[]; readonly maxResults?: number; readonly nextToken?: string; readonly totalCount?: number; }
export type AddMemoriesOptions = {
  scope?: MemoryScope;
  metadata?: Readonly<Record<string, string>>;
} & ({ text: string; messages?: never } | { text?: never; messages: readonly MemoryMessage[] });
export interface SearchMemoriesOptions {
  scope?: MemoryScope;
  topK?: number;
  metadata?: Readonly<Record<string, string>>;
  enableRerank?: boolean;
  minSimilarity?: number;
  minScore?: number;
}
export interface PageOptions { maxResults?: number; nextToken?: string; }
export interface ListMemoriesOptions extends PageOptions { agentId?: string; sessionId?: string; userId?: string; }
export interface ListMemorySessionsOptions extends PageOptions { agentId?: string; userId?: string; }
export interface ListMemorySessionMessagesOptions extends PageOptions { agentId?: string; userId?: string; }
export interface UpdateMemoryOptions { text?: string; metadata?: Readonly<Record<string, string>>; }
