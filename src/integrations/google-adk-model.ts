import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import { FinishReason, type Content, type ContentUnion, type Part } from '@google/genai';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3FinishReason,
  LanguageModelV3Message, LanguageModelV3Prompt, LanguageModelV3Usage } from '@ai-sdk/provider';
import type { ModelClient, ProviderModelClient } from '../model';
import { ConfigError, InvocationError } from '../errors';
import { languageModel } from './ai-sdk';

/** ADK owns the agent loop; AI SDK normalizes native and direct provider models. */
export class AgentCoreLlm extends BaseLlm {
  private readonly delegate: LanguageModelV3;
  constructor(client: ModelClient | ProviderModelClient) { super({ model: client.settings.model }); this.delegate = languageModel(client); }
  async connect(): Promise<never> { throw new ConfigError('AgentCore models do not implement ADK bidirectional live connections'); }
  async *generateContentAsync(request: LlmRequest, stream = false, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse> {
    const lifetime = new AbortController();
    const signals = [lifetime.signal, abortSignal, request.config?.abortSignal].filter((value): value is AbortSignal => value !== undefined);
    const options = requestOptions(request, AbortSignal.any(signals));
    try {
      if (!stream) {
        const result = await this.delegate.doGenerate(options);
        yield { content: { role: 'model', parts: result.content.flatMap(outputParts) }, ...completion(result.finishReason, result.usage) };
        return;
      }
      const result = await this.delegate.doStream(options);
      const reader = result.stream.getReader();
      const parts: Part[] = []; const text = new Map<string, Part>(); let finished = false;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          const item = next.value;
          if (item.type === 'error') throw item.error;
          if (item.type === 'text-delta' || item.type === 'reasoning-delta') {
            const key = `${item.type}:${item.id}`; let part = text.get(key);
            if (!part) { part = { text: '', ...(item.type === 'reasoning-delta' ? { thought: true } : {}) }; text.set(key, part); parts.push(part); }
            part.text += item.delta;
            yield { content: { role: 'model', parts: [{ text: item.delta, thought: part.thought }] }, partial: true, turnComplete: false };
          } else if (item.type === 'reasoning-end') {
            const signature = item.providerMetadata?.anthropic?.signature;
            const part = text.get(`reasoning-delta:${item.id}`);
            if (part && typeof signature === 'string') part.thoughtSignature = signature;
          } else if (item.type === 'tool-call' || item.type === 'file') {
            parts.push(...outputParts(item));
          } else if (item.type === 'finish') {
            finished = true;
            yield { content: { role: 'model', parts }, partial: false, turnComplete: true, ...completion(item.finishReason, item.usage) };
          }
        }
        if (!finished) throw new InvocationError('model stream ended without a completion event');
      } finally { lifetime.abort(); reader.releaseLock(); }
    } finally { lifetime.abort(); }
  }
}

type ChatPart = Extract<LanguageModelV3Message, { role: 'assistant' }>['content'][number];
type UserPart = Extract<LanguageModelV3Message, { role: 'user' }>['content'][number];
function prompt(contents: Content[]): LanguageModelV3Prompt {
  const result: LanguageModelV3Prompt = []; const pending: { name: string; id: string }[] = [];
  for (const [index, content] of contents.entries()) {
    const assistant = content.role === 'model'; let group: ChatPart[] = [];
    const flush = () => {
      if (group.length) result.push(assistant ? { role: 'assistant', content: group } : { role: 'user', content: group as UserPart[] });
      group = [];
    };
    for (const [partIndex, part] of (content.parts ?? []).entries()) {
      if (part.functionCall) {
        const call = part.functionCall;
        if (!assistant || !call.name) throw new ConfigError('ADK functionCall requires a model message and tool name');
        const id = call.id ?? `call-${index}-${partIndex}`; pending.push({ id, name: call.name });
        group.push({ type: 'tool-call', toolCallId: id, toolName: call.name, input: call.args ?? {} });
      } else if (part.functionResponse) {
        flush(); const response = part.functionResponse;
        const match = pending.findIndex(call => response.id ? call.id === response.id : call.name === response.name);
        if (match < 0) throw new ConfigError('ADK functionResponse has no matching functionCall');
        const call = pending.splice(match, 1)[0]!;
        result.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.id, toolName: call.name,
          output: { type: 'text', value: JSON.stringify(response.response ?? {}) } }] });
      } else if (part.text !== undefined) {
        if (part.thought && assistant) group.push({ type: 'reasoning', text: part.text,
          providerOptions: part.thoughtSignature ? { anthropic: { signature: part.thoughtSignature } } : undefined });
        else if (!part.thought) group.push({ type: 'text', text: part.text });
      } else if (part.inlineData?.data !== undefined || part.fileData?.fileUri) {
        const mediaType = part.inlineData?.mimeType ?? part.fileData?.mimeType;
        if (!mediaType) throw new ConfigError('ADK file content requires mimeType');
        group.push({ type: 'file', mediaType, data: part.inlineData?.data ?? new URL(part.fileData!.fileUri!) });
      } else throw new ConfigError('unsupported ADK content part for AgentCore models');
    }
    flush();
  }
  return result;
}
function systemText(value: ContentUnion): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(systemText).join('\n');
  if ('parts' in value) return (value.parts ?? []).map(systemText).join('\n');
  if ('text' in value && value.text !== undefined) return value.text;
  throw new ConfigError('ADK system instruction must contain text');
}
/** Translate GenAI's OpenAPI-style Schema; native parametersJsonSchema bypasses this. */
function jsonSchema(value: unknown): Record<string, unknown> {
  const schema = structuredClone(value) as Record<string, unknown>;
  if (typeof schema.type === 'string') schema.type = schema.type.toLowerCase();
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']) {
    if (typeof schema[key] === 'string') schema[key] = Number(schema[key]);
  }
  if (Array.isArray(schema.enum) && (schema.type === 'integer' || schema.type === 'number')) schema.enum = schema.enum.map(Number);
  if (schema.properties) schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, item]) => [key, jsonSchema(item)]));
  if (schema.items) schema.items = jsonSchema(schema.items);
  if (Array.isArray(schema.anyOf)) schema.anyOf = schema.anyOf.map(jsonSchema);
  const nullable = schema.nullable; delete schema.nullable; delete schema.propertyOrdering;
  return nullable ? { anyOf: [schema, { type: 'null' }] } : schema;
}
function requestOptions(request: LlmRequest, abortSignal: AbortSignal): LanguageModelV3CallOptions {
  const config = request.config ?? {};
  const messages = prompt(request.contents);
  if (config.systemInstruction) messages.unshift({ role: 'system', content: systemText(config.systemInstruction) });
  const allowed = config.toolConfig?.functionCallingConfig?.allowedFunctionNames ?? request.allowedTools;
  const declarations = (config.tools ?? []).flatMap(tool => {
    if (!('functionDeclarations' in tool)) throw new ConfigError('Gemini built-in tools are not supported by AgentCore model protocols');
    return tool.functionDeclarations ?? [];
  }).filter(tool => !allowed || allowed.includes(tool.name!));
  const functions = declarations.map(tool => {
    if (!tool.name) throw new ConfigError('ADK function declaration requires a name');
    return { type: 'function' as const, name: tool.name, description: tool.description,
      inputSchema: tool.parametersJsonSchema ? structuredClone(tool.parametersJsonSchema) as Record<string, unknown>
        : tool.parameters ? jsonSchema(tool.parameters) : { type: 'object', properties: {} } };
  });
  const mode = config.toolConfig?.functionCallingConfig?.mode;
  const options: LanguageModelV3CallOptions = { prompt: messages, abortSignal,
    maxOutputTokens: config.maxOutputTokens, temperature: config.temperature, topP: config.topP, topK: config.topK,
    stopSequences: config.stopSequences, seed: config.seed, presencePenalty: config.presencePenalty, frequencyPenalty: config.frequencyPenalty,
    tools: functions.length ? functions : undefined,
    toolChoice: mode === 'NONE' || allowed?.length === 0 ? { type: 'none' } : mode === 'ANY' ? { type: 'required' } : { type: 'auto' },
  };
  if (config.responseMimeType === 'application/json' || config.responseJsonSchema || config.responseSchema) {
    options.responseFormat = { type: 'json', schema: config.responseJsonSchema ? structuredClone(config.responseJsonSchema) as Record<string, unknown>
      : config.responseSchema ? jsonSchema(config.responseSchema) : undefined };
  }
  return options;
}
function outputParts(item: LanguageModelV3Content): Part[] {
  if (item.type === 'text') return [{ text: item.text }];
  if (item.type === 'reasoning') {
    const signature = item.providerMetadata?.anthropic?.signature;
    return [{ text: item.text, thought: true, thoughtSignature: typeof signature === 'string' ? signature : undefined }];
  }
  if (item.type === 'tool-call') return [{ functionCall: { id: item.toolCallId, name: item.toolName, args: JSON.parse(item.input) } }];
  if (item.type === 'file') return [{ inlineData: { mimeType: item.mediaType, data: typeof item.data === 'string' ? item.data : Buffer.from(item.data).toString('base64') } }];
  return [];
}
function completion(reason: LanguageModelV3FinishReason, usage: LanguageModelV3Usage): Partial<LlmResponse> {
  const input = usage.inputTokens.total, output = usage.outputTokens.total;
  return { finishReason: reason.unified === 'length' ? FinishReason.MAX_TOKENS : reason.unified === 'content-filter' ? FinishReason.SAFETY
    : reason.unified === 'stop' || reason.unified === 'tool-calls' ? FinishReason.STOP : FinishReason.OTHER,
    ...(reason.unified === 'error' ? { errorCode: 'MODEL_ERROR', errorMessage: 'model generation failed' } : {}),
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input !== undefined && output !== undefined ? input + output : undefined,
      cachedContentTokenCount: usage.inputTokens.cacheRead, thoughtsTokenCount: usage.outputTokens.reasoning },
  };
}
