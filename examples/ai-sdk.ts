import { generateText, stepCountIs } from 'ai';
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { languageModel, tools } from 'alibabacloud-agentcore-sdk/integrations/ai-sdk';
import { skillTools } from 'alibabacloud-agentcore-sdk/skill';

const core = AgentCore.auto({ logger: console });
try {
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  const result = await generateText({
    model: languageModel(client),
    tools: tools([...await mcp.listTools(), ...skillTools([skill])]),
    prompt: '加载可用 Skill，按其说明完成一个示范。',
    stopWhen: stepCountIs(5),
  });
  console.log(result.text);
} finally {
  await core.close();
}
