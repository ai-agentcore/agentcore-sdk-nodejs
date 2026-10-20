import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CollaborationTurnContext } from 'alibabacloud-agentcore-sdk/collaboration';
import { MatrixFileClient } from '../src/matrix-files';
import { CollaborationWorkspace } from '../src/workspace';
import { WorkerCollaboration } from '../src/worker';
import { TaskServiceClient } from '../src/task-service';
import { httpServer, snapshot } from './helpers';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const context = new CollaborationTurnContext(undefined, undefined, '!room', '$request', 'group');
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'room-files-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ path: string; body: string; authorization?: string }> = [];
  let status = 200, maximum = 100, mode = '';
  const content: Record<string, unknown> = { msgtype: 'm.file', body: '../data.txt', url: 'mxc://ws/media' };
  const server = await httpServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.statusCode = status;
    if (status !== 200) { res.end('private upstream error'); return; }
    if (req.url!.endsWith('/config')) res.end(JSON.stringify({ 'm.upload.size': maximum }));
    else if (req.url!.includes('/event/')) res.end(JSON.stringify({ type: 'm.room.message', room_id: '!room',
      sender: '@human:ws', content }));
    else if (req.url!.includes('/download/')) {
      if (mode === 'interrupted') { res.writeHead(200, { 'Content-Length': '100' }); res.write('hello'); res.destroy(); }
      else if (mode === 'hanging') { res.writeHead(200, { 'Content-Length': '100' }); res.write('hello'); }
      else res.end('hello');
    }
    else if (req.method === 'POST') res.end('{"content_uri":"mxc://ws/media"}');
    else if (mode === 'uncertain') res.destroy();
    else res.end('{"event_id":"$sent"}');
  }); cleanup.push(() => server.close());
  const client = new MatrixFileClient({ endpointProvider: () => server.url, tokenProvider: () => 'secret' });
  cleanup.push(() => client.close());
  return { root, requests, client, content, workspace: new CollaborationWorkspace(root),
    setStatus: (value: number) => { status = value; }, setLimit: (value: number) => { maximum = value; },
    setMode: (value: string) => { mode = value; } };
}
it('downloads through the current room and authenticated media, without requiring a team', async () => {
  const { client, workspace, requests } = await setup();
  const state = { ...snapshot(), teams: {} };
  const result = await client.download(state, context, '$file', workspace);
  expect(await readFile(result.local_path, 'utf8')).toBe('hello');
  expect(result).toMatchObject({ event_id: '$file', filename: 'data.txt', size: 5 });
  expect(requests.every(r => r.authorization === 'Bearer secret')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('mxc://');
});
it('uploads bytes and sends a main-timeline image reply before confirming delivery', async () => {
  const { client, root, workspace, requests } = await setup();
  await writeFile(join(root, 'image.png'), 'image');
  const result = await client.send(snapshot(), context, 'image.png', 'result', workspace);
  expect(result).toEqual({ event_id: '$sent', filename: 'image.png', status: 'sent' });
  expect(requests[1]!.body).toBe('image');
  const content = JSON.parse(requests[2]!.body);
  expect(content).toMatchObject({ msgtype: 'm.image', body: 'result', filename: 'image.png',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$request' } } });
  expect(content['m.mentions']).toBeUndefined();
});
it.each([[403, 'UNAUTHORIZED'], [404, 'NOT_FOUND'], [503, 'UNAVAILABLE']])('maps HTTP %s without exposing the body', async (status, code) => {
  const { client, workspace, setStatus } = await setup(); setStatus(status as number);
  await expect(client.download(snapshot(), context, '$file', workspace))
    .rejects.toMatchObject({ code: 'COLLABORATION_ROOM_FILE_' + code });
});
it.each(['oversize', 'interrupted'])('cleans partial files on %s', async mode => {
  const { client, root, workspace, setMode, setLimit } = await setup();
  if (mode === 'oversize') setLimit(2); else setMode(mode);
  await expect(client.download(snapshot(), context, '$file', workspace)).rejects.toMatchObject({
    code: mode === 'oversize' ? 'COLLABORATION_FILE_TOO_LARGE' : 'COLLABORATION_ROOM_FILE_UNAVAILABLE' });
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  expect(entries.filter(e => e.isFile())).toEqual([]);
  expect(entries.some(e => e.name.startsWith('.agentcore-download'))).toBe(false);
});
it.each(['encrypted', 'thread'])('rejects %s before media access', async mode => {
  const { client, content, workspace, requests } = await setup();
  if (mode === 'encrypted') content.file = {}; else content['m.relates_to'] = { rel_type: 'm.thread' };
  await expect(client.download(snapshot(), context, '$file', workspace))
    .rejects.toMatchObject({ code: 'COLLABORATION_ROOM_FILE_UNSUPPORTED' });
  expect(requests).toHaveLength(1);
});
it('retries an uncertain send with one upload, same transaction and same token', async () => {
  const { client, root, workspace, requests, setMode } = await setup();
  await writeFile(join(root, 'file.txt'), 'result'); setMode('uncertain');
  await expect(client.send(snapshot(), context, 'file.txt', undefined, workspace))
    .rejects.toMatchObject({ code: 'COLLABORATION_ROOM_FILE_SEND_UNKNOWN', retryable: false });
  expect(requests.filter(r => r.path.includes('/upload'))).toHaveLength(1);
  const sends = requests.filter(r => r.path.includes('/send/'));
  expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
});
it('rejects outside paths before upload and propagates native tool context without a Team', async () => {
  const { client, root, workspace, requests } = await setup();
  await expect(client.send(snapshot(), context, '../outside', undefined, workspace))
    .rejects.toMatchObject({ code: 'COLLABORATION_ARGUMENT_INVALID' });
  const worker = new WorkerCollaboration(() => ({ ...snapshot(), teams: {} }), {} as TaskServiceClient, root, client);
  const tool = worker.tools().find(t => t.name === 'agentteams_download_room_file')!;
  expect(await tool.invoke({ event_id: '$file' })).toMatchObject({ code: 'COLLABORATION_CONTEXT_REQUIRED' });
  const header = Buffer.from(JSON.stringify({ version: 1, roomId: '!room', eventId: '$request', roomKind: 'group' })).toString('base64url');
  const result = await worker.requestContext({ 'X-AgentCore-Collaboration-Context': header }, () => tool.invoke({ event_id: '$file' }));
  expect(result).toMatchObject({ ok: true, data: { event_id: '$file', size: 5 } });
  expect(requests).toHaveLength(3);
});
it('closing the client aborts streaming downloads and cleans partial files', async () => {
  const { client, root, workspace, requests, setMode } = await setup(); setMode('hanging');
  const rejected = expect(client.download(snapshot(), context, '$file', workspace))
    .rejects.toMatchObject({ code: 'COLLABORATION_ROOM_FILE_UNAVAILABLE' });
  await expect.poll(() => requests.length).toBe(3);
  client.close(); await rejected;
  expect((await readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile())).toEqual([]);
});
it('cancels only the current request download without closing the shared client', async () => {
  const { client, root, requests, setMode } = await setup(); setMode('hanging');
  const worker = new WorkerCollaboration(() => ({ ...snapshot(), teams: {} }), {} as TaskServiceClient, root, client);
  const tool = worker.tools().find(t => t.name === 'agentteams_download_room_file')!;
  const abort = new AbortController();
  const header = Buffer.from(JSON.stringify({ version: 1, roomId: '!room', eventId: '$request', roomKind: 'group' })).toString('base64url');
  const pending = worker.requestContext({ 'X-AgentCore-Collaboration-Context': header },
    () => tool.invoke({ event_id: '$file' }), abort.signal);
  await expect.poll(() => requests.length).toBe(3);
  abort.abort();
  expect(await pending).toMatchObject({ ok: false, code: 'COLLABORATION_ROOM_FILE_UNAVAILABLE' });
  expect((await readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile())).toEqual([]);
  setMode('');
  expect(await worker.requestContext({ 'X-AgentCore-Collaboration-Context': header },
    () => tool.invoke({ event_id: '$file' }))).toMatchObject({ ok: true });
});
it('shared tools send concurrently without mixing room or reply context', async () => {
  const { client, root, requests } = await setup();
  await writeFile(join(root, 'file.txt'), 'result');
  const worker = new WorkerCollaboration(() => ({ ...snapshot(), teams: {} }), {} as TaskServiceClient, root, client);
  const tool = worker.tools().find(t => t.name === 'agentteams_send_room_file')!;
  await Promise.all(['one', 'two'].map(id => worker.requestContext({
    'X-AgentCore-Collaboration-Context': Buffer.from(JSON.stringify({
      version: 1, roomId: '!room-' + id, eventId: '$event-' + id, roomKind: 'group',
    })).toString('base64url'),
  }, async () => {
    const result = await tool.invoke({ local_path: 'file.txt' });
    expect(result).toMatchObject({ ok: true });
  })));
  const sends = requests.filter(r => r.path.includes('/send/')); expect(sends).toHaveLength(2);
  for (const id of ['one', 'two']) {
    const send = sends.find(r => r.path.includes('!room-' + id))!;
    expect(JSON.parse(send.body)['m.relates_to']['m.in_reply_to'].event_id).toBe('$event-' + id);
  }
});
it('refreshes only a definite 401 and does not forward credentials to redirects', async () => {
  let token = 'old';
  const seen: string[] = [];
  const server = await httpServer(async (req, res) => {
    seen.push(req.headers.authorization!);
    if (req.headers.authorization === 'Bearer old') {
      token = 'new'; res.statusCode = 401; res.end();
    } else {
      res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/private'); res.end();
    }
  }); cleanup.push(() => server.close());
  const client = new MatrixFileClient({ tokenProvider: () => token, endpointProvider: () => server.url });
  cleanup.push(() => client.close());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'room-auth-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await expect(client.download(snapshot(), context, '$file', new CollaborationWorkspace(root)))
    .rejects.toMatchObject({ code: 'COLLABORATION_ROOM_FILE_UNAVAILABLE', retryable: false });
  expect(seen).toEqual(['Bearer old', 'Bearer new']);
});
