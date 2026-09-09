import type { EmbeddingModelV3, LanguageModelV3 } from '@ai-sdk/provider';
import type { generateText, streamText, embedMany, ModelMessage, ToolSet } from 'ai';
import { inspect } from 'node:util';
import { ConfigError } from '../errors';
import { nullLogger, type Logger } from '../logging';
import type { ModelCallOptions } from './client';

export interface DirectProviderOptions {
  /** A configured AI SDK provider model. The provider owns its endpoint and auth. */
  languageModel: LanguageModelV3;
  embeddingModel?: EmbeddingModelV3;
  timeoutMs?: number;
  logger?: Logger;
}
export type ProviderGenerateOptions<T extends ToolSet = ToolSet> = Omit<Parameters<typeof generateText<T>>[0], 'model' | 'messages' | 'prompt' | 'abortSignal'>;
export type ProviderStreamOptions<T extends ToolSet = ToolSet> = Omit<Parameters<typeof streamText<T>>[0], 'model' | 'messages' | 'prompt' | 'abortSignal'>;
export type ProviderEmbeddingOptions = Omit<Parameters<typeof embedMany>[0], 'model' | 'values' | 'abortSignal'>;

/** Multi-provider Direct models use AI SDK messages/results, not a simulated OpenAI protocol. */
export class ProviderModelClient {
  readonly settings: Readonly<{ model: string; provider: string }>;
  readonly languageModel: LanguageModelV3;
  private readonly lifetime = new AbortController();
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly embeddingModel?: EmbeddingModelV3;

  constructor(options: DirectProviderOptions) {
    const model = options.languageModel;
    this.settings = Object.freeze({ model: model.modelId, provider: model.provider });
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.logger = options.logger ?? nullLogger;
    // Keep lifecycle enforcement when this model is handed to a framework.
    this.languageModel = {
      specificationVersion: 'v3', provider: model.provider, modelId: model.modelId,
      supportedUrls: model.supportedUrls,
      doGenerate: async args => {
        const abortSignal = this.signal(args.abortSignal);
        return model.doGenerate({ ...args, abortSignal });
      },
      doStream: async args => {
        const abortSignal = this.signal(args.abortSignal);
        return model.doStream({ ...args, abortSignal });
      },
    };
    this.embeddingModel = options.embeddingModel;
    this.logger.info('agentcore.model.client.created', { mode: 'direct-provider', ...this.settings });
  }

  async completion<T extends ToolSet = ToolSet>(messages: readonly ModelMessage[], parameters: ProviderGenerateOptions<T> = {}, options: ModelCallOptions = {}) {
    const abortSignal = this.signal(options.signal);
    const { generateText } = await import('ai');
    return this.request('completion', () => generateText<T>({ maxRetries: 0, ...parameters,
      model: this.languageModel, messages: [...messages], abortSignal,
    }));
  }
  async invoke<T extends ToolSet = ToolSet>(messages: readonly ModelMessage[], parameters: ProviderGenerateOptions<T> = {}, options: ModelCallOptions = {}) {
    return this.completion(messages, parameters, options);
  }
  async *stream<T extends ToolSet = ToolSet>(messages: readonly ModelMessage[], parameters: ProviderStreamOptions<T> = {}, options: ModelCallOptions = {}) {
    const controller = new AbortController();
    const abortSignal = this.signal(AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]));
    const { streamText } = await import('ai');
    try {
      // The iterator below propagates errors and logs safe metadata. AI SDK's
      // default onError prints the entire error, including provider request data.
      const result = streamText<T>({ maxRetries: 0, onError: () => {}, ...parameters, model: this.languageModel, messages: [...messages], abortSignal });
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw part.error;
        yield part;
      }
    } catch (error) { this.failed('stream', error); throw error; }
    finally { controller.abort(); }
  }
  async embedding(input: string | readonly string[], parameters: ProviderEmbeddingOptions = {}, options: ModelCallOptions = {}) {
    const abortSignal = this.signal(options.signal);
    if (!this.embeddingModel) throw new ConfigError('direct provider embedding requires embeddingModel');
    const { embedMany } = await import('ai');
    return this.request('embedding', () => embedMany({ maxRetries: 0, ...parameters, model: this.embeddingModel!,
      values: typeof input === 'string' ? [input] : [...input], abortSignal,
    }));
  }
  close(): void { this.lifetime.abort(); }
  [inspect.custom](): string { return `ProviderModelClient(model=${this.settings.model}, provider=${this.settings.provider}, <redacted>)`; }
  toJSON(): string { return this[inspect.custom](); }

  private signal(signal?: AbortSignal): AbortSignal {
    this.lifetime.signal.throwIfAborted();
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
  }
  private async request<T>(operation: string, invoke: () => Promise<T>): Promise<T> {
    try { return await invoke(); } catch (error) { this.failed(operation, error); throw error; }
  }
  private failed(operation: string, error: unknown): void {
    this.logger.warn('agentcore.model.request.failed', { operation, ...this.settings,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
