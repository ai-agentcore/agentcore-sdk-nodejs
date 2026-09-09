export type MessageRole = 'developer' | 'system' | 'user' | 'assistant' | 'tool' | 'activity' | 'reasoning';
export interface ToolCall { id: string; type: string; function: Record<string, unknown>; }
export interface Message {
  role: MessageRole;
  content?: string | ReadonlyArray<Record<string, unknown>> | null;
  id?: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface AgentTool { name: string; description: string; parameters: Record<string, unknown>; }
export interface AgentRequest {
  protocol: string;
  messages: Message[];
  tools?: AgentTool[];
  stream: boolean;
  rawRequest: Request;
  rawPayload: Record<string, unknown>;
  /** Forward this signal to model/tool calls and any long-running application work. */
  signal: AbortSignal;
}
export const EventType = {
  TEXT: 'TEXT', TEXT_END: 'TEXT_END', REASONING: 'REASONING', REASONING_END: 'REASONING_END', TOOL_CALL: 'TOOL_CALL',
  TOOL_CALL_CHUNK: 'TOOL_CALL_CHUNK', TOOL_RESULT: 'TOOL_RESULT', ERROR: 'ERROR',
} as const;
export class AgentEvent {
  constructor(readonly event: string, readonly data: Record<string, unknown>) {}
  get type(): string { return this.event; }
  toJSON(): Record<string, unknown> { return { ...this.data, type: this.event }; }
}
export type AgentOutput = string | AgentEvent | undefined | null;
export type AgentResult = AgentOutput | Iterable<AgentOutput> | AsyncIterable<AgentOutput>;
