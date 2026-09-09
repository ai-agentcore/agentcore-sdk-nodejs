import { realpath, stat } from 'node:fs/promises';
import { RuntimeEnvironmentProvider } from '@alibabacloud/agentcore-sdk/runtime';
import { CollaborationConfigError, type CollaborationOptions, type CollaborationRuntime } from '@alibabacloud/agentcore-sdk/collaboration';
import { DebugCollaborationRuntime } from './debug';
import { TeamsProvider } from './teams';
import { TaskServiceClient } from './task-service';
import { WorkerCollaboration } from './worker';

export class Collaboration implements CollaborationRuntime {
  private readonly teams: TeamsProvider;
  private readonly debug?: DebugCollaborationRuntime;
  private readonly client: TaskServiceClient;
  private instance?: Promise<WorkerCollaboration>;
  private closed = false;
  constructor(private readonly options: CollaborationOptions = {}) {
    this.teams = new TeamsProvider(options.teamsPath, options.logger);
    if (options.debugSource) {
      const debug = this.debug = new DebugCollaborationRuntime(options.debugSource, { logger: options.logger });
      this.client = new TaskServiceClient({ endpointProvider: () => debug.endpoint(), tokenProvider: name => debug.token(name),
        tokenRefresher: (name, token) => debug.refreshToken(name, token), logger: options.logger });
    } else {
      const environment = new RuntimeEnvironmentProvider(options.envPath || process.env.AGENTCORE_ENV_PATH);
      this.client = new TaskServiceClient({ endpointProvider: () => environment.taskServiceEndpoint(), tokenProvider: name => environment.value(name), logger: options.logger });
    }
  }
  worker(): Promise<WorkerCollaboration> {
    if (this.closed) return Promise.reject(new Error('AgentCore collaboration is closed'));
    return this.instance ??= this.createWorker().catch(error => { this.instance = undefined; throw error; });
  }
  close(): void { this.closed = true; this.client.close(); }
  private async createWorker(): Promise<WorkerCollaboration> {
    const provider = this.debug && !this.options.teamsPath ? () => this.debug!.teamsSnapshot() : () => this.teams.snapshot();
    await provider();
    let workspace: string;
    try {
      workspace = await realpath(this.options.workspaceDir || process.env.AGENT_WORKSPACE || process.cwd());
      if (!(await stat(workspace)).isDirectory()) throw new Error('directory');
    } catch { throw new CollaborationConfigError('The collaboration workspace must be an existing directory.'); }
    if (this.closed) throw new Error('AgentCore collaboration is closed');
    return new WorkerCollaboration(provider, this.client, workspace);
  }
}
