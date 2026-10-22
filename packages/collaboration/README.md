# AgentCore Collaboration for Node.js

为 AgentCore Agent 添加 Worker 任务协作能力，包括任务执行、进度反馈和成果提交。

这是基础 SDK 的可选扩展包，可以独立安装和升级。

协作能力目前按白名单开放，需先在 AgentCore 平台开通。安装本包不会自动开通平台协作能力。

## 安装

公开发行版的安装方式（可用版本以正式发布为准）：

```bash
npm install alibabacloud-agentcore-sdk alibabacloud-agentcore-collaboration
```

协作包 0.1.4 需要基础 SDK `^0.1.6`，以支持请求级取消信号；需要 Node.js 20.3+。同时使用框架时，还需满足该框架的版本要求。

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

请求入口应先完成鉴权，并从可信平台入口接收 `X-AgentCore-Collaboration-Context` 和 `X-AgentCore-Session-ID`，不能直接信任任意客户端提供的协作 Header。`worker.requestContext()` 默认只绑定协作上下文，不代替入口鉴权；传入下文的取消信号时，同时绑定该请求的普通 Context。

应用退出时调用 `await core.close()`。无需使用 SDK Server，也不要求选择特定 Web 框架。

## 协作环境配置

协作工具调用时重新读取运行时 env 文件（默认 `/var/run/agentcore/agent/env`）。任务服务地址和具名 Matrix Token 优先使用文件中的值，缺少的字段从进程环境变量补充。文件不存在时允许仅使用环境变量；必需字段仍缺失、文件无法读取或格式错误时，调用报错，不静默回退。文件中的凭证更新会在后续调用中生效，不会被旧的进程环境变量覆盖。

## Matrix 房间附件

注册上述工具和 Skills 后，会包含 `room-files` Skill 及两个工具，无需改变 AG-UI / OpenAI 消息格式或增加附件 Header：

| 工具 | 参数 | 成功结果 `data` |
|---|---|---|
| `agentteams_download_room_file` | `event_id` | `event_id`、`local_path`、`filename`、`content_type`、`size` |
| `agentteams_send_room_file` | `local_path`、可选 `caption` | `event_id`、`filename`、`status: "sent"` |

群聊可以先发送文件，再回复该文件并 @Agent。转发输入只包含附件摘要及事件 ID；Token 和媒体 URL 不交给模型。房间文件需要 Matrix 身份、当前请求 Context 和房间访问权限，不要求 Team 成员关系。自建 Server 继续通过 `worker.requestContext(headers, callback)` 绑定完整调用。

支持请求取消的自建 Server 可传入第三个参数 `worker.requestContext(headers, callback, signal)`，取消时中止该请求的文件传输，不关闭其他会话共用的客户端。使用本次版本的 `AgentCoreServer` 时自动传递请求取消信号；旧版基础 SDK 不具备自动传递能力。

文件保存到协作工作目录独立的 `attachments/` 子目录，失败时清理半文件；成功文件的保留周期由应用管理。发送只接受工作目录内的普通文件，不允许越界或符号链接，大小受 Matrix 媒体上限约束。PNG/JPEG/GIF/WebP 发送为原生图片，其他格式发送为普通附件。不支持加密附件或跨服务器媒体拉取。

下载只传输文件，不读取、解析文件。将已有文件/图片读取工具与 `worker.tools()` 一起注册；图片还要求视觉模型。未提供读取工具时，Agent 应说明限制，不根据文件名猜测内容。

发送成功会在主时间线回复当前消息，不自动 Mention、不替换 Working 消息、不提交 Task Result 或结束 Run。只有 `status: "sent"` 表示已收到 Matrix 消息事件 ID；`COLLABORATION_ROOM_FILE_SEND_UNKNOWN` 不可盲目重试。先升级协作包和 Agent，再升级转发组件。

## 升级

```bash
npm update alibabacloud-agentcore-collaboration
```

保持基础 SDK 版本兼容，升级后重启应用即可使用新的协作能力。镜像部署时请重新构建镜像。
