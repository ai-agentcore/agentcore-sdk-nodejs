# Release notes

## SDK 0.1.7 — 2026-10-30

- 平台 MCP 调用从当前请求上下文透传 WAT，按请求隔离身份；直接连接第三方 MCP 时不自动附加平台身份。
- 支持每次 MCP 工具调用传入业务 Header，并在同一请求内复用 MCP 会话。
- 请求结束时清理请求级会话，确保单个清理任务失败不阻止其余资源释放。

## Collaboration 0.1.4 — 2026-10-22

- 新增房间附件下载与发送工具，按当前房间中的 Matrix Event ID 下载附件到工作区，并将本地文件或图片作为原生 Matrix 消息回复。
- 内置 `room-files` Skill；文件解析和图片理解继续使用应用已有的工具，无需加入 Team 即可处理房间文件。
- 支持请求取消时终止附件传输并清理下载中的临时文件；发送结果不确定时保留事务信息，避免盲目重传导致重复消息。
- 基础 SDK 依赖最低版本提升至 `0.1.6`，以使用请求级取消信号。

## SDK 0.1.6 — 2026-10-22

- `RequestContext` 新增可选的 `AbortSignal`，`AgentCoreServer` 将请求取消信号传递到上下文，供协作附件传输使用。
- 自建 Server 可在绑定请求上下文时提供取消信号；现有调用方式保持兼容。

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
