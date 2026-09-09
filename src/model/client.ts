import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { inspect } from 'node:util';
import { ConfigError, InvocationError } from '../errors';
import { nullLogger, type Logger } from '../logging';
import { httpUrl, requiredString, type AgentConfig } from '../runtime/config';
import type { ModelDescriptor } from '../controlplane/client';

export type ModelProtocol = 'openai' | 'anthropic';
export type ModelMessage = { role: string; content?: unknown; [key: string]: unknown };
export type ModelParameters = Record<string, unknown>;
export type ModelResponse = Record<string, unknown>;
export type HeadersProvider = () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
export interface ModelCallOptions { signal?: AbortSignal; }
export interface DirectModelOptions {
  model: string;
  baseURL: string;
  provider?: ModelProtocol;
  apiKey?: string;
  apiKeyProvider?: () => string | Promise<string>;
  headersProvider?: HeadersProvider;
  timeoutMs?: number;
  logger?: Logger;
}
export interface ModelSettings {
  readonly model: string;
  readonly provider: ModelProtocol;
  readonly baseURL: string;
  readonly maxTokens?: number;
}

export function managedModelProtocol(protocol: string): ModelProtocol {
  switch (protocol.trim().toLowerCase()) {
    case 'openai/v1': return 'openai';
    case 'anthropic': return 'anthropic';
    default: throw new ConfigError(`managed model protocol has no SDK adapter: ${protocol}`);
  }
}
export function modelBaseURL(gatewayURL: string, connectionId: string, protocol: string): string {
  const provider = managedModelProtocol(protocol);
  const gateway = gatewayURL.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/model-connection$/, '');
  return `${gateway}/model-connection/${encodeURIComponent(connectionId)}${provider === 'openai' ? '/v1' : ''}`;
}

export class ModelClient {
  readonly descriptor?: ModelDescriptor;
  readonly settings: ModelSettings;
  private readonly logger: Logger;
  private readonly openai?: OpenAI;
  private readonly anthropic?: Anthropic;
  private readonly lifetime = new AbortController();
  private readonly requestHeaders: HeadersProvider;

  private constructor(settings: ModelSettings, requestHeaders: HeadersProvider, descriptor: ModelDescriptor | undefined, logger: Logger, private readonly timeoutMs: number) {
    this.settings = Object.freeze(settings); this.requestHeaders = requestHeaders;
    this.descriptor = descriptor; this.logger = logger;
    const fetch = this.httpFetch.bind(this);
    // OpenAI requires a non-empty constructor key; our fetch always replaces it
    // with the current provider headers, so this marker is never transmitted.
    if (settings.provider === 'openai') this.openai = new OpenAI({ baseURL: settings.baseURL, apiKey: 'agentcore-transport', fetch, timeout: timeoutMs, maxRetries: 0 });
    else this.anthropic = new Anthropic({ baseURL: settings.baseURL, apiKey: null, authToken: '', defaultHeaders: { 'X-Api-Key': null, Authorization: null }, fetch, timeout: timeoutMs, maxRetries: 0 });
    this.logger.info('agentcore.model.client.created', { mode: descriptor ? 'managed' : 'direct', model: settings.model, provider: settings.provider, baseURL: settings.baseURL });
  }

  static platform(config: AgentConfig, descriptor: ModelDescriptor, options: { logger?: Logger; timeoutMs?: number } = {}): ModelClient {
    const provider = managedModelProtocol(descriptor.protocol);
    const headers = { ...config.gatewayHeaders };
    return new ModelClient({ model: descriptor.modelName, provider, baseURL: modelBaseURL(config.modelGatewayUrl, descriptor.connectionId, descriptor.protocol), maxTokens: descriptor.maxTokens },
      () => headers, descriptor, options.logger ?? nullLogger, options.timeoutMs ?? 600_000);
  }
  static direct(options: DirectModelOptions): ModelClient {
    if (options.apiKey !== undefined && options.apiKeyProvider !== undefined) throw new ConfigError('apiKey and apiKeyProvider are mutually exclusive');
    const provider = options.provider ?? 'openai';
    if (provider !== 'openai' && provider !== 'anthropic') throw new ConfigError(`direct model protocol has no SDK adapter: ${provider}`);
    const model = requiredString(options.model, 'model'); const baseURL = httpUrl(options.baseURL, 'direct model baseURL');
    const resolve = async () => {
      const headers: Record<string, string> = {};
      const key = options.apiKeyProvider ? requiredString(await options.apiKeyProvider(), 'apiKeyProvider result') : options.apiKey;
      if (key) headers[provider === 'openai' ? 'authorization' : 'x-api-key'] = provider === 'openai' ? `Bearer ${key}` : key;
      Object.assign(headers, await options.headersProvider?.());
      return headers;
    };
    return new ModelClient({ model, baseURL, provider }, resolve, undefined, options.logger ?? nullLogger, options.timeoutMs ?? 600_000);
  }

  /** Headers are resolved for framework transports as well as direct API calls. */
  async headers(): Promise<Readonly<Record<string, string>>> { return this.requestHeaders(); }

  async completion(messages: readonly ModelMessage[], parameters: ModelParameters = {}, options: ModelCallOptions = {}): Promise<ModelResponse> {
    this.reject(parameters, ['messages', 'stream']);
    return this.invokeRequest('completion', async () => {
      if (this.openai) return this.openai.chat.completions.create({ ...parameters, model: this.settings.model, messages: [...messages], stream: false } as OpenAI.ChatCompletionCreateParamsNonStreaming, options);
      return this.anthropic!.messages.create({ ...this.anthropicParameters(messages, parameters), model: this.settings.model, stream: false } as Anthropic.MessageCreateParamsNonStreaming, options);
    });
  }
  async invoke(messages: readonly ModelMessage[], parameters: ModelParameters = {}, options: ModelCallOptions = {}): Promise<ModelResponse> { return this.completion(messages, parameters, options); }
  async *stream(messages: readonly ModelMessage[], parameters: ModelParameters = {}, options: ModelCallOptions = {}): AsyncGenerator<ModelResponse> {
    this.reject(parameters, ['messages', 'stream']);
    const request = async () => this.openai
      ? this.openai.chat.completions.create({ ...parameters, model: this.settings.model, messages: [...messages], stream: true } as OpenAI.ChatCompletionCreateParamsStreaming, options)
      : this.anthropic!.messages.create({ ...this.anthropicParameters(messages, parameters), model: this.settings.model, stream: true } as Anthropic.MessageCreateParamsStreaming, options);
    yield* this.invokeStream('stream', request);
  }
  async responses(input: unknown, parameters: ModelParameters = {}, options: ModelCallOptions = {}): Promise<ModelResponse> {
    this.reject(parameters, ['input', 'stream']); this.requireOpenAI('Responses API');
    return this.invokeRequest('responses', () => this.openai!.responses.create({ ...parameters, model: this.settings.model, input, stream: false } as OpenAI.Responses.ResponseCreateParamsNonStreaming, options));
  }
  async *responsesStream(input: unknown, parameters: ModelParameters = {}, options: ModelCallOptions = {}): AsyncGenerator<ModelResponse> {
    this.reject(parameters, ['input', 'stream']); this.requireOpenAI('Responses API');
    yield* this.invokeStream('responsesStream', () => this.openai!.responses.create({ ...parameters, model: this.settings.model, input, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming, options));
  }
  async embedding(input: unknown, parameters: ModelParameters = {}, options: ModelCallOptions = {}): Promise<ModelResponse> {
    this.reject(parameters, ['input']);
    if (this.descriptor) throw new InvocationError('managed model protocol does not publish Embedding API');
    this.requireOpenAI('Embedding API');
    return this.invokeRequest('embedding', () => this.openai!.embeddings.create({ ...parameters, model: this.settings.model, input } as OpenAI.EmbeddingCreateParams, options));
  }
  close(): void { this.lifetime.abort(); }
  [inspect.custom](): string { return `ModelClient(model=${this.settings.model}, provider=${this.settings.provider}, <redacted>)`; }
  toJSON(): string { return this[inspect.custom](); }

  private requireOpenAI(operation: string): void { if (!this.openai) throw new InvocationError(`Anthropic protocol does not publish ${operation}`); }
  private reject(parameters: ModelParameters, operationFields: string[]): void {
    this.lifetime.signal.throwIfAborted();
    const reserved = ['model', 'resourceName', 'resource_name', 'extra_headers', ...operationFields];
    const conflicts = reserved.filter((name) => Object.hasOwn(parameters, name));
    if (conflicts.length) throw new TypeError(`reserved model request parameters: ${conflicts.join(', ')}`);
  }
  private anthropicParameters(messages: readonly ModelMessage[], parameters: ModelParameters): Record<string, unknown> {
    const systemMessages = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const body = { ...parameters, messages: messages.filter((m) => m.role !== 'system') };
    const maxTokens = parameters.max_tokens ?? this.settings.maxTokens;
    if (maxTokens === undefined) throw new ConfigError('Anthropic model requires max_tokens');
    Object.assign(body, { max_tokens: maxTokens });
    if (systemMessages.length) {
      if (Object.hasOwn(parameters, 'system')) throw new TypeError('system is already set by a system message');
      if (systemMessages.length > 1 && !systemMessages.every((v) => typeof v === 'string')) throw new TypeError('multiple Anthropic system messages must contain text');
      Object.assign(body, { system: systemMessages.length === 1 ? systemMessages[0] : systemMessages.join('\n\n') });
    }
    return body;
  }
  /** Authenticated transport shared by native clients and framework adapters. */
  async httpFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    this.lifetime.signal.throwIfAborted();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // Native SDK auth is populated here, including dynamic direct credentials.
    headers.delete('authorization'); headers.delete('x-api-key');
    for (const [key, value] of Object.entries(await this.requestHeaders())) headers.set(key, value);
    this.logger.info('agentcore.model.http.request', { method: request.method, url: `${url.origin}${url.pathname}` });
    return globalThis.fetch(request, { headers, redirect: 'manual',
      signal: AbortSignal.any([this.lifetime.signal, request.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
  }
  private async invokeRequest(operation: string, request: () => Promise<unknown>): Promise<ModelResponse> {
    try { return await request() as ModelResponse; }
    catch (cause) { this.failed(operation, cause); throw new InvocationError('model request failed', { cause }); }
  }
  private async *invokeStream(operation: string, request: () => Promise<AsyncIterable<unknown> & { controller: AbortController }>): AsyncGenerator<ModelResponse> {
    let stream: (AsyncIterable<unknown> & { controller: AbortController }) | undefined;
    try { stream = await request(); for await (const event of stream) yield event as ModelResponse; }
    catch (cause) { this.failed(operation, cause); throw new InvocationError('model stream request failed', { cause }); }
    finally { stream?.controller.abort(); }
  }
  private failed(operation: string, error: unknown): void {
    const status = error && typeof error === 'object' && 'status' in error ? String(error.status) : undefined;
    const requestId = error && typeof error === 'object' && 'request_id' in error ? String(error.request_id) : undefined;
    this.logger.warn('agentcore.model.request.failed', { operation, baseURL: this.settings.baseURL, model: this.settings.model, status, requestId });
  }
}
