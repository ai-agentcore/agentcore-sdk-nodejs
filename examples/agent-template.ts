import { createAgent } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { model, skillTools } from 'alibabacloud-agentcore-sdk/integrations/langchain';

const core = AgentCore.auto({ logger: console });
try {
  const template = await core.templates.get('my-agent-template', { version: '1.0.0' });
  const skills = await template.loadSkills();
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const agent = createAgent({ model: await model(client), tools: skillTools(skills), systemPrompt: template.instruction });
  const result = await agent.invoke({ messages: [new HumanMessage('介绍你可以使用的技能。')] });
  console.log(result.messages.at(-1)?.content);
} finally {
  await core.close();
}
