# 用手动 AK/SK 或 STS 本地运行

凭证由应用传入 `AccessKeyCredential`。不要写进代码、agent.yaml 或日志；以下环境变量名是示例应用约定，由示例代码读取，不是 SDK 自动凭证发现机制。

```typescript
import { AgentCore, AccessKeyCredential } from '@alibabacloud/agentcore-sdk';

const accessKeyCredential = new AccessKeyCredential({
  accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID!,
  accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET!,
  securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN, // 使用 STS 时提供
});
```

## 只用 Memory 或 Skill：不需要 agent.yaml

```typescript
const core = new AgentCore({
  workspaceId: 'ws-example', regionId: 'cn-hangzhou', accessKeyCredential,
});
try {
  const result = await core.memoryStore('test-memory').searchMemories('饮品偏好', {
    scope: { agentId: 'local-test-user' },
  });
  console.log(result.memories.length);
  const skill = await core.skills.managed('test-skill');
  console.log(skill.name, skill.root);
} finally {
  await core.close();
}
```

记忆空间和 Skill 必须已存在，AK/STS 须有对应 Workspace 的权限。显式 Workspace 模式不与 `configPath/envPath` 或 `AGENTCORE_DEBUG_TOKEN` 组合。固定 STS 过期后需由应用提供新凭证并重建 Core；不会用该 STS 自动获取新的 STS。

## 托管模型和 MCP：另需本地高代码配置

AK/SK 用于控制面查询；网关由 Consumer Header 鉴权。需从已授权的环境取得网关地址和 Consumer，不能将 AK 或其他身份 Token 当成 Consumer。

```yaml
apiVersion: agentteams.io/v1alpha1
kind: AgentConfig
metadata:
  name: local-agent
  workspaceId: ws-example
  regionId: cn-hangzhou
spec:
  model:
    gatewayUrl: https://your-gateway.example/model-connection
  mcp:
    gatewayUrl: https://your-gateway.example/mcp-servers
  credentials:
    header:
      - key: Authorization
        value: Bearer <consumer-token>
```

将文件保存在受限的本地目录，不提交版本控制。网关地址必须能从本机访问。资源名称通过 `core.model('test-mc')`、`core.mcp('test-mcp')` 指定，SDK 按控制面返回的 ID 拼接路径。

```typescript
const core = AgentCore.auto({ configPath: './agent.yaml', accessKeyCredential });
try {
  const model = await core.model('test-mc', { model: 'qwen3.8-max' });
  console.log(await model.completion([{ role: 'user', content: '你好' }]));
  console.log((await (await core.mcp('test-mcp')).listTools()).map(tool => tool.name));
} finally {
  await core.close();
}
```

本机不要配置 `AGENTCORE_DEBUG_TOKEN`，它的启动优先级高于文件。也不要指向云端 env 文件；手动 AK 模式不需要 Controller/SA。默认控制面使用 Workspace 区域对应的线上端点；预发或其他环境用 `controlPlaneEndpoint` 显式指定，显式端点不进行公网/私网探测替换。

## 真实联调记录（2026-09-07）

`tests/live/real-chain.mjs` 和 `real-frameworks.mjs` 是手动云端测试，不进入默认测试。凭证从剪贴板读取，只保留在进程内；`LIVE_CONFIG_PATH` 可指定已有本地 YAML。运行完整框架矩阵使用 Node 22.22+。

本轮 17 项检查通过：真实模型 Chat/Responses（普通与流式）、MCP 初始化/列工具/调用、Skill 下载/读取、Memory 写入/检索，以及 LangChain、LangGraph、Google ADK、Mastra 各自经过 AG-UI/OpenAI 流式入口的真实 Agent 执行、记忆召回与写回。测试独立分区的 15 条记忆已删除。

Memory 写入/检索约 11 秒完成，验证了 AddMemories 超时修复；本地另有延迟 4.5 秒返回的 HTTP 回归测试。不代表 Controller 凭证颁发、所有后端协议或长期稳定性已验证。AgentRun 兼容链路的测试结果见该仓独立记录。

`core.credentials.get()` 不是普通 OpenAPI 元数据读取，还需要 WAT 和身份 STS；仅上述 AK/YAML 无法完成托管凭证查询。

内部验证脚本位于 `tests/live/manual-access-key.ts`，不属于一期用户使用入口：设置 `AGENTCORE_CONFIG_PATH` 时查询模型和 MCP；否则用 `AGENTCORE_WORKSPACE_ID/AGENTCORE_REGION_ID` 查询 Memory。脚本只读 Memory，不写入测试数据。实际模型调用可能产生费用。
