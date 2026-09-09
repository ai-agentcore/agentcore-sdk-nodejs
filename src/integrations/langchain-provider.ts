import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage, type UsageMetadata } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3Message, LanguageModelV3Prompt,
  LanguageModelV3ToolChoice, LanguageModelV3Usage, LanguageModelV3FunctionTool, SharedV3ProviderOptions } from '@ai-sdk/provider';
import type { ProviderModelClient } from '../model/provider';
import { ConfigError, InvocationError } from '../errors';

export type LangChainProviderOptions = Pick<LanguageModelV3CallOptions,
  'maxOutputTokens' | 'temperature' | 'topP' | 'topK' | 'presencePenalty' | 'frequencyPenalty' | 'seed' | 'responseFormat' | 'providerOptions' | 'headers'>;
export interface ProviderChatCallOptions extends BaseChatModelCallOptions, LangChainProviderOptions { tools?: BindToolsInput[]; }

/** LangChain owns tool execution; this bridge performs one provider call per model step. */
export class ProviderChatModel extends BaseChatModel<ProviderChatCallOptions> {
  constructor(private readonly client: ProviderModelClient, private readonly defaults: LangChainProviderOptions = {}) { super({ maxRetries: 0 }); }
  _llmType(): string { return 'agentcore-provider'; }
  get callKeys(): string[] { return [...super.callKeys, 'tools', 'tool_choice', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'responseFormat', 'providerOptions', 'headers']; }
  bindTools(tools: BindToolsInput[], kwargs?: Partial<ProviderChatCallOptions>) { return this.withConfig({ ...kwargs, tools }); }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const result = await this.client.languageModel.doGenerate(this.request(messages, options));
    const content = result.content.filter(p => p.type === 'text' || p.type === 'reasoning' || p.type === 'file').map(outputPart);
    const calls = result.content.filter(p => p.type === 'tool-call');
    const message = new AIMessageChunk({ content, tool_calls: calls.map(call => ({ type: 'tool_call', id: call.toolCallId, name: call.toolName, args: JSON.parse(call.input) })),
      additional_kwargs: { agentcore_tool_metadata: Object.fromEntries(calls.map(call => [call.toolCallId, call.providerMetadata])) },
      usage_metadata: usage(result.usage), response_metadata: { finish_reason: result.finishReason.unified, providerMetadata: result.providerMetadata,
        sources: result.content.filter(p => p.type === 'source') },
    });
    return { generations: [{ text: message.text, message }] };
  }
  async *_streamResponseChunks(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      const result = await this.client.languageModel.doStream(this.request(messages, { ...options, signal }));
      const reader = result.stream.getReader();
      const blocks = new Map<string, number>(); const calls = new Map<string, number>(); let finished = false;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          const part = next.value; let message: AIMessageChunk | undefined; let text = '';
          if (part.type === 'error') throw part.error;
          if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
            const key = `${part.type}:${part.id}`;
            if (!blocks.has(key)) blocks.set(key, blocks.size);
            const index = blocks.get(key)!;
            text = part.type === 'text-delta' ? part.delta : '';
            message = new AIMessageChunk({ content: [part.type === 'text-delta'
              ? { type: 'text', text, index, providerOptions: part.providerMetadata }
              : { type: 'reasoning', reasoning: part.delta, index, providerOptions: part.providerMetadata }] });
          } else if (part.type === 'text-end' || part.type === 'reasoning-end') {
            const index = blocks.get(`${part.type === 'text-end' ? 'text' : 'reasoning'}-delta:${part.id}`);
            if (index !== undefined && part.providerMetadata) message = new AIMessageChunk({ content: [{
              type: part.type === 'text-end' ? 'text' : 'reasoning', index, providerOptions: part.providerMetadata,
            }] });
          } else if (part.type === 'tool-input-start') {
            const index = calls.size; calls.set(part.id, index);
            message = new AIMessageChunk({ content: [], tool_call_chunks: [{ type: 'tool_call_chunk', index, id: part.id, name: part.toolName, args: '' }] });
          } else if (part.type === 'tool-input-delta') {
            message = new AIMessageChunk({ content: [], tool_call_chunks: [{ type: 'tool_call_chunk', index: calls.get(part.id), args: part.delta }] });
          } else if (part.type === 'tool-call') {
            const metadata = { agentcore_tool_metadata: { [part.toolCallId]: part.providerMetadata } };
            message = new AIMessageChunk({ content: [], additional_kwargs: metadata,
              tool_call_chunks: calls.has(part.toolCallId) ? [] : [{ type: 'tool_call_chunk', index: calls.size, id: part.toolCallId, name: part.toolName, args: part.input }],
            });
            if (!calls.has(part.toolCallId)) calls.set(part.toolCallId, calls.size);
          } else if (part.type === 'file') {
            const index = blocks.size; blocks.set(`file:${index}`, index);
            message = new AIMessageChunk({ content: [{ ...outputPart(part), index }] });
          } else if (part.type === 'source') {
            message = new AIMessageChunk({ content: [], response_metadata: { sources: [part] } });
          } else if (part.type === 'finish') {
            finished = true;
            message = new AIMessageChunk({ content: [], usage_metadata: usage(part.usage),
              response_metadata: { finish_reason: part.finishReason.unified, providerMetadata: part.providerMetadata } });
          }
          if (message) {
            const chunk = new ChatGenerationChunk({ text, message }); yield chunk;
            await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
          }
        }
        if (!finished) throw new InvocationError('model stream ended without a completion event');
      } finally { reader.releaseLock(); }
    } finally { controller.abort(); }
  }
  private request(messages: BaseMessage[], options: this['ParsedCallOptions']): LanguageModelV3CallOptions {
    const settings = { ...this.defaults, ...options };
    return { prompt: prompt(messages), abortSignal: options.signal, stopSequences: options.stop,
      maxOutputTokens: settings.maxOutputTokens, temperature: settings.temperature, topP: settings.topP, topK: settings.topK,
      presencePenalty: settings.presencePenalty, frequencyPenalty: settings.frequencyPenalty, seed: settings.seed,
      responseFormat: settings.responseFormat, providerOptions: settings.providerOptions, headers: settings.headers,
      tools: options.tools?.map(item => {
        const value = convertToOpenAITool(item).function;
        return { type: 'function', name: value.name, description: value.description, inputSchema: value.parameters as LanguageModelV3FunctionTool['inputSchema'] };
      }), toolChoice: toolChoice(options.tool_choice),
    };
  }
}

type ChatPart = Extract<LanguageModelV3Message, { role: 'assistant' }>['content'][number];
type UserPart = Extract<LanguageModelV3Message, { role: 'user' }>['content'][number];
function prompt(messages: BaseMessage[]): LanguageModelV3Prompt {
  const names = new Map<string, string>(); const result: LanguageModelV3Prompt = [];
  for (const message of messages) {
    const role = message.type;
    if (role === 'system') { result.push({ role: 'system', content: message.text }); continue; }
    if (role === 'tool') {
      const id = (message as BaseMessage & { tool_call_id: string }).tool_call_id;
      const name = message.name ?? names.get(id);
      if (!name) throw new ConfigError('LangChain ToolMessage requires a matching tool call or name');
      result.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: name,
        output: { type: 'text', value: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) } }] });
      continue;
    }
    if (role !== 'human' && role !== 'ai') throw new ConfigError(`unsupported LangChain message role: ${role}`);
    const content: ChatPart[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(inputPart);
    if (role === 'ai') {
      const metadata = message.additional_kwargs.agentcore_tool_metadata as Record<string, SharedV3ProviderOptions> | undefined;
      for (const call of (message as AIMessage).tool_calls ?? []) {
        if (!call.id) throw new ConfigError('LangChain tool call requires an id');
        names.set(call.id, call.name);
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.args, providerOptions: metadata?.[call.id] });
      }
      result.push({ role: 'assistant', content });
    } else result.push({ role: 'user', content: content as UserPart[] });
  }
  return result;
}
function inputPart(part: Record<string, any>): ChatPart {
  const providerOptions = part.providerOptions as SharedV3ProviderOptions | undefined;
  if (part.type === 'text') return { type: 'text', text: part.text, providerOptions };
  if (part.type === 'reasoning') return { type: 'reasoning', text: part.reasoning, providerOptions };
  if (part.type === 'image_url') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
    return filePart(url, 'image/*', providerOptions);
  }
  if (['image', 'audio', 'video', 'file'].includes(part.type)) {
    const data = part.url ?? part.data;
    const mediaType = part.mimeType ?? part.mime_type ?? (part.type === 'file' ? undefined : `${part.type}/*`);
    if (data !== undefined) return filePart(data, mediaType, providerOptions);
  }
  throw new ConfigError(`unsupported LangChain provider content block: ${part.type}`);
}
function filePart(data: string | Uint8Array, mediaType?: string, providerOptions?: SharedV3ProviderOptions): ChatPart {
  if (typeof data === 'string' && data.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
    if (!match) throw new ConfigError('data URL must contain base64 data and a media type');
    return { type: 'file', mediaType: match[1]!, data: match[2]!, providerOptions };
  }
  const url = typeof data === 'string' && /^(https?:|gs:)/.test(data) ? new URL(data) : undefined;
  if (!mediaType) throw new ConfigError('file content requires a media type');
  return { type: 'file', mediaType, data: url ?? data, providerOptions };
}
function outputPart(part: Extract<LanguageModelV3Content, { type: 'text' | 'reasoning' | 'file' }>): { type: string; [key: string]: unknown } {
  if (part.type === 'text') return { type: 'text', text: part.text, providerOptions: part.providerMetadata };
  if (part.type === 'reasoning') return { type: 'reasoning', reasoning: part.text, providerOptions: part.providerMetadata };
  return { type: 'file', mimeType: part.mediaType,
    data: typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64'), providerOptions: part.providerMetadata };
}
function usage(value: LanguageModelV3Usage): UsageMetadata {
  const input = value.inputTokens.total ?? 0; const output = value.outputTokens.total ?? 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}
function toolChoice(value: ProviderChatCallOptions['tool_choice']): LanguageModelV3ToolChoice | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'none' || value === 'required') return { type: value };
  if (value === 'any') return { type: 'required' };
  if (typeof value === 'string') return { type: 'tool', toolName: value };
  if (value.type === 'function' && typeof value.function?.name === 'string') return { type: 'tool', toolName: value.function.name };
  throw new ConfigError('unsupported LangChain tool_choice');
}
