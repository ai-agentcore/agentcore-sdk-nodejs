import { MemoryValidationError } from '../errors';
import type { ContextEvent as Event, JsonValue, SourceEvent } from './context-models';
export type ContextEvent = Event;

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function json(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => json(item, seen))
    : object(value) && Object.values(value).every((item) => json(item, seen));
  seen.delete(value);
  return valid;
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const content = (value: unknown): boolean =>
  Array.isArray(value) && value.every((block) => object(block) && nonempty(block.type));
const eventStatus = (value: unknown): boolean => value === 'succeeded' || value === 'failed' || value === 'cancelled';
function sourceEvent(value: unknown): value is SourceEvent {
  if (
    !json(value) ||
    !object(value) ||
    !Number.isSafeInteger(value.timestamp) ||
    Number(value.timestamp) < 0 ||
    !object(value.data)
  )
    return false;
  const data = value.data;
  switch (value.type) {
    case 'message':
      return (
        typeof data.role === 'string' &&
        ['user', 'assistant', 'system', 'developer', 'tool'].includes(data.role) &&
        content(data.content) &&
        (data.callId === undefined || nonempty(data.callId)) &&
        (data.role !== 'tool' || nonempty(data.callId))
      );
    case 'tool_call':
      return nonempty(data.callId) && nonempty(data.name) && 'arguments' in data;
    case 'tool_result':
      return nonempty(data.callId) && eventStatus(data.status) && content(data.content);
    case 'model_request':
      return Array.isArray(data.input);
    case 'model_response':
      return eventStatus(data.status);
    default:
      return false;
  }
}

/** Validate, copy and freeze JSON so requests cannot change during credential acquisition. */
export function immutableJson(value: unknown): JsonValue {
  if (!json(value)) throw new MemoryValidationError('event fields must be finite, acyclic JSON values');
  return canonical(value);
}
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => canonical(item)));
  if (jsonObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      ),
    );
  }
  return value;
}
function jsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalJson(value: JsonValue): string {
  if (jsonObject(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return JSON.stringify(value);
}
export function parseContextEvent(value: unknown): Event {
  const copy = immutableJson(value);
  if (!sourceEvent(copy)) throw new MemoryValidationError('invalid Context event');
  return copy;
}

function wireContent(value: JsonValue): JsonValue {
  if (!object(value) || value.type !== 'opaque') return value;
  if (!nonempty(value.format) || !('value' in value))
    throw new MemoryValidationError('source opaque content requires format and value');
  if (value.format.endsWith(';encoding=json') && typeof value.value === 'string') {
    try {
      return { ...value, value: canonicalJson(immutableJson(JSON.parse(value.value))) };
    } catch {
      throw new MemoryValidationError('opaque encoding=json value must contain valid JSON');
    }
  }
  return { ...value, format: `${value.format};encoding=json`, value: canonicalJson(immutableJson(value.value)) };
}

/** The core owns the deployed message-envelope mapping for all five source variants. */
export function contextEventFromSource(value: unknown): Event {
  const event = immutableJson(value);
  if (!sourceEvent(event)) throw new MemoryValidationError('invalid source event');
  if (event.type === 'message')
    return parseContextEvent({ ...event, data: { ...event.data, content: event.data.content.map(wireContent) } });
  const role = event.type === 'tool_result' ? 'tool' : 'assistant';
  return parseContextEvent({
    type: 'message',
    timestamp: event.timestamp,
    data: {
      role,
      ...(event.type === 'tool_result' ? { callId: event.data.callId } : {}),
      content: [{ type: 'opaque', format: `harness.${event.type};encoding=json`, value: canonicalJson(event.data) }],
    },
  });
}
export const ContextEvent = Object.freeze({ fromSource: contextEventFromSource, typed: parseContextEvent });
