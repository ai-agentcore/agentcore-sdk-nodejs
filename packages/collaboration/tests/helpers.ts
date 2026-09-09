import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseTeamsConfig } from '../src/teams';
export function teamsConfig() { return { apiVersion: 'agentteams.io/v1alpha1', kind: 'TeamsConfig', metadata: { runtimeName: 'runtime' }, spec: {
  self: { name: 'worker', runtimeName: 'runtime', matrixUserId: '@worker:server' }, matrix: { tokenEnv: 'MATRIX_TOKEN' }, defaultTeamName: 'team',
  teams: [{ name: 'team', teamRoomId: '!team:server', membership: { role: 'worker' }, members: [
    { type: 'agent', name: 'leader', role: 'leader', runtimeName: 'leader-runtime', matrixUserId: '@leader:server' },
    { type: 'human', name: 'human', role: 'human', matrixUserId: '@human:server' },
  ] }],
} }; }
export const snapshot = () => parseTeamsConfig(JSON.stringify(teamsConfig()));
export async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => { res.statusCode = 500; res.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
