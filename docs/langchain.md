# LangChain / LangGraph

两个子路径都导出 `model()`、`tools()`、`skillTools()`，共享同一个实现。原生 OpenAI/Anthropic 使用对应 LangChain 模型；其他提供方通过 `BaseChatModel` 桥接。工具、Agent 调度及 checkpoint 仍使用 LangChain / LangGraph 原实现。

## 安装

```bash
npm install langchain@^1.5.10 @langchain/core@^1.2.9 @langchain/langgraph@^1.4.14 zod@^4.5.4
# 根据模型协议选择提供方包；可以同时安装。
npm install @langchain/openai@^1.5.11
npm install @langchain/anthropic@^1.5.9
```

这些框架包都是可选 peer，不随主 SDK 强制安装。当前测试的 `@langchain/openai@1.5.11` 要求 Node.js 22+，Anthropic 包要求 Node.js 20+；不要将主 SDK 的 Node 20 范围理解为所有可选框架版本都支持 Node 20。只用 Memory 中间件/节点，不需要安装模型提供方包；只用 OpenAI，不会加载 Anthropic 包。

## 模型和工具

```typescript
import { AgentCore } from '@alibabacloud/agentcore-sdk';
import { model, tools, skillTools } from '@alibabacloud/agentcore-sdk/integrations/langchain';
import { createAgent } from 'langchain';

const core = AgentCore.auto();
try {
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  const agent = createAgent({
    model: await model(client, { temperature: 0.2 }),
    tools: [...tools(await mcp.listTools()), ...skillTools([skill])],
  });
  const result = await agent.invoke({ messages: [{ role: 'user', content: '请查询时区' }] });
  console.log(result.messages.at(-1)?.content);
} finally {
  await core.close();
}
```

`model()` 根据 ModelClient 的协议选择 `ChatOpenAI` / `ChatAnthropic`；托管与 direct 客户端都可使用。模型名称、地址、鉴权和传输由 ModelClient 决定；适配层只接受框架的生成/调用设置。默认输出上限来自已解析的模型，可用 `maxTokens` 覆盖。框架的内置重试设为 0，不在多层各自重试模型请求。

保留原生调用方式：`invoke()` 默认请求 JSON，`stream()` 输出原生消息分片，`bindTools()`、回调和 `streamEvents()` 保持框架语义。没有照搬 Python 适配器的强制 `streaming: true`，因为 Node ChatOpenAI 的普通 invoke 在该模式下还会聚合流及估算 token。应用如确实需要，可自行传入该选项。

OpenAI 默认使用 Chat API；可显式设置 `{useResponsesApi: true}`。模型是否支持 Responses 由下游决定，错误不回退为 Chat；原生框架自身要求 Responses 的特性仍按其语义工作。

模型调用复用 Core 的 Consumer Header、direct 动态 API Key、超时和关闭信号。适配对象借用客户端，不拥有 Core；停止应用请求后由应用关闭 Core。调用者取消信号通过原生框架的 `{signal}` 参数传入。

`tools()` 使用 LangChain 原生 JSON Schema 工具与 ToolMessage 转换。Schema 在转换时复制，因为框架校验器会为它添加元数据；不修改 Core 的只读 Schema。Skill 工具沿用既定名称、参数、JSON 结果和执行目录，`skillTools(skills, options)` 的 options 与 Core Skill 工具一致。

## 自定义多提供方模型

如果使用 `core.directModel({ languageModel })`，不需要安装 LangChain 的 OpenAI / Anthropic 提供方包，安装对应 AI SDK 提供方即可：

```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google';
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
const client = core.directModel({ languageModel: google('gemini-2.5-flash') });
const native = await model(client, { temperature: 0.2, maxOutputTokens: 128 });
const agent = createAgent({ model: native, tools: [] });
const answer = await agent.invoke({ messages: [{ role: 'user', content: '你好' }] });
console.log(answer.messages.at(-1)?.text);
```

桥接仅做 LangChain 消息/工具定义与 AI SDK 模型接口的转换，不运行第二套 Agent 循环。每一步调用一次提供方；默认不重试，模型端点和鉴权来自已经构造的提供方。生成设置用 `LangChainProviderOptions` 的 AI SDK 字段名，调用方 `{signal}`、`stop`、`tool_choice` 沿用 LangChain 名称。

支持文本、思考内容、URL/base64 图片与文件、普通函数工具调用以及流式参数分片。工具调用和思考内容的提供方元数据会保留用于下一轮请求；来源引用放到 `response_metadata.sources`。`withStructuredOutput()` 复用 BaseChatModel 的函数调用方案，不自建 JSON 解析/修复重试器。不支持的文件 ID 或内容块会明确报错，不静默丢弃。

## Memory 与 Server

LangChain 使用 `agentCoreMemoryMiddleware()`，LangGraph 使用显式的 `AgentCoreMemoryNodes`；scope、写回时机和 checkpoint 边界见 README 的 Memory 章节。模型/工具适配不会自动启用 Memory，也不会从模型工具参数推断身份。

云端完整示例为 `examples/langchain-server.ts`，包含模型、MCP、Skill、Memory 与两个 Server 协议入口：

```bash
npx tsx examples/langchain-server.ts
```

示例需 Workspace 中预先存在 `test-mc`（模型 `qwen3.8-max`）、`test-mcp`、`test-skill` 和 `test-memory`。它处理单用户文本轮次，输出模型文本事件；不把内部工具调用伪装成需要 OpenAI 客户端执行的函数调用。它不实现多租户身份认证或持久化对话历史，生产应用应自行确定可信的逻辑身份/session scope。

框架事件到 `AgentEvent` 的映射留在应用层，Server 只负责 AG-UI / OpenAI 编码。应用可按需要额外将工具执行过程映射为 AG-UI 工具事件。

## 验证范围

`tests/langchain.test.ts` 使用原生 ChatOpenAI / ChatAnthropic 验证 JSON、SSE、工具循环、Schema、超时/取消、direct 凭证与关闭，以及实际 LangGraph 节点。`tests/framework-server.test.ts` 运行真实 createAgent，经官方 MCP Streamable HTTP 服务、真实 Skill 文件及签名 Memory HTTP 请求完成多步工具循环，再通过 AG-UI 和 OpenAI SSE 输出。

这些都是本地协议集成测试，模型回复和 Memory 服务由测试服务提供，不是云端模型推理成功的证明。独立 tarball 另验证 ESM/CJS、可选提供方安装和公开 TypeScript 类型。
