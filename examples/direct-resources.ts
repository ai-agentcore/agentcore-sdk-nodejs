import { fileURLToPath } from 'node:url';
import { AgentCore } from '@alibabacloud/agentcore-sdk';
import { skillTools } from '@alibabacloud/agentcore-sdk/skill';

// Your own service endpoints and credentials, not platform resource names.
const core = new AgentCore({ logger: console });
try {
  const model = core.directModel({
    provider: 'openai',
    model: process.env.CUSTOM_MODEL_NAME!,
    baseURL: process.env.CUSTOM_MODEL_BASE_URL!,
    apiKey: process.env.CUSTOM_MODEL_API_KEY!,
  });
  console.log(await model.completion([{ role: 'user', content: '你好' }]));
  const mcp = core.directMCP({
    url: process.env.CUSTOM_MCP_URL!,
    // For authenticated services, supply your own resolver:
    // headersProvider: () => ({ Authorization: process.env.CUSTOM_MCP_AUTH! }),
  });
  console.log('MCP tools:', (await mcp.listTools()).map(tool => tool.name));
  const skills = await core.skills.local(fileURLToPath(new URL('./skills', import.meta.url)));
  console.log('Local Skills:', skills.map(skill => skill.name));
  console.log('Skill tools:', skillTools(skills).map(tool => tool.name));
  // Convert these tools with a framework adapter to run an Agent tool loop.
} finally {
  await core.close();
}
