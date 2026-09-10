import { lstat, mkdir, mkdtemp, readdir, realpath, rename, link, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CollaborationConfigError, CollaborationToolArgumentError } from 'alibabacloud-agentcore-sdk/collaboration';

/** File capabilities exposed to the model are restricted to the application's workspace. */
export class CollaborationWorkspace {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async path(value: string): Promise<string> {
    let root: string;
    try { root = await realpath(this.root); if (!(await lstat(root)).isDirectory()) throw new Error('directory'); }
    catch { throw new CollaborationConfigError('The collaboration workspace is unavailable.'); }
    const target = resolve(root, value), suffix = relative(root, target);
    if (suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)) throw new CollaborationToolArgumentError('Local paths must remain inside the collaboration workspace.');
    let current = root;
    for (const part of suffix ? suffix.split(sep) : []) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new CollaborationToolArgumentError('Local paths must not contain symbolic links.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async source(value: string, allowDirectory = false): Promise<string> {
    const path = await this.path(value);
    try { const info = await lstat(path); if (info.isFile() || allowDirectory && info.isDirectory()) return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    throw new CollaborationToolArgumentError('The local source must be an existing regular file' + (allowDirectory ? ' or directory.' : '.'));
  }
  async collect(source: string, remote: string): Promise<Array<{ local: string; remote: string }>> {
    if ((await lstat(source)).isFile()) return [{ local: source, remote }];
    const result: Array<{ local: string; remote: string }> = [];
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() && !entry.isDirectory()) throw new CollaborationToolArgumentError('Only regular files and directories can be synchronized.');
      result.push(...await this.collect(join(source, entry.name), `${remote}/${entry.name}`));
    }
    return result;
  }
  async write(value: string, overwrite: boolean, producer: (staging: string) => Promise<number>): Promise<{ path: string; size: number }> {
    const target = await this.path(value);
    if (target === await realpath(this.root)) throw new CollaborationToolArgumentError('The output path must name a file.');
    await mkdir(dirname(target), { recursive: true });
    const temporary = await mkdtemp(join(dirname(target), '.agentcore-download-')), staging = join(temporary, 'content');
    try {
      const size = await producer(staging);
      if (overwrite) await rename(staging, target);
      else {
        try { await link(staging, target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CollaborationToolArgumentError('The local destination already exists; choose another path or set overwrite.'); throw error; }
      }
      return { path: target, size };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  writeBytes(value: string, overwrite: boolean, content: Uint8Array): Promise<{ path: string; size: number }> {
    return this.write(value, overwrite, async path => { await writeFile(path, content); return content.length; });
  }
}

export function teamPath(value: string): string {
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') ||
      path !== 'shared' && !path.startsWith('shared/') || /^shared\/(?:tasks|subtasks)(?:\/|$)/.test(path)) {
    throw new CollaborationToolArgumentError('Team files must use shared/** outside shared/tasks/** and shared/subtasks/**.');
  }
  return path;
}
