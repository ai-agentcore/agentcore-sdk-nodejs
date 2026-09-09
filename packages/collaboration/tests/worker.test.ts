import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AgentCore } from '@alibabacloud/agentcore-sdk';
import { skillTools } from '@alibabacloud/agentcore-sdk/skill';
import { languageModel, tools as aiTools } from '@alibabacloud/agentcore-sdk/integrations/ai-sdk';
import { generateText, stepCountIs } from 'ai';
import { TaskServiceClient, WorkerCollaboration } from '../src';
import { httpServer, snapshot, teamsConfig } from './helpers';
import { parseTeamsConfig, type TeamsSnapshot } from '../src/teams';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const header = (roomId = '!task', eventId = '$event', roomKind = 'task', teamId: string | undefined = 'team') => ({
  'x-agentcore-collaboration-context': Buffer.from(JSON.stringify({ version: 1, roomId, eventId, roomKind, teamId })).toString('base64url'),
});
async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'collab-worker-'))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let room = '!task', status = 200, brokenDownload = false, unsafeList = false;
  const server = await httpServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local'); let raw = ''; for await (const data of req) raw += data;
    requests.push({ path: req.url!, method: req.method!, body: raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw });
    if (url.pathname === '/signed') {
      expect(req.headers.authorization).toBeUndefined();
      if (brokenDownload) { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); setTimeout(() => res.destroy(), 5); }
      else res.end('download'); return;
    }
    expect(req.headers.authorization).toBe('Bearer hidden-token');
    res.statusCode = status;
    if (status !== 200) { res.end('private error'); return; }
    if (url.pathname === '/v1/sub-tasks/sub') { res.end('{"taskId":"task"}'); return; }
    if (url.pathname === '/v1/tasks/task') { res.end(JSON.stringify({ roomId: room })); return; }
    if (url.pathname.endsWith('/files/download')) { res.end(JSON.stringify({ downloadUrl: server.url + '/signed?secret=hidden' })); return; }
    if (url.pathname.endsWith('/files/content')) { res.end(url.searchParams.get('fileRef') === 'binary' ? Buffer.from([255, 0]) : 'text'); return; }
    if (url.pathname.endsWith('/files/stat')) { res.statusCode = 404; res.end('{}'); return; }
    if (url.pathname === '/v1/teams/team/files' && req.method === 'GET') {
      res.end(JSON.stringify({ items: [{ path: unsafeList ? 'shared/tasks/secret' : url.searchParams.get('cursor') ? 'shared/docs/b.txt' : 'shared/docs/a.txt' }], nextCursor: url.searchParams.get('cursor') ? null : 'next' })); return;
    }
    res.end('{"accepted":true}');
  }); cleanup.push(() => server.close());
  const client = new TaskServiceClient({ endpointProvider: () => server.url, tokenProvider: () => 'hidden-token' }); cleanup.push(() => client.close());
  let current: TeamsSnapshot | undefined = snapshot();
  const worker = new WorkerCollaboration(() => current, client, directory);
  const call = (name: string, input: Record<string, unknown> = {}) => worker.tools().find(tool => tool.name === 'agentteams_' + name)!.invoke(input);
  return { directory, worker, call, requests, setRoom: (value: string) => { room = value; }, setSnapshot: (value: TeamsSnapshot | undefined) => { current = value; }, setStatus: (value: number) => { status = value; }, breakDownload: () => { brokenDownload = true; }, unsafeList: () => { unsafeList = true; } };
}

it('exposes exactly the Worker tool surface and bundled skills, without Manager operations or credentials', async () => {
  const { worker, call, directory } = await setup();
  expect(worker.tools()).toHaveLength(24); expect(new Set(worker.tools().map(t => t.name)).size).toBe(24);
  expect(worker.tools().some(t => /create_task|assign_subtask|approve/.test(t.name))).toBe(false);
  const skills = await worker.skills(); expect(skills.map(s => s.name)).toEqual(['file-sharing', 'task-execution']);
  expect(skills.every(s => s.instruction.length > 300 && s.files.includes('SKILL.md'))).toBe(true);
  const prompt = worker.composePrompt('Application instructions.');
  expect(prompt).not.toContain('You are an AgentCore Worker');
  expect(prompt).toContain("do not change the application's identity");
  expect(prompt).toContain('Application instructions.'); expect(prompt).toContain(directory); expect(prompt).toContain('MUST load and follow');
  const team = await call('get_team_context');
  expect(team).toMatchObject({ ok: true, data: { member: { name: 'worker', runtimeName: 'runtime', matrixUserId: '@worker:server' } } });
  const roster = JSON.stringify(team);
  expect(roster).toContain('@worker:server'); expect(roster).not.toMatch(/MATRIX_TOKEN|hidden-token|tokenEnv/);
});

it('requires trusted Task Room context on all state and file writes, but allows read-only use outside a turn', async () => {
  const { call, worker, requests, setRoom } = await setup();
  expect(await call('get_task', { task_id: 'task' })).toMatchObject({ ok: true }); requests.length = 0;
  const writes: Array<[string, Record<string, unknown>]> = [
    ['ack_subtask', {}], ['report_subtask_progress', { content: {} }], ['heartbeat_subtask', {}], ['block_subtask', { reason: 'input missing' }],
    ['submit_subtask_result', { summary: 'done' }], ['write_subtask_file', { path: 'result/a', content: 'hello' }], ['write_subtask_file_from_path', { path: 'result/a', local_path: 'a' }],
  ];
  for (const [name, args] of writes) {
    expect(await call(name, { subtask_id: 'sub', ...args })).toMatchObject({ ok: false, code: 'COLLABORATION_CONTEXT_REQUIRED' });
    expect(await worker.requestContext(header('!task', '$event', 'group'), () => call(name, { subtask_id: 'sub', ...args }))).toMatchObject({ ok: false, code: 'COLLABORATION_TASK_UNAUTHORIZED' });
  }
  expect(requests).toHaveLength(0);
  await worker.requestContext(header(), async () => {
    expect(await call('ack_subtask', { subtask_id: 'sub', event_id: 'model-forged' })).toMatchObject({ ok: true });
    setRoom('!different');
    expect(await call('submit_subtask_result', { subtask_id: 'sub', summary: 'done' })).toMatchObject({ ok: false, code: 'COLLABORATION_TASK_UNAUTHORIZED' });
  });
  expect(requests.filter(r => r.method === 'POST')).toEqual([{ method: 'POST', path: '/v1/sub-tasks/sub/ack', body: { relatedRoomMessageId: '$event' } }]);
  expect(requests.filter(r => r.path === '/v1/tasks/task')).toHaveLength(2);
});

it('re-evaluates membership and handles expected errors as tool results without hiding programming errors', async () => {
  const { worker, call, requests, setSnapshot, setStatus } = await setup();
  setSnapshot(undefined); expect(await call('get_task', { task_id: 'task' })).toMatchObject({ code: 'COLLABORATION_DISABLED' });
  const config = teamsConfig(); config.spec.teams[0]!.membership.role = 'leader'; setSnapshot(parseTeamsConfig(JSON.stringify(config)));
  expect(await call('get_task', { task_id: 'task' })).toMatchObject({ code: 'COLLABORATION_ROLE_UNSUPPORTED' });
  setSnapshot(snapshot());
  expect(await worker.requestContext(header('!task', '$event', 'task', 'missing'), () => call('get_task', { task_id: 'task' }))).toMatchObject({ code: 'COLLABORATION_TEAM_UNAVAILABLE' });
  expect(requests).toHaveLength(0); setStatus(503);
  expect(await call('get_task', { task_id: 'task' })).toEqual({ ok: false, code: 'COLLABORATION_TASK_UNAVAILABLE', retryable: true, message: 'Task Service is temporarily unavailable.' });
  const broken = new WorkerCollaboration(() => { throw new Error('programming mistake'); }, {} as TaskServiceClient, '.');
  await expect(broken.tools()[0]!.invoke({})).rejects.toThrow('programming mistake');
});

it.each([
  ['get_task', {}], ['get_task', { task_id: ' ' }], ['list_tasks', { limit: 0 }], ['list_tasks', { limit: 1.2 }],
  ['report_subtask_progress', { subtask_id: 'sub', content: [] }], ['submit_subtask_result', { subtask_id: 'sub', summary: 'done', file_refs: [1] }],
] as const)('rejects invalid %s arguments before HTTP', async (name, args) => {
  const { call, requests } = await setup();
  expect(await call(name, args)).toMatchObject({ ok: false, code: 'COLLABORATION_ARGUMENT_INVALID' }); expect(requests).toHaveLength(0);
});

it('encodes inline binary content and atomically downloads without replacing existing files or leaking partial files', async () => {
  const { call, directory, breakDownload } = await setup();
  expect(await call('read_task_file', { task_id: 'task', file_ref: 'binary' })).toEqual({ ok: true, data: { encoding: 'base64', content: '/wA=' } });
  const args = { task_id: 'task', file_ref: 'ref', output_path: 'input/file' };
  expect(await call('download_task_file', args)).toEqual({ ok: true, data: { path: join(directory, 'input/file'), size: 8 } });
  expect(await call('download_task_file', args)).toMatchObject({ ok: false, code: 'COLLABORATION_ARGUMENT_INVALID' });
  await writeFile(join(directory, 'input/file'), 'keep'); breakDownload();
  expect(await call('download_task_file', { ...args, overwrite: true })).toMatchObject({ code: 'COLLABORATION_TASK_UNAVAILABLE' });
  expect(await readFile(join(directory, 'input/file'), 'utf8')).toBe('keep'); expect(await readdir(join(directory, 'input'))).toEqual(['file']);
});

it('confines local file access to the workspace and excludes Task storage from Team synchronization', async () => {
  const { worker, call, directory, requests } = await setup();
  await mkdir(join(directory, 'source')); await writeFile(join(directory, 'source/a'), 'a'); await symlink(join(directory, 'source'), join(directory, 'link'));
  await worker.requestContext(header(), async () => {
    for (const path of ['../escape', 'link/a']) expect(await call('write_subtask_file_from_path', { subtask_id: 'sub', path: 'result/a', local_path: path })).toMatchObject({ code: 'COLLABORATION_ARGUMENT_INVALID' });
    for (const path of ['shared/tasks/a', 'shared/subtasks/a', 'shared/../secret', '/shared/a']) expect(await call('filesync_list', { path })).toMatchObject({ code: 'COLLABORATION_ARGUMENT_INVALID' });
  });
  expect(requests.every(r => r.method === 'GET' && !r.path.includes('/files'))).toBe(true);
});

it('synchronizes paginated Team directories without deleting files and refuses out-of-prefix entries', async () => {
  const { worker, call, directory, requests, unsafeList } = await setup();
  await mkdir(join(directory, 'source')); await writeFile(join(directory, 'source/a.txt'), 'one'); await writeFile(join(directory, 'source/b.txt'), 'two');
  await worker.requestContext(header(), async () => {
    expect(await call('filesync_push', { path: 'shared/docs', local_path: 'source' })).toMatchObject({ ok: true, data: { transferred: 2 } });
    expect(await call('filesync_pull', { path: 'shared/docs', local_path: 'download' })).toMatchObject({ ok: true, data: { transferred: 2 } });
    expect(await call('filesync_stat', { path: 'shared/docs' })).toEqual({ ok: true, data: { kind: 'directory', path: 'shared/docs', entries: 2 } });
    unsafeList(); expect(await call('filesync_pull', { path: 'shared/docs', local_path: 'unsafe' })).toMatchObject({ code: 'COLLABORATION_TASK_UNAVAILABLE' });
  });
  expect(await readFile(join(directory, 'download/a.txt'), 'utf8')).toBe('text'); expect(await readFile(join(directory, 'download/b.txt'), 'utf8')).toBe('text');
  expect(requests.filter(r => r.method === 'PUT')).toHaveLength(2); expect(requests.some(r => r.method === 'DELETE')).toBe(false);
  expect(requests.filter(r => r.method === 'PUT').every(r => String(r.body).includes('Content-Type: text/plain'))).toBe(true);
  expect(await readdir(directory)).not.toContain('unsafe');
});

it('runs a native AI SDK agent tool loop through HTTP and binds each write to the trusted request event', async () => {
  const { worker, requests } = await setup(); let calls = 0;
  const sequence = [
    { name: 'load_skills', arguments: '{"name":"task-execution"}' },
    { name: 'agentteams_get_team_context', arguments: '{}' },
    { name: 'agentteams_ack_subtask', arguments: '{"subtask_id":"sub"}' },
    { name: 'agentteams_submit_subtask_result', arguments: '{"subtask_id":"sub","summary":"Requested check passed."}' },
  ];
  const model = await httpServer(async (req, res) => {
    let raw = ''; for await (const data of req) raw += data;
    const body = JSON.parse(raw); const step = calls++;
    if (step > 0) expect(body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('Task execution'))).toBe(true);
    if (step > 1) expect(body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('member'))).toBe(true);
    const tool = sequence[step];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + step, type: 'function', function: tool }] } : { role: 'assistant', content: 'Submitted; awaiting review.' } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
  }); cleanup.push(() => model.close());
  const core = AgentCore.auto(); cleanup.push(() => core.close());
  const skills = await worker.skills();
  const result = await worker.requestContext(header('!task', '$trusted-event'), () => generateText({ model: languageModel(core.directModel({ model: 'test', baseURL: model.url + '/v1', apiKey: 'model-test' })),
    system: worker.composePrompt('Run the assigned check.'), prompt: 'Handle assigned subtask sub.', tools: aiTools([...worker.tools(), ...skillTools(skills)]), stopWhen: stepCountIs(6) }));
  expect(result.text).toBe('Submitted; awaiting review.'); expect(calls).toBe(5);
  expect(requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([{ relatedRoomMessageId: '$trusted-event' }, { summary: 'Requested check passed.', fileRefs: [], relatedRoomMessageId: '$trusted-event' }]);
});
