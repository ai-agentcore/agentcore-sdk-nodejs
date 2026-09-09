import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from '../errors';
import { Tool, type ToolArguments } from '../integrations/common';
import { nullLogger, type Logger } from '../logging';
import type { Skill } from './loader';

export interface SkillToolsOptions {
  commandApproval?: (command: string, cwd: string) => boolean | Promise<boolean>;
  commandTimeoutSeconds?: number;
  logger?: Logger;
}
export function skillTools(skills: readonly Skill[], options: SkillToolsOptions = {}): Tool[] {
  const timeout = options.commandTimeoutSeconds ?? 300;
  if (!Number.isInteger(timeout) || timeout <= 0) throw new ConfigError('command timeout must be a positive integer');
  const selected = new Map(skills.map((skill) => [skill.name, skill]));
  if (selected.size !== skills.length) throw new ConfigError('selected Skills must have unique names');
  const missing = (name: unknown) => JSON.stringify({ error: `Skill '${String(name)}' not found. Available skills: ${[...selected.keys()].join(', ') || 'none'}` });
  const tools = [new Tool({
    name: 'load_skills', description: `Load skill instructions for the agent. Call without arguments to list all available skills, or with a skill name to get detailed instructions.\n\nAvailable skills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`,
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The name of the skill to load. If omitted, returns all available skills.' } } },
    invoke: async ({ name }) => {
      if (name === undefined || name === null || name === '') return JSON.stringify({ skills: skills.map(({ name, description }) => ({ name, description })) });
      const skill = typeof name === 'string' ? selected.get(name) : undefined;
      if (!skill) return missing(name);
      return JSON.stringify({ name: skill.name, description: skill.description, instruction: skill.instruction, files: await list(skill.root) });
    },
  }), new Tool({
    name: 'read_skill_file', description: "Read a file from a skill's directory, or list the directory when the relative path points to a directory.",
    parameters: { type: 'object', properties: { name: { type: 'string' }, relative_path: { type: 'string' } }, required: ['name', 'relative_path'] },
    invoke: async ({ name, relative_path: resource }) => {
      const skill = typeof name === 'string' ? selected.get(name) : undefined;
      if (!skill) return missing(name);
      if (typeof resource !== 'string') return JSON.stringify({ error: 'relative_path must be a string' });
      try {
        if (isAbsolute(resource) || resource.split(/[\\/]/).includes('..')) throw new Error('Path is outside the skill directory. Access denied.');
        const path = join(skill.root, resource); const target = await realpath(path); const root = await realpath(skill.root);
        const relation = relative(root, target);
        if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation) || (await lstat(path)).isSymbolicLink()) throw new Error('Path is outside the skill directory. Access denied.');
        if ((await stat(path)).isDirectory()) return JSON.stringify({ files: await list(path) });
        return JSON.stringify({ content: new TextDecoder('utf8', { fatal: true }).decode(await readFile(path)) });
      } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to read skill file' }); }
    },
  })];
  if ((process.env.ALLOW_EXECUTE_COMMAND ?? 'true').toLowerCase() !== 'false') tools.push(new Tool({
    name: 'execute_command', description: 'Execute a shell command in the Agent container for a selected Skill. Before calling this tool, display the exact command and ask the user for confirmation. Returns stdout, stderr, exit_code, and timeout status.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Optional working directory.' }, timeout: { type: 'integer', description: 'Optional timeout in seconds.' } }, required: ['command'] },
    invoke: (args) => execute(args, defaultDirectory(skills), timeout, options),
  }));
  return tools;
}
async function list(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort();
}
function defaultDirectory(skills: readonly Skill[]): string {
  if (skills.length === 1) return skills[0]!.root;
  if (skills.length && skills[0]!.workspaceId && skills.every((s) => s.source === 'agentcore' && s.workspaceId === skills[0]!.workspaceId)) {
    let common = resolve(skills[0]!.root);
    for (const skill of skills.slice(1)) while (relative(common, skill.root).startsWith(`..${sep}`) || relative(common, skill.root) === '..') common = dirname(common);
    return common;
  }
  if (skills.length && skills.every((s) => dirname(s.root) === dirname(skills[0]!.root))) return dirname(skills[0]!.root);
  return process.cwd();
}
async function execute(args: ToolArguments, defaultCwd: string, defaultTimeout: number, options: SkillToolsOptions): Promise<string> {
  const { command, cwd = defaultCwd, timeout = defaultTimeout } = args;
  if (typeof command !== 'string' || !command) return JSON.stringify({ error: 'command must be a non-empty string' });
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) return JSON.stringify({ error: 'timeout must be a positive integer' });
  try {
    if (typeof cwd !== 'string' || !(await stat(cwd)).isDirectory()) throw new Error('Working directory does not exist');
    if (options.commandApproval && !await options.commandApproval(command, cwd)) return JSON.stringify({ error: 'Command execution rejected by user.' });
    const logger = options.logger ?? nullLogger;
    logger.info('agentcore.skill.command.started', { cwd, timeout_seconds: timeout });
    const result = await runCommand(command, cwd, timeout);
    logger.info('agentcore.skill.command.completed', { cwd, exit_code: result.exit_code, timed_out: result.timed_out });
    return JSON.stringify(result);
  } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to execute command' }); }
}
function runCommand(command: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; exit_code: number; timed_out: boolean }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, { shell: true, cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const limit = 100 * 1024;
    const output = [Buffer.alloc(0), Buffer.alloc(0)]; const truncated = [false, false];
    for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', (chunk: Buffer) => {
      const remaining = limit - output[index]!.length;
      if (chunk.length > remaining) truncated[index] = true;
      if (remaining > 0) output[index] = Buffer.concat([output[index]!, chunk.subarray(0, remaining)]);
    });
    let timedOut = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(value); }
    };
    const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); killTimer = setTimeout(() => signal('SIGKILL'), 100); }, timeout * 1000);
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Even if the shell exits first, kill any remaining children of a timed-out command.
      if (timedOut) { clearTimeout(killTimer); signal('SIGKILL'); }
      const text = (index: number) => output[index]!.toString('utf8') + (truncated[index] ? `\n... [output truncated, exceeded ${limit} bytes]` : '');
      accept(timedOut ? { stdout: '', stderr: `Command timed out after ${timeout} seconds.`, exit_code: -1, timed_out: true }
        : { stdout: text(0), stderr: text(1), exit_code: code ?? -1, timed_out: false });
    });
  });
}
