import type { Hono } from 'hono';
import type { AgentInvoker } from './invoker';

/** Each protocol owns its routes; all protocols invoke the same application handler. */
export interface ProtocolHandler {
  readonly name: string;
  routes(invoker: AgentInvoker): Hono;
}
