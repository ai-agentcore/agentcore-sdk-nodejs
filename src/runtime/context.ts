import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
import { ContextError } from '../errors';

export class RequestContext {
  readonly headers: Readonly<Record<string, string>>;
  constructor(headers: Readonly<Record<string, string>>) {
    this.headers = Object.freeze(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
  }
  [inspect.custom](): string { return 'RequestContext(headers=<redacted>)'; }
  toJSON(): string { return this[inspect.custom](); }
}
const context = new AsyncLocalStorage<RequestContext>();
export function currentContext(required = true): RequestContext | undefined {
  const value = context.getStore();
  if (!value && required) throw new ContextError('no AgentCore request context is active');
  return value;
}
export function useContext<T>(value: RequestContext, callback: () => T): T {
  return context.run(value, callback);
}
