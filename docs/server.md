# AgentCore Node Server

入口为 `alibabacloud-agentcore-sdk/server`。Server 只负责接收 Agent 请求与协议编码，不创建 Core、不读取 agent.yaml，不根据请求中的 `model` 去选择平台模型；模型资源由业务处理函数自行选择。

## 默认路由

| 路由 | 行为 |
| --- | --- |
| `GET /healthz` | 返回 `{"status":"ok"}` |
| `GET /readyz` | 默认检查是否注册 handler；自定义 `readiness` 可检查资源就绪，未就绪返回 503 |
| `GET /openai/v1/models` | 列出应用的协议模型名，默认 `agentcore`，不是 Workspace 模型目录 |
| `POST /openai/v1/chat/completions` | OpenAI Chat Completions，支持 JSON 和 SSE |
| `POST /ag-ui/agent` | AG-UI RunAgentInput 输入，SSE 输出 |

```typescript
import { AgentCoreServer, AgentEvent, EventType } from 'alibabacloud-agentcore-sdk/server';

const server = new AgentCoreServer({
  logger: console,
  invoke: async function* (request, context) {
    // context.headers 保留普通请求 Header，不以 threadId/sessionId 改写它们。
    request.signal.throwIfAborted();
    yield new AgentEvent(EventType.TEXT, { delta: 'Hello' });
  },
});
await server.start({ port: 9000, hostname: '0.0.0.0' });
// 在应用自己的退出处理函数中 await server.close()。
```

可直接运行的无云资源示例见 `examples/server.ts`。Handler 可同步/异步返回字符串、`AgentEvent` 或两者的同步/异步可迭代对象；`null`、`undefined` 和空字符串忽略。不接受任意业务对象隐式转 JSON。

## 请求与事件

统一 `AgentRequest` 包含 `protocol`、`messages`、`tools`、`stream`、`rawPayload`、`rawRequest` 与 `signal`。消息中的工具字段统一为 `toolCalls/toolCallId`；原始协议字段完整保留在 `rawPayload`。

`AgentEvent(event, data)` 支持以下标准事件，也允许 AG-UI 自定义事件名：

- `TEXT` / `REASONING`：`{delta: string}`。
- `TOOL_CALL`：`{id, name, args}`；完整参数统一序列化成一次工具参数片段。
- `TOOL_CALL_CHUNK`：`{id, name?, args_delta}`。
- `TOOL_RESULT`：`{id, name?, result}`。
- `ERROR`：`{message?, code?}`，终止本轮，不再报告成功结束。

AG-UI 编码处理 Run、Text、Reasoning、Tool 的开始/内容/结束关系；OpenAI 编码聚合文本、reasoning_content 与 tool_calls。OpenAI 工具结果不作为 Chat Completion 输出；自定义 AG-UI 事件不会投影成 OpenAI 字段。

每次 Invoker 恢复异步迭代器时都绑定当前 RequestContext，因此 `currentContext()` 在 handler 和其异步操作中可用。上下文不推断调用者身份，也不按 Agent Session 创建额外 MCP Session。

## 流、错误与取消

两种 SSE 在输出空闲 15 秒后发送 `: ping` 注释；有业务帧时重新计时，不插入业务事件。只保持一个待完成的迭代器读取，输出遵循 Hono 的流背压。

客户端断连时，`request.signal` 会中止。业务必须将该信号传给模型请求及其他可取消的长操作，例如原生模型调用的第三个参数 `{signal: request.signal}`；JavaScript 无法强制终止一个忽略取消信号的 Promise。迭代器退出时执行 `return()`，业务生成器中的 `finally` 用于清理资源。

未知异常只向客户端返回通用错误；注入的 Logger 会记录协议、RequestId、错误类型、message 和 stack。不输出完整请求、Header 或成功凭证响应。应用异常消息和日志可能包含业务信息，应用应控制日志访问权限，避免在异常文本中拼接凭证。

## 生命周期与扩展

`startup` 成功后才监听端口；绑定端口失败时调用 `shutdown` 释放已初始化资源。`close()` 停止接收新连接，等待正在处理的请求结束，再调用 `shutdown`；它不会按任意超时强杀业务。应用如需强制终止在途业务，应使用自己的取消控制器。实例关闭后不再重新启动。

```typescript
const server = new AgentCoreServer({
  startup: async () => { /* 创建业务资源 */ },
  shutdown: async () => { /* await core.close() 等 */ },
  readiness: () => true,
});
```

`ProtocolHandler` 是 `{name, routes(invoker): Hono}`。自定义协议返回自己的 Hono 路由，通过 `AgentInvoker.invoke/invokeStream` 调用同一业务函数。`protocols` 显式传入时替换默认协议；OpenAI/AG-UI 构造函数支持自定义路径前缀。

Server 的 `app` 是可扩展的 Hono 应用，可以增加业务路由或应用选择的鉴权/CORS 中间件。需要覆盖已有路由的中间件，应在外层 Hono 应用先注册，再挂载 `server.app`；外部自行托管 Hono 时，生命周期也由宿主负责，Server 的 `startup/shutdown` 由 `start/close` 管理，不由裸 `app.fetch` 自动调用。

Server 不接管 SIGINT/SIGTERM，不默认放开跨域，也不持有 AgentRun 兼容层的共享 Runtime。

## 验证

`tests/server.test.ts`：官方 OpenAI 客户端实际 HTTP 调用、AG-UI 官方事件 Schema 校验、JSON/SSE 错误、工具参数片段、普通 Header、并发上下文、自定义协议、断连清理、真实 15 秒心跳和启动/关闭。

`tests/package.test.cjs`：独立 tarball 中 ESM/CJS Server 的实际 HTTP 调用和跨入口上下文、公开 TypeScript 类型。以上均为本地测试，不代表云端联调结果。
