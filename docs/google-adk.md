# Google ADK

入口为 `@alibabacloud/agentcore-sdk/integrations/google-adk`，提供 `model()`、`tools()`、`skillTools()` 和 `AgentCoreMemoryService`。实现基于 Node ADK 2.0 的公开扩展接口；不是把 Python LiteLLM 类名复制为 Node 占位实现。

## 按需安装

```bash
npm install @google/adk@^2.0.0 @google/genai@^2.21.0
# 使用 model() 时还需要现有 AI SDK 模型适配依赖：
npm install ai@^6.0.277 @ai-sdk/provider@^3.0.15 @ai-sdk/openai-compatible@^2.0.74 @ai-sdk/openai@^3.0.109 @ai-sdk/anthropic@^3.0.116
```

这些都是可选 peer；主 SDK 不强制安装 ADK。仅使用 ADK 工具或 Memory，不加载 AI SDK 模型依赖。当前使用 Node 22 验证，完整最低 Node 版本矩阵仍在实施清单中。

## 原生 Agent

```typescript
import { AgentCore } from '@alibabacloud/agentcore-sdk';
import { model, tools, skillTools, AgentCoreMemoryService } from '@alibabacloud/agentcore-sdk/integrations/google-adk';
import { LlmAgent, Runner, InMemorySessionService, PRELOAD_MEMORY } from '@google/adk';

const core = AgentCore.auto();
const client = await core.model('test-mc', { model: 'qwen3.8-max' });
const mcp = await core.mcp('test-mcp');
const skill = await core.skills.managed('test-skill');
const memory = new AgentCoreMemoryService(core.memoryStore('test-memory'), {
  partitionResolver: (appName, userId) => `${appName}:${userId}`,
});
const agent = new LlmAgent({
  name: 'agent', model: await model(client),
  tools: [PRELOAD_MEMORY, ...tools(await mcp.listTools()), ...skillTools([skill])],
});
const sessions = new InMemorySessionService();
const runner = new Runner({ appName: 'app', agent, sessionService: sessions, memoryService: memory });
// 创建 Session、运行 Agent、按应用策略写回 Memory，结束后 await core.close()。
```

完整云端 CLI 示例见 `examples/google-adk.ts`，需预先创建示例中的四类资源：

```bash
npx tsx examples/google-adk.ts
```

也可将 `core.directModel(...)` 交给 `model()`；鉴权、地址、模型名称和生命周期仍由 ModelClient 负责。适配层不拥有 Core，不会在单次 Agent 调用结束后关闭资源。

## 模型与工具边界

Node ADK 当前没有 Python 的 LiteLLM 客户端，因此用 `BaseLlm` 接入现有 AI SDK 适配。OpenAI Chat / Anthropic Messages 共用消息、工具调用及流式事件转换；不重写两套鉴权/HTTP 客户端。

- 支持 JSON 和 SSE、系统文本、对话文本、图片/文件输入、函数调用与结果、reasoning 文本和 Anthropic 签名、usage 与结束原因。具体媒体能力仍由下游模型决定。
- 每次流返回 partial 文本，结束后返回完整的非 partial 内容，供 ADK 保存历史；不会把函数参数片段提前当成可执行工具调用。
- Core 的默认 maxTokens 可由 ADK `generateContentConfig.maxOutputTokens` 覆盖；常用采样参数、工具选择和输出 JSON Schema 转发到提供方。GenAI Schema 的大写类型、nullable 和字符串长度限制转换为 JSON Schema；已有 `parametersJsonSchema/responseJsonSchema` 保持原意。
- `LlmRequest.model` 不改变已经绑定的 ModelClient 身份。取消信号与提前结束迭代均会中止底层模型请求，不自动重放生成请求。
- 不实现 Gemini 的 Live/BIDI、Google Search 等服务端内置工具。它们不是当前 AgentCore 网关的 OpenAI/Anthropic 协议能力；请求这些功能会明确报错。

`tools()` 保留 Core 工具的原名、描述和完整 JSON Schema，调用结果由 ADK 原生工具流程包装。适配器不把 JSON Schema 改写成函数签名，也不另加 JSON Schema 校验器；参数约束由具体工具/服务实施。Skill 沿用 Core 的三个工具、执行目录和命令确认配置。

## Memory

`AgentCoreMemoryService` 实现 ADK 的原生 [BaseMemoryService](https://adk.dev/api-reference/typescript/interfaces/BaseMemoryService.html)，不替代 SessionService，也不自动写入每轮消息。

- `searchMemory({appName, userId, query})`：应用提供的 `partitionResolver` 转成 Memory `agentId`；召回跨该逻辑分区的记忆，返回 ADK 的 Content/timestamp。ADK 当前 MemoryEntry 没有 Memory ID 和自定义 metadata 字段，不擅自扩展框架响应。
- `addSessionToMemory(session)`：提取该 Session 的用户文本和最终助手文本；排除工具调用/结果、thought、partial 和错误事件。写入 scope 包含逻辑 agentId 和 ADK session.id。
- `addEventsToMemory({appName, userId, sessionId, events, customMetadata?})`：显式增量写入，事件过滤与完整 Session 相同。用户应选择增量或完整写入方式，SDK 不自行推断游标，也不对重复提交做隐式去重。

调用者身份由应用确定，不能让模型工具参数选择 userId/agentId。`PRELOAD_MEMORY` 和 `LOAD_MEMORY` 可以直接使用该服务；PRELOAD 的调用和失败处理遵循 ADK 自身逻辑。服务本身不吞查询/写入错误，不将失败转换为空数据，不重试结果未知的记忆写入。

## 验证

本地测试覆盖两个模型协议各自的 JSON/SSE、原生 Runner 多轮工具执行、Memory 分区和事件过滤、媒体及 Schema 投影、超时/取消。`tests/framework-server.test.ts` 对 LangChain 与 ADK 共用同一个本地模型/MCP/Skill/Memory 服务，验证 AG-UI 和 OpenAI Server 输出。

独立 tarball 验证 ESM/CJS、仅 ADK Memory/Tools 的可选依赖隔离、完整模型 Agent 和公开类型。测试使用真实框架与本地协议服务，不能据此宣称云端模型、MCP 或 Memory 联调已通过。
