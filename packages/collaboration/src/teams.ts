import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseDocument, visit } from 'yaml';
import { CollaborationConfigError } from '@alibabacloud/agentcore-sdk/collaboration';
import type { Logger } from '@alibabacloud/agentcore-sdk';

export const DEFAULT_TEAMS_PATH = '/var/run/agentcore/agent/teams.yaml';
export type TeamRole = 'leader' | 'worker' | 'manager' | 'admin' | 'human' | 'member';
export interface TeamMemberSnapshot {
  readonly type: 'agent' | 'human'; readonly name: string; readonly role: TeamRole;
  readonly runtimeName?: string; readonly matrixUserId?: string; readonly personalRoomId?: string;
}
export interface TeamSnapshot { readonly name: string; readonly roomId?: string; readonly role: TeamRole; readonly members: readonly TeamMemberSnapshot[]; }
export interface TeamsSnapshot {
  readonly runtimeName: string; readonly selfName: string; readonly selfMatrixUserId?: string; readonly selfPersonalRoomId?: string;
  readonly matrixTokenEnv?: string; readonly defaultTeamName?: string; readonly teams: Readonly<Record<string, TeamSnapshot>>;
}

/** Reload changed files on demand. Missing means disabled; malformed updates retain the last valid snapshot. */
export class TeamsProvider {
  private lastGood?: TeamsSnapshot;
  private signature?: string;
  private digest?: string;
  private pending?: Promise<TeamsSnapshot | undefined>;
  constructor(readonly path = DEFAULT_TEAMS_PATH, private readonly logger?: Logger) {}
  snapshot(): Promise<TeamsSnapshot | undefined> {
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load(): Promise<TeamsSnapshot | undefined> {
    let signature: string | undefined, digest: string | undefined;
    try {
      const before = await stat(this.path, { bigint: true });
      signature = fileSignature(before);
      if (signature === this.signature) return this.lastGood;
      const data = await readFile(this.path);
      const after = await stat(this.path, { bigint: true });
      if (signature !== fileSignature(after) || BigInt(data.length) !== after.size) throw new CollaborationConfigError('teams.yaml changed while reading');
      digest = createHash('sha256').update(data).digest('hex');
      if (digest !== this.digest) this.lastGood = parseTeamsConfig(data);
      this.signature = signature; this.digest = digest;
      return this.lastGood;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastGood = undefined; this.signature = undefined; this.digest = undefined; return;
      }
      if (!this.lastGood) throw cause instanceof CollaborationConfigError ? cause : new CollaborationConfigError('cannot read teams.yaml', { cause });
      if (signature && digest) { this.signature = signature; this.digest = digest; }
      this.logger?.warn('agentcore.collaboration.teams.update_ignored', { path: this.path, errorType: cause instanceof Error ? cause.name : typeof cause });
      return this.lastGood;
    }
  }
}
function fileSignature(value: { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string { return `${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`; }

export function parseTeamsConfig(data: Uint8Array | string): TeamsSnapshot {
  let root: Record<string, unknown>;
  try {
    if (!data.length || Buffer.byteLength(data) > 1024 * 1024) throw new Error('size');
    const text = typeof data === 'string' ? data : new TextDecoder('utf8', { fatal: true }).decode(data);
    const document = parseDocument(text, { uniqueKeys: true });
    visit(document, { Alias() { throw new Error('alias'); }, Node(_key, node) { if ('anchor' in node && node.anchor) throw new Error('anchor'); } });
    if (document.errors.length) throw new Error('yaml');
    root = object(document.toJS(), 'teams.yaml');
  } catch (cause) { throw new CollaborationConfigError('teams.yaml must be valid UTF-8 YAML without aliases, duplicate keys, or size over 1 MiB', { cause }); }
  if (root.apiVersion !== 'agentteams.io/v1alpha1' || root.kind !== 'TeamsConfig') throw new CollaborationConfigError('unsupported teams.yaml apiVersion or kind');
  const metadata = object(root.metadata, 'metadata'), spec = object(root.spec, 'spec'), self = object(spec.self, 'spec.self');
  const runtimeName = text(metadata.runtimeName, 'metadata.runtimeName'), selfName = text(self.name, 'spec.self.name');
  if (text(self.runtimeName, 'spec.self.runtimeName') !== runtimeName) throw new CollaborationConfigError('spec.self.runtimeName must match metadata.runtimeName');
  const selfMatrixUserId = optionalText(self.matrixUserId, 'spec.self.matrixUserId');
  let matrixTokenEnv: string | undefined;
  if (spec.matrix != null) {
    matrixTokenEnv = text(object(spec.matrix, 'spec.matrix').tokenEnv, 'spec.matrix.tokenEnv');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(matrixTokenEnv)) throw new CollaborationConfigError('spec.matrix.tokenEnv is invalid');
    if (!selfMatrixUserId) throw new CollaborationConfigError('spec.self.matrixUserId is required when spec.matrix is configured');
  }
  if (!Array.isArray(spec.teams)) throw new CollaborationConfigError('spec.teams must be a list');
  const teams: Record<string, TeamSnapshot> = Object.create(null), rooms = new Set<string>();
  for (const raw of spec.teams) {
    const team = object(raw, 'team'), name = text(team.name, 'team.name');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || Object.hasOwn(teams, name)) throw new CollaborationConfigError('Team names must be unique and mount-safe');
    const roomId = optionalText(team.teamRoomId, 'team.teamRoomId');
    if (roomId && rooms.has(roomId)) throw new CollaborationConfigError('duplicate teamRoomId');
    if (roomId) rooms.add(roomId);
    if (!Array.isArray(team.members)) throw new CollaborationConfigError('team.members must be a list');
    const names = new Set<string>(), runtimes = new Set<string>(), users = new Set<string>();
    const members = team.members.map(value => {
      const member = object(value, 'member'), type = text(member.type, 'member.type');
      if (type !== 'agent' && type !== 'human') throw new CollaborationConfigError('member.type is unsupported');
      const memberRuntime = optionalText(member.runtimeName, 'member.runtimeName');
      if ((type === 'agent') !== Boolean(memberRuntime)) throw new CollaborationConfigError('only agent members require runtimeName');
      const name = text(member.name, 'member.name'), matrixUserId = optionalText(member.matrixUserId, 'member.matrixUserId');
      if (name === selfName || memberRuntime === runtimeName || (selfMatrixUserId !== undefined && matrixUserId === selfMatrixUserId)) throw new CollaborationConfigError('member identity conflicts with spec.self');
      for (const [set, value] of [[names, name], [runtimes, memberRuntime], [users, matrixUserId]] as const) {
        if (value && set.has(value)) throw new CollaborationConfigError('duplicate member identity');
        if (value) set.add(value);
      }
      return Object.freeze({ type, name, runtimeName: memberRuntime, matrixUserId, role: role(member.role), personalRoomId: optionalText(member.personalRoomId, 'member.personalRoomId') });
    });
    teams[name] = Object.freeze({ name, roomId, role: role(object(team.membership, 'team.membership').role), members: Object.freeze(members) });
  }
  const defaultTeamName = optionalText(spec.defaultTeamName, 'spec.defaultTeamName');
  if (defaultTeamName && !Object.hasOwn(teams, defaultTeamName)) throw new CollaborationConfigError('spec.defaultTeamName must reference a configured Team');
  return Object.freeze({ runtimeName, selfName, selfMatrixUserId, selfPersonalRoomId: optionalText(self.personalRoomId, 'spec.self.personalRoomId'),
    matrixTokenEnv, defaultTeamName, teams: Object.freeze(teams) });
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollaborationConfigError(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string { const result = optionalText(value, field); if (!result) throw new CollaborationConfigError(`${field} is required`); return result; }
function optionalText(value: unknown, field: string): string | undefined {
  if (value == null) return;
  if (typeof value !== 'string' || !value.trim()) throw new CollaborationConfigError(`${field} must be non-empty text`);
  return value.trim();
}
function role(value: unknown): TeamRole {
  if (!['leader', 'worker', 'manager', 'admin', 'human', 'member'].includes(String(value))) throw new CollaborationConfigError('Team role is unsupported');
  return value as TeamRole;
}
