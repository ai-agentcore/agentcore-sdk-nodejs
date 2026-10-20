import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lookup } from 'mime-types';
import { CollaborationConfigError, CollaborationError, CollaborationFileTooLargeError,
  type CollaborationTurnContext } from 'alibabacloud-agentcore-sdk/collaboration';
import { currentContext } from 'alibabacloud-agentcore-sdk/runtime';
import type { TaskServiceOptions } from './task-service';
import type { TeamsSnapshot } from './teams';
import { CollaborationWorkspace } from './workspace';

type Data = Record<string, unknown>;
export class RoomFileError extends CollaborationError {
  override readonly code: string;
  override readonly retryable: boolean;
  constructor(kind: string, message: string, retryable = false) {
    super(message); this.code = 'COLLABORATION_ROOM_FILE_' + kind; this.retryable = retryable;
  }
}

/** Room media only. URLs and credentials never enter model arguments or results. */
export class MatrixFileClient {
  private readonly lifetime = new AbortController();
  constructor(private readonly options: TaskServiceOptions) {}
  close(): void { this.lifetime.abort(); }

  async download(snapshot: TeamsSnapshot, context: CollaborationTurnContext, eventId: string, workspace: CollaborationWorkspace) {
    return this.operation('download', context, eventId, async () => {
      const event = await this.json(snapshot, 'GET', eventPath(context.roomId, eventId));
      let content = eventContent(event, context.roomId);
      const relation = object(content['m.relates_to']);
      if (relation.rel_type === 'm.replace') {
        if (typeof relation.event_id !== 'string' || !relation.event_id) throw unsupported();
        const original = await this.json(snapshot, 'GET', eventPath(context.roomId, relation.event_id));
        const originalContent = eventContent(original, context.roomId);
        if (!event.sender || event.sender !== original.sender ||
          ['m.replace', 'm.thread'].includes(String(object(originalContent['m.relates_to']).rel_type))) throw unsupported();
        content = object(content['m.new_content']);
      }
      if (!['m.file', 'm.image'].includes(String(content.msgtype)) || 'file' in content ||
        object(content['m.relates_to']).rel_type === 'm.thread') throw unsupported();
      const media = mediaPath(content.url), filename = safeFilename(content.filename || content.body);
      const limit = await this.limit(snapshot);
      const info = object(content.info), contentType = typeof info.mimetype === 'string' && info.mimetype ? info.mimetype : 'application/octet-stream';
      const result = await workspace.write(join('attachments', randomUUID(), filename), false, async staging => {
        const response = await this.request(snapshot, 'GET', media);
        if (!response.body) throw new RoomFileError('UNAVAILABLE', 'Media response has no body.', true);
        const reader = response.body.getReader();
        let size = 0;
        try {
          const output = await open(staging, 'wx');
          try {
            while (true) {
              const { value, done } = await reader.read(); if (done) break;
              size += value.byteLength;
              if (size > limit) throw new CollaborationFileTooLargeError('File exceeds the Matrix media limit.');
              await output.writeFile(value);
            }
          } finally { await output.close(); }
        } catch (error) {
          if (error instanceof CollaborationError) throw error;
          throw new RoomFileError('UNAVAILABLE', 'Media download was interrupted.', true);
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return size;
      });
      return { event_id: eventId, local_path: result.path, filename, content_type: contentType, size: result.size };
    });
  }

  async send(snapshot: TeamsSnapshot, context: CollaborationTurnContext, localPath: string, caption: string | undefined, workspace: CollaborationWorkspace) {
    return this.operation('send', context, undefined, async () => {
      const source = await workspace.source(localPath), filename = basename(source);
      const mime = lookup(source) || 'application/octet-stream';
      const blob = await openAsBlob(source, { type: mime }), limit = await this.limit(snapshot);
      if (blob.size > limit) throw new CollaborationFileTooLargeError('File exceeds the Matrix media limit.');
      const uploaded = await this.json(snapshot, 'POST', '/_matrix/media/v3/upload?filename=' + encodeURIComponent(filename), blob);
      try { mediaPath(uploaded.content_uri); } catch { throw unconfirmed('POST'); }
      const content = { msgtype: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) ? 'm.image' : 'm.file',
        filename, body: caption || filename, url: uploaded.content_uri, info: { mimetype: mime, size: blob.size },
        'm.relates_to': { 'm.in_reply_to': { event_id: context.eventId } } };
      const transactionId = randomUUID();
      const sent = await this.json(snapshot, 'PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(context.roomId)}/send/m.room.message/${transactionId}`, content);
      if (typeof sent.event_id !== 'string' || !sent.event_id) throw unconfirmed('PUT');
      this.options.logger?.info('agentcore.room_file.sent', { roomId: context.roomId,
        requestEventId: context.eventId, eventId: sent.event_id, bytes: blob.size });
      return { event_id: sent.event_id, filename, status: 'sent' };
    });
  }

  private async operation<T extends { event_id: string; size?: number }>(action: string, context: CollaborationTurnContext,
    attachmentId: string | undefined, call: () => Promise<T>): Promise<T> {
    const start = Date.now(), fields = { operation: action, roomId: context.roomId, requestEventId: context.eventId,
      attachmentEventId: attachmentId, invocationId: currentContext(false)?.headers['x-agentcore-invocation-id'] };
    this.options.logger?.info('agentcore.room_file.started', fields);
    try {
      const result = await call();
      this.options.logger?.info('agentcore.room_file.completed', { ...fields, eventId: result.event_id, bytes: result.size, durationMs: Date.now() - start });
      return result;
    } catch (error) {
      this.options.logger?.warn('agentcore.room_file.failed', { ...fields,
        code: error instanceof CollaborationError ? error.code : 'LOCAL_IO_ERROR', durationMs: Date.now() - start });
      throw error;
    }
  }

  private async limit(snapshot: TeamsSnapshot): Promise<number> {
    const data = await this.json(snapshot, 'GET', '/_matrix/client/v1/media/config'), size = data['m.upload.size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new RoomFileError('UNAVAILABLE', 'Matrix media limit is unavailable.', true);
    return size;
  }
  private async json(snapshot: TeamsSnapshot, method: string, path: string, body?: Blob | Data): Promise<Data> {
    const response = await this.request(snapshot, method, path, body);
    try {
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object required');
      return result as Data;
    } catch { throw unconfirmed(method); }
    finally { await response.body?.cancel().catch(() => {}); }
  }
  private async request(snapshot: TeamsSnapshot, method: string, path: string, body?: Blob | Data): Promise<Response> {
    const name = snapshot.matrixTokenEnv;
    if (!name) throw new CollaborationConfigError('Worker Matrix identity is not configured.');
    const base = new URL(await this.options.endpointProvider());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new CollaborationConfigError('Matrix endpoint is unavailable.');
    const url = base.toString().replace(/\/+$/, '') + path;
    let token = await this.options.tokenProvider(name), uncertain = false;
    const requestSignal = currentContext(false)?.signal;
    const signal = AbortSignal.any([this.lifetime.signal,
      ...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token) throw new CollaborationConfigError('Worker Matrix token is unavailable.');
      const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
      if (body) headers['Content-Type'] = body instanceof Blob ? body.type : 'application/json';
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
          redirect: 'manual', signal });
      } catch {
        if (method === 'PUT' && attempt === 0 && !signal.aborted) {
          uncertain = true;
          this.options.logger?.info('agentcore.room_file.send_retry', { retries: 1, sameTransaction: true });
          continue;
        }
        throw unconfirmed(method);
      }
      if (response.status === 401 && attempt === 0 && !uncertain) {
        await response.body?.cancel();
        token = this.options.tokenRefresher ? await this.options.tokenRefresher(name, token) : await this.options.tokenProvider(name);
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        this.options.logger?.warn('agentcore.room_file.http_failed', { method, status, retries: attempt,
          requestId: response.headers.get('x-request-id')?.replace(/[\r\n]/g, '').slice(0, 128) });
        await response.body?.cancel();
        if (uncertain) throw unconfirmed(method);
        if (status === 401 || status === 403) throw new RoomFileError('UNAUTHORIZED', `Matrix denied access (HTTP ${status}).`);
        if (status === 404) throw new RoomFileError('NOT_FOUND', 'Room event or media does not exist.');
        if (status === 413) throw new CollaborationFileTooLargeError('File exceeds the Matrix media limit.');
        throw new RoomFileError('UNAVAILABLE', `Matrix request failed (HTTP ${status}).`, method === 'GET' && status >= 500);
      }
      return response;
    }
    throw unconfirmed(method);
  }
}

function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
function eventContent(event: Data, room: string): Data {
  if (event.type !== 'm.room.message' || event.room_id !== room) throw unsupported();
  return object(event.content);
}
function eventPath(room: string, event: string): string { return `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(event)}`; }
function mediaPath(value: unknown): string {
  if (typeof value !== 'string' || !/^mxc:\/\/[^/\s]+\/[^/?#\s]+$/.test(value)) throw unsupported();
  const [server, media] = value.slice(6).split('/');
  return `/_matrix/client/v1/media/download/${encodeURIComponent(server!)}/${encodeURIComponent(media!)}`;
}
function safeFilename(value: unknown): string {
  let name = String(value || 'attachment').replace(/\\/g, '/').split('/').at(-1)!
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 120) || 'attachment';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function unsupported(): RoomFileError { return new RoomFileError('UNSUPPORTED', 'This event is not a supported unencrypted room attachment.'); }
function unconfirmed(method: string): RoomFileError {
  return method === 'GET' ? new RoomFileError('UNAVAILABLE', 'Matrix media service is unavailable.', true)
    : new RoomFileError('SEND_UNKNOWN', 'File delivery could not be confirmed; do not resend blindly.');
}
