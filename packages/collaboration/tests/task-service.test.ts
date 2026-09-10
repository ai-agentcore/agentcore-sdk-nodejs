import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { TaskServiceClient } from '../src/task-service';
import { CollaborationConfigError, CollaborationTaskUnavailableError, CollaborationTaskUnauthorizedError } from 'alibabacloud-agentcore-sdk/collaboration';
import { httpServer, snapshot } from './helpers';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const makeClient = (url: string, options: Partial<ConstructorParameters<typeof TaskServiceClient>[0]> = {}) => {
  const client = new TaskServiceClient({ endpointProvider: () => url, tokenProvider: name => { expect(name).toBe('MATRIX_TOKEN'); return 'test-token'; }, ...options });
  cleanup.push(() => client.close()); return client;
};

it('requires Matrix identity before resolving credentials or endpoint', async () => {
  const unexpected = () => { throw new Error('provider must not be called'); };
  const client = new TaskServiceClient({ endpointProvider: unexpected, tokenProvider: unexpected });
  cleanup.push(() => client.close());
  await expect(client.getTask({ ...snapshot(), matrixTokenEnv: undefined }, 'task'))
    .rejects.toThrow('Worker Task Service Matrix identity is not configured.');
});

it('uses the Worker Task Service paths, camel-case wire fields, and existing idempotency contract', async () => {
  const requests: { method?: string; path: string; query: Record<string, string>; body: unknown; key?: string }[] = [];
  const server = await httpServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const url = new URL(req.url!, 'http://local'); expect(req.headers.authorization).toBe('Bearer test-token');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null, key: req.headers['idempotency-key'] as string });
    if (url.pathname.endsWith('/content')) { res.end('file body'); return; }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  }); cleanup.push(() => server.close());
  const client = makeClient(server.url + '/agentteams-app'), team = snapshot();
  await client.getTask(team, 'task/a');
  await client.listTasks(team, { status: 'assigned', teamId: 'team', assignedTo: '@w', search: 'title', cursor: 'next', limit: 2 });
  await client.getSubtask(team, 'sub/a');
  await client.listSubtasks(team, { taskId: 'task', assignedTo: '@w', status: 'assigned' });
  await client.ackSubtask(team, 'sub', '$event');
  await client.reportSubtaskProgress(team, 'sub', { text: 'progress' }, '$event');
  await client.heartbeatSubtask(team, 'sub');
  await client.blockSubtask(team, 'sub', 'blocked', '$event', { missing: 'input' });
  await client.submitSubtaskResult(team, 'sub', 'done', ['ref'], '$event');
  await client.listResults(team, 'task', 'sub');
  await client.listEvents(team, 'task', { subtaskId: 'sub', eventType: 'created', cursor: 'next', limit: 3 });
  await client.listTaskFiles(team, 'task', { prefix: 'input', cursor: 'next', limit: 4 });
  await client.listSubtaskFiles(team, 'sub');
  expect(new TextDecoder().decode(await client.readTaskFile(team, 'task', 'file/one'))).toBe('file body');
  expect(new TextDecoder().decode(await client.readSubtaskFile(team, 'sub', 'ref'))).toBe('file body');
  await client.getTaskFileDownloadRef(team, 'task', 'ref');
  await client.getSubtaskFileDownloadRef(team, 'sub', 'ref');
  await client.listTeamFiles(team, 'team', 'shared/docs', { cursor: 'next', limit: 5 });
  await client.statTeamFile(team, 'team', 'shared/docs/a');
  expect(new TextDecoder().decode(await client.readTeamFile(team, 'team', 'shared/docs/a'))).toBe('file body');
  expect(requests.map(r => r.path.replace('/agentteams-app', ''))).toEqual([
    '/v1/tasks/task%2Fa', '/v1/tasks', '/v1/sub-tasks/sub%2Fa', '/v1/sub-tasks', '/v1/sub-tasks/sub/ack', '/v1/sub-tasks/sub/progress',
    '/v1/sub-tasks/sub/heartbeat', '/v1/sub-tasks/sub/block', '/v1/sub-tasks/sub/results', '/v1/tasks/task/results', '/v1/tasks/task/events',
    '/v1/tasks/task/files', '/v1/sub-tasks/sub/files', '/v1/tasks/task/files/content', '/v1/sub-tasks/sub/files/content',
    '/v1/tasks/task/files/download', '/v1/sub-tasks/sub/files/download', '/v1/teams/team/files', '/v1/teams/team/files/stat', '/v1/teams/team/files/content',
  ]);
  expect(requests[1]!.query).toEqual({ status: 'assigned', teamId: 'team', assignedTo: '@w', search: 'title', cursor: 'next', limit: '2' });
  expect(requests[4]).toMatchObject({ method: 'POST', body: { relatedRoomMessageId: '$event' }, key: 'agentcore-' + createHash('sha256').update('ack\0sub\0$event\0{"relatedRoomMessageId":"$event"}').digest('hex') });
  expect(requests[5]).toMatchObject({ body: { content: { text: 'progress' }, relatedRoomMessageId: '$event' }, key: undefined });
  expect(requests[6]!.body).toBeNull(); expect(requests[7]).toMatchObject({ body: { reason: 'blocked', evidence: { missing: 'input' }, relatedRoomMessageId: '$event' } });
  expect(requests[8]).toMatchObject({ body: { summary: 'done', fileRefs: ['ref'], relatedRoomMessageId: '$event' } });
  expect(requests[9]!.query).toEqual({ subTaskId: 'sub' }); expect(requests[10]!.query).toEqual({ subTaskId: 'sub', type: 'created', cursor: 'next', limit: '3' });
  expect(requests[11]!.query).toEqual({ prefix: 'input', cursor: 'next', limit: '4' }); expect(requests[12]!.query).toEqual({ limit: '100' });
  expect(requests[13]!.query).toEqual({ fileRef: 'file/one' }); expect(requests[17]!.query).toEqual({ path: 'shared/docs', cursor: 'next', limit: '5' });
  await client.ackSubtask(team, 'sub', '$event'); expect(requests.at(-1)!.key).toBe(requests[4]!.key);
  await client.ackSubtask(team, 'sub', '$different'); expect(requests.at(-1)!.key).not.toBe(requests[4]!.key);
});

it.each([false, true])('refreshes a rejected token once (refresher=%s) and replays complete multipart file bytes', async refresh => {
  const directory = await mkdtemp(join(tmpdir(), 'collab-upload-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'file.bin'), content = Buffer.alloc(1024 * 1024, 42); await writeFile(source, content);
  const seen: Uint8Array[] = [], tokens: string[] = []; let reads = 0, refreshes = 0;
  const server = await httpServer(async (req, res) => {
    tokens.push(req.headers.authorization!); const chunks = []; for await (const part of req) chunks.push(part);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData();
    seen.push(new Uint8Array(await (form.get('file') as File).arrayBuffer()));
    res.statusCode = seen.length === 1 ? 401 : 200; res.end('{}');
  }); cleanup.push(() => server.close());
  const client = makeClient(server.url, { tokenProvider: () => ++reads === 1 ? 'old' : 'new',
    tokenRefresher: refresh ? (_name, rejected) => { expect(rejected).toBe('old'); refreshes++; return 'new'; } : undefined });
  await client.writeSubtaskFileFromPath(snapshot(), 'sub', 'result/file.bin', source);
  expect(tokens).toEqual(['Bearer old', 'Bearer new']); expect(refreshes).toBe(refresh ? 1 : 0); expect(seen).toHaveLength(2);
  for (const data of seen) expect(Buffer.from(data).equals(content)).toBe(true);
});

it.each([[400, 'COLLABORATION_TASK_INVALID'], [401, 'COLLABORATION_TASK_UNAUTHORIZED'], [403, 'COLLABORATION_TASK_UNAUTHORIZED'], [404, 'COLLABORATION_TASK_NOT_FOUND'], [409, 'COLLABORATION_TASK_CONFLICT'], [413, 'COLLABORATION_FILE_TOO_LARGE'], [422, 'COLLABORATION_TASK_INVALID'], [500, 'COLLABORATION_TASK_UNAVAILABLE'], [503, 'COLLABORATION_TASK_UNAVAILABLE']])('maps HTTP %s and does not blindly retry writes', async (status, code) => {
  let calls = 0; const logs: unknown[] = [];
  const server = await httpServer((_req, res) => { calls++; res.statusCode = status as number; res.setHeader('x-request-id', 'trace-1'); res.end('secret response'); }); cleanup.push(() => server.close());
  const client = makeClient(server.url, { logger: { debug() {}, info() {}, error() {}, warn: (_name, fields) => logs.push(fields) } });
  await expect(client.ackSubtask(snapshot(), 'sub', '$event')).rejects.toMatchObject({ code });
  expect(calls).toBe(status === 401 ? 2 : 1); expect(logs).toContainEqual(expect.objectContaining({ requestId: 'trace-1', status }));
  expect(JSON.stringify(logs)).not.toMatch(/secret response|test-token/);
});

it('streams signed file downloads without Task Service credentials across redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collab-download-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'download.bin'), bytes = Buffer.alloc(2 * 1024 * 1024, 67); let downloaded = 0;
  const server = await httpServer((req, res) => {
    if (req.url!.includes('/files/download')) { expect(req.headers.authorization).toBe('Bearer test-token'); res.end(JSON.stringify({ downloadUrl: server.url + '/signed?secret=hidden' })); }
    else {
      expect(req.headers.authorization).toBeUndefined();
      if (req.url!.startsWith('/signed')) { res.statusCode = 302; res.setHeader('location', '/bytes'); res.end(); }
      else { downloaded++; res.end(bytes); }
    }
  }); cleanup.push(() => server.close()); const client = makeClient(server.url);
  expect(await client.downloadTaskFileToPath(snapshot(), 'task', 'ref', destination)).toBe(bytes.length);
  expect((await readFile(destination)).equals(bytes)).toBe(true); expect(downloaded).toBe(1);
});

it('classifies a download disconnect as unavailable, not a local file configuration error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collab-broken-download-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await httpServer((req, res) => {
    if (req.url!.includes('/files/download')) res.end(JSON.stringify({ downloadUrl: server.url + '/broken' }));
    else { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); setTimeout(() => res.destroy(), 10); }
  }); cleanup.push(() => server.close());
  await expect(makeClient(server.url).downloadSubtaskFileToPath(snapshot(), 'sub', 'ref', join(directory, 'file'))).rejects.toBeInstanceOf(CollaborationTaskUnavailableError);
});

it('handles invalid responses, request timeouts, close, and missing token without leaking provider details', async () => {
  let calls = 0;
  const server = await httpServer((_req, res) => { calls++; if (calls === 1) res.end('not json'); }); cleanup.push(() => server.close());
  const client = makeClient(server.url, { timeoutMs: 30 });
  await expect(client.getTask(snapshot(), 'task')).rejects.toBeInstanceOf(CollaborationTaskUnavailableError);
  await expect(client.getTask(snapshot(), 'task')).rejects.toBeInstanceOf(CollaborationTaskUnavailableError);
  client.close(); await expect(client.getTask(snapshot(), 'task')).rejects.toThrow(); expect(calls).toBe(2);
  const invalid = makeClient(server.url, { tokenProvider: () => { throw new Error('secret in provider'); } });
  await expect(invalid.getTask(snapshot(), 'task')).rejects.toThrow('Worker Task Service token is unavailable'); expect(calls).toBe(2);
});
