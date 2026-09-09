import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { AgentCoreError, ConfigError, ContextError } from '../errors';
import { AgentInvoker, errorCode, failureFields } from './invoker';
import { AgentEvent, EventType, type AgentRequest, type Message, type AgentTool } from './model';
import type { ProtocolHandler } from './protocol';
import { eventStream, sse } from './sse';

export class OpenAIProtocolHandler implements ProtocolHandler {
  readonly name = 'openai_chat_completions';
  constructor(readonly prefix = '/openai/v1', readonly modelName = 'agentcore') {}
  routes(invoker: AgentInvoker): Hono {
    const app = new Hono();
    app.get(`${this.prefix}/models`, c => c.json({ object: 'list', data: [{
      id: this.modelName, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'agentcore',
    }] }));
    app.post(`${this.prefix}/chat/completions`, async c => {
      if (!invoker.configured) return c.json({ error: { message: 'handler is not configured', type: 'server_error' } }, 503);
      let request: AgentRequest;
      try { request = parseOpenAI(c.req.raw, await c.req.json()); }
      catch { return c.json({ error: { message: 'invalid request', type: 'invalid_request_error' } }, 400); }
      const model = text(request.rawPayload.model) || this.modelName;
      if (request.stream) return eventStream(c, signal => formatStream(invoker, { ...request, signal }, model));
      try {
        const state = new CompletionState();
        for (const event of await invoker.invoke(request)) {
          if (event.event === EventType.ERROR) throw new Error('agent reported an error');
          state.consume(event);
        }
        return c.json({ ...completion(model), object: 'chat.completion', choices: [{ index: 0,
          message: { role: 'assistant', content: state.content.join('') || null,
            ...(state.reasoning.length ? { reasoning_content: state.reasoning.join('') } : {}),
            ...(state.calls.size ? { tool_calls: [...state.calls.values()].map(({ id, name, args }) => ({
              id, type: 'function', function: { name, arguments: args },
            })) } : {}) }, finish_reason: state.finishReason,
        }] });
      } catch (error) {
        const invalid = error instanceof ConfigError || error instanceof ContextError;
        return c.json({ error: { message: error instanceof AgentCoreError ? error.message : 'handler failed',
          type: invalid ? 'invalid_request_error' : 'server_error', code: errorCode(error) } },
        invalid ? 400 : error instanceof AgentCoreError ? 502 : 500);
      }
    });
    return app;
  }
}

function parseOpenAI(rawRequest: Request, value: unknown): AgentRequest {
  const payload = object(value);
  if (!Array.isArray(payload.messages)) throw new Error('messages must be an array');
  const messages = payload.messages.map(value => {
    const item = object(value);
    if (!['developer', 'system', 'user', 'assistant', 'tool'].includes(String(item.role))) throw new Error('invalid role');
    let toolCalls: Message['toolCalls'];
    if (item.tool_calls != null) {
      if (!Array.isArray(item.tool_calls)) throw new Error('invalid tool_calls');
      toolCalls = item.tool_calls.map(value => {
        const call = object(value);
        if (!text(call.id)) throw new Error('tool id is required');
        return { id: call.id as string, type: text(call.type) || 'function', function: object(call.function) };
      });
    }
    return { role: item.role as Message['role'], content: item.content as Message['content'],
      id: text(item.id), name: text(item.name), toolCalls, toolCallId: text(item.tool_call_id) };
  });
  let tools: AgentTool[] | undefined;
  if (payload.tools != null) {
    if (!Array.isArray(payload.tools)) throw new Error('tools must be an array');
    tools = payload.tools.map(value => {
      const item = object(value), fn = object(item.function);
      if ((item.type ?? 'function') !== 'function' || !text(fn.name)) throw new Error('invalid function tool');
      if (fn.description !== undefined && typeof fn.description !== 'string') throw new Error('invalid description');
      return { name: fn.name as string, description: fn.description as string ?? '', parameters: object(fn.parameters ?? {}) };
    });
  }
  return { protocol: 'openai', messages, tools, stream: payload.stream === true,
    rawRequest, rawPayload: payload, signal: rawRequest.signal };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  return value as Record<string, unknown>;
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function completion(model: string) { return { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model }; }
class CompletionState {
  readonly content: string[] = [];
  readonly reasoning: string[] = [];
  readonly calls = new Map<string, { id: string; index: number; name: string; args: string }>();
  get finishReason(): string { return this.calls.size ? 'tool_calls' : 'stop'; }
  consume(event: AgentEvent): Record<string, unknown>[] {
    const data = event.data;
    if (event.event === EventType.TEXT || event.event === EventType.REASONING) {
      if (typeof data.delta !== 'string' || !data.delta) return [];
      (event.event === EventType.TEXT ? this.content : this.reasoning).push(data.delta);
      return [{ [event.event === EventType.TEXT ? 'content' : 'reasoning_content']: data.delta }];
    }
    if (event.event !== EventType.TOOL_CALL_CHUNK || typeof data.id !== 'string' || !data.id) return [];
    const deltas: Record<string, unknown>[] = [];
    let call = this.calls.get(data.id);
    if (!call) {
      call = { id: data.id, index: this.calls.size, name: text(data.name) || '', args: '' };
      this.calls.set(call.id, call);
      deltas.push({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] });
    }
    if (text(data.name)) call.name = text(data.name)!;
    if (typeof data.args_delta === 'string' && data.args_delta) {
      call.args += data.args_delta;
      deltas.push({ tool_calls: [{ index: call.index, function: { arguments: data.args_delta } }] });
    }
    return deltas;
  }
}
async function* formatStream(invoker: AgentInvoker, request: AgentRequest, model: string): AsyncGenerator<string> {
  const base = { ...completion(model), object: 'chat.completion.chunk' }, state = new CompletionState();
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => sse({ ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }] });
  yield chunk({ role: 'assistant' });
  let failed = false;
  try {
    for await (const event of invoker.invokeStream(request)) {
      if (event.event === EventType.ERROR) {
        yield sse({ error: { message: 'handler failed', type: 'server_error' } }); failed = true; break;
      }
      for (const delta of state.consume(event)) yield chunk(delta);
    }
  } catch (error) {
    if (request.signal.aborted) return;
    invoker.logger.error('agentcore.server.openai.stream.failed', { ...failureFields(error), requestId: request.rawRequest.headers.get('x-request-id') ?? undefined });
    yield sse({ error: { message: 'handler failed', type: 'server_error', code: errorCode(error) } }); failed = true;
  }
  if (!failed) yield chunk({}, state.finishReason);
  yield 'data: [DONE]\n\n';
}
