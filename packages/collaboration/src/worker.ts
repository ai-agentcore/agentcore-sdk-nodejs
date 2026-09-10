import { fileURLToPath } from 'node:url';
import { lookup } from 'mime-types';
import { Tool, type ToolArguments } from 'alibabacloud-agentcore-sdk';
import { Skills, type Skill } from 'alibabacloud-agentcore-sdk/skill';
import { bindCollaborationContext, currentCollaborationContext, CollaborationError, CollaborationConfigError,
  CollaborationContextError, CollaborationContextRequiredError, CollaborationDisabledError,
  CollaborationRoleUnsupportedError, CollaborationTaskConflictError, CollaborationTaskNotFoundError,
  CollaborationTaskUnauthorizedError, CollaborationTaskUnavailableError, CollaborationTeamUnavailableError,
  CollaborationToolArgumentError, type CollaborationTurnContext } from 'alibabacloud-agentcore-sdk/collaboration';
import { TeamsProvider, type TeamsSnapshot } from './teams';
import { TaskServiceClient } from './task-service';
import { CollaborationWorkspace, teamPath } from './workspace';
import { WORKER_PROMPT } from './worker-prompt';

export type TeamsSnapshotProvider = () => TeamsSnapshot | undefined | Promise<TeamsSnapshot | undefined>;
type Input = ToolArguments;
type Field = Record<string, unknown>;
type Operation = (snapshot: TeamsSnapshot, input: Input, context: CollaborationTurnContext | undefined, teamId?: string) => Promise<unknown> | unknown;
const text = { type: 'string', minLength: 1 }, object = { type: 'object', additionalProperties: true };
const limit = { type: 'integer', minimum: 1, maximum: 100 }, boolean = { type: 'boolean' };

/** Explicit composition: this object never runs an agent, acknowledges work, or writes Memory on its own. */
export class WorkerCollaboration {
  private readonly workspace: CollaborationWorkspace;
  private readonly workerTools: Tool[];
  constructor(private readonly teams: TeamsProvider | TeamsSnapshotProvider, private readonly client: TaskServiceClient, workspace: string) {
    this.workspace = new CollaborationWorkspace(workspace); this.workerTools = this.createTools();
  }
  composePrompt(userPrompt: string): string {
    return [userPrompt.trimEnd(), WORKER_PROMPT, '## Collaboration Workspace\n\n' +
      `The local collaboration workspace is ${JSON.stringify(this.workspace.root)}. Pass local_path and output_path relative to this directory unless an absolute path is already known. ` +
      'Before uploading an artifact created elsewhere, stage it in this workspace using only filesystem capabilities already provided by the application.'].filter(Boolean).join('\n\n');
  }
  tools(): Tool[] { return [...this.workerTools]; }
  skills(): Promise<Skill[]> { return new Skills().local(fileURLToPath(new URL('../worker-skills/', import.meta.url))); }
  requestContext<T>(headers: Readonly<Record<string, string>>, callback: () => T): T { return bindCollaborationContext(headers, callback); }

  private createTools(): Tool[] {
    const tools: Tool[] = [];
    const add = (name: string, description: string, properties: Record<string, Field>, required: string[], mode: 'read' | 'write' | 'team', operation: Operation) => {
      tools.push(new Tool({ name: 'agentteams_' + name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, invoke: async input => {
        try {
          validate(input, properties, required);
          const snapshot = await (this.teams instanceof TeamsProvider ? this.teams.snapshot() : this.teams());
          if (!snapshot) throw new CollaborationDisabledError('Collaboration is not enabled for this Agent.');
          const context = currentCollaborationContext(false);
          let teamId: string | undefined;
          if (mode === 'write') {
            if (!context) throw new CollaborationContextRequiredError('This action is only available from a collaboration request in its Task Room.');
            if (context.roomKind !== 'task' || !context.teamId) throw new CollaborationTaskUnauthorizedError('This operation must run in the owning Task Room.');
            workerTeam(snapshot, context.teamId);
            const subtask = record(await this.client.getSubtask(snapshot, str(input, 'subtask_id')));
            if (typeof subtask.taskId !== 'string' || !subtask.taskId.trim()) throw new CollaborationTaskUnavailableError('Task Service returned an invalid Subtask response.');
            const task = record(await this.client.getTask(snapshot, subtask.taskId));
            if (task.roomId !== context.roomId) throw new CollaborationTaskUnauthorizedError('This operation must run in the owning Task Room.');
          } else if (mode === 'team') {
            if (!context) throw new CollaborationContextRequiredError('The SDK could not select a current Team for this operation.');
            teamId = context.teamId;
            if (!teamId) {
              const choices = Object.values(snapshot.teams).filter(team => team.role === 'worker');
              if (choices.length !== 1) throw new CollaborationContextRequiredError('The SDK could not select a current Team for this operation.');
              teamId = choices[0]!.name;
            }
            workerTeam(snapshot, teamId);
          } else if (context?.teamId) workerTeam(snapshot, context.teamId);
          else if (!Object.keys(snapshot.teams).length) throw new CollaborationTeamUnavailableError('This Agent has no configured Team membership.');
          else if (!Object.values(snapshot.teams).some(team => team.role === 'worker')) throw new CollaborationRoleUnsupportedError('The current Agent is not a Worker in any configured Team.');
          return { ok: true, data: await operation(snapshot, input, context, teamId) };
        } catch (error) {
          if (error instanceof CollaborationError || error instanceof CollaborationConfigError || error instanceof CollaborationContextError) return { ok: false, code: error.code, retryable: error.retryable, message: error.message };
          throw error;
        }
      } }));
    };
    add('get_team_context', 'Read the configured Worker identity, Team memberships, roles and members. Not live Matrix membership.', {}, [], 'read', snapshot => ({
      member: { name: snapshot.selfName, runtimeName: snapshot.runtimeName, matrixUserId: snapshot.selfMatrixUserId, personalRoomId: snapshot.selfPersonalRoomId },
      defaultTeamName: snapshot.defaultTeamName,
      teams: Object.values(snapshot.teams).map(team => ({ name: team.name, teamRoomId: team.roomId, role: team.role, members: team.members })),
    }));
    add('list_tasks', 'Read authoritative Tasks visible to this Worker.', { status: text, team_id: text, assigned_to: text, search: text, cursor: text, limit }, [], 'read', (s, a) =>
      this.client.listTasks(s, { status: opt(a, 'status'), teamId: opt(a, 'team_id'), assignedTo: opt(a, 'assigned_to'), search: opt(a, 'search'), cursor: opt(a, 'cursor'), limit: a.limit as number | undefined }));
    add('get_task', 'Read authoritative Task details by exact ID.', { task_id: text }, ['task_id'], 'read', (s, a) => this.client.getTask(s, str(a, 'task_id')));
    add('get_subtask', 'Read authoritative Subtask details by exact ID.', { subtask_id: text }, ['subtask_id'], 'read', (s, a) => this.client.getSubtask(s, str(a, 'subtask_id')));
    add('list_subtasks', 'Read authoritative Subtasks visible to this Worker.', { task_id: text, status: text, assigned_to: text }, [], 'read', (s, a) => this.client.listSubtasks(s, { taskId: opt(a, 'task_id'), status: opt(a, 'status'), assignedTo: opt(a, 'assigned_to') }));
    add('ack_subtask', 'Acknowledge the assigned Subtask in its Task Room.', { subtask_id: text }, ['subtask_id'], 'write', (s, a, c) => this.client.ackSubtask(s, str(a, 'subtask_id'), c!.eventId));
    add('report_subtask_progress', 'Report meaningful Subtask progress.', { subtask_id: text, content: object }, ['subtask_id', 'content'], 'write', (s, a, c) => this.client.reportSubtaskProgress(s, str(a, 'subtask_id'), a.content as Input, c!.eventId));
    add('heartbeat_subtask', 'Refresh the lease of the active assigned Subtask.', { subtask_id: text }, ['subtask_id'], 'write', (s, a) => this.client.heartbeatSubtask(s, str(a, 'subtask_id')));
    add('block_subtask', 'Block a Subtask with a concrete reason and optional evidence.', { subtask_id: text, reason: text, evidence: object }, ['subtask_id', 'reason'], 'write', (s, a, c) => this.client.blockSubtask(s, str(a, 'subtask_id'), str(a, 'reason'), c!.eventId, a.evidence as Input | undefined));
    for (const owner of ['task', 'subtask'] as const) {
      const id = `${owner}_id`;
      add(`list_${owner}_files`, 'List files owned by this ' + owner + '; follow nextCursor.', { [id]: text, prefix: text, cursor: text, limit }, [id], 'read', (s, a) => this.client[owner === 'task' ? 'listTaskFiles' : 'listSubtaskFiles'](s, str(a, id), { prefix: opt(a, 'prefix'), cursor: opt(a, 'cursor'), limit: a.limit as number | undefined }));
      add(`read_${owner}_file`, 'Read an exact fileRef returned by a file listing. Use download for large or binary files.', { [id]: text, file_ref: text }, [id, 'file_ref'], 'read', async (s, a) => encoded(await this.client[owner === 'task' ? 'readTaskFile' : 'readSubtaskFile'](s, str(a, id), str(a, 'file_ref'))));
      add(`download_${owner}_file`, 'Download an exact fileRef into the local workspace without exposing its signed URL.', { [id]: text, file_ref: text, output_path: text, overwrite: boolean }, [id, 'file_ref', 'output_path'], 'read', (s, a) => this.workspace.write(str(a, 'output_path'), a.overwrite === true, path => this.client[owner === 'task' ? 'downloadTaskFileToPath' : 'downloadSubtaskFileToPath'](s, str(a, id), str(a, 'file_ref'), path)));
    }
    add('write_subtask_file', 'Upload text or base64 data to the assigned Subtask, not the parent Task.', { subtask_id: text, path: text, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf-8', 'base64'] }, content_type: text }, ['subtask_id', 'path', 'content'], 'write', (s, a) => this.client.writeSubtaskFile(s, str(a, 'subtask_id'), str(a, 'path'), bytes(a), opt(a, 'content_type')));
    add('write_subtask_file_from_path', 'Upload an existing workspace file to the assigned Subtask.', { subtask_id: text, path: text, local_path: text, content_type: text }, ['subtask_id', 'path', 'local_path'], 'write', async (s, a) => {
      const source = await this.workspace.source(str(a, 'local_path'));
      return this.client.writeSubtaskFileFromPath(s, str(a, 'subtask_id'), str(a, 'path'), source, opt(a, 'content_type') || lookup(source) || 'application/octet-stream');
    });
    add('submit_subtask_result', 'Submit a short Result and exact returned fileRefs. Await review after success.', { subtask_id: text, summary: text, file_refs: { type: 'array', items: text } }, ['subtask_id', 'summary'], 'write', (s, a, c) => this.client.submitSubtaskResult(s, str(a, 'subtask_id'), str(a, 'summary'), (a.file_refs as string[] | undefined) ?? [], c!.eventId));
    add('list_results', 'Read Task Results, optionally narrowed to a Subtask.', { task_id: text, subtask_id: text }, ['task_id'], 'read', (s, a) => this.client.listResults(s, str(a, 'task_id'), opt(a, 'subtask_id')));
    add('list_task_events', 'Read authoritative Task Events; follow nextCursor.', { task_id: text, subtask_id: text, event_type: text, cursor: text, limit }, ['task_id'], 'read', (s, a) => this.client.listEvents(s, str(a, 'task_id'), { subtaskId: opt(a, 'subtask_id'), eventType: opt(a, 'event_type'), cursor: opt(a, 'cursor'), limit: a.limit as number | undefined }));
    add('filesync_list', 'List non-Task Team files under shared/**; follow nextCursor.', { path: text, cursor: text, limit }, ['path'], 'team', (s, a, _c, team) => this.client.listTeamFiles(s, team!, teamPath(str(a, 'path')), { cursor: opt(a, 'cursor'), limit: a.limit as number | undefined }));
    add('filesync_stat', 'Inspect a non-Task Team file or directory.', { path: text }, ['path'], 'team', async (s, a, _c, team) => {
      const path = teamPath(str(a, 'path')), selected = await this.selectTeamFiles(s, team!, path);
      return selected.exact ? { kind: 'file', ...selected.items[0] } : { kind: 'directory', path, entries: selected.items.length };
    });
    add('filesync_push', 'Upload workspace files to non-Task shared/**. Does not delete remote files.', { path: text, local_path: text }, ['path', 'local_path'], 'team', async (s, a, _c, team) => {
      const path = teamPath(str(a, 'path')), localPath = await this.workspace.source(str(a, 'local_path'), true), files = [];
      for (const file of await this.workspace.collect(localPath, path)) files.push({ path: file.remote, localPath: file.local, result: await this.client.writeTeamFileFromPath(s, team!, file.remote, file.local, lookup(file.local) || 'application/octet-stream') });
      return { action: 'push', path, localPath, transferred: files.length, files };
    });
    add('filesync_pull', 'Download non-Task Team files into the workspace. Overwrites by default; never deletes local files.', { path: text, local_path: text, overwrite: boolean }, ['path', 'local_path'], 'team', async (s, a, _c, team) => {
      const path = teamPath(str(a, 'path')), localPath = await this.workspace.path(str(a, 'local_path')), selected = await this.selectTeamFiles(s, team!, path), files = [];
      for (const item of selected.items) {
        const output = selected.exact ? localPath : `${localPath}/${item.path.slice(path.length + 1)}`;
        const result = await this.workspace.writeBytes(output, a.overwrite !== false, await this.client.readTeamFile(s, team!, item.path));
        files.push({ path: item.path, output: result.path });
      }
      return { action: 'pull', path, localPath, transferred: files.length, files };
    });
    return tools;
  }
  private async selectTeamFiles(snapshot: TeamsSnapshot, team: string, path: string): Promise<{ exact: boolean; items: Array<Input & { path: string }> }> {
    let original: unknown;
    if (path !== 'shared') {
      try { return { exact: true, items: [{ ...record(await this.client.statTeamFile(snapshot, team, path)), path }] }; }
      catch (error) { if (!(error instanceof CollaborationTaskConflictError || error instanceof CollaborationTaskNotFoundError)) throw error; original = error; }
    }
    const items: Array<Input & { path: string }> = [];
    let cursor: string | undefined;
    do {
      const page = record(await this.client.listTeamFiles(snapshot, team, path, { cursor }));
      if (!Array.isArray(page.items)) throw new CollaborationTaskUnavailableError('Task Service returned an invalid Team file list.');
      for (const value of page.items) {
        const item = record(value);
        try {
          if (typeof item.path !== 'string' || !item.path.startsWith(path + '/')) throw new Error('prefix');
          items.push({ ...item, path: teamPath(item.path) });
        } catch { throw new CollaborationTaskUnavailableError('Task Service returned an invalid Team file list.'); }
      }
      if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) throw new CollaborationTaskUnavailableError('Task Service returned an invalid Team file cursor.');
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
    if (!items.length && original) throw original;
    return { exact: false, items: items.sort((a, b) => a.path.localeCompare(b.path)) };
  }
}

function workerTeam(snapshot: TeamsSnapshot, id: string): void {
  const team = snapshot.teams[id];
  if (!team) throw new CollaborationTeamUnavailableError('The collaboration Team is unavailable.');
  if (team.role !== 'worker') throw new CollaborationRoleUnsupportedError('The current Agent is not a Worker in this Team.');
}
function record(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollaborationTaskUnavailableError('Task Service returned an invalid response.');
  return value as Input;
}
function str(input: Input, key: string): string { return (input[key] as string).trim(); }
function opt(input: Input, key: string): string | undefined { return input[key] == null ? undefined : str(input, key); }
function encoded(content: Uint8Array): { encoding: string; content: string } {
  try { return { encoding: 'utf-8', content: new TextDecoder('utf8', { fatal: true }).decode(content) }; }
  catch { return { encoding: 'base64', content: Buffer.from(content).toString('base64') }; }
}
function bytes(input: Input): Uint8Array {
  const content = input.content as string;
  if (input.encoding !== 'base64') return Buffer.from(content, 'utf8');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new CollaborationToolArgumentError('content must be valid base64.');
  return Buffer.from(content, 'base64');
}
// These are the primitive fields used by Worker tools, not a general JSON Schema interpreter.
function validate(input: Input, fields: Record<string, Field>, required: string[]): void {
  for (const [key, schema] of Object.entries(fields)) {
    const value = input[key];
    if (value == null && !required.includes(key)) continue;
    const valid = schema.type === 'string' ? typeof value === 'string' && (!schema.minLength || !!value.trim()) && (!schema.enum || (schema.enum as unknown[]).includes(value))
      : schema.type === 'integer' ? Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100
      : schema.type === 'boolean' ? typeof value === 'boolean'
      : schema.type === 'array' ? Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim())
      : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!valid) throw new CollaborationToolArgumentError(`${key} has an invalid value.`);
  }
}
