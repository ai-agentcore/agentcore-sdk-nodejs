import { ConfigError } from './errors';

const keys = [
  'AGENTCORE_MODEL_CONNECTION_NAME', 'AGENTCORE_MODEL_NAME',
  'AGENTCORE_AGENT_SPEC_NAME', 'AGENTCORE_AGENT_SPEC_VERSION',
  'AGENTCORE_MCP_NAMES', 'AGENTCORE_SKILLS',
] as const;

/** Environment defaults only; this does not configure resource authentication. */
export class ResourceDefaults {
  private readonly values: Record<string, string | undefined>;
  constructor(environment: Record<string, string | undefined> = process.env) {
    this.values = Object.fromEntries(keys.map(key => [key, environment[key]]));
  }
  model(name?: string, model?: string): { name: string; model?: string } {
    return name !== undefined ? { name, model } : {
      name: this.required('AGENTCORE_MODEL_CONNECTION_NAME'),
      model: model ?? this.optional('AGENTCORE_MODEL_NAME'),
    };
  }
  agentSpec(name?: string, version?: string): { name: string; version?: string } {
    return name !== undefined ? { name, version } : {
      name: this.required('AGENTCORE_AGENT_SPEC_NAME'),
      version: version ?? this.optional('AGENTCORE_AGENT_SPEC_VERSION'),
    };
  }
  mcpNames(): string[] {
    const key = 'AGENTCORE_MCP_NAMES';
    return this.list(key).map(value => text(value, key));
  }
  skills(): Array<{ name: string; version?: string }> {
    const key = 'AGENTCORE_SKILLS';
    return this.list(key).map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ConfigError(`${key} must contain objects with a name and optional version`);
      const item = value as Record<string, unknown>;
      return { name: text(item.name, key), ...('version' in item ? { version: text(item.version, key) } : {}) };
    });
  }
  private optional(key: string): string | undefined { return this.values[key]?.trim() || undefined; }
  private required(key: string): string {
    const value = this.optional(key);
    if (value === undefined) throw new ConfigError(`Set ${key} or pass an explicit resource name`);
    return value;
  }
  private list(key: string): unknown[] {
    const raw = this.optional(key); if (raw === undefined) return [];
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ConfigError(`${key} must be a JSON array`); }
    if (!Array.isArray(value)) throw new ConfigError(`${key} must be a JSON array`);
    return value;
  }
}
function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ConfigError(`${key} resource names and versions must be non-empty strings`);
  return value.trim();
}
