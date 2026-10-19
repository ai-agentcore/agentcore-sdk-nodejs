# Release notes

## 0.1.5 — 2026-10-19

- 新增 Agent 模版读取入口 `core.templates.get()`，按指定版本或 `latest` 标签加载 Workspace 中的模版。
- 通过 `template.instruction` 获取主 Agent 的 Prompt，通过 `loadSkills()` 按需加载随包静态 Skill 和引用的云端 Skill；模型仍由应用独立选择。
- Skill 加载支持并发复用和成功结果缓存，返回现有 Skill 对象，可直接接入框架工具适配器。
- 补充 LangChain 使用示例和签名 HTTP 协议回归测试。

## 0.1.4 — 2026-10-18

- Memory 写入默认改为异步提取，`addMemories()` 返回 `{ taskId }`。原先依赖返回值 `memoryIds` 的调用需显式传入 `sync: true`。
- 新增 `getMemoryTask(taskId)`，用于查询提取进度、记忆 ID 和任务错误。
- LangChain、LangGraph、Google ADK 和 Mastra 的记忆回写改为等待任务受理，不等待提取完成。回写开关、消息范围和错误处理方式保持不变。
- 修复 Node 24.21+ 下提前退出 LangChain 自定义 Provider 流时，预读阻塞取消、HTTP 连接不能及时关闭的问题。
