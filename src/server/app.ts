import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { type Logger, nullLogger } from '../logging';
import { AgentInvoker, type InvokeHandler, failureFields } from './invoker';
import { OpenAIProtocolHandler } from './openai';
import { AGUIProtocolHandler } from './agui';
import type { ProtocolHandler } from './protocol';

export interface AgentCoreServerOptions {
  invoke?: InvokeHandler;
  protocols?: ProtocolHandler[];
  startup?: () => void | Promise<void>;
  shutdown?: () => void | Promise<void>;
  readiness?: () => boolean | Promise<boolean>;
  logger?: Logger;
}
export class AgentCoreServer {
  readonly app = new Hono();
  private readonly invoker: AgentInvoker;
  private readonly logger: Logger;
  private server?: Server;
  private starting?: Promise<string>;
  private stopping?: Promise<void>;
  constructor(private readonly options: AgentCoreServerOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.invoker = new AgentInvoker(options.invoke, this.logger);
    this.app.get('/healthz', c => c.json({ status: 'ok' }));
    this.app.get('/readyz', async c => {
      let ready = false;
      try { ready = options.readiness ? await options.readiness() : this.invoker.configured; }
      catch (error) { this.logger.warn('agentcore.server.readiness.failed', failureFields(error)); }
      return c.json({ ready }, ready ? 200 : 503);
    });
    for (const protocol of options.protocols ?? [new OpenAIProtocolHandler(), new AGUIProtocolHandler()]) {
      this.app.route('/', protocol.routes(this.invoker));
    }
  }
  invoke(handler: InvokeHandler): void { this.invoker.setHandler(handler); }

  start(options: { port?: number; hostname?: string } = {}): Promise<string> {
    if (this.stopping) return Promise.reject(new Error('AgentCore server is closed'));
    if (this.starting) return this.starting;
    this.starting = this.listen(options).catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }
  private async listen(options: { port?: number; hostname?: string }): Promise<string> {
    this.logger.info('agentcore.server.lifecycle.startup.started');
    let initialized = false;
    try {
      await this.options.startup?.();
      initialized = true;
      const address = await new Promise<AddressInfo>((resolve, reject) => {
        const server = serve({ fetch: this.app.fetch, port: options.port ?? 9000, hostname: options.hostname ?? '0.0.0.0' }, resolve) as Server;
        this.server = server;
        server.once('error', reject);
      });
      this.logger.info('agentcore.server.lifecycle.startup.succeeded', { port: address.port });
      return `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
    } catch (error) {
      this.logger.error('agentcore.server.lifecycle.startup.failed', failureFields(error));
      this.server = undefined;
      // Successful application startup must be paired with cleanup if bind fails.
      if (initialized) {
        try { await this.options.shutdown?.(); }
        catch (cleanupError) { this.logger.error('agentcore.server.lifecycle.shutdown.failed', failureFields(cleanupError)); }
      }
      throw error;
    }
  }
  /** Stop accepting traffic, drain requests, then release application resources. */
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stop();
    return this.stopping;
  }
  private async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    if (!this.server?.listening) return;
    this.logger.info('agentcore.server.lifecycle.shutdown.started');
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    try { await this.options.shutdown?.(); }
    catch (error) { this.logger.error('agentcore.server.lifecycle.shutdown.failed', failureFields(error)); throw error; }
    this.logger.info('agentcore.server.lifecycle.shutdown.succeeded');
  }
}
