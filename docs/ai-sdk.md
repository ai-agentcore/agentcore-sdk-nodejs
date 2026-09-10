# AI SDK 模型与工具适配

该入口适用于 AI SDK 6，也可将生成的 `LanguageModelV3` 交给使用该接口的 Mastra。完整 Mastra Agent 与其他框架的验收仍在实施清单中跟踪。

## 安装与使用

主 SDK 不强制安装框架；选用此子路径时安装对应可选 peer 依赖：

```bash
npm install ai@^6.0.277 @ai-sdk/provider@^3.0.15 \
  @ai-sdk/openai-compatible@^2.0.74 @ai-sdk/openai@^3.0.109 @ai-sdk/anthropic@^3.0.116
```

```typescript
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { languageModel, tools } from 'alibabacloud-agentcore-sdk/integrations/ai-sdk';
import { skillTools } from 'alibabacloud-agentcore-sdk/skill';
import { generateText, stepCountIs } from 'ai';

const core = AgentCore.auto();
try {
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  const result = await generateText({
    model: languageModel(client),
    tools: tools([...await mcp.listTools(), ...skillTools([skill])]),
    prompt: '请使用可用工具完成我的请求。',
    stopWhen: stepCountIs(5),
    maxRetries: 0,
  });
  console.log(result.text);
} finally {
  await core.close();
}
```

重复工具名会报错，避免合并工具时静默覆盖。MCP 调用结果仍为官方 MCP 结果对象，Skill 沿用自身返回内容。

## 协议与生命周期

- `languageModel(client)` 根据客户端协议选择 OpenAI-compatible Chat 或 Anthropic Messages。资源身份已绑定，不重新查询控制面。
- OpenAI Responses 显式用 `languageModel(client, { api: 'responses' })`。网关有路由不代表后端模型支持，服务端拒绝会原样传播，不切回 Chat，也不按模型目录模拟流式。
- `generateText` / `streamText` 的返回值、工具循环、消息和事件转换由 AI SDK 原生实现负责。
- 连接描述中的 `maxTokens` 只作默认 `maxOutputTokens`；调用方显式值优先。
- 显式指定的结构化输出 JSON Schema 会传给下游，不静默降级为普通 JSON 模式；模型是否支持由下游判断，拒绝时正常报错。
- 原生客户端与框架共用 `ModelClient.httpFetch()`，实际发送时注入 Consumer Header 或自定义凭证；保持请求的其他 Header、手动重定向策略、客户端超时和取消。
- 适配器不接管 Core 所有权。应用关闭 Core 后，已有框架模型也不能继续发送请求。AI SDK 的重试行为由应用的 `maxRetries` 控制。
- 自定义 OpenAI/Anthropic 模型可先通过 `core.directModel()` 构造，无需 `agent.yaml`。其他提供方使用 `core.directModel({ languageModel })`，返回 `ProviderModelClient`；它的 `client.languageModel` 可直接交给 AI SDK，详见 [多提供方接入](direct-providers.md)。

## 已验证范围

本地真实 HTTP 服务覆盖模型→工具→模型循环、Chat SSE、Responses JSON/SSE、Anthropic、错误传播、动态自定义凭证、Request Header、超时及关闭。打包后另在独立目录验证 ESM/CJS 调用，以及未安装框架时主包可用。这些不是云端模型联调结果。
