import { afterEach, vi } from 'vitest';
import { AccessKeyCredential, ContextMemoryClient, type ContextEvent } from '../src';
import { httpServer } from './helpers';

export const scope = { userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', sessionId: 'session-1' };
export const event = {
  type: 'message',
  timestamp: 1234,
  data: { role: 'user', content: [{ type: 'text', text: 'PRIVATE_CONTENT' }] },
} satisfies ContextEvent;
export const credential = new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' });
export const memory = {
  memoryId: 'memory-1',
  content: { text: 'prefers tea' },
  scope,
  type: 'semantic',
  source: 'events',
  sourceEventIds: ['event-1'],
  valid: true,
  version: 2,
};
const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

export async function setup(handler: Parameters<typeof httpServer>[0]) {
  const server = await httpServer(handler);
  servers.push(server);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const options = {
    workspaceId: 'ws-test',
    regionId: 'cn-hangzhou',
    memoryStoreName: 'test-memory',
    endpoint: server.url,
    accessKeyCredential: credential,
    logger,
  };
  return { client: ContextMemoryClient.fromCredentials(options), options, logger };
}
