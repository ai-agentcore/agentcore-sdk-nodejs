# AgentCore SDK for Node.js

使用 TypeScript 或 JavaScript 构建 Agent，连接 AgentCore 云端资源或自有服务，并与常用 Agent 框架集成。

[AgentCore 官网](https://www.aliyun.com/product/agentcore) · [官方文档](https://help.aliyun.com/zh/agentcore/) · [示例指南](examples/README.md)

## 从这里开始

| 你想做什么 | 入口 |
| --- | --- |
| 连接平台上的模型、MCP 和 Skill | [云端资源](#使用云端资源) |
| 在部署时选择模型、模版、MCP 和 Skill | [环境变量配置](#通过环境变量选择资源) |
| 使用自己的模型、MCP 或本地 Skill | [自定义资源](#使用自定义资源) |
| 为 Agent 添加长期记忆 | [Memory](#使用-memory) |
| 原生 Context 事件、分页与完整记忆检索 | [Native Context Memory](docs/context-memory.md) |
| 为自有 harness 显式采集事件和召回 | [可选 Memory 插件](packages/memory-plugin/README.md) |
| 配置 MCP 凭证与固定 Header | [凭证与 Header](#凭证与-mcp-header) |
| 接入已有 Agent 框架 | [框架集成](#框架集成) |
| 将 Agent 发布为 HTTP 服务 | [服务协议](#提供-agent-服务) |

## 功能

- **模型**：访问托管模型，或连接自定义模型服务。
- **工具与 Skill**：接入 MCP 服务，使用云端或随应用分发的 Skill。
- **记忆**：检索和保存长期记忆，接入框架的 Agent 执行流程。
- **凭证**：按名称获取托管 API Key，或为 MCP 显式绑定 Header 凭证。
- **服务协议**：通过 AG-UI 或 OpenAI Chat Completions 提供 Agent 服务。

支持 LangChain、LangGraph、Google ADK、Mastra 和 AI SDK。

## 安装

基础 SDK 需要 Node.js 20.3+；使用全部框架示例建议 Node.js 22.22+。

```bash
npm install alibabacloud-agentcore-sdk
```

框架依赖按需安装，见 [示例指南](examples/README.md#框架依赖)。

## 快速开始

### 使用云端资源

先参考[官方文档](https://help.aliyun.com/zh/agentcore/)创建 Workspace，再按需准备模型连接、MCP 和 Skill，并为 Agent 授予访问权限。以下代码在部署到 AgentCore 的应用中运行；将资源名称替换为当前 Workspace 中自己的资源名称。只使用模型时，无需创建 MCP 或 Skill。

```typescript
import { AgentCore } from 'alibabacloud-agentcore-sdk';

const core = AgentCore.auto();
try {
  const model = await core.model('test-mc', { model: 'qwen3.8-max' });
  const response = await model.completion([{ role: 'user', content: '你好' }]);
  console.log(response);

  const mcp = await core.mcp('test-mcp');
  console.log((await mcp.listTools()).map(tool => tool.name));

  const skill = await core.skills.managed('test-skill');
  console.log(skill.name);
} finally {
  await core.close();
}
```

### 凭证与 MCP Header

在平台创建凭证并授权后，使用 `await core.credentials.get(name)` 按名称获取。API Key 凭证通过 `credential.value` 读取；MCP Header 凭证通过 `credential.asHeaders()` 读取。不要将凭证值写入日志或提交到代码仓库。

托管 MCP 可在创建时显式绑定 MCP Header 凭证，并追加固定 Header。只有该 MCP 在凭证允许的应用范围内时才能使用：

```typescript
const mcp = await core.mcp('test-mcp', {
  credentialName: 'my-mcp-credential', // 可省略；须在平台创建并允许访问该 MCP
  headers: { 'x-business-id': 'my-app' }, // 可省略
});
```

Header 作用于该客户端的握手、工具发现和工具调用，不是请求级身份上下文。
SDK 会复制配置，不同 Header 配置使用不同客户端和 Session；不传时保持原有行为。
合并顺序为平台 Header → 凭证 Header → 自定义 Header；名称大小写不敏感，冲突直接报错，不做覆盖。
`Authorization`、平台已配置的 Header，以及 `Host`、`Mcp-Session-Id`、`Mcp-Protocol-Version` 等协议维护字段不可覆盖。
HTTP Header provider 在每次发送请求时求值，Session 复用不影响 Header 更新。
托管 MCP 使用 Streamable HTTP；直连 MCP 保留 `headersProvider`，stdio 不承载 HTTP Header。
不要修改共享客户端来切换用户身份。Header 的内容由业务明确选择，不自动透传入站请求头。
固定 Header 不等于可信身份。完整示例见 [MCP 凭证与 Header](examples/mcp-credentials.ts)。

### 使用自定义资源

连接自有模型、MCP 服务，无需在 AgentCore 注册资源：

```typescript
import { AgentCore } from 'alibabacloud-agentcore-sdk';

const core = new AgentCore();
try {
  const model = core.directModel({
    provider: 'openai',
    model: process.env.CUSTOM_MODEL_NAME!,
    baseURL: process.env.CUSTOM_MODEL_BASE_URL!,
    apiKey: process.env.CUSTOM_MODEL_API_KEY!,
  });
  console.log(await model.completion([{ role: 'user', content: '你好' }]));

  const mcp = core.directMCP({ url: process.env.CUSTOM_MCP_URL! });
  console.log((await mcp.listTools()).map(tool => tool.name));
} finally {
  await core.close();
}
```

本地 Skill 加载方式及完整配置见 [自定义资源示例](examples/direct-resources.ts)。

## 使用 Agent 模版

在当前 Workspace 中准备一个已发布的 Agent 模版，并授予应用相应的模版和 Skill 读取权限：

```typescript
const template = await core.templates.get('my-agent-template', { version: '1.0.0' });
const instruction = template.instruction;
const skills = await template.loadSkills();
```

`instruction` 是模版主 Agent 的 Prompt 字符串。`loadSkills()` 按需加载随包 Skill 和引用的云端 Skill，返回现有 `Skill` 对象，可直接交给各框架的 `skillTools()`。模型由应用独立配置。

省略模版版本时使用 `latest` 标签；同一个模版对象成功加载 Skill 后会复用结果，不自动跟随引用标签变化。请在 Core 的生命周期内加载和使用 Skill。完整用法见 [Agent 模版示例](examples/agent-template.ts)。

## 通过环境变量选择资源

部署时可通过进程环境变量配置一个默认模型、一个 Agent 模版（AgentSpec），以及多个 MCP 和 Skill，不必把资源名称写死在代码中。先在当前 Workspace 准备对应资源并授予应用访问权限。

| 环境变量 | 内容 |
| --- | --- |
| `AGENTCORE_MODEL_CONNECTION_NAME` | 默认模型连接名称 |
| `AGENTCORE_MODEL_NAME` | 默认连接下的模型名称，可选；省略时沿用连接的模型选择规则 |
| `AGENTCORE_AGENT_SPEC_NAME` | 默认 AgentSpec 名称 |
| `AGENTCORE_AGENT_SPEC_VERSION` | AgentSpec 版本，可选；省略时使用 `latest` 标签 |
| `AGENTCORE_MCP_NAMES` | MCP 名称的 JSON 字符串数组 |
| `AGENTCORE_SKILLS` | Skill 的 JSON 对象数组；每项包含 `name` 和可选的 `version`，省略版本时使用 `latest` 标签 |

例如，将下列名称和版本替换为自己 Workspace 中的资源：

```bash
export AGENTCORE_MODEL_CONNECTION_NAME=test-mc
export AGENTCORE_MODEL_NAME=qwen3.8-max
export AGENTCORE_AGENT_SPEC_NAME=my-agent-spec
export AGENTCORE_AGENT_SPEC_VERSION=1.0.0
export AGENTCORE_MCP_NAMES='["test-mcp","another-mcp"]'
export AGENTCORE_SKILLS='[{"name":"test-skill"},{"name":"another-skill","version":"1.0.0"}]'
```

```typescript
const core = AgentCore.auto();
try {
  const model = await core.model();
  const mcps = await core.mcpsFromEnv();
  const skills = await core.skills.fromEnv();
  const template = await core.templates.get();
  const instruction = template.instruction;
} finally {
  await core.close();
}
```

[完整示例](examples/environment-resources.ts)。框架适配器继续接收已经解析的 Model Client、MCP 工具和 Skill。

显式传资源名时保持原有行为，不继承默认连接的模型名称或默认 AgentSpec 的版本；省略资源名时，也可显式传模型名称或版本覆盖对应默认值。MCP／Skill 未配置时批量入口返回空列表，配置为 `[]` 也表示不加载；非法 JSON 或列表项会在调用相应入口时报错。

只需配置实际使用的资源。SDK 不自动加载这些资源，也不自动将 AgentSpec 内的 Skill 与环境变量 Skill 合并。同一个已初始化客户端不会随环境变量变化自动切换资源；修改后请重新创建客户端或重新部署。认证与访问权限的配置方式不变。

## 使用 Memory

SDK 0.1.9 新增原生 `core.contextMemory(name)`，提供 CreateEvents、分页 ListEvents 和包含类型、来源等信息的 SearchMemories。它使用 `context` 凭据及独立 Memory endpoint，支持四维可选 scope。用法、错误与取消边界见 [Native Context Memory](docs/context-memory.md)。下文 `memoryStore()` 的提取和 CRUD 行为保持兼容。

Memory 用于保存和检索长期记忆，也支持查询、更新、删除记忆以及查看会话消息。使用前，在 AgentCore 中创建 MemoryStore 并授予应用访问权限。

```typescript
import { AgentCore } from 'alibabacloud-agentcore-sdk';

const core = AgentCore.auto();
try {
  const store = core.memoryStore('test-memory');
  const submission = await store.addMemories({
    scope: { userId: 'example-user', sessionId: 'session-1' },
    text: '用户喜欢简短的中文回答。',
  });

  console.log('Memory task:', submission.taskId);
  const task = await store.getMemoryTask(submission.taskId);
  console.log('Task status:', task.status);

  // 检索已有记忆；刚提交的任务可能尚未完成。
  const result = await store.searchMemories('用户有哪些回答偏好？', {
    scope: { userId: 'example-user' },
    topK: 5,
  });
  for (const hit of result.memories) {
    console.log(hit.memory.content.text);
  }
} finally {
  await core.close();
}
```

- `userId`、`agentId`、`sessionId` 是独立的记忆范围字段；写入时都可省略，服务端会使用默认范围。
- 查询时只指定需要精确匹配的字段，未指定字段按通配范围查询；响应中的默认范围字段表现为 `undefined`。
- `listMemorySessionMessages(sessionId, { userId, agentId })` 要求会话 ID，且 `userId`、`agentId` 至少提供一个。
- 分区标识由可信业务上下文提供，不替代访问权限控制。

示例会写入真实数据，建议使用测试记忆空间。新写入的记忆可能需要一定时间才能检索到，首次查询可能为空。

`addMemories()` 返回任务 ID，通过 `getMemoryTask(taskId)` 查询处理进度。任务成功后可从 `memoryIds` 读取记忆 ID；失败时可从 `error` 查看原因。

如需等待提取完成并直接读取 `memoryIds`，显式传入 `sync: true`：

```typescript
const result = await store.addMemories({ text: '用户喜欢简短回答。', sync: true });
console.log(result.memoryIds);
```

完整代码见 [Memory 基础示例](examples/memory.ts)。框架接入见 [LangChain](examples/langchain-server.ts)、[Google ADK](examples/google-adk.ts) 和 [Mastra](examples/mastra.ts) 示例。

## 框架集成

将模型、MCP 和 Skill 接入现有框架，不必重写 Agent 的业务逻辑。

| 框架 | 使用指南 | 示例 |
| --- | --- | --- |
| LangChain | [LangChain / LangGraph](docs/langchain.md) | [Agent 服务与 Memory](examples/langchain-server.ts) |
| LangGraph | [LangChain / LangGraph](docs/langchain.md) | [模型与工具循环](examples/langgraph.ts) |
| Google ADK | [Google ADK](docs/google-adk.md) | [Runner 与 Memory](examples/google-adk.ts) |
| Mastra | [Mastra](docs/mastra.md) | [Agent 与 Memory](examples/mastra.ts) |
| AI SDK 6 | [AI SDK](docs/ai-sdk.md) | [模型与工具循环](examples/ai-sdk.ts) |

## 提供 Agent 服务

`AgentCoreServer` 支持 AG-UI、OpenAI Chat Completions 和自定义 `ProtocolHandler`。

在仓库中运行 [最小服务示例](examples/server.ts)：

```bash
npm ci
npm run build
npx tsx examples/server.ts
```

示例监听 9000 端口，默认接口为 `POST /ag-ui/agent` 和 `POST /openai/v1/chat/completions`，支持流式响应。

示例使用公开包名导入，在仓库中运行前需要构建本地包。完整模型、MCP、Skill 和 Memory 服务见 [LangChain 示例](examples/langchain-server.ts)，AG-UI/OpenAI 请求示例见 [调用 Agent 服务](examples/README.md#调用-agent-服务)。

框架执行流应使用对应的[事件转换器](examples/execution-events.md)，不要只提取文本。AG-UI 可表达消息边界、工具调用和工具结果；OpenAI Chat Completions 按其标准表达文本和工具调用，不提供独立的工具结果流式事件。会话历史的保存与恢复仍由应用或所用框架负责。完整配置见 [Agent 服务指南](docs/server.md)。

## 使用提示

`AgentCoreServer` 在当前执行上下文中保留入站网关设置的 `X-AgentCore-Accessor-WAT`。
`core.mcp()` 调用平台 MCP 时自动携带该原始值，同一次入站请求内复用 MCP Session，
不同入站请求隔离，请求结束（包括失败或取消）后关闭 Session。已有网关 `Authorization` 继续保留；
直连 MCP 不会自动收到平台 WAT。不要把 Accessor JWT、WAT 或 Matrix ID 配成固定 MCP
Header。自行启动的后台任务或跨进程执行需要显式传播可信请求上下文。
`listTools({ headers: { "X-Trace-ID": "..." } })`、`callTool(name, args, { headers: {...} })`
支持逐次传入业务 Header，不改变 MCP Session；身份、Authorization 和协议 Header 不可覆盖。
手动管理 `RequestContext` 时，在请求结束后调用 `await context.close()` 释放 Session。
WAT 兑换、到期恢复和工具权限校验由网关负责，SDK 不会自动重试工具调用。

- 在应用生命周期内复用 Core，退出时调用 `await core.close()`。
- 模型的工具调用、Responses 和 Embedding 支持情况取决于所选模型。
- 仅加载可信 Skill；不需要执行命令时设置 `ALLOW_EXECUTE_COMMAND=false`。
- 使用 `AgentCore.auto({ logger: console })` 开启日志，不要记录 API Key 等敏感信息。

更多资源配置、框架依赖与运行命令见 [示例指南](examples/README.md)。

执行流接入参见 [框架事件转换器与协议边界](examples/execution-events.md)。展示工具执行过程时，不要只转发文本 chunk。
