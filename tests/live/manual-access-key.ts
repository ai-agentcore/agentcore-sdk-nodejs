// Internal verification harness; not a supported first-release usage example.
import { AgentCore, AccessKeyCredential } from '../../src';

// These environment names are the application's configuration, not automatic SDK discovery.
const accessKeyCredential = new AccessKeyCredential({
  accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID!,
  accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET!,
  securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN,
});
const configPath = process.env.AGENTCORE_CONFIG_PATH;
const core = new AgentCore({
  ...(configPath ? { configPath } : {
    workspaceId: process.env.AGENTCORE_WORKSPACE_ID!,
    regionId: process.env.AGENTCORE_REGION_ID!,
  }),
  accessKeyCredential,
  controlPlaneEndpoint: process.env.AGENTCORE_CONTROL_ENDPOINT,
  logger: console,
});
try {
  if (configPath) {
    const client = await core.model('test-mc', { model: 'qwen3.8-max' });
    console.log(await client.completion([{ role: 'user', content: '你好' }]));
    console.log((await (await core.mcp('test-mcp')).listTools()).map(tool => tool.name));
  } else {
    const memories = await core.memoryStore('test-memory').searchMemories('饮品偏好', {
      scope: { agentId: 'local-test-user' },
    });
    console.log({ memories: memories.memories.length });
  }
  const skill = await core.skills.managed('test-skill');
  console.log({ skill: skill.name, directory: skill.root });
} finally {
  await core.close();
}
