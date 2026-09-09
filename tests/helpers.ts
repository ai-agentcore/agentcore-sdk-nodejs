import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function httpServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export function configMapping() {
  return {
    apiVersion: 'agentteams.io/v1alpha1', kind: 'AgentConfig',
    metadata: { runtimeName: 'test-agent', workspaceId: 'ws-test', regionId: 'cn-hangzhou' },
    spec: {
      model: { gatewayUrl: 'https://gateway.example/model-connection' },
      mcp: { gatewayUrl: 'https://gateway.example/mcp-servers' },
      credentials: { header: [{ key: 'Authorization', value: 'Bearer consumer-secret' }] },
    },
  };
}
