# Mastra 模型、工具和 Memory

适配 `@mastra/core` 1.64.x 的原生 Agent、Tool 和 Processor。模型复用 AI SDK 适配层，不增加另一套网关或鉴权实现。

```bash
npm install @mastra/core@^1.64.0 ai@^6.0.277 @ai-sdk/provider@^3.0.15 \
  @ai-sdk/openai-compatible@^2.0.74 @ai-sdk/openai@^3.0.109 @ai-sdk/anthropic@^3.0.116
```

这些是可选框架依赖，不随主 SDK 强制安装。单独使用工具或 Memory Processor 不需要额外安装模型提供方包。框架及其依赖的 Node 版本要求以各包声明为准；当前验证环境是 Node 22.14.0，不代表最低版本已经验收。

```typescript
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { model, tools, skillTools, AgentCoreMemoryProcessor } from 'alibabacloud-agentcore-sdk/integrations/mastra';

const core = AgentCore.auto();
try {
  const memory = new AgentCoreMemoryProcessor(core.memoryStore('test-memory'), {
    scopeResolver: context => ({
      read: { agentId: context!.get('user') as string },
      write: { agentId: context!.get('user') as string, sessionId: context!.get('session') as string },
    }),
    writeBack: true,
    logger: console,
  });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  const agent = new Agent({
    id: 'example', name: 'example', instructions: 'Use tools when relevant.',
    model: await model(await core.model('test-mc', { model: 'qwen3.8-max' })),
    tools: { ...tools(await mcp.listTools()), ...skillTools([skill]) },
    inputProcessors: [memory], outputProcessors: [memory],
  });
  const context = new RequestContext();
  // 由应用已鉴别的请求身份赋值，不让模型决定逻辑分区。
  context.set('user', 'example-user'); context.set('session', 'example-session');
  console.log((await agent.generate('请查看 Skill 并查询杭州时区。', { requestContext: context })).text);
} finally { await core.close(); }
```

## 语义

- `model(client)` 绑定客户端资源，托管及自定义 OpenAI/Anthropic 共用传输、凭证、超时和取消；Responses 显式传 `{ api: 'responses' }`。
- `tools()` 返回原生 Mastra 工具字典，复制 JSON Schema 并交给框架校验；Skill 工具名、参数和执行目录不变。适配器不关闭借用的 Core。
- Memory 在 `processInput` 对本轮末尾连续 user 文本召回一次；不把 assistant/tool 结尾的续跑历史当作新输入。
- `processLLMRequest` 只修改传给模型的 prompt，不写回 MessageList。因此召回参考内容不会被当作会话历史保存。
- `writeBack` 默认关闭。开启后，把**同一个** Processor 加入 `inputProcessors` 和 `outputProcessors`，只写本轮 user 文本与正常 stop 的最后一步 assistant 文本。不写工具结果、推理、中间回复、截断或取消的输出。
- 每轮状态使用 Mastra 提供的请求级 state，不在 Processor 实例保存当前用户或记忆；同一个 Agent 可以服务多个并发请求。
- Memory 服务调用失败为 best-effort，可通过 `logger` 定位；缺少 agentId/sessionId 等应用配置错误仍抛出。Mastra 可能包装为 Input processor error，并在其日志中保留底层错误。

这不是 Mastra `Memory` 存储后端：Thread、历史消息、checkpoint、working memory 仍由应用和框架管理。AgentCore 提供长期记忆的召回和写入，不伪装成 SQL/向量数据库。

## 验证

`tests/mastra.test.ts` 使用真实 Mastra Agent 与本地 HTTP 模型/签名 Memory 服务，覆盖 generate/stream、工具循环、并发分区、错误、取消和写入边界；`tests/framework-server.test.ts` 执行模型 + MCP + Skill + Memory，经 AG-UI/OpenAI 两种协议输出。`tests/package.test.cjs` 验证独立安装后的 ESM/CJS 与公开 TypeScript 类型。这些是本地协议测试，不是云端资源联调。

原生 Processor 生命周期见 [Mastra Processors](https://mastra.ai/docs/agents/processors)。
