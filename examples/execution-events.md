# 框架执行事件

使用每个框架适配模块导出的 `AgentCoreConverter`，将完整框架执行流交给 Server。每次请求新建转换器，不要只输出文本 chunk。

```typescript
import { AgentCoreConverter } from 'alibabacloud-agentcore-sdk/integrations/langchain';

async function* invoke(request) {
  const events = agent.streamEvents(
    { messages: request.messages },
    { version: 'v2', signal: request.signal },
  );
  yield* new AgentCoreConverter().stream(events);
}
```

| 导入模块 | 输入 |
| --- | --- |
| `integrations/langchain`、`integrations/langgraph` | `streamEvents(..., { version: 'v2' })` |
| `integrations/google-adk` | `runner.runAsync(...)` 的完整 Event |
| `integrations/ai-sdk` | `streamText(...).fullStream`，不是 textStream |
| `integrations/mastra` | `(await agent.stream(...)).fullStream` |

也可以逐个调用 `converter.convert(event)`，在同一个循环中保留业务日志。LangChain / LangGraph 的完整工具参数在模型一轮结束时输出一次，结果使用 ToolMessage 的 tool_call_id，不是 callback run_id。ADK 最终文本快照不会重复输出；AI SDK / Mastra 不会把不同步骤复用的文本块 ID 当成同一条消息。

## 协议表达范围

| 内容 | AG-UI | OpenAI Chat Completions |
| --- | --- | --- |
| 过程说明 → 最终回答 | 分开的 TEXT_MESSAGE_START / CONTENT / END | 同一个 completion 的 content 增量 |
| 工具调用 | TOOL_CALL_START / ARGS / END | delta.tool_calls |
| 工具结果 | TOOL_CALL_RESULT，保留调用 ID | 不输出：协议没有对应的响应事件 |
| 框架显式 reasoning | reasoning 事件 | reasoning_content 扩展字段 |

OpenAI 非流式结果也只是一条 assistant 消息，不能用来无损还原 Agent 全部执行过程。需要过程展示时使用 AG-UI。转换器不会根据文本猜测“过程/最终答案”，也不会把普通过程说明伪装为 REASONING；客户端根据结构化消息边界、工具关系和自己的展示策略选择主消息 / Thread。

LangChain / LangGraph 会转发框架已经处理并返回的错误 ToolMessage，保留原始调用 ID，不改变错误处理策略。并行模型调用保留各自消息身份；同一次调用中交替出现的文本和 reasoning 各自形成消息段。

自定义执行器可以直接输出 `AgentEvent`。TEXT / REASONING 支持 `message_id`；带 ID 的消息由相同 ID 的 `TEXT_END` / `REASONING_END` 结束，允许交错输出。不带 ID 的 END 关闭该类型的所有当前消息；流正常完成时也会关闭剩余消息。
