# Release notes

## Unreleased

- Memory 写入默认改为异步提取，`addMemories()` 返回 `{ taskId }`。原先依赖返回值 `memoryIds` 的调用需显式传入 `sync: true`。
- 新增 `getMemoryTask(taskId)`，用于查询提取进度、记忆 ID 和任务错误。
- LangChain、LangGraph、Google ADK 和 Mastra 的记忆回写改为等待任务受理，不等待提取完成。回写开关、消息范围和错误处理方式保持不变。
- 修复 Node 24.21+ 下提前退出 LangChain 自定义 Provider 流时，预读阻塞取消、HTTP 连接不能及时关闭的问题。
