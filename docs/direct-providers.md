# 自定义模型：多提供方接入

托管资源仍使用 `await core.model('连接名称')`，根据控制面协议走 OpenAI / Anthropic 原生客户端。下面的 Direct 入口不查询控制面、不读取 `agent.yaml`，也不发送平台 Consumer 凭证。

## 选择入口

- 自定义 OpenAI / Anthropic URL：`core.directModel({ model, baseURL, provider, apiKey })`，返回现有 `ModelClient`，消息和结果为对应原生协议格式。
- 其他提供方：`core.directModel({ languageModel, embeddingModel? })`，返回 `ProviderModelClient`，使用 AI SDK 6 的消息、生成结果及流式事件。不要把 OpenAI `tool_calls` 等协议结构直接当作 AI SDK 消息。

这对应 Python Direct 使用 LiteLLM 的多提供方能力，但不在 Node 里模拟 LiteLLM 或重写各厂商协议。提供方实例采用 [AI SDK 的模型接口](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)，可以使用官方包、社区包或应用自己的兼容提供方。

## 示例：Google 原生协议

```bash
npm install ai@^6 @ai-sdk/provider@^3 @ai-sdk/google@^3
```

```typescript
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
const core = new AgentCore();
const client = core.directModel({
  languageModel: google('gemini-2.5-flash'),
  embeddingModel: google.embeddingModel('gemini-embedding-001'),
});
try {
  const messages = [{ role: 'user' as const, content: '你好' }];
  const result = await client.invoke(messages, { maxOutputTokens: 128 });
  console.log(result.text);
  for await (const event of client.stream(messages)) {
    if (event.type === 'text-delta') process.stdout.write(event.text);
  }
  const vectors = await client.embedding(['第一段', '第二段']);
  console.log(vectors.embeddings.length);
} finally {
  await core.close();
}
```

模型名称只是示例，是否可访问和支持对应能力由提供方决定。Embedding 使用单独传入的 `embeddingModel`，不会把生成模型名称当作向量模型。OpenAI Responses 可在创建提供方时选择 `openai.responses(name)`；不会在请求失败后自动换成 Chat。

## 工具、框架与生命周期

- `completion()` / `invoke()` 接受 AI SDK 的生成参数，包括 `tools`、`stopWhen`、`providerOptions`；`stream()` 输出 AI SDK `fullStream` 的事件，错误事件会抛出原始错误。
- `embedding()` 接受一个字符串或字符串数组，返回 AI SDK `embedMany` 结果。
- SDK 默认 `maxRetries: 0`；需要重试时可显式设置。提供方决定模型能力，不查模型目录或模拟流式。
- `timeoutMs` 默认 600 秒；调用方可在第三个参数传 `{ signal }`。退出流式迭代会取消请求，关闭 Core 会取消当前请求并阻止后续调用。
- 传入的提供方实例可以由应用共享；Core 仅关闭自己的客户端生命周期，不销毁应用的提供方。
- AI SDK 可直接使用 `client.languageModel`。Mastra / Google ADK 的 `model(client)` 已接受该客户端，并保留 Core 的取消和关闭语义。
- LangChain / LangGraph 的 `model(client)` 也接受该客户端，返回 `BaseChatModel` 桥接模型。支持普通/流式消息、`bindTools`、函数调用式 `withStructuredOutput`、回调和取消；生成参数使用 AI SDK 名称（例如 `maxOutputTokens`）。工具执行与 Agent 循环仍由 LangChain 负责。详见 [LangChain 使用说明](langchain.md)。
- 各厂商的 URL、鉴权、动态凭证由其提供方工厂配置；Core 不从中解析或记录凭证。SDK 的错误日志只记录操作、模型、提供方和错误类型。

## 验证范围

本地 HTTP 测试使用真实 `@ai-sdk/google`，覆盖 Google JSON/SSE、普通及流式工具循环（保留 thought signature）、单条/批量 Embedding、503 不重试、迭代退出、超时、调用方取消、Core 关闭，以及 Mastra/ADK 适配。没有调用云端 Google 服务，不代表所有提供方或云端模型均已验证。

LangChain 补充验证 Agent 普通/流式工具循环、LangGraph 节点、回调、用量、结构化输出、内嵌图片及连续对话中的来源元数据。思考内容及签名可进入下一轮请求；检索来源保留在 `response_metadata.sources`，不伪装成用户消息。所有这些验证仍使用本地模型协议服务。
