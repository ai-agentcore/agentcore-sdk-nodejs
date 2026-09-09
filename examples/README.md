# 示例指南

从云端资源、自定义服务或你熟悉的框架开始。各示例可以独立阅读和运行。

[SDK 首页](../README.md) · [AgentCore 官网](https://www.aliyun.com/product/agentcore) · [官方文档](https://help.aliyun.com/zh/agentcore/)

## 云端资源准备

首次使用平台可参考[官方文档](https://help.aliyun.com/zh/agentcore/)。按所选示例创建需要的资源，并授予应用访问权限；不必为每个示例准备全部资源。示例中的名称均可替换。

| 资源 | 示例名称 |
| --- | --- |
| 模型连接 | `test-mc` |
| 模型 | `qwen3.8-max` |
| MCP | `test-mcp` |
| Skill | `test-skill` |
| MemoryStore | `test-memory`（Memory 基础示例及 LangChain、ADK、Mastra 示例需要） |
| MCP Header 凭证 | `my-mcp-credential`（凭证示例需要，应用范围须允许 `test-mcp`） |

框架示例需要模型支持工具调用。请根据 MCP 和 Skill 的用途调整示例中的问题。Memory 示例会写入数据，建议使用专门的测试记忆空间。

## 选择示例

从仓库根目录运行：

```bash
npm ci
npm run build
npx tsx examples/cloud-resources.ts
```

云端示例用于部署在 AgentCore 中的应用。示例使用公开包名 `@alibabacloud/agentcore-sdk` 及对应子路径，可直接复制到自己的项目。仓库内运行时通过同名包的 exports 使用本地 `dist`，因此请先执行 `npm run build`；修改 SDK 源码后也需要重新构建。

| 示例 | 内容 |
| --- | --- |
| [cloud-resources.ts](cloud-resources.ts) | 云端模型、MCP 和 Skill |
| [mcp-credentials.ts](mcp-credentials.ts) | 为托管 MCP 绑定凭证、配置固定 Header，以及单独获取凭证 |
| [memory.ts](memory.ts) | Memory 写入与检索，不依赖框架或模型连接 |
| [direct-resources.ts](direct-resources.ts) | 自定义模型、MCP 和本地 Skill |
| [server.ts](server.ts) | 不依赖模型的 Echo 服务 |
| [langchain-server.ts](langchain-server.ts) | LangChain Agent、Memory 与 HTTP 服务 |
| [langgraph.ts](langgraph.ts) | LangGraph 模型与工具循环 |
| [google-adk.ts](google-adk.ts) | ADK Runner 与 Memory |
| [mastra.ts](mastra.ts) | Mastra Agent 与 Memory |
| [ai-sdk.ts](ai-sdk.ts) | AI SDK 模型与工具循环 |

其他示例用 `npx tsx examples/<文件名>.ts` 运行。使用全部框架示例建议 Node.js 22.22+。

## 框架依赖

仓库开发依赖已包含框架；在自己的应用中，只安装选用的框架及适配依赖。

LangChain / LangGraph：

```bash
npm install langchain@^1 @langchain/core@^1 @langchain/langgraph@^1 \
  @langchain/openai@^1 @langchain/anthropic@^1 zod@^4
```

AI SDK、Google ADK 和 Mastra 的模型适配需要：

```bash
npm install ai@^6 @ai-sdk/provider@^3 @ai-sdk/openai@^3 \
  @ai-sdk/openai-compatible@^2 @ai-sdk/anthropic@^3
```

使用 ADK 或 Mastra 时另安装对应框架：

```bash
# Google ADK
npm install @google/adk@^2 @google/genai@^2

# Mastra
npm install @mastra/core@^1
```

## 自定义模型、MCP 和 Skill

运行 [direct-resources.ts](direct-resources.ts) 前，通过环境变量提供自有服务的配置：

| 变量 | 含义 |
| --- | --- |
| `CUSTOM_MODEL_NAME` | 模型名称 |
| `CUSTOM_MODEL_BASE_URL` | 模型 API Base URL |
| `CUSTOM_MODEL_API_KEY` | 模型 API Key |
| `CUSTOM_MCP_URL` | MCP Endpoint |

这些变量由示例代码读取。OpenAI 兼容服务的 Base URL 通常包含 `/v1`。MCP 默认使用 Streamable HTTP，也支持显式选择 SSE 或 stdio；需要鉴权时使用 `headersProvider` 提供请求头。

示例附带 [greeting Skill](skills/greeting/SKILL.md)。用 `await core.skills.local(path)` 加载自己的 Skill 目录，再通过框架的 `skillTools()` 接入 Agent。

云端 Skill 可显式指定版本：

```typescript
const skill = await core.skills.managed('test-skill', '1.0.0');
```

请将 `1.0.0` 替换为该 Skill 已发布的版本。

## 记忆

运行基础示例：`npx tsx examples/memory.ts`。它演示 `test-memory` 的写入与检索，分区和会话参数见 [Memory 快速开始](../README.md#使用-memory)。写入后可能需要一定时间才能检索到。

框架接入见 LangChain、ADK 和 Mastra 示例。应用从可信业务上下文指定 `userId`、`agentId` 或 `sessionId`；框架读写范围均须显式提供至少一个字段，它们不是访问凭证。LangChain 和 Mastra 示例开启写回，ADK 示例在完成后保存一次会话。

例如 `scopeResolver` 可以返回 `{ read: { userId: 'alice' }, write: { userId: 'alice', sessionId: 'session-1' } }`。
ADK 仍通过 `partitionResolver(appName, userId)` 映射到 `agentId`；`addEventsToMemory` 可省略 `sessionId`。

## 凭证与 Header

[凭证示例](mcp-credentials.ts) 展示两种用法：创建托管 MCP 客户端时显式绑定凭证，以及通过 `core.credentials.get(name)` 单独读取凭证。API Key 使用 `.value`；MCP Header 使用 `.asHeaders()`。示例只输出 Header 名称，不输出凭证值。

创建 MCP 时传入的 `headers` 是客户端级固定配置，不用于在共享客户端上逐请求切换用户身份。Header 冲突、保护字段和 Session 的作用范围见 [SDK 说明](../README.md#凭证与-mcp-header)。

## 调用 Agent 服务

服务示例监听 9000 端口，提供 AG-UI 和 OpenAI Chat Completions 接口。向已部署的应用发送请求：

```bash
curl -N 'https://<agent-endpoint>/openai/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  -d '{"model":"app","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

根据部署环境补充认证信息。示例固定使用代码中的模型连接；请求的 `model` 字段不会自动切换连接。AG-UI 接口为 `POST /ag-ui/agent`，健康检查为 `GET /healthz` 和 `GET /readyz`。

AG-UI 请求示例（将 Endpoint 替换为实际地址）：

```bash
curl -N 'https://<agent-endpoint>/ag-ui/agent' \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "example-thread-1",
    "runId": "example-run-1",
    "messages": [
      {"id": "message-1", "role": "user", "content": "加载可用 Skill，按其说明完成一个示范。"}
    ],
    "state": {},
    "tools": [],
    "context": [],
    "forwardedProps": {}
  }'
```

每次运行使用新的 `runId`；同一对话可复用 `threadId`，但它不会让服务自动保存历史。`tools: []` 不会禁用 Agent 代码中已经配置的 MCP/Skill 工具。

运行 `examples/langchain-server.ts` 时，正常输出以 `RUN_STARTED` 开始、`RUN_FINISHED` 结束。发生工具调用时，可看到独立文本消息的 START/CONTENT/END，以及 `TOOL_CALL_START/ARGS/END`、`TOOL_CALL_RESULT`；调用和结果由相同 `toolCallId` 关联。是否调用工具取决于模型和任务，不保证每个请求都有工具事件。运行失败会输出 `RUN_ERROR`。

OpenAI 流式响应输出 `choices[].delta` 并以 `[DONE]` 结束；将 `stream` 改为 `false` 可获取单个 JSON 响应。它不输出独立工具结果，也不能保留多条 assistant 消息边界。模型和工具循环由此服务执行，客户端不要把返回的工具调用轨迹再次执行。

`examples/server.ts` 是无云资源的 Echo 示例，只会返回文本；要观察真实 Agent 的工具流程，请使用 LangChain 服务示例。默认不开放浏览器跨域；若浏览器与服务跨域，由应用按实际来源配置 CORS，参见 [服务指南](../docs/server.md#生命周期与扩展)。

需要展示工具调用和工具结果时，使用[框架执行事件转换器](execution-events.md)接入完整执行流。AG-UI 保留消息边界和工具结果；OpenAI Chat Completions 不表达完整执行轨迹。服务不会替应用保存会话历史，需要多轮对话时由应用或框架管理。
