import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { TemplateArtifact } from './controlplane/client';
import { ConfigError } from './errors';
import { nullLogger, type Logger } from './logging';
import { materializeTemplateSkill, unpackArchive, type Skill, type Skills } from './skill/loader';

interface TemplateProvider {
  getTemplate(name: string, version?: string): Promise<TemplateArtifact>;
  resolveSkillVersion(name: string, selectorType: string, value: string): Promise<string>;
}
interface Definition { name: string; source: 'STATIC' | 'REFERENCE'; selectorType: string; selectorValue: string; }
type Runtime = () => Promise<{ provider: TemplateProvider; workspaceId: string }>;

/** One fetched template. Loading referenced Skills is an explicit asynchronous operation. */
export class AgentTemplate {
  private pending?: Promise<readonly Skill[]>;
  constructor(readonly name: string, readonly version: string, readonly instruction: string,
    private readonly load: () => Promise<Skill[]>, private readonly logger: Logger = nullLogger) {}
  async loadSkills(): Promise<Skill[]> {
    this.pending ??= (async () => {
      this.logger.info('agentcore.template.skills.load.started', { name: this.name, version: this.version });
      const result = await this.load();
      this.logger.info('agentcore.template.skills.load.succeeded', { name: this.name, version: this.version, count: result.length });
      return result;
    })().catch((error: unknown) => {
      this.pending = undefined;
      this.logger.warn('agentcore.template.skills.load.failed', { name: this.name, version: this.version, error_type: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    return [...await this.pending];
  }
}

export class Templates {
  private readonly workspace: string;
  constructor(private readonly runtime: Runtime, private readonly skills: Skills,
    workspaceDir?: string, private readonly logger: Logger = nullLogger) {
    this.workspace = resolve(workspaceDir ?? process.env.AGENTCORE_SKILL_WORKSPACE_DIR ?? '.skills/.agentcore-managed', '.templates');
  }
  async get(name: string, options: { version?: string } = {}): Promise<AgentTemplate> {
    component(name); if (options.version !== undefined) component(options.version);
    const { provider, workspaceId } = await this.runtime(); component(workspaceId);
    this.logger.info('agentcore.template.get.started', { name, version: options.version ?? 'latest' });
    const artifact = await provider.getTemplate(name, options.version); component(artifact.version);
    const files = await unpackArchive(artifact.archive, undefined, 50 * 1024 * 1024);
    const { definitions, instruction } = parse(files);
    const digest = createHash('sha256').update(artifact.archive).digest('hex');
    const load = async (): Promise<Skill[]> => {
      await this.runtime();
      const result: Skill[] = [];
      for (const item of definitions) {
        this.logger.info('agentcore.template.skill.load.started', { template: name, skill: item.name, source: item.source });
        if (item.source === 'REFERENCE') {
          const version = await provider.resolveSkillVersion(item.name, item.selectorType, item.selectorValue);
          result.push(await this.skills.managed(item.name, { version }));
        } else {
          const prefix = `skills/${item.name}/`;
          const resources = new Map([...files].filter(([path]) => path.startsWith(prefix)).map(([path, data]) => [path.slice(prefix.length), data]));
          result.push(await materializeTemplateSkill(join(this.workspace, workspaceId, name, artifact.version, digest, item.name), item.name, resources,
            { source: 'template', workspaceId, name: item.name, version: artifact.version, digest }));
        }
      }
      return result;
    };
    this.logger.info('agentcore.template.get.succeeded', { name, version: artifact.version, skills: definitions.length });
    return new AgentTemplate(name, artifact.version, instruction, load, this.logger);
  }
}

function component(value: string): void {
  if (!value.trim() || /[\\/:\0]/.test(value) || value === '.' || value === '..') throw new ConfigError('Invalid template resource name or version');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('Invalid Agent template manifest');
  return value as Record<string, unknown>;
}
function parse(files: Map<string, Buffer>): { definitions: Definition[]; instruction: string } {
  let manifest: Record<string, unknown>;
  try { manifest = object(JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '{}')); }
  catch { throw new ConfigError('Invalid Agent template manifest'); }
  const items = manifest.skills === undefined ? [] : manifest.skills; if (!Array.isArray(items)) throw new ConfigError('Agent template skills must be an array');
  const definitions = new Map<string, Definition>();
  for (const value of items) {
    const item = typeof value === 'string' ? { name: value } : object(value);
    if (typeof item.name !== 'string') throw new ConfigError('Template Skill name is required');
    component(item.name);
    if (item.sourceType != null && item.version != null) throw new ConfigError(`Template Skill must use versionSelector, not version: ${item.name}`);
    const source = item.sourceType ?? 'STATIC';
    if (source !== 'STATIC' && source !== 'REFERENCE' || source === 'STATIC' && item.versionSelector != null) throw new ConfigError(`Invalid template Skill source or selector: ${item.name}`);
    const selector = item.versionSelector == null ? { type: 'LABEL', value: 'latest' } : object(item.versionSelector);
    if (selector.type !== 'LABEL' && selector.type !== 'VERSION' || typeof selector.value !== 'string' || !selector.value.trim()) throw new ConfigError(`Invalid Skill version selector: ${item.name}`);
    if (definitions.has(item.name)) throw new ConfigError(`Duplicate template Skill: ${item.name}`);
    definitions.set(item.name, { name: item.name, source, selectorType: selector.type, selectorValue: selector.value });
  }
  for (const path of files.keys()) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path); if (!match) continue;
    const name = match[1]!;
    if (definitions.get(name)?.source === 'REFERENCE') throw new ConfigError(`Template Skill is both a reference and a file: ${name}`);
    if (!definitions.has(name)) definitions.set(name, { name, source: 'STATIC', selectorType: 'LABEL', selectorValue: 'latest' });
  }
  const decoder = new TextDecoder('utf8', { fatal: true });
  const agents = decoder.decode(files.get('config/AGENTS.md'));
  const soul = decoder.decode(files.get('config/SOUL.md'));
  const instruction = agents.trim() && soul.trim() ? `## AGENTS.md\n\n${agents.trim()}\n\n## SOUL.md\n\n${soul.trim()}` : agents.trim() ? agents : soul;
  return { definitions: [...definitions.values()], instruction };
}
