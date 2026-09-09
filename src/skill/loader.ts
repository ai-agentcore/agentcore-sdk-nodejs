import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { parseDocument } from 'yaml';
import type { SkillArtifact } from '../controlplane/client';
import { ConfigError, ResourceNotConfiguredError } from '../errors';
import { nullLogger, type Logger } from '../logging';

const MAX_BYTES = 10 * 1024 * 1024;
const METADATA = '.agentcore-skill.json';
const writes = new Map<string, Promise<void>>();
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly instruction: string;
  readonly root: string;
  readonly files: readonly string[];
  readonly source: 'local' | 'agentcore';
  readonly digest?: string;
  readonly workspaceId?: string;
}
export interface SkillProvider { getSkill(name: string, version?: string): Promise<SkillArtifact>; }
export interface SkillsOptions {
  workspaceDir?: string;
  runtime?: () => Promise<{ workspaceId: string; provider: SkillProvider }>;
  logger?: Logger;
}

export class Skills {
  private readonly pins = new Map<string, Promise<Skill>>();
  private readonly workspace: string;
  private readonly logger: Logger;
  constructor(private readonly options: SkillsOptions = {}) {
    this.workspace = resolve(options.workspaceDir ?? process.env.AGENTCORE_SKILL_WORKSPACE_DIR ?? '.skills/.agentcore-managed');
    this.logger = options.logger ?? nullLogger;
  }
  async local(root: string): Promise<Skill[]> {
    this.logger.info('agentcore.skill.local.load.started', { root });
    try {
      root = resolve(root);
      if (!(await lstat(root)).isDirectory()) throw new ConfigError('local Skill root is not a directory');
      const entries = await readdir(root, { withFileTypes: true });
      const directories = entries.some((entry) => entry.name === 'SKILL.md') ? [root] : entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
        if (entry.isSymbolicLink()) throw new ConfigError('local Skill root must not contain symbolic-link Skills');
        return entry.isDirectory() ? [join(root, entry.name)] : [];
      });
      const result: Skill[] = [];
      for (const directory of directories) {
        if ((await readdir(directory)).includes('SKILL.md')) result.push(await loadDirectory(directory));
      }
      this.logger.info('agentcore.skill.local.load.succeeded', { root, skill_count: result.length }); return result;
    } catch (error) { this.logger.warn('agentcore.skill.local.load.failed', { root, error_type: error instanceof Error ? error.name : 'Error' }); throw error; }
  }
  async managed(name: string, options: { version?: string } = {}): Promise<Skill> {
    if (!this.options.runtime) throw new ResourceNotConfiguredError('managed Skill runtime is not configured');
    const { workspaceId, provider } = await this.options.runtime();
    component(name, 'name'); component(workspaceId, 'workspace ID');
    if (options.version !== undefined) component(options.version, 'version');
    const key = JSON.stringify([workspaceId, name, options.version]);
    const cached = this.pins.get(key); if (cached) return cached;
    const pending = (async () => {
      this.logger.info('agentcore.skill.managed.load.started', { workspace_id: workspaceId, name, version: options.version ?? 'latest' });
      const artifact = await provider.getSkill(name, options.version); component(artifact.version, 'version');
      const files = await unpack(name, artifact.archive);
      const hash = createHash('sha256');
      for (const [path, data] of [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(path).update('\0').update(data).update('\0');
      const digest = hash.digest('hex');
      const target = join(this.workspace, workspaceId, name, artifact.version);
      const metadata = { source: 'agentcore', workspaceId, name, version: artifact.version, digest };
      // Serialize writes to the same named version across Core instances in this process.
      const write = (writes.get(target) ?? Promise.resolve()).catch(() => undefined).then(() => materialize(target, files, metadata));
      writes.set(target, write);
      try { await write; } finally { if (writes.get(target) === write) writes.delete(target); }
      const sourceFiles = ['SKILL.md', ...[...files.keys()].filter((path) => path !== 'SKILL.md').sort()];
      const skill = Object.freeze({ ...await loadDirectory(target, sourceFiles), ...metadata, source: 'agentcore' as const });
      this.logger.info('agentcore.skill.managed.load.succeeded', { workspace_id: workspaceId, name, version: artifact.version, digest });
      return skill;
    })();
    this.pins.set(key, pending);
    try { return await pending; } catch (error) {
      this.pins.delete(key); this.logger.warn('agentcore.skill.managed.load.failed', { workspace_id: workspaceId, name, error_type: error instanceof Error ? error.name : 'Error' }); throw error;
    }
  }
}

function component(value: string, label: string): void {
  if (!value.trim() || /[\\/:\0]/.test(value) || value === '.' || value === '..') throw new ConfigError(`managed Skill ${label} is invalid`);
}
function safePath(path: string): void {
  if (!path || /[\\:\0]/.test(path) || posix.isAbsolute(path) || path !== posix.normalize(path) || path.split('/').some((part) => part === '.' || part === '..') || path === METADATA) throw new ConfigError('managed Skill contains an unsafe resource path');
}
async function unpack(name: string, archive: Uint8Array): Promise<Map<string, Buffer>> {
  if (!archive.length || archive.length > MAX_BYTES) throw new ConfigError('Skill package exceeds the 10 MiB size limit');
  try {
    const zip = await new Promise<ZipFile>((accept, reject) => fromBuffer(Buffer.from(archive), { lazyEntries: true, strictFileNames: true }, (error, value) => error ? reject(error) : accept(value)));
    const files = new Map<string, Buffer>(); let total = 0;
    await new Promise<void>((accept, reject) => {
      zip.on('error', reject); zip.on('end', accept);
      zip.on('entry', (entry: Entry) => { void (async () => {
        if (entry.fileName.endsWith('/')) return;
        safePath(entry.fileName);
        if (!entry.fileName.startsWith(`${name}/`)) throw new ConfigError('managed Skill package must use the Skill name as its root directory');
        const path = entry.fileName.slice(name.length + 1); safePath(path);
        if (files.has(path)) throw new ConfigError('managed Skill package contains a duplicate path');
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new ConfigError('Skill directories must not contain symbolic links');
        if (entry.uncompressedSize > MAX_BYTES - total) throw new ConfigError('Skill content exceeds the 10 MiB size limit');
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
        const chunks: Buffer[] = [];
        for await (const chunk of stream) { const data = Buffer.from(chunk); total += data.length; if (total > MAX_BYTES) throw new ConfigError('Skill content exceeds the 10 MiB size limit'); chunks.push(data); }
        files.set(path, Buffer.concat(chunks));
      })().then(() => zip.readEntry(), (error) => { zip.close(); reject(error); }); });
      zip.readEntry();
    });
    if (!files.has('SKILL.md')) throw new ConfigError(`managed Skill package does not contain ${name}/SKILL.md`);
    for (const path of files.keys()) {
      let parent = posix.dirname(path);
      while (parent !== '.') { if (files.has(parent)) throw new ConfigError('managed Skill contains a colliding resource path'); parent = posix.dirname(parent); }
    }
    return files;
  } catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError('managed Skill package is not a valid ZIP archive'); }
}

async function materialize(target: string, files: Map<string, Buffer>, metadata: Record<string, string>): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const existing: unknown = JSON.parse(await readFile(join(target, METADATA), 'utf8'));
      if (JSON.stringify(existing) === JSON.stringify(metadata)) return;
    }
  } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(join(dirname(target), '.skill-'));
  try {
    for (const [path, content] of files) { const destination = join(temporary, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content); }
    await writeFile(join(temporary, METADATA), JSON.stringify(metadata));
    await loadDirectory(temporary); // Do not replace a working version with invalid SKILL.md.
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function loadDirectory(root: string, sourceFiles?: readonly string[]): Promise<Skill> {
  const files: string[] = []; let total = 0;
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new ConfigError('Skill directories must not contain symbolic links');
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${name}/`);
      else if (entry.isFile() && entry.name !== METADATA) { total += (await lstat(join(directory, entry.name))).size; if (total > MAX_BYTES) throw new ConfigError('Skill content exceeds the 10 MiB size limit'); files.push(name); }
    }
  }
  if (sourceFiles) {
    // Managed packages track source files, not files generated by command execution.
    for (const name of sourceFiles) {
      const entry = await lstat(join(root, name));
      if (entry.isSymbolicLink() || !entry.isFile()) throw new ConfigError('managed Skill workspace is missing a source file');
      files.push(name);
    }
  } else await walk(root);
  const instruction = new TextDecoder('utf8', { fatal: true }).decode(await readFile(join(root, 'SKILL.md')));
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(instruction);
  const metadata: Record<string, string> = {};
  if (match) {
    const document = parseDocument(match[1]!);
    if (document.errors.length) throw new ConfigError('SKILL.md contains invalid YAML frontmatter');
    let value: unknown;
    try { value = document.toJS({ maxAliasCount: 0 }) ?? {}; } catch { throw new ConfigError('SKILL.md contains invalid YAML frontmatter'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('SKILL.md frontmatter must be an object');
    for (const key of ['name', 'description', 'version']) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && item !== null) { if (typeof item !== 'string') throw new ConfigError(`SKILL.md frontmatter ${key} must be a string`); metadata[key] = item; }
    }
  }
  return Object.freeze({ name: metadata.name || basename(root), description: metadata.description || '', version: metadata.version || '', instruction, root, files: Object.freeze(files), source: 'local' as const });
}
