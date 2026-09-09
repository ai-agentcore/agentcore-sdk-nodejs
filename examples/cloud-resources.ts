import { AgentCore } from '@alibabacloud/agentcore-sdk';

// Run in a cloud container with platform-provided configuration.
const core = AgentCore.auto({ logger: console });
try {
  const model = await core.model('test-mc', { model: 'qwen3.8-max' });
  console.log(await model.completion([{ role: 'user', content: '请简短介绍你自己。' }]));
  // Optional fixed headers apply to this MCP client's connections and calls.
  const mcp = await core.mcp('test-mcp', { headers: { 'x-business-id': 'example-app' } });
  console.log('MCP tools:', (await mcp.listTools()).map(tool => tool.name));
  // Pass an existing version as the second argument to pin the Skill.
  const skill = await core.skills.managed('test-skill');
  console.log('Skill:', skill.name, skill.version);
  // To execute MCP tools, use a framework example or mcp.callTool(name, arguments).
} finally {
  await core.close();
}
