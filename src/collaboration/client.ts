import type { CollaborationOptions, CollaborationRuntime, Worker } from './contracts';

export class CollaborationClient {
  private runtime?: Promise<CollaborationRuntime>;
  private closed = false;
  constructor(private readonly options: CollaborationOptions) {}
  async worker(): Promise<Worker> {
    this.ensureOpen();
    this.runtime ??= this.load().catch(error => { this.runtime = undefined; throw error; });
    const worker = await (await this.runtime).worker();
    this.ensureOpen(); return worker;
  }
  async close(): Promise<void> {
    this.closed = true;
    const runtime = await this.runtime?.catch(() => undefined);
    await runtime?.close();
  }
  private async load(): Promise<CollaborationRuntime> {
    // Keep the addon optional and resolved from the application's installation at runtime.
    const packageName = 'alibabacloud-agentcore-collaboration';
    const addon = await import(packageName) as { Collaboration: new (options: CollaborationOptions) => CollaborationRuntime };
    return new addon.Collaboration(this.options);
  }
  private ensureOpen(): void { if (this.closed) throw new Error('AgentCore collaboration client is closed'); }
}
