import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { defaultSettingsMiddleware, jsonSchema, tool, wrapLanguageModel, type ToolSet } from 'ai';
import { ConfigError } from '../errors';
import type { ModelClient } from '../model/client';
import type { ProviderModelClient } from '../model/provider';
import type { Tool, ToolArguments } from './common';

/** The caller owns the ModelClient (or its Core); this adapter does not close it. */
export function languageModel(client: ModelClient | ProviderModelClient, options: { api?: 'chat' | 'responses' } = {}): LanguageModelV3 {
  if ('languageModel' in client) {
    if (options.api) throw new ConfigError('select the API when constructing the direct provider model');
    return client.languageModel;
  }
  const { provider, baseURL, model, maxTokens } = client.settings;
  const fetch = client.httpFetch.bind(client);
  let result: LanguageModelV3;
  if (provider === 'anthropic') {
    if (options.api === 'responses') throw new ConfigError('Anthropic protocol does not publish Responses API');
    result = createAnthropic({ baseURL: `${baseURL.replace(/\/+$/, '')}/v1`, apiKey: 'agentcore-transport', fetch })(model);
  } else if (options.api === 'responses') {
    result = createOpenAI({ baseURL, apiKey: 'agentcore-transport', fetch }).responses(model);
  } else {
    // Forward explicitly requested schemas; the backend decides model support.
    result = createOpenAICompatible({ name: 'agentcore', baseURL, fetch, supportsStructuredOutputs: true }).chatModel(model);
  }
  // A descriptor supplies defaults, not a limit on explicit per-call settings.
  return maxTokens === undefined ? result : wrapLanguageModel({
    model: result, middleware: defaultSettingsMiddleware({ settings: { maxOutputTokens: maxTokens } }),
  });
}

/** MCP and Skill tools share the same canonical Tool representation. */
export function tools(items: readonly Tool[]): ToolSet {
  const result: ToolSet = Object.create(null) as ToolSet;
  for (const item of items) {
    if (Object.hasOwn(result, item.name)) throw new ConfigError(`duplicate tool name: ${item.name}`);
    result[item.name] = tool({
      description: item.description,
      inputSchema: jsonSchema<ToolArguments>(item.parameters),
      execute: (arguments_) => item.invoke(arguments_),
    });
  }
  return result;
}
export { AISDKEventConverter as AgentCoreConverter } from './event-converters';
