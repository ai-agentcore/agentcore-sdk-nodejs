import { createAgent } from 'langchain';
import { AgentCore } from '../src';
import { AgentCoreServer } from '../src/server';
import { model, tools, AgentCoreConverter } from '../src/integrations/langchain';
import { skillTools } from '../src/skill';

// Cloud example: install the collaboration addon and mount Teams/runtime configuration.
// The platform ingress, not an untrusted client, supplies the collaboration context header.
const core = AgentCore.auto({ logger: console });
async function buildAgent() {
  const worker = await core.collaboration.worker();
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  return createAgent({
    model: await model(client),
    systemPrompt: worker.composePrompt('Complete the assigned work with the available tools.'),
    tools: tools([...worker.tools(), ...skillTools(await worker.skills())]),
  });
}
let agent: Awaited<ReturnType<typeof buildAgent>>;
const server = new AgentCoreServer({
  logger: console,
  startup: async () => { try { agent = await buildAgent(); } catch (error) { await core.close(); throw error; } },
  shutdown: () => core.close(),
  invoke: async function* (request) {
    const content = request.messages.at(-1)?.content;
    if (typeof content !== 'string') throw new Error('This example expects a text assignment');
    // Server already binds the trusted collaboration context across the complete stream.
    const converter = new AgentCoreConverter();
    for await (const event of agent.streamEvents({ messages: [{ role: 'user', content }] }, { version: 'v2', signal: request.signal })) {
      yield* converter.convert(event);
    }
  },
});
await server.start({ port: 9000 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void server.close().catch(error => { console.error(error); process.exitCode = 1; });
});
