import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { Collaboration } from '../src';
import { CollaborationConfigError } from 'alibabacloud-agentcore-sdk/collaboration';
import { httpServer, teamsConfig } from './helpers';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'collab-facade-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }

it('uses the mounted env dynamically and disables the same Worker when teams.yaml is removed', async () => {
  const root = await directory(), teamsPath = join(root, 'teams.yaml'), envPath = join(root, 'env');
  await writeFile(teamsPath, JSON.stringify(teamsConfig()));
  const tokens: string[] = [];
  const server = await httpServer((req, res) => { tokens.push(req.headers.authorization!); res.end('{}'); }); cleanup.push(() => server.close());
  await writeFile(envPath, `export AGENTCORE_TASK_SERVICE_ENDPOINT=${server.url}\nexport MATRIX_TOKEN=one\n`);
  const collaboration = new Collaboration({ teamsPath, envPath, workspaceDir: root }); cleanup.push(() => collaboration.close());
  const [a, b] = await Promise.all([collaboration.worker(), collaboration.worker()]); expect(a).toBe(b);
  expect(a.composePrompt('')).toContain(await realpath(root));
  const tool = a.tools().find(t => t.name === 'agentteams_get_task')!;
  expect(await tool.invoke({ task_id: 'task' })).toMatchObject({ ok: true });
  await writeFile(envPath, (await readFile(envPath, 'utf8')).replace('TOKEN=one', 'TOKEN=two'));
  expect(await tool.invoke({ task_id: 'task' })).toMatchObject({ ok: true });
  expect(tokens).toEqual(['Bearer one', 'Bearer two']);
  await rm(teamsPath); expect(await tool.invoke({ task_id: 'task' })).toMatchObject({ code: 'COLLABORATION_DISABLED' }); expect(tokens).toHaveLength(2);
  collaboration.close(); await expect(collaboration.worker()).rejects.toThrow('closed');
});

it('retries failed Worker initialization without retaining a half-created instance', async () => {
  const root = await directory(), teamsPath = join(root, 'teams.yaml'); await writeFile(teamsPath, 'bad');
  const collaboration = new Collaboration({ teamsPath, workspaceDir: root }); cleanup.push(() => collaboration.close());
  await expect(collaboration.worker()).rejects.toBeInstanceOf(CollaborationConfigError);
  await writeFile(teamsPath, JSON.stringify(teamsConfig()));
  const worker = await collaboration.worker(); expect(await collaboration.worker()).toBe(worker);
});

it('starts without Matrix identity and enables the same Worker after membership is configured', async () => {
  const root = await directory(), teamsPath = join(root, 'teams.yaml'), envPath = join(root, 'env');
  await writeFile(teamsPath, JSON.stringify({ apiVersion: 'agentteams.io/v1alpha1', kind: 'TeamsConfig', metadata: { runtimeName: 'runtime' },
    spec: { self: { name: 'worker', runtimeName: 'runtime' }, teams: [] } }));
  let requests = 0;
  const server = await httpServer((_req, res) => { requests++; res.end('{}'); }); cleanup.push(() => server.close());
  await writeFile(envPath, `export AGENTCORE_TASK_SERVICE_ENDPOINT=${server.url}\nexport MATRIX_TOKEN=test-token\n`);
  const collaboration = new Collaboration({ teamsPath, envPath, workspaceDir: root }); cleanup.push(() => collaboration.close());
  const worker = await collaboration.worker();
  expect(worker.composePrompt('You are a writing assistant.')).toMatch(/^You are a writing assistant\./);
  const tool = worker.tools().find(t => t.name === 'agentteams_get_task')!;
  expect(await tool.invoke({ task_id: 'task' })).toMatchObject({ code: 'COLLABORATION_TEAM_UNAVAILABLE', message: 'This Agent has no configured Team membership.' });
  expect(requests).toBe(0);
  await writeFile(teamsPath, JSON.stringify(teamsConfig()));
  expect(await collaboration.worker()).toBe(worker);
  expect(await tool.invoke({ task_id: 'task' })).toMatchObject({ ok: true });
  expect(requests).toBe(1);
});

it('borrows debug identity, refreshes a rejected Matrix token once, and never reads local env/agent.yaml', async () => {
  const root = await directory(); let tokens = 0, configs = 0, requests = 0;
  const server = await httpServer((req, res) => {
    expect(req.url).toBe('/agentteams-app/v1/tasks/task'); requests++;
    expect(req.headers.authorization).toBe(`Bearer matrix-${requests}`);
    res.statusCode = requests === 1 ? 401 : 200; res.end('{}');
  }); cleanup.push(() => server.close());
  const collaboration = new Collaboration({ workspaceDir: root, envPath: join(root, 'absent-env'), debugSource: {
    matrixUrl: server.url,
    loadTeamsConfig: async () => { configs++; return Buffer.from(JSON.stringify(teamsConfig())); },
    exchangeMatrixToken: async () => `matrix-${++tokens}`,
  } }); cleanup.push(() => collaboration.close());
  const worker = await collaboration.worker();
  expect(await worker.tools().find(t => t.name === 'agentteams_get_task')!.invoke({ task_id: 'task' })).toEqual({ ok: true, data: {} });
  expect(configs).toBe(1); expect(tokens).toBe(2);
});

it('does not publish a Worker after close races with debug Teams loading', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const collaboration = new Collaboration({ debugSource: { matrixUrl: 'http://localhost', exchangeMatrixToken: async () => 'unused', loadTeamsConfig: async () => { await pending; return undefined; } } });
  const worker = collaboration.worker(); collaboration.close(); release();
  await expect(worker).rejects.toThrow('closed');
});
