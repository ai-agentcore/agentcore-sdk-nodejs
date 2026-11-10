# AgentCore Memory plugin（首稿）

可选、独立构建的 AgentCore 记忆插件接入包。连接单独部署的 Memory 接入服务，提供显式事件采集和召回，不改变基础 SDK 的 MemoryStore 或已有框架中间件。

## 从源码构建

在本目录执行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
```

Node.js 20.3+，提供 ESM、CJS 和类型声明。源码包名为 `alibabacloud-agentcore-memory-plugin`，版本 0.1.0，尚未发布。业务项目可通过本地文件依赖接入此目录。

```typescript
import { MemoryPlugin } from "alibabacloud-agentcore-memory-plugin";

const plugin = new MemoryPlugin({
  endpoint: gatewayEndpoint, // 完整 /v2/memory 地址
  tokenProvider: () => gatewayToken,
  captureEnabled: true,
});
const session = plugin.session(
  {
    memoryStoreName: identity.memoryStoreName,
    userId: identity.userId,
    agentId: identity.agentId,
    ...(identity.teamId ? { teamId: identity.teamId } : {}),
  },
  identity.sessionId,
);

const recalled = await session.recall(query, {
  mode: "shared",
  maxResults: 3,
  maxChars: 3600,
});
// 由业务框架将 recalled.context 作为带来源标记的参考数据使用。
const receipts = await session.capture(persistedRecords);
```

identity 必须来自业务鉴权入口，persistedRecords 必须是已保存的真实执行记录。完整的函数示例见 `examples/memory-plugin.ts`。

## 使用环境变量配置

```sh
export AGENTCORE_MEMORY_PLUGIN_ENABLED=true
export AGENTCORE_MEMORY_STORE_NAMES="mymemory:true,yourmemory:false,memstore-1:true"
```

```typescript
const plugin = MemoryPlugin.fromEnvironment({
  endpoint: gatewayEndpoint,
  tokenProvider: () => gatewayToken,
});
// plugin.session(binding, sessionId) 中的 memoryStoreName 选择对应库。
```

全局开关默认 false，关闭时不发送采集或召回请求。库名列表默认为空，未列出的库不启用；`name:true` 开启采集和召回，`name:false` 只关闭采集，保留召回。布尔值只接受 true/false，忽略大小写及条目两侧空白；重复库名、空条目、缺失布尔值或格式非法均报错。

fromEnvironment 在调用时读取并固定配置，修改后需重建插件。第二参数可传业务已读取的可信环境映射，默认 process.env。该入口不接受 captureEnabled/recallEnabled 覆盖。显式 new MemoryPlugin(...) 仍只使用构造参数，不读取这两个变量；基础 MemoryStore API 不受影响。配置库名不授予访问权限，每个 binding 仍需对应的服务令牌。

## 采集与召回契约

采集默认关闭，召回默认开启，timeoutMs 默认 1500，允许 100 至 10000。tokenProvider 每次请求获取网关 Bearer 令牌，可异步返回；它与云端 AK、模型 API key 分别管理。每个 session 固定完整 binding 和会话身份；同一授权身份的多个会话可并发共享 plugin，不保存全局 current user。

SourceRecord 包含稳定 sourceId 和 event。支持 message、tool_call、tool_result、model_request、model_response 五种事件；timestamp 为非负整数毫秒，data 保留结构化内容。工具调用包含 callId、name、arguments，工具结果包含 callId、status、content。只有 harness 确认完整的事件才能提交，不自动采集流式 chunk 或安装 middleware。

sourceId 使用业务 producer 命名空间，与源 timestamp 和内容一起持久保存。每批 1 至 100 条，单事件不超过 900000 UTF-8 字节，总请求不超过 1 MiB，不自动拆批或重试。结果保留 queued、stored、unknown、failed；queued 不代表云端存储，stored 不代表提取或检索完成。

`MemoryPluginError.outcomeUnknown` 表示采集结果无法确认。业务保留原记录并核对网关；不能生成新 ID 或 timestamp 盲目重发。SDK 没有本地持久队列，受理前可靠性由业务负责，受理后的云端投递由网关账本负责。AbortSignal 可以取消请求等待，但不能证明服务端未受理。

shared 在相同授权范围跨会话召回，session 只读当前会话。memories 保留 sourceEventIds，context 明确标记为不可信参考数据；maxChars 包含标记和 JSON 格式开销，按 Unicode 码点计数。关闭召回或空查询返回空结果，服务故障抛出错误。准备 context 不等于模型使用记忆。

需要支持 `host=sdk` 的 `/v2/memory/capture` 和 `/search` 接入服务。业务自行安排前置召回、事件采集及框架注入；避免对相同事件同时开启原 Memory middleware 自动回写。本稿未完成真实云端端到端验收。
