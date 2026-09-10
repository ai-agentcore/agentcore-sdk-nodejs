# AgentCore Collaboration for Node.js

为 AgentCore Agent 添加 Worker 任务协作能力，包括任务执行、进度反馈和成果提交。

这是基础 SDK 的可选扩展包，可以独立安装和升级。

## 安装

公开发行版的安装方式（可用版本以正式发布为准）：

```bash
npm install alibabacloud-agentcore-sdk alibabacloud-agentcore-collaboration
```

协作包 0.1.x 适用于基础 SDK `^0.1.0`，需要 Node.js 20.3+。同时使用框架时，还需满足该框架的版本要求。

本页使用 LangChain，建议 Node.js 22.22+。请额外安装：

```bash
npm install langchain@^1 @langchain/core@^1 @langchain/langgraph@^1 \
  @langchain/openai@^1 @langchain/anthropic@^1 zod@^4
```

使用其他框架时，按需安装对应的 [框架依赖](../../examples/README.md#框架依赖)。

## 使用

先在 AgentCore 中为 Agent 配置团队和 Worker 角色，再将协作指令、工具及 Skill 加入 Agent：

```typescript
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { skillTools } from 'alibabacloud-agentcore-sdk/skill';
import { tools } from 'alibabacloud-agentcore-sdk/integrations/langchain';

const core = AgentCore.auto();
const worker = await core.collaboration.worker();

const instructions = worker.composePrompt('完成分配的业务任务。');
const agentTools = tools([...worker.tools(), ...skillTools(await worker.skills())]);
// 将 instructions 和 agentTools 传给 LangChain Agent。
// 应用退出时 await core.close()。
```

完整示例见 [LangChain 协作服务](../../examples/collaboration-server.ts)。其他框架可使用各自的工具适配器。

协作指令只补充能力和操作规则，不覆盖应用身份。普通请求按应用原有方式处理；收到任务分配或修订通知时进入任务流程。尚未配置团队和 Matrix 身份时，允许初始化 Worker，但团队操作返回未配置团队的错误；后续配置更新可被读取，无需重建 Worker。

建议通过 `AgentCoreServer` 接收协作任务；自建服务器需要使用 `worker.requestContext(headers, callback)` 包围完整的 Agent 执行，并确保请求来自受信任的调用方。

## 使用自己的 Server

不使用 `AgentCoreServer` 时，也可以将协作工具接入已有应用。沿用上面的 `core`、`worker`、`instructions` 和 `agentTools`，构建一次 Agent：

```typescript
import { createAgent } from 'langchain';
import { model } from 'alibabacloud-agentcore-sdk/integrations/langchain';

const client = await core.model('test-mc', { model: 'qwen3.8-max' });
const agent = createAgent({
  model: await model(client),
  systemPrompt: instructions,
  tools: agentTools,
});

type AgentInput = Parameters<typeof agent.invoke>[0];
```

在现有 Server 的请求处理函数中，将请求头规范化为字符串映射，并将解析后的 Agent 输入传入以下接入函数。普通调用：

```typescript
async function invokeAgent(headers: Record<string, string>, input: AgentInput) {
  return worker.requestContext(headers, async () => {
    return await agent.invoke(input);
  });
}
```

流式调用：

```typescript
async function streamAgent(
  headers: Record<string, string>,
  input: AgentInput,
  emit: (update: unknown) => Promise<void>,
  signal: AbortSignal,
) {
  await worker.requestContext(headers, async () => {
    const stream = await agent.stream(input, { streamMode: 'updates', signal });
    for await (const update of stream) {
      await emit(update);
    }
  });
}
```

`emit` 由自建 Server 实现，负责将 LangChain 更新编码成平台配置的 AG-UI / OpenAI 等协议并写入响应；这些更新本身不是协议事件。客户端断开时触发传入的 `AbortSignal`。完整的流迭代必须在 `requestContext` 回调内完成，不要只从回调返回生成器再到外部消费。

请求入口应先完成鉴权，并从可信平台入口接收 `X-AgentCore-Collaboration-Context` 和 `X-AgentCore-Session-ID`，不能直接信任任意客户端提供的协作 Header。`worker.requestContext()` 只绑定协作上下文，不代替入口鉴权，也不绑定 SDK 的普通请求 Context。

应用退出时调用 `await core.close()`。无需使用 SDK Server，也不要求选择特定 Web 框架。

## 升级

```bash
npm update alibabacloud-agentcore-collaboration
```

保持基础 SDK 版本兼容，升级后重启应用即可使用新的协作能力。镜像部署时请重新构建镜像。
