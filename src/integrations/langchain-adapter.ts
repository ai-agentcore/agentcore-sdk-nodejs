import type { ChatOpenAIFields } from '@langchain/openai';
import type { ChatAnthropicInput } from '@langchain/anthropic';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import type { JsonSchema7Type } from '@langchain/core/utils/json_schema';
import type { ModelClient, ProviderModelClient } from '../model';
import type { ProviderChatModel, LangChainProviderOptions } from './langchain-provider';
import type { Tool, ToolArguments } from './common';
import { skillTools as canonicalSkillTools, type Skill, type SkillToolsOptions } from '../skill';

type CoreOwnedFields = 'model' | 'modelName' | 'apiKey' | 'openAIApiKey' | 'anthropicApiKey'
  | 'anthropicApiUrl' | 'configuration' | 'clientOptions' | 'createClient' | 'completions' | 'responses' | 'maxRetries';
/** Provider-specific generation options; identity and transport belong to ModelClient. */
export type LangChainModelOptions = Omit<ChatOpenAIFields, CoreOwnedFields> | Omit<ChatAnthropicInput, CoreOwnedFields>;

export type { LangChainProviderOptions } from './langchain-provider';
export function model(client: ModelClient, options?: LangChainModelOptions): Promise<import('@langchain/openai').ChatOpenAI | import('@langchain/anthropic').ChatAnthropic>;
export function model(client: ProviderModelClient, options?: LangChainProviderOptions): Promise<ProviderChatModel>;
export async function model(client: ModelClient | ProviderModelClient, options: LangChainModelOptions | LangChainProviderOptions = {}) {
  if ('languageModel' in client) {
    const { ProviderChatModel } = await import('./langchain-provider');
    return new ProviderChatModel(client, options as LangChainProviderOptions);
  }
  const { provider, model, baseURL, maxTokens } = client.settings;
  const fetch = client.httpFetch.bind(client);
  if (provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({ streamUsage: true, maxTokens,
      ...options as ChatAnthropicInput,
      model, apiKey: 'agentcore-transport', anthropicApiUrl: baseURL, maxRetries: 0,
      clientOptions: { baseURL, fetch },
    });
  }
  const { ChatOpenAI } = await import('@langchain/openai');
  return new ChatOpenAI({ streamUsage: true, useResponsesApi: false, maxTokens,
    ...options as ChatOpenAIFields,
    model, apiKey: 'agentcore-transport', maxRetries: 0, configuration: { baseURL, fetch },
  });
}

/** Keep native schema validation, ToolMessage conversion, callbacks and tool execution. */
export function tools(values: readonly Tool[]): StructuredToolInterface[] {
  return values.map(value => tool((args: ToolArguments) => value.invoke(args), {
    // LangChain's JSON Schema validator annotates its schema during dereferencing.
    name: value.name, description: value.description, schema: structuredClone(value.parameters) as JsonSchema7Type,
  }));
}
export function skillTools(values: readonly Skill[], options: SkillToolsOptions = {}): StructuredToolInterface[] {
  return tools(canonicalSkillTools(values, options));
}
