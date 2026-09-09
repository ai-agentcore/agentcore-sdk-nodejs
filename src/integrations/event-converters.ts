import { randomUUID } from 'node:crypto';
import { AgentEvent, EventType } from '../server/model';

// These adapters accept native framework events, including framework extension fields.
type NativeEvent = Record<string, any>;
const endText = () => new AgentEvent(EventType.TEXT_END, {});
function messageEvents(message: any): AgentEvent[] {
  const blocks = message?.contentBlocks ?? (typeof message?.content === 'string'
    ? [{ type: 'text', text: message.content }] : message?.content ?? []);
  return blocks.flatMap((block: any) => {
    if (block.type !== 'text' && block.type !== 'reasoning') return [];
    const delta = block.type === 'text' ? block.text : block.reasoning;
    return delta ? [new AgentEvent(block.type === 'text' ? EventType.TEXT : EventType.REASONING,
      { delta })] : [];
  });
}

abstract class EventConverter {
  abstract convert(event: NativeEvent): AgentEvent[];
  /** One converter per invocation; supply the entire framework event stream. */
  async *stream(events: AsyncIterable<NativeEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of events) yield* this.convert(event);
  }
}

/** streamEvents(version: 'v2'); emit complete arguments once at model end. */
export class LangChainEventConverter extends EventConverter {
  private readonly streamed = new Map<string, Set<string>>();
  private readonly messages = new Map<string, AgentEvent>();
  private readonly segments = new Map<string, number>();
  private readonly calls = new Set<string>();
  private readonly results = new Set<string>();
  convert(event: NativeEvent): AgentEvent[] {
    const data = event.data ?? {}, runId = event.run_id;
    if (event.event === 'on_chat_model_stream') {
      const events = messageEvents(data.chunk);
      const kinds = this.streamed.get(runId) ?? new Set<string>();
      events.forEach(e => kinds.add(e.type));
      this.streamed.set(runId, kinds);
      return this.withMessageIds(runId, events);
    } else if (event.event === 'on_chat_model_end') {
      const output = data.output, streamed = this.streamed.get(runId);
      const events = this.withMessageIds(runId, messageEvents(output).filter(e => !streamed?.has(e.type)));
      this.streamed.delete(runId);
      events.push(...this.endMessage(runId));
      this.segments.delete(runId);
      for (const call of output?.tool_calls ?? []) {
        this.calls.add(call.id);
        events.push(new AgentEvent(EventType.TOOL_CALL, { id: call.id, name: call.name, args: call.args }));
      }
      return events;
    } else if (event.event === 'on_tool_end') {
      return this.toolResult(data.output);
    } else if (event.event === 'on_chain_end') {
      // Handled ToolNode failures have no on_tool_end. Root snapshots repeat
      // results and history, so only forward calls observed in this invocation.
      const messages = Array.isArray(data.output) ? data.output : data.output?.messages ?? [];
      return messages.filter((message: any) => (message?.type ?? message?._getType?.()) === 'tool'
        && this.calls.has(message.tool_call_id)).flatMap((message: any) => this.toolResult(message));
    }
    return [];
  }
  private toolResult(message: any): AgentEvent[] {
    const id = message?.tool_call_id;
    if (!id || this.results.has(id)) return [];
    this.results.add(id);
    return [new AgentEvent(EventType.TOOL_RESULT, { id, name: message.name, result: message.content })];
  }
  private endMessage(runId: string): AgentEvent[] {
    const previous = this.messages.get(runId);
    this.messages.delete(runId);
    return previous ? [new AgentEvent(previous.event === EventType.TEXT ? EventType.TEXT_END : EventType.REASONING_END,
      { message_id: previous.data.message_id })] : [];
  }
  private withMessageIds(runId: string, events: AgentEvent[]): AgentEvent[] {
    const converted: AgentEvent[] = [];
    for (const event of events) {
      const previous = this.messages.get(runId);
      let messageId = previous?.data.message_id;
      if (!previous || previous.event !== event.event) {
        converted.push(...this.endMessage(runId));
        const segment = (this.segments.get(runId) ?? 0) + 1;
        this.segments.set(runId, segment);
        messageId = `${runId}:${segment}`;
      }
      const identified = new AgentEvent(event.event, { ...event.data, message_id: messageId });
      this.messages.set(runId, identified);
      converted.push(identified);
    }
    return converted;
  }
}

/** ADK runAsync events; final snapshots must not duplicate partial text. */
export class GoogleADKEventConverter extends EventConverter {
  private readonly partial = new Set<string>();
  private readonly calls = new Set<string>();
  convert(event: NativeEvent): AgentEvent[] {
    if (event.errorCode) return [new AgentEvent(EventType.ERROR, { code: event.errorCode, message: event.errorMessage })];
    const events: AgentEvent[] = [], author = event.author;
    for (const part of event.content?.parts ?? []) {
      if (part.text && (event.partial || !this.partial.has(author))) events.push(new AgentEvent(
        part.thought ? EventType.REASONING : EventType.TEXT, { delta: part.text },
      ));
      const call = part.functionCall;
      if (call && !this.calls.has(call.id)) {
        this.calls.add(call.id);
        events.push(new AgentEvent(EventType.TOOL_CALL, { id: call.id, name: call.name, args: call.args }));
      }
      const result = part.functionResponse;
      if (result) events.push(new AgentEvent(EventType.TOOL_RESULT, { id: result.id, name: result.name, result: result.response }));
    }
    if (event.partial) this.partial.add(author);
    else {
      this.partial.delete(author);
      events.push(endText(), new AgentEvent(EventType.REASONING_END, {}));
    }
    return events;
  }
}

/** Vercel AI SDK fullStream. TextStream alone has already lost tool events. */
export class AISDKEventConverter extends EventConverter {
  private textId?: string;
  convert(event: NativeEvent): AgentEvent[] {
    switch (event.type) {
      case 'text-start': this.textId = randomUUID(); return [];
      case 'text-delta': return [new AgentEvent(EventType.TEXT, { delta: event.text, message_id: this.textId })];
      case 'text-end': return [endText()];
      case 'reasoning-delta': return [new AgentEvent(EventType.REASONING, { delta: event.text })];
      case 'reasoning-end': return [new AgentEvent(EventType.REASONING_END, {})];
      case 'tool-call': return [new AgentEvent(EventType.TOOL_CALL, { id: event.toolCallId, name: event.toolName, args: event.input })];
      case 'tool-result': return [new AgentEvent(EventType.TOOL_RESULT, { id: event.toolCallId, name: event.toolName, result: event.output })];
      case 'tool-error': return [new AgentEvent(EventType.TOOL_RESULT, { id: event.toolCallId, name: event.toolName, result: String(event.error) })];
      case 'error': throw event.error;
      default: return [];
    }
  }
}

/** Mastra fullStream has payload-wrapped events, unlike AI SDK fullStream. */
export class MastraEventConverter extends EventConverter {
  private textId?: string;
  convert(event: NativeEvent): AgentEvent[] {
    const data = event.payload ?? {};
    switch (event.type) {
      case 'text-start': this.textId = randomUUID(); return [];
      case 'text-delta': return [new AgentEvent(EventType.TEXT, { delta: data.text, message_id: this.textId })];
      case 'text-end': return [endText()];
      case 'reasoning-delta': return [new AgentEvent(EventType.REASONING, { delta: data.text })];
      case 'reasoning-end': return [new AgentEvent(EventType.REASONING_END, {})];
      case 'tool-call': return [new AgentEvent(EventType.TOOL_CALL, { id: data.toolCallId, name: data.toolName, args: data.args })];
      case 'tool-result': return [new AgentEvent(EventType.TOOL_RESULT, { id: data.toolCallId, name: data.toolName, result: data.result })];
      case 'error': throw data.error;
      default: return [];
    }
  }
}
