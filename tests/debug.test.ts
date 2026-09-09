import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError } from '../src/errors';
import { createRuntimeSource, DebugRuntimeSource, DebugToken, parseDebugToken } from '../src/runtime/debug';
import { ControlConfigLoader } from '../src/runtime/control-config';
import { configMapping, httpServer } from './helpers';

const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const resources: Array<{ close(): void }> = [];
afterEach(async () => { resources.splice(0).forEach((r) => r.close()); vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map((s) => s.close())); });
async function server(handler: Parameters<typeof httpServer>[0]) { const result = await httpServer(handler); servers.push(result); return result; }
const encode = (url: string, extra = {}) => Buffer.from(JSON.stringify({ product: 'agentcore', jwtToken: 'original-jwt', controllerUrl: url, matrixUrl: url, modelGatewayUrl: url, ...extra })).toString('base64');
const exchanged = (count: number, jwtTTL = 3_600_000) => ({ token: `sa-${count}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), jwtToken: `jwt-${count}`, jwtExpiresAt: new Date(Date.now() + jwtTTL).toISOString() });

describe('bootstrap token', () => {
  it('accepts current edge token envelope and ignores future fields without leaking JWT', () => {
    const token = parseDebugToken(encode('http://localhost:8000', { newField: 'future' }));
    expect(token.jwtToken).toBe('original-jwt'); expect(token.modelGatewayUrl).toBe('http://localhost:8000');
    expect(inspect(token)).not.toContain('original-jwt'); expect(JSON.stringify(token)).not.toContain('original-jwt');
  });
  it.each(['invalid', '', encode('https://controller.example/path'), encode('https://controller.example', { product: 'other' }), encode('https://controller.example', { matrixUrl: null })])('rejects malformed envelope', (raw) => {
    expect(() => parseDebugToken(raw)).toThrow(ConfigError);
  });
});

it('prioritizes bootstrap over local YAML and executes JWT → SA → scoped STS → signed OSS', async () => {
  const calls: Array<{ url: string; authorization?: string; body: string }> = [];
  let signatureOK = false;
  const oss = await server((req, res) => {
    const date = req.headers.date;
    const canonical = `GET\n\n\n${date}\nx-oss-security-token:oss-sts\n/test-bucket/control/agent.yaml`;
    signatureOK = req.headers.authorization === `OSS oss-ak:${createHmac('sha1', 'oss-sk').update(canonical).digest('base64')}`;
    res.end(stringify(configMapping()));
  });
  const controller = await server((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      calls.push({ url: req.url!, authorization: req.headers.authorization, body });
      if (req.url === '/api/v1/edge/token') res.end(JSON.stringify(exchanged(1)));
      else if (req.url === '/api/v1/credentials/sts?purpose=oss&target=control') res.end(JSON.stringify({
        access_key_id: 'oss-ak', access_key_secret: 'oss-sk', security_token: 'oss-sts', expiration: new Date(Date.now() + 3_600_000).toISOString(),
        oss_endpoint: oss.url, oss_bucket: 'test-bucket', agent_config_path: 'control/agent.yaml',
      }));
      else { res.statusCode = 404; res.end(); }
    });
  });
  vi.stubEnv('AGENTCORE_DEBUG_TOKEN', encode(controller.url));
  const source = createRuntimeSource({ configPath: '/does-not-exist/agent.yaml' }); resources.push(source as DebugRuntimeSource);
  expect(source).toBeInstanceOf(DebugRuntimeSource);
  const [runtime, same] = await Promise.all([source.resolve(), source.resolve()]);
  expect(runtime).toBe(same); expect(signatureOK).toBe(true);
  expect(runtime.config.modelGatewayUrl).toBe(`${controller.url}/model-connection`);
  expect(runtime.config.mcpGatewayUrl).toBe(`${controller.url}/mcp-servers`);
  expect(runtime.config.workspaceId).toBe('ws-test');
  expect(runtime.config.gatewayHeaders.authorization).toBe('Bearer consumer-secret');
  expect(calls).toEqual([
    { url: '/api/v1/edge/token', authorization: undefined, body: JSON.stringify({ jwtToken: 'original-jwt' }) },
    { url: '/api/v1/credentials/sts?purpose=oss&target=control', authorization: 'Bearer sa-1', body: '' },
  ]);
});

it('coalesces SA renewal, uses the rotated JWT, and refreshes before JWT expiry without a foreground request', async () => {
  const jwts: string[] = [];
  const controller = await server((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      jwts.push((JSON.parse(body) as { jwtToken: string }).jwtToken);
      res.end(JSON.stringify(exchanged(jwts.length, jwts.length === 1 ? 300_100 : 3_600_000)));
    });
  });
  const source = new DebugRuntimeSource(parseDebugToken(encode(controller.url))); resources.push(source);
  expect(await Promise.all([source.get(), source.get()])).toEqual(['sa-1', 'sa-1']);
  await sleep(1150);
  expect(jwts).toEqual(['original-jwt', 'jwt-1']);
  expect(await source.get()).toBe('sa-2');
  expect(await Promise.all([source.refresh('sa-2'), source.refresh('sa-2')])).toEqual(['sa-3', 'sa-3']);
  expect(await source.refresh('sa-1')).toBe('sa-3'); expect(jwts).toHaveLength(3);
  source.close();
  await expect(source.get()).rejects.toThrow();
  expect(inspect(source)).not.toContain('jwt-');
});

it('retries transient bootstrap failures but not rejected credentials', async () => {
  let calls = 0; let status = 503;
  const controller = await server((_req, res) => { calls++; res.statusCode = status; res.end('{}'); });
  const source = new DebugRuntimeSource(parseDebugToken(encode(controller.url))); resources.push(source);
  await expect(source.get()).rejects.toThrow('unavailable'); expect(calls).toBe(3);
  status = 401; await expect(source.get()).rejects.toThrow('rejected'); expect(calls).toBe(4);
});

it('does not persist half of a malformed token response', async () => {
  let calls = 0;
  const controller = await server((_req, res) => { calls++; res.end(JSON.stringify(calls === 1 ? { ...exchanged(1), jwtExpiresAt: 'bad' } : exchanged(2))); });
  const source = new DebugRuntimeSource(parseDebugToken(encode(controller.url))); resources.push(source);
  await expect(source.get()).rejects.toThrow('invalid debug token response');
  expect(await source.get()).toBe('sa-2'); expect(calls).toBe(2);
});

it('retries config loading after failed initialization while retaining a valid SA', async () => {
  let yaml = ''; let exchanges = 0;
  const oss = await server((_req, res) => res.end(yaml));
  const controller = await server((req, res) => {
    if (req.url === '/api/v1/edge/token') { exchanges++; res.end(JSON.stringify(exchanged(1))); }
    else res.end(JSON.stringify({ access_key_id: 'ak', access_key_secret: 'sk', security_token: 'sts', expiration: new Date(Date.now() + 3_600_000).toISOString(), oss_endpoint: oss.url, oss_bucket: 'test-bucket', agent_config_path: 'agent.yaml' }));
  });
  const source = new DebugRuntimeSource(parseDebugToken(encode(controller.url))); resources.push(source);
  await expect(source.resolve()).rejects.toThrow(ConfigError);
  yaml = stringify(configMapping());
  expect((await source.resolve()).config.workspaceId).toBe('ws-test'); expect(exchanges).toBe(1);
});

it('loads optional teams and exchanges Matrix token using SA', async () => {
  const oss = await server((_req, res) => { res.statusCode = 404; res.end(); });
  const controller = await server((req, res) => {
    if (req.url === '/api/v1/credentials/matrix-token') res.end(JSON.stringify({ access_token: 'matrix-secret' }));
    else if (req.url === '/api/v1/edge/token') res.end(JSON.stringify(exchanged(1)));
    else res.end(JSON.stringify({ access_key_id: 'ak', access_key_secret: 'sk', security_token: 'sts', expiration: new Date(Date.now() + 3_600_000).toISOString(), oss_endpoint: oss.url, oss_bucket: 'test-bucket', agent_config_path: 'agent.yaml', teams_config_path: 'teams.yaml' }));
  });
  const loader = new ControlConfigLoader(controller.url, { get: () => 'sa' }); resources.push(loader);
  expect(await loader.loadTeams()).toBeUndefined();
  const source = new DebugRuntimeSource(new DebugToken('jwt', controller.url, controller.url, controller.url)); resources.push(source);
  expect(await source.exchangeMatrixToken()).toBe('matrix-secret');
});
