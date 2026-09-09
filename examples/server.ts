import { AgentCoreServer, AgentEvent, EventType } from '../src/server';

// Protocol smoke example: no cloud credentials or agent.yaml required.
const server = new AgentCoreServer({
  logger: console,
  invoke: async function* (request) {
    request.signal.throwIfAborted();
    const message = request.messages.at(-1)?.content;
    yield new AgentEvent(EventType.TEXT, { delta: 'Echo: ' });
    yield typeof message === 'string' ? message : 'Hello';
  },
});

await server.start({ port: 9000 });
// Shutdown policy belongs to the application, not the SDK.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().catch(error => { console.error(error); process.exitCode = 1; }); });
}
