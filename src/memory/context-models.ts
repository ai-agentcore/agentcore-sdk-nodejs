import type { AccessKeyCredential, CredentialProvider } from '../auth/access-key';
import type { Logger } from '../logging';
import type { Memory, MemoryScope } from './models';

export const MemoryType = Object.freeze({
  Semantic: 'semantic',
  Skill: 'skill',
  UserProfile: 'user_profile',
  SessionSummary: 'session_summary',
} as const satisfies Record<string, string>);
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type EventData = Readonly<Record<string, JsonValue>>;
export type ContentBlock = EventData & { readonly type: string };
export type MessageRole = 'user' | 'assistant' | 'system' | 'developer' | 'tool';
type EventBase<T extends string, D> = Readonly<{ type: T; timestamp: number; data: D & EventData }>;
export type MessageEvent = EventBase<
  'message',
  {
    readonly role: MessageRole;
    readonly content: readonly JsonValue[];
    readonly callId?: string;
  }
>;
export type SourceEvent =
  | MessageEvent
  | EventBase<'tool_call', { readonly callId: string; readonly name: string; readonly arguments: JsonValue }>
  | EventBase<
      'tool_result',
      { readonly callId: string; readonly status: EventStatus; readonly content: readonly JsonValue[] }
    >
  | EventBase<'model_request', { readonly input: readonly JsonValue[] }>
  | EventBase<'model_response', { readonly status: EventStatus }>;
export type EventStatus = 'succeeded' | 'failed' | 'cancelled';
export type ContextEvent = SourceEvent;

export interface ContextMemory extends Memory {
  readonly type?: MemoryType;
  readonly source?: string;
  readonly valid?: boolean;
  readonly sourceEventIds?: readonly string[];
  readonly version?: string | number;
}
export interface ContextMemorySearchHit {
  readonly memory: ContextMemory;
  readonly score: number;
  readonly similarity: number;
}
export interface ContextMemorySearchResult {
  readonly memories: readonly ContextMemorySearchHit[];
  readonly requestId?: string;
}
export interface ContextMemorySearchOptions {
  readonly scope?: MemoryScope;
  readonly types?: readonly MemoryType[];
  readonly topK?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly enableRerank?: boolean;
  readonly minSimilarity?: number;
  readonly minScore?: number;
}
export type EventReceipt =
  | Readonly<{ kind: 'stored'; inputIndex: number; status: 'STORED'; eventId: string; code?: string; message?: string }>
  | Readonly<{ kind: 'other'; inputIndex: number; status: string; eventId?: string; code?: string; message?: string }>;
export interface CreateEventsResult {
  readonly results: readonly EventReceipt[];
  readonly requestId?: string;
}
/** ListEvents rows are service envelopes. Keep additional fields for reconciliation. */
export interface ContextEventRecord {
  readonly [key: string]: JsonValue;
}
export interface EventPage {
  readonly items: readonly ContextEventRecord[];
  readonly nextToken?: string;
  readonly maxResults?: number;
  readonly totalCount?: number;
  readonly requestId?: string;
}
export interface ListEventsOptions {
  readonly scope?: MemoryScope;
  readonly nextToken?: string;
  readonly maxResults?: number;
}
export interface MemoryCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface ContextMemoryClientOptions {
  readonly workspaceId: string;
  readonly memoryStoreName: string;
  readonly regionId: string;
  readonly endpoint?: string;
  readonly accessKeyCredential?: AccessKeyCredential;
  readonly resourceSTSProvider?: CredentialProvider;
  readonly logger?: Logger;
}
