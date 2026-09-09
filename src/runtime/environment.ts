import { readFile } from 'node:fs/promises';
import { ConfigError } from '../errors';
import { httpUrl, requiredString } from './config';

export const DEFAULT_ENV_PATH = '/var/run/agentcore/agent/env';
export interface RuntimeEnvironment {
  controllerUrl: string;
  agentSATokenFile: string;
  controlPlaneEndpoint?: string;
}

// Tokenize shell quoting, but deliberately do not evaluate expansions or commands.
function words(line: string): string[] {
  const parts: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === "'") {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '\\') {
      const next = line[++i];
      if (next === undefined) throw new Error('incomplete escape');
      if (quote === '"' && next !== '"' && next !== '\\') word += '\\';
      word += next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { parts.push(word); word = ''; started = false; }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error('unclosed quote');
  if (started) parts.push(word);
  return parts;
}

export function parseRuntimeEnvironment(text: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const parts = words(line);
      if (parts.length !== 2 || parts[0] !== 'export') throw new Error('expected export');
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(parts[1]!);
      if (!match || Object.hasOwn(values, match[1]!)) throw new Error('invalid assignment');
      values[match[1]!] = match[2]!;
    } catch { throw new ConfigError(`invalid runtime env at line ${index + 1}`); }
  }
  return values;
}

export class RuntimeEnvironmentProvider {
  constructor(readonly path = DEFAULT_ENV_PATH) {}
  async read(): Promise<Record<string, string>> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); } catch (cause) {
      throw new ConfigError('cannot read AgentCore runtime env', { cause });
    }
    return parseRuntimeEnvironment(text);
  }
  async snapshot(): Promise<RuntimeEnvironment> {
    const values = await this.read();
    const endpoint = values.AGENTCORE_CONTROL_ENDPOINT || process.env.AGENTCORE_CONTROL_ENDPOINT;
    return {
      controllerUrl: httpUrl(values.AGENTCORE_CONTROLLER_URL || values.AGENTTEAMS_CONTROLLER_URL, 'runtime Controller URL'),
      agentSATokenFile: requiredString(values.AGENTCORE_AUTH_TOKEN_FILE || values.AGENTTEAMS_AUTH_TOKEN_FILE, 'runtime SA token file'),
      controlPlaneEndpoint: endpoint?.trim() || undefined,
    };
  }
  async value(name: string): Promise<string> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError('runtime environment name is invalid');
    const values = await this.read();
    return requiredString(values[name] || process.env[name], `runtime env ${name}`);
  }
  async taskServiceEndpoint(): Promise<string> {
    const values = await this.read();
    const endpoint = values.AGENTCORE_TASK_SERVICE_ENDPOINT || process.env.AGENTCORE_TASK_SERVICE_ENDPOINT;
    if (endpoint?.trim()) return httpUrl(endpoint, 'Task Service endpoint');
    const gateway = httpUrl(values.AGENTTEAMS_MATRIX_URL || process.env.AGENTTEAMS_MATRIX_URL, 'Task Service endpoint');
    return gateway.endsWith('/agentteams-app') ? gateway : `${gateway}/agentteams-app`;
  }
}
