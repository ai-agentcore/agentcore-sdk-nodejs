import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { Logger } from '@alibabacloud/agentcore-sdk';
import { CollaborationConfigError, CollaborationFileTooLargeError, CollaborationTaskConflictError,
  CollaborationTaskInvalidError, CollaborationTaskNotFoundError, CollaborationTaskUnauthorizedError,
  CollaborationTaskUnavailableError } from '@alibabacloud/agentcore-sdk/collaboration';
import type { TeamsSnapshot } from './teams';

type Value = string | Promise<string>;
type Query = Record<string, string | number | undefined>;
export interface TaskServiceOptions {
  tokenProvider: (environmentName: string) => Value;
  endpointProvider: () => Value;
  tokenRefresher?: (environmentName: string, rejectedToken: string) => Value;
  timeoutMs?: number;
  logger?: Logger;
}
export interface FileListOptions { prefix?: string; cursor?: string; limit?: number; }
export interface TaskListOptions { status?: string; teamId?: string; assignedTo?: string; search?: string; cursor?: string; limit?: number; }

/** Worker-only transport. No retry of uncertain writes; a 401 can refresh identity once. */
export class TaskServiceClient {
  private readonly lifetime = new AbortController();
  private readonly timeoutMs: number;
  constructor(private readonly options: TaskServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new CollaborationConfigError('Task Service timeoutMs must be positive');
  }
  close(): void { this.lifetime.abort(); }
  getTask(snapshot: TeamsSnapshot, taskId: string): Promise<unknown> { return this.request(snapshot, 'GET', `/v1/tasks/${id(taskId)}`); }
  listTasks(snapshot: TeamsSnapshot, options: TaskListOptions = {}): Promise<unknown> { return this.request(snapshot, 'GET', '/v1/tasks', { query: { ...options, limit: options.limit ?? 100 } }); }
  getSubtask(snapshot: TeamsSnapshot, subtaskId: string): Promise<unknown> { return this.request(snapshot, 'GET', `/v1/sub-tasks/${id(subtaskId)}`); }
  listSubtasks(snapshot: TeamsSnapshot, options: { taskId?: string; status?: string; assignedTo?: string } = {}): Promise<unknown> { return this.request(snapshot, 'GET', '/v1/sub-tasks', { query: options }); }
  ackSubtask(snapshot: TeamsSnapshot, subtaskId: string, eventId: string): Promise<unknown> {
    const body = { relatedRoomMessageId: eventId };
    return this.request(snapshot, 'POST', `/v1/sub-tasks/${id(subtaskId)}/ack`, { body, key: idempotencyKey('ack', subtaskId, eventId, body) });
  }
  reportSubtaskProgress(snapshot: TeamsSnapshot, subtaskId: string, content: Record<string, unknown>, eventId: string): Promise<unknown> {
    return this.request(snapshot, 'POST', `/v1/sub-tasks/${id(subtaskId)}/progress`, { body: { content, relatedRoomMessageId: eventId } });
  }
  heartbeatSubtask(snapshot: TeamsSnapshot, subtaskId: string): Promise<unknown> { return this.request(snapshot, 'POST', `/v1/sub-tasks/${id(subtaskId)}/heartbeat`); }
  blockSubtask(snapshot: TeamsSnapshot, subtaskId: string, reason: string, eventId: string, evidence?: Record<string, unknown>): Promise<unknown> {
    const body = { reason, relatedRoomMessageId: eventId, ...(evidence === undefined ? {} : { evidence }) };
    return this.request(snapshot, 'POST', `/v1/sub-tasks/${id(subtaskId)}/block`, { body, key: idempotencyKey('block', subtaskId, eventId, body) });
  }
  submitSubtaskResult(snapshot: TeamsSnapshot, subtaskId: string, summary: string, fileRefs: readonly string[], eventId: string): Promise<unknown> {
    const body = { summary, fileRefs: [...fileRefs], relatedRoomMessageId: eventId };
    return this.request(snapshot, 'POST', `/v1/sub-tasks/${id(subtaskId)}/results`, { body, key: idempotencyKey('result', subtaskId, eventId, body) });
  }
  listResults(snapshot: TeamsSnapshot, taskId: string, subtaskId?: string): Promise<unknown> { return this.request(snapshot, 'GET', `/v1/tasks/${id(taskId)}/results`, { query: { subTaskId: subtaskId } }); }
  listEvents(snapshot: TeamsSnapshot, taskId: string, options: { subtaskId?: string; eventType?: string; cursor?: string; limit?: number } = {}): Promise<unknown> {
    return this.request(snapshot, 'GET', `/v1/tasks/${id(taskId)}/events`, { query: { subTaskId: options.subtaskId, type: options.eventType, cursor: options.cursor, limit: options.limit ?? 50 } });
  }
  listTaskFiles(snapshot: TeamsSnapshot, taskId: string, options: FileListOptions = {}): Promise<unknown> { return this.listFiles(snapshot, 'tasks', taskId, options); }
  listSubtaskFiles(snapshot: TeamsSnapshot, subtaskId: string, options: FileListOptions = {}): Promise<unknown> { return this.listFiles(snapshot, 'sub-tasks', subtaskId, options); }
  readTaskFile(snapshot: TeamsSnapshot, taskId: string, fileRef: string): Promise<Uint8Array> { return this.request(snapshot, 'GET', `/v1/tasks/${id(taskId)}/files/content`, { query: { fileRef }, binary: true }); }
  readSubtaskFile(snapshot: TeamsSnapshot, subtaskId: string, fileRef: string): Promise<Uint8Array> { return this.request(snapshot, 'GET', `/v1/sub-tasks/${id(subtaskId)}/files/content`, { query: { fileRef }, binary: true }); }
  getTaskFileDownloadRef(snapshot: TeamsSnapshot, taskId: string, fileRef: string): Promise<unknown> { return this.request(snapshot, 'GET', `/v1/tasks/${id(taskId)}/files/download`, { query: { fileRef } }); }
  getSubtaskFileDownloadRef(snapshot: TeamsSnapshot, subtaskId: string, fileRef: string): Promise<unknown> { return this.request(snapshot, 'GET', `/v1/sub-tasks/${id(subtaskId)}/files/download`, { query: { fileRef } }); }
  async downloadTaskFileToPath(snapshot: TeamsSnapshot, taskId: string, fileRef: string, destination: string): Promise<number> {
    return this.downloadReference(await this.getTaskFileDownloadRef(snapshot, taskId, fileRef), destination);
  }
  async downloadSubtaskFileToPath(snapshot: TeamsSnapshot, subtaskId: string, fileRef: string, destination: string): Promise<number> {
    return this.downloadReference(await this.getSubtaskFileDownloadRef(snapshot, subtaskId, fileRef), destination);
  }
  writeSubtaskFile(snapshot: TeamsSnapshot, subtaskId: string, path: string, content: Uint8Array, contentType = 'application/octet-stream'): Promise<unknown> {
    return this.upload(snapshot, `/v1/sub-tasks/${id(subtaskId)}/files`, path, new Blob([Uint8Array.from(content)], { type: contentType }), basename(path));
  }
  async writeSubtaskFileFromPath(snapshot: TeamsSnapshot, subtaskId: string, path: string, source: string, contentType = 'application/octet-stream'): Promise<unknown> {
    return this.upload(snapshot, `/v1/sub-tasks/${id(subtaskId)}/files`, path, await fileBlob(source, contentType), basename(source));
  }
  listTeamFiles(snapshot: TeamsSnapshot, teamId: string, path: string, options: { cursor?: string; limit?: number } = {}): Promise<unknown> {
    return this.request(snapshot, 'GET', `/v1/teams/${id(teamId)}/files`, { query: { path, cursor: options.cursor, limit: options.limit ?? 100 } });
  }
  statTeamFile(snapshot: TeamsSnapshot, teamId: string, path: string): Promise<unknown> { return this.request(snapshot, 'GET', `/v1/teams/${id(teamId)}/files/stat`, { query: { path } }); }
  readTeamFile(snapshot: TeamsSnapshot, teamId: string, path: string): Promise<Uint8Array> { return this.request(snapshot, 'GET', `/v1/teams/${id(teamId)}/files/content`, { query: { path }, binary: true }); }
  async writeTeamFileFromPath(snapshot: TeamsSnapshot, teamId: string, path: string, source: string, contentType = 'application/octet-stream'): Promise<unknown> {
    return this.upload(snapshot, `/v1/teams/${id(teamId)}/files`, path, await fileBlob(source, contentType), basename(source));
  }
  private listFiles(snapshot: TeamsSnapshot, resource: string, resourceId: string, options: FileListOptions): Promise<unknown> {
    return this.request(snapshot, 'GET', `/v1/${resource}/${id(resourceId)}/files`, { query: { ...options, limit: options.limit ?? 100 } });
  }
  private upload(snapshot: TeamsSnapshot, endpoint: string, path: string, file: Blob, name: string): Promise<unknown> {
    const form = new FormData(); form.set('file', file, name || 'file');
    return this.request(snapshot, 'PUT', endpoint, { query: { path }, form });
  }
  private async request<T = unknown>(snapshot: TeamsSnapshot, method: string, path: string,
    options: { query?: Query; body?: Record<string, unknown>; key?: string; form?: FormData; binary?: boolean } = {}): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    const tokenEnv = snapshot.matrixTokenEnv;
    if (tokenEnv === undefined) throw new CollaborationConfigError('Worker Task Service Matrix identity is not configured.');
    const endpoint = await supplied(() => this.options.endpointProvider(), 'endpoint');
    const url = new URL(endpoint.replace(/\/+$/, '') + path);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CollaborationConfigError('Worker Task Service endpoint is unavailable.');
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const logger = this.options.logger, fields = { method, path };
    logger?.info('agentcore.collaboration.task.request.started', fields);
    let refreshed: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = refreshed ?? await supplied(() => this.options.tokenProvider(tokenEnv), 'token');
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: options.binary ? '*/*' : 'application/json' };
      if (options.key) headers['Idempotency-Key'] = options.key;
      if (options.body) headers['Content-Type'] = 'application/json';
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body: options.form ?? (options.body ? JSON.stringify(options.body) : undefined), redirect: 'manual',
          signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]) });
      } catch { throw new CollaborationTaskUnavailableError('Task Service is temporarily unavailable.'); }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        if (this.options.tokenRefresher) refreshed = await supplied(() => this.options.tokenRefresher!(tokenEnv, token), 'token');
        continue;
      }
      if (!response.ok) {
        logger?.warn('agentcore.collaboration.task.request.failed', { ...fields, status: response.status, requestId: response.headers.get('x-request-id') ?? response.headers.get('x-acs-request-id') ?? undefined });
        await response.body?.cancel(); raiseStatus(response.status);
      }
      try {
        const data = options.binary ? new Uint8Array(await response.arrayBuffer()) : await response.text();
        const result = typeof data === 'string' ? data ? JSON.parse(data) : null : data;
        logger?.info('agentcore.collaboration.task.request.succeeded', fields);
        return result as T;
      } catch { throw new CollaborationTaskUnavailableError('Task Service returned an invalid response.'); }
    }
    throw new CollaborationTaskUnauthorizedError('Task Service rejected this Worker operation.');
  }
  private async downloadReference(reference: unknown, destination: string): Promise<number> {
    const value = reference && typeof reference === 'object' ? (reference as Record<string, unknown>).downloadUrl : undefined;
    let url: URL;
    try { url = new URL(typeof value === 'string' ? value : ''); } catch { throw new CollaborationTaskUnavailableError('Task Service returned an invalid download reference.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CollaborationTaskUnavailableError('Task Service returned an invalid download reference.');
    let response: Response;
    try { response = await fetch(url, { headers: { Accept: '*/*' }, signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]) }); }
    catch { throw new CollaborationTaskUnavailableError('The file download reference is temporarily unavailable.'); }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new CollaborationTaskUnavailableError('The file download reference is temporarily unavailable.'); }
    // No Task Service Authorization on signed downloads; stream large files without buffering.
    let target;
    try { target = await open(destination, 'w'); }
    catch (cause) { await response.body.cancel(); throw new CollaborationConfigError('The local download path is unavailable.', { cause }); }
    let total = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
        try { await target.writeFile(chunk); }
        catch (cause) { throw new CollaborationConfigError('The local download path is unavailable.', { cause }); }
        total += chunk.length;
      }
    } catch (cause) {
      if (cause instanceof CollaborationConfigError) throw cause;
      throw new CollaborationTaskUnavailableError('The file download reference is temporarily unavailable.');
    } finally { await target.close(); }
    return total;
  }
}
function id(value: string): string { return encodeURIComponent(value); }
async function fileBlob(source: string, type: string): Promise<Blob> {
  try { return await openAsBlob(source, { type }); } catch (cause) { throw new CollaborationConfigError('The local upload path is unavailable.', { cause }); }
}
async function supplied(provider: () => Value, label: string): Promise<string> {
  try { const value = await provider(); if (typeof value === 'string' && value.trim()) return value.trim(); } catch { /* Provider internals may contain secrets. */ }
  throw new CollaborationConfigError(`Worker Task Service ${label} is unavailable.`);
}
function idempotencyKey(operation: string, target: string, eventId: string, body: Record<string, unknown>): string {
  const payload = JSON.stringify(body, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return 'agentcore-' + createHash('sha256').update(`${operation}\0${target}\0${eventId}\0${payload}`).digest('hex');
}
function raiseStatus(status: number): never {
  if (status === 401 || status === 403) throw new CollaborationTaskUnauthorizedError('Task Service rejected this Worker operation.');
  if (status === 400 || status === 422) throw new CollaborationTaskInvalidError('Task Service rejected the operation input.');
  if (status === 404) throw new CollaborationTaskNotFoundError('The requested Task Service resource was not found.');
  if (status === 409) throw new CollaborationTaskConflictError('Task Service rejected the current Task or Subtask state.');
  if (status === 413) throw new CollaborationFileTooLargeError('The requested file exceeds the supported size limit.');
  throw new CollaborationTaskUnavailableError('Task Service is temporarily unavailable.');
}
