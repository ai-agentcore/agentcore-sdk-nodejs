import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { AuthenticationError, ConfigError, CredentialExchangeError } from '../errors';
import { ControllerClient, type ControllerOptions } from '../auth/controller';
import type { AgentSATokenSource } from '../auth/agent-sa-token';
import { readBytes } from '../http';
import { nullLogger, type Logger } from '../logging';
import { httpUrl, object, parseAgentConfig, requiredString, type AgentConfig } from './config';

interface ControlCredential {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: number;
  ossEndpoint: string;
  ossBucket: string;
  agentConfigPath: string;
  teamsConfigPath?: string;
}

function objectKey(value: unknown, field: string): string {
  const key = requiredString(value, field);
  if (/[\\\r\n]/.test(key) || key.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new CredentialExchangeError(`Controller returned an invalid ${field}`);
  }
  return key;
}

export class ControlConfigLoader {
  private readonly controller: ControllerClient;
  private readonly logger: Logger;
  private readonly lifetime = new AbortController();
  #credential?: ControlCredential;
  private pending?: Promise<ControlCredential>;
  constructor(endpoint: string, source: AgentSATokenSource, private readonly options: ControllerOptions = {}) {
    this.controller = new ControllerClient(endpoint, source, options);
    this.logger = options.logger ?? nullLogger;
  }

  async load(): Promise<AgentConfig> {
    const credential = await this.credential();
    const data = await this.download(credential, credential.agentConfigPath);
    return parseAgentConfig(data!);
  }

  async loadTeams(): Promise<Uint8Array | undefined> {
    let credential = await this.credential();
    if (!credential.teamsConfigPath) credential = await this.credential(true);
    return credential.teamsConfigPath ? this.download(credential, credential.teamsConfigPath, true) : undefined;
  }

  close(): void { this.controller.close(); this.lifetime.abort(); this.#credential = undefined; }

  private async credential(force = false): Promise<ControlCredential> {
    this.lifetime.signal.throwIfAborted();
    if (!force && this.#credential && this.#credential.expiration > Date.now() + 60_000) return this.#credential;
    if (this.pending) return this.pending;
    const request = this.exchange();
    this.pending = request;
    try { this.#credential = await request; return this.#credential; }
    finally { this.pending = undefined; }
  }

  private async exchange(): Promise<ControlCredential> {
    const response = await this.controller.post('/api/v1/credentials/sts', { purpose: 'oss', target: 'control' });
    if (response.status === 401) throw new AuthenticationError('Controller rejected the Agent SA token');
    if (response.status < 200 || response.status >= 300) throw new CredentialExchangeError(`Controller control-config STS failed with HTTP ${response.status}`);
    try {
      const data = object(response.payload, 'control-config STS');
      const read = (field: string) => requiredString(data[field], field);
      const endpoint = read('oss_endpoint');
      const ossEndpoint = httpUrl(endpoint.includes('://') ? endpoint : `https://${endpoint}`, 'OSS endpoint');
      if (new URL(ossEndpoint).pathname !== '/') throw new Error('OSS endpoint path');
      const ossBucket = read('oss_bucket');
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(ossBucket)) throw new Error('OSS bucket');
      const expiration = Date.parse(read('expiration'));
      if (!(expiration > Date.now())) throw new Error('expired control-config STS');
      return {
        accessKeyId: read('access_key_id'), accessKeySecret: read('access_key_secret'), securityToken: read('security_token'),
        expiration, ossEndpoint, ossBucket,
        agentConfigPath: objectKey(data.agent_config_path, 'agent_config_path'),
        teamsConfigPath: data.teams_config_path == null ? undefined : objectKey(data.teams_config_path, 'teams_config_path'),
      };
    } catch { throw new CredentialExchangeError('Controller returned an invalid control-config STS response'); }
  }

  private async download(credential: ControlCredential, key: string, missingOK = false): Promise<Uint8Array | undefined> {
    const original = new URL(credential.ossEndpoint);
    const candidates = [original];
    if (/^(?:[a-z0-9-]+\.)?oss-.+-internal\.aliyuncs\.com$/.test(original.hostname)) {
      const fallback = new URL(original); fallback.hostname = fallback.hostname.replace('-internal.aliyuncs.com', '.aliyuncs.com');
      candidates.push(fallback);
    }
    let lastStatus: number | undefined;
    for (const endpoint of candidates) {
      this.lifetime.signal.throwIfAborted();
      const url = new URL(endpoint);
      const pathStyle = url.hostname === 'localhost' || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0;
      if (!pathStyle && !url.hostname.startsWith(`${credential.ossBucket}.`)) url.hostname = `${credential.ossBucket}.${url.hostname}`;
      const encodedKey = key.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
      url.pathname = `${pathStyle ? `/${credential.ossBucket}` : ''}/${encodedKey}`;
      const date = new Date().toUTCString();
      const canonical = `GET\n\n\n${date}\nx-oss-security-token:${credential.securityToken}\n/${credential.ossBucket}/${key}`;
      const signature = createHmac('sha1', credential.accessKeySecret).update(canonical).digest('base64');
      this.logger.debug('agentcore.control_config.download.started', { host: url.host, path: url.pathname });
      try {
        const response = await fetch(url, {
          headers: { Date: date, Authorization: `OSS ${credential.accessKeyId}:${signature}`, 'x-oss-security-token': credential.securityToken },
          redirect: 'manual', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.options.timeoutMs ?? 10_000)]),
        });
        if (response.ok) {
          const data = await readBytes(response, 1024 * 1024, 'runtime config');
          this.logger.info('agentcore.control_config.download.succeeded', { host: url.host, bytes: data.length });
          return data;
        }
        lastStatus = response.status;
        await response.body?.cancel();
        if (missingOK && response.status === 404) return undefined;
        this.logger.warn('agentcore.control_config.download.failed', { host: url.host, status: response.status });
      } catch (error) {
        this.lifetime.signal.throwIfAborted();
        if (error instanceof ConfigError) throw error;
        this.logger.warn('agentcore.control_config.download.failed', { host: url.host, reason: 'transport_error' });
      }
    }
    throw new ConfigError(lastStatus ? `AgentCore configuration download failed with HTTP ${lastStatus}` : 'cannot reach the AgentCore configuration store');
  }
}
