import { AgentCoreError } from '../errors';
import { type Logger, nullLogger } from '../logging';
import { RequestContext, useContext } from '../runtime/context';
import { parseCollaborationContext, useCollaborationContext } from '../collaboration/context';
import { AgentEvent, EventType, type AgentRequest, type AgentResult, type AgentOutput } from './model';

export type InvokeHandler = (request: AgentRequest, context: RequestContext) => AgentResult | Promise<AgentResult>;

export class AgentInvoker {
  constructor(private handler?: InvokeHandler, readonly logger: Logger = nullLogger) {}
  get configured(): boolean { return this.handler !== undefined; }
  setHandler(handler: InvokeHandler): void { this.handler = handler; }

  async *invokeStream(request: AgentRequest): AsyncGenerator<AgentEvent> {
    if (!this.handler) throw new Error('AgentCore handler is not configured');
    const context = new RequestContext(Object.fromEntries(request.rawRequest.headers));
    const fields = { protocol: request.protocol, requestId: context.headers['x-request-id'],
      sessionId: context.headers['x-agentcore-session-id'] };
    this.logger.info('agentcore.server.invoke.started', fields);
    try {
      request.signal.throwIfAborted();
      const collaboration = parseCollaborationContext(context.headers);
      const run = <T>(callback: () => T) => useContext(context, () => useCollaborationContext(collaboration, callback));
      const result = await run(() => this.handler!(request, context));
      const iterator = iterate(result)[Symbol.asyncIterator]();
      try {
        for (;;) {
          request.signal.throwIfAborted();
          // Async generators run at next(), not at construction time.
          const item = await run(() => iterator.next());
          if (item.done) break;
          request.signal.throwIfAborted();
          const event = normalize(item.value);
          if (event) yield event;
        }
      } finally { await run(() => iterator.return?.(undefined)); }
    } catch (error) {
      if (request.signal.aborted) this.logger.info('agentcore.server.invoke.cancelled', fields);
      else this.logger.error('agentcore.server.invoke.failed', { ...fields, ...failureFields(error) });
      throw error;
    }
    this.logger.info('agentcore.server.invoke.succeeded', fields);
  }
  async invoke(request: AgentRequest): Promise<AgentEvent[]> {
    const events = [];
    for await (const event of this.invokeStream(request)) events.push(event);
    return events;
  }
}
async function* iterate(result: AgentResult): AsyncGenerator<AgentOutput> {
  if (result != null && typeof result === 'object' && Symbol.asyncIterator in result) yield* result;
  else if (result != null && typeof result === 'object' && Symbol.iterator in result) yield* result;
  else yield result as AgentOutput;
}
function normalize(value: AgentOutput): AgentEvent | undefined {
  if (value == null || value === '') return;
  if (typeof value === 'string') return new AgentEvent(EventType.TEXT, { delta: value });
  if (!(value instanceof AgentEvent)) throw new TypeError('handler must return text, AgentEvent, or an event iterable');
  if (value.event !== EventType.TOOL_CALL) return value;
  const args = value.data.args ?? '';
  return new AgentEvent(EventType.TOOL_CALL_CHUNK, { id: value.data.id ?? '', name: value.data.name ?? '',
    args_delta: typeof args === 'string' ? args : JSON.stringify(args) });
}
export function errorCode(error: unknown): string { return error instanceof AgentCoreError ? error.code : 'INTERNAL_ERROR'; }
export function failureFields(error: unknown) {
  return { code: errorCode(error), errorType: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
}
