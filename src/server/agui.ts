import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RunAgentInputSchema } from '@ag-ui/core';
import { AgentInvoker, errorCode, failureFields } from './invoker';
import { AgentEvent, EventType, type AgentRequest, type Message } from './model';
import type { ProtocolHandler } from './protocol';
import { eventStream, sse } from './sse';

export class AGUIProtocolHandler implements ProtocolHandler {
  readonly name = 'ag-ui';
  constructor(readonly prefix = '/ag-ui/agent') {}
  routes(invoker: AgentInvoker): Hono {
    const app = new Hono();
    app.post(this.prefix, async c => {
      if (!invoker.configured) return c.json({ error: { code: 'HANDLER_NOT_CONFIGURED' } }, 503);
      let request: AgentRequest, threadId: string, runId: string;
      try {
        const payload = await c.req.json();
        const parsed = RunAgentInputSchema.parse(payload);
        threadId = parsed.threadId; runId = parsed.runId;
        const messages: Message[] = parsed.messages.map(message => ({
          role: message.role, id: message.id, name: 'name' in message ? message.name : undefined,
          content: 'content' in message ? message.content as Message['content'] : undefined,
          toolCalls: 'toolCalls' in message ? message.toolCalls : undefined,
          toolCallId: 'toolCallId' in message ? message.toolCallId : undefined,
        }));
        const tools = parsed.tools.map(tool => {
          if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw new Error('tool parameters must be an object');
          return { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> };
        });
        request = { protocol: 'agui', messages, tools, stream: true,
          rawRequest: c.req.raw, rawPayload: payload, signal: c.req.raw.signal };
      } catch {
        return eventStream(c, async function* () { yield sse({ type: 'RUN_ERROR', message: 'invalid request', code: 'INVALID_REQUEST' }); });
      }
      return eventStream(c, signal => formatStream(invoker, { ...request, signal }, threadId, runId));
    });
    return app;
  }
}

class StreamState {
  textId?: string;
  reasoningId?: string;
  tools = new Set<string>();
  toolIds = new Set<string>();
  textIds = new Set<string>();
  reasoningIds = new Set<string>();
  finishIdentified(reasoning: boolean, messageId?: string): Record<string, unknown>[] {
    const active = reasoning ? this.reasoningIds : this.textIds;
    return (messageId === undefined ? [...active] : [messageId]).flatMap(id => {
      if (!active.delete(id)) return [];
      return reasoning ? [{ type: 'REASONING_MESSAGE_END', messageId: id }, { type: 'REASONING_END', messageId: id }]
        : [{ type: 'TEXT_MESSAGE_END', messageId: id }];
    });
  }
  finishText(): Record<string, unknown>[] {
    if (!this.textId) return [];
    const messageId = this.textId; this.textId = undefined;
    return [{ type: 'TEXT_MESSAGE_END', messageId }];
  }
  finishReasoning(): Record<string, unknown>[] {
    if (!this.reasoningId) return [];
    const messageId = this.reasoningId; this.reasoningId = undefined;
    return [{ type: 'REASONING_MESSAGE_END', messageId }, { type: 'REASONING_END', messageId }];
  }
  finishTool(toolCallId: string): Record<string, unknown>[] {
    return this.tools.delete(toolCallId) ? [{ type: 'TOOL_CALL_END', toolCallId }] : [];
  }
  finishTools(): Record<string, unknown>[] { return [...this.tools].flatMap(id => this.finishTool(id)); }
  consume(event: AgentEvent): Record<string, unknown>[] {
    const data = event.data;
    const identity = typeof data.message_id === 'string' ? data.message_id : undefined;
    if (event.event === EventType.TEXT_END) return [...(identity === undefined ? this.finishText() : []), ...this.finishIdentified(false, identity)];
    if (event.event === EventType.REASONING_END) return [...(identity === undefined ? this.finishReasoning() : []), ...this.finishIdentified(true, identity)];
    if (event.event === EventType.TEXT || event.event === EventType.REASONING) {
      const reasoning = event.event === EventType.REASONING;
      const events = [...(reasoning ? this.finishText() : this.finishReasoning()), ...this.finishTools()];
      if (identity) events.push(...(reasoning ? this.finishReasoning() : this.finishText()));
      const active = reasoning ? this.reasoningIds : this.textIds;
      let messageId = identity ?? (reasoning ? this.reasoningId : this.textId);
      if (identity ? !active.has(identity) : !messageId) {
        messageId ??= randomUUID();
        if (identity) active.add(identity);
        else if (reasoning) this.reasoningId = messageId;
        else this.textId = messageId;
        if (reasoning) {
          events.push({ type: 'REASONING_START', messageId });
        }
        events.push({ type: reasoning ? 'REASONING_MESSAGE_START' : 'TEXT_MESSAGE_START', messageId,
          role: reasoning ? 'reasoning' : 'assistant' });
      }
      if (typeof data.delta === 'string' && data.delta) events.push({
        type: reasoning ? 'REASONING_MESSAGE_CONTENT' : 'TEXT_MESSAGE_CONTENT', messageId, delta: data.delta,
      });
      return events;
    }
    if (event.event === EventType.TOOL_CALL_CHUNK || event.event === EventType.TOOL_RESULT) {
      if (typeof data.id !== 'string' || !data.id) return [];
      const toolCallId = data.id, events = [...this.finishText(), ...this.finishReasoning()];
      if (!this.toolIds.has(toolCallId)) {
        this.tools.add(toolCallId);
        this.toolIds.add(toolCallId);
        events.push({ type: 'TOOL_CALL_START', toolCallId, toolCallName: data.name ?? '' });
      }
      if (event.event === EventType.TOOL_CALL_CHUNK) {
        if (typeof data.args_delta === 'string' && data.args_delta) events.push({ type: 'TOOL_CALL_ARGS', toolCallId, delta: data.args_delta });
      } else {
        events.push(...this.finishTool(toolCallId));
        events.push({ type: 'TOOL_CALL_RESULT', toolCallId, messageId: `tool-result-${toolCallId}`, role: 'tool',
          content: typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? '') });
      }
      return events;
    }
    return [event.toJSON()];
  }
}
async function* formatStream(invoker: AgentInvoker, request: AgentRequest, threadId: string, runId: string): AsyncGenerator<string> {
  const state = new StreamState();
  yield sse({ type: 'RUN_STARTED', threadId, runId });
  try {
    for await (const event of invoker.invokeStream(request)) {
      if (event.event === EventType.ERROR) {
        yield sse({ type: 'RUN_ERROR', message: event.data.message || 'agent failed', code: event.data.code }); return;
      }
      for (const encoded of state.consume(event)) yield sse(encoded);
    }
  } catch (error) {
    if (request.signal.aborted) return;
    invoker.logger.error('agentcore.server.agui.stream.failed', { ...failureFields(error), threadId, runId,
      requestId: request.rawRequest.headers.get('x-request-id') ?? undefined });
    yield sse({ type: 'RUN_ERROR', message: 'handler failed', code: errorCode(error) }); return;
  }
  for (const encoded of [...state.finishReasoning(), ...state.finishTools(), ...state.finishText(),
    ...state.finishIdentified(false), ...state.finishIdentified(true)]) yield sse(encoded);
  yield sse({ type: 'RUN_FINISHED', threadId, runId });
}
