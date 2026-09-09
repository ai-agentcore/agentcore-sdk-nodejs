import { createAgent } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AgentCore } from '../src';
import { AgentCoreServer } from '../src/server';
import { model, tools, skillTools, agentCoreMemoryMiddleware, AgentCoreConverter } from '../src/integrations/langchain';

// Cloud runtime example. Create these named resources in the Agent's Workspace first.
const core = AgentCore.auto({ logger: console });
async function createApplicationAgent() {
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  return createAgent({
    model: await model(client),
    tools: [...tools(await mcp.listTools()), ...skillTools([skill])],
    middleware: [agentCoreMemoryMiddleware(core.memoryStore('test-memory'), {
      contextSchema: z.object({ sessionId: z.string() }),
      scopeResolver: ({ sessionId }) => ({ read: { agentId: 'langchain-example' }, write: { agentId: 'langchain-example', sessionId } }),
      writeBack: true,
    })],
  });
}
let agent: Awaited<ReturnType<typeof createApplicationAgent>>;
const server = new AgentCoreServer({
  logger: console,
  startup: async () => {
    try { agent = await createApplicationAgent(); }
    catch (error) { await core.close(); throw error; }
  },
  shutdown: () => core.close(),
  invoke: async function* (request, context) {
    // Single-user text-turn example, not a checkpoint/history implementation.
    // Production applications must select scope from their own trusted identity/session.
    const sessionId = context.headers['x-agentcore-session-id'] ?? 'example-session';
    const content = request.messages.at(-1)?.content;
    if (typeof content !== 'string') throw new Error('This example expects a text user turn');
    const converter = new AgentCoreConverter();
    for await (const event of agent.streamEvents({ messages: [new HumanMessage(content)] }, {
      version: 'v2', signal: request.signal, context: { sessionId },
    })) {
      yield* converter.convert(event);
    }
  },
});

await server.start({ port: 9000 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().catch(error => { console.error(error); process.exitCode = 1; }); });
}
