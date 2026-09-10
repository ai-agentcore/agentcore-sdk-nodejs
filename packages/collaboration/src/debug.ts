import { createHash } from 'node:crypto';
import { AgentCoreError, type Logger } from 'alibabacloud-agentcore-sdk';
import { CollaborationConfigError } from 'alibabacloud-agentcore-sdk/collaboration';
import { httpUrl } from 'alibabacloud-agentcore-sdk/runtime';
import { parseTeamsConfig, type TeamsSnapshot } from './teams';

/** Supplied by the base SDK's DebugRuntimeSource; the addon does not own its lifetime. */
export interface DebugCollaborationSource {
  readonly matrixUrl: string;
  loadTeamsConfig(): Promise<Uint8Array | undefined>;
  exchangeMatrixToken(): Promise<string>;
}
export class DebugCollaborationRuntime {
  private snapshot?: TeamsSnapshot;
  private digest?: string;
  private matrixToken?: string;
  private nextRefresh = 0;
  private initialized = false;
  private serial: Promise<void> = Promise.resolve();
  private readonly interval: number;
  constructor(private readonly source: DebugCollaborationSource, private readonly options: { refreshIntervalMs?: number; logger?: Logger } = {}) {
    this.interval = options.refreshIntervalMs ?? 60_000;
    if (!Number.isFinite(this.interval) || this.interval < 0) throw new CollaborationConfigError('refreshIntervalMs must be non-negative');
  }
  teamsSnapshot(): Promise<TeamsSnapshot | undefined> {
    if (this.initialized && Date.now() < this.nextRefresh) return Promise.resolve(this.snapshot);
    return this.exclusive(async () => {
      if (this.initialized && Date.now() < this.nextRefresh) return this.snapshot;
      try {
        const data = await this.source.loadTeamsConfig();
        if (data === undefined) { this.snapshot = undefined; this.digest = undefined; this.matrixToken = undefined; }
        else {
          const digest = createHash('sha256').update(data).digest('hex');
          if (digest !== this.digest) {
            const snapshot = parseTeamsConfig(data);
            if (snapshot.selfMatrixUserId !== this.snapshot?.selfMatrixUserId && this.matrixToken) this.matrixToken = await this.exchange();
            this.snapshot = snapshot; this.digest = digest;
          }
        }
      } catch (cause) {
        if (!(cause instanceof AgentCoreError)) throw cause;
        if (!this.initialized) throw cause instanceof CollaborationConfigError ? cause : new CollaborationConfigError('cannot load teams.yaml for local debug', { cause });
        this.options.logger?.warn('agentcore.collaboration.debug.teams.update_ignored', { errorType: cause.name });
      }
      this.initialized = true; this.nextRefresh = Date.now() + this.interval;
      return this.snapshot;
    });
  }
  endpoint(): string {
    try {
      const override = process.env.AGENTCORE_TASK_SERVICE_ENDPOINT?.trim();
      if (override) return httpUrl(override, 'Task Service endpoint');
      const gateway = httpUrl(this.source.matrixUrl, 'Task Service endpoint');
      return gateway.endsWith('/agentteams-app') ? gateway : gateway + '/agentteams-app';
    } catch { throw new CollaborationConfigError('Worker Task Service endpoint is unavailable.'); }
  }
  token(_environmentName: string): Promise<string> {
    return this.exclusive(async () => {
      if (!this.snapshot) throw new CollaborationConfigError('Worker Matrix token is unavailable.');
      return this.matrixToken ??= await this.exchange();
    });
  }
  refreshToken(_environmentName: string, rejected: string): Promise<string> {
    return this.exclusive(async () => {
      if (!this.snapshot) throw new CollaborationConfigError('Worker Matrix token is unavailable.');
      if (this.matrixToken && this.matrixToken !== rejected) return this.matrixToken;
      return this.matrixToken = await this.exchange();
    });
  }
  private async exchange(): Promise<string> {
    try { const token = await this.source.exchangeMatrixToken(); if (typeof token === 'string' && token.trim()) return token.trim(); }
    catch (cause) { if (!(cause instanceof AgentCoreError)) throw cause; }
    throw new CollaborationConfigError('Worker Matrix token is unavailable.');
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation);
    this.serial = next.then(() => {}, () => {});
    return next;
  }
}
