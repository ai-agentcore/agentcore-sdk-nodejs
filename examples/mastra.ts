import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { AgentCore } from '../src';
import { model, tools, skillTools, AgentCoreMemoryProcessor } from '../src/integrations/mastra';

// Cloud example. Configure the trusted logical user/session in application code.
const core = AgentCore.auto({ logger: console });
try {
  const memory = new AgentCoreMemoryProcessor(core.memoryStore('test-memory'), {
    scopeResolver: context => ({ read: { agentId: context!.get('user') as string },
      write: { agentId: context!.get('user') as string, sessionId: context!.get('session') as string } }),
    writeBack: true, logger: console,
  });
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  const agent = new Agent({ id: 'example', name: 'example', instructions: 'Use tools when relevant.', model: await model(client),
    tools: { ...tools(await mcp.listTools()), ...skillTools([skill]) }, inputProcessors: [memory], outputProcessors: [memory] });
  const requestContext = new RequestContext();
  requestContext.set('user', 'example-user'); requestContext.set('session', randomUUID());
  const output = await agent.stream('请查看 Skill 并查询杭州时区。', { requestContext, maxSteps: 5 });
  for await (const part of output.fullStream) {
    if (part.type === 'text-delta') process.stdout.write(part.payload.text);
    if (part.type === 'error') throw part.payload.error;
  }
  console.log();
} finally { await core.close(); }
