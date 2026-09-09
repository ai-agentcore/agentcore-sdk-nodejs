import { readFile } from 'node:fs/promises';
import { parseDocument, visit } from 'yaml';
import { ConfigError } from '../errors';

export const DEFAULT_CONFIG_PATH = '/var/run/agentcore/agent/agent.yaml';
export interface AgentConfig {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly runtimeName: string;
  readonly workspaceId: string;
  readonly regionId: string;
  readonly modelGatewayUrl: string;
  readonly mcpGatewayUrl: string;
  readonly gatewayHeaders: Readonly<Record<string, string>>;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function httpUrl(value: unknown, label: string): string {
  const text = requiredString(value, label);
  let url: URL;
  try { url = new URL(text); } catch { throw new ConfigError(`${label} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${label} must be HTTP(S) without user info, query, or fragment`);
  }
  return text.replace(/\/+$/, '');
}

const sensitive = new Set(['apikey', 'api_key', 'authorization', 'accesskeyid', 'accesskeysecret',
  'cookie', 'header', 'headers', 'password', 'secret', 'securitytoken', 'token']);
function rejectInlineCredentials(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectInlineCredentials(item, `${label}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (sensitive.has(key.toLowerCase())) throw new ConfigError(`${label}.${key} must not contain inline credentials`);
      rejectInlineCredentials(item, `${label}.${key}`);
    }
  }
}

export function parseAgentConfig(data: string | Uint8Array): AgentConfig {
  if (Buffer.byteLength(data) > 1024 * 1024) throw new ConfigError('agent.yaml exceeds the 1 MiB size limit');
  let value: unknown;
  try {
    const text = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data);
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) throw new Error('invalid YAML');
    visit(doc, {
      Alias() { throw new Error('YAML alias'); },
      Node(_key, node) { if ('anchor' in node && node.anchor) throw new Error('YAML anchor'); },
      Pair(_key, pair) {
        if (!pair.key || typeof pair.key !== 'object' || !('value' in pair.key) || typeof pair.key.value !== 'string') {
          throw new Error('non-string YAML key');
        }
      },
    });
    value = doc.toJS();
  } catch {
    // YAML errors may contain a source excerpt with Consumer credentials.
    throw new ConfigError('invalid agent.yaml (UTF-8 YAML, unique string keys, no anchors or aliases required)');
  }
  return parseAgentConfigMapping(value);
}

export function parseAgentConfigMapping(value: unknown): AgentConfig {
  const root = object(value, 'agent.yaml');
  if (root.apiVersion !== 'agentteams.io/v1alpha1' || root.kind !== 'AgentConfig') {
    throw new ConfigError('unsupported agent.yaml apiVersion or kind');
  }
  const metadata = object(root.metadata, 'metadata');
  const spec = object(root.spec, 'spec');
  const model = object(spec.model, 'spec.model');
  const mcp = object(spec.mcp, 'spec.mcp');
  rejectInlineCredentials(model, 'spec.model');
  rejectInlineCredentials(mcp, 'spec.mcp');
  const rawHeaders = object(spec.credentials, 'spec.credentials').header;
  if (!Array.isArray(rawHeaders) || !rawHeaders.length) throw new ConfigError('spec.credentials.header must be a non-empty list');
  const headers: Record<string, string> = {};
  for (const raw of rawHeaders) {
    const header = object(raw, 'gateway header');
    const key = requiredString(header.key, 'header.key').toLowerCase();
    const val = requiredString(header.value, 'header.value');
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || /[\r\n]/.test(val)) throw new ConfigError('invalid gateway header');
    if (Object.hasOwn(headers, key)) throw new ConfigError(`duplicate gateway header: ${key}`);
    Object.defineProperty(headers, key, { value: val, enumerable: true });
  }
  if (!/^bearer\s+\S/i.test(headers.authorization ?? '')) throw new ConfigError('spec.credentials.header requires a Bearer Authorization header');
  const runtimeName = requiredString(metadata.runtimeName, 'metadata.runtimeName');
  return Object.freeze({
    apiVersion: root.apiVersion, kind: root.kind,
    name: metadata.name == null ? runtimeName : requiredString(metadata.name, 'metadata.name'),
    runtimeName,
    workspaceId: requiredString(metadata.workspaceId, 'metadata.workspaceId'),
    regionId: requiredString(metadata.regionId, 'metadata.regionId'),
    modelGatewayUrl: httpUrl(model.gatewayUrl, 'spec.model.gatewayUrl'),
    mcpGatewayUrl: httpUrl(mcp.gatewayUrl, 'spec.mcp.gatewayUrl'),
    gatewayHeaders: Object.freeze(headers),
  });
}

export async function loadAgentConfig(path = process.env.AGENTCORE_CONFIG_PATH || DEFAULT_CONFIG_PATH): Promise<AgentConfig> {
  let data: Buffer;
  try { data = await readFile(path); } catch (cause) {
    throw new ConfigError('cannot read agent.yaml', { cause });
  }
  return parseAgentConfig(data);
}
