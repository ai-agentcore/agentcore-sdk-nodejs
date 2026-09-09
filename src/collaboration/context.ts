import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
import { CollaborationContextError, CollaborationContextRequiredError } from './errors';

export class CollaborationTurnContext {
  constructor(readonly sessionId: string | undefined, readonly teamId: string | undefined,
    readonly roomId: string, readonly eventId: string, readonly roomKind: 'dm' | 'group' | 'task') { Object.freeze(this); }
  [inspect.custom](): string { return 'CollaborationTurnContext(<redacted>)'; }
  toJSON(): string { return this[inspect.custom](); }
}
const context = new AsyncLocalStorage<CollaborationTurnContext | undefined>();
export function currentCollaborationContext(required?: true): CollaborationTurnContext;
export function currentCollaborationContext(required: false): CollaborationTurnContext | undefined;
export function currentCollaborationContext(required = true): CollaborationTurnContext | undefined {
  const value = context.getStore();
  if (!value && required) throw new CollaborationContextRequiredError('No collaboration request context is active.');
  return value;
}
export function useCollaborationContext<T>(value: CollaborationTurnContext | undefined, callback: () => T): T { return context.run(value, callback); }
export function bindCollaborationContext<T>(headers: Readonly<Record<string, string>>, callback: () => T): T {
  return useCollaborationContext(parseCollaborationContext(headers), callback);
}
export function parseCollaborationContext(headers: Readonly<Record<string, string>>): CollaborationTurnContext | undefined {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const encoded = normalized['x-agentcore-collaboration-context'];
  if (encoded === undefined) return;
  let data: Record<string, unknown>;
  try {
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) throw new Error('base64');
    data = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(encoded, 'base64url')));
    if (!data || Array.isArray(data) || data.version !== 1) throw new Error('schema');
  } catch { throw new CollaborationContextError('collaboration context header is invalid'); }
  const field = (name: string, required = true): string | undefined => {
    const value = data[name];
    if (value == null && !required) return;
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new CollaborationContextError(`collaboration context ${name} is invalid`);
    return value.trim();
  };
  const kind = field('roomKind');
  if (kind !== 'dm' && kind !== 'group' && kind !== 'task') throw new CollaborationContextError('collaboration context roomKind is invalid');
  return new CollaborationTurnContext(normalized['x-agentcore-session-id']?.trim() || undefined,
    field('teamId', kind === 'task'), field('roomId')!, field('eventId')!, kind);
}
