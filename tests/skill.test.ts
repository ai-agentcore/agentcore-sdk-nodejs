import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { afterEach, expect, it, vi } from 'vitest';
import { Skills, skillTools } from '../src/skill';
import { AgentCore, AccessKeyCredential } from '../src';
import { httpServer } from './helpers';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'agentcore-skill-')); dirs.push(dir); return dir; }
async function archive(files: Record<string, string | Buffer>) {
  const zip = new ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', (c: Buffer) => chunks.push(c)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject); });
  zip.end(); return result;
}
async function local(name = 'test') {
  const dir = join(await directory(), name); await mkdir(dir);
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill\nversion: v1\n---\nUse this skill.\n`);
  return dir;
}

it('loads local single and collection directories without runtime configuration', async () => {
  const root = await local(); const core = new AgentCore({ configPath: '/missing/agent.yaml' });
  try {
    const [skill] = await core.skills.local(root);
    expect(skill).toMatchObject({ name: 'test', source: 'local', version: 'v1', root, files: ['SKILL.md'] });
    expect(await core.skills.local(join(root, '..'))).toHaveLength(1); expect(core.config).toBeUndefined();
  } finally { await core.close(); }
});

it('downloads via the real control-plane API with explicit AK and materializes the named root once', async () => {
  const data = await archive({ 'test/SKILL.md': '---\nname: different-display-name\n---\nInstructions', 'test/scripts/run.js': 'console.log("ran")' });
  const requests: string[] = [];
  const endpoint = await httpServer((req, res) => {
    requests.push(req.url!);
    if (req.url!.startsWith('/archive')) { res.end(data); return; }
    expect(req.headers.authorization).toBeDefined(); res.setHeader('content-type', 'application/json');
    if (req.url!.includes('download-via-oss')) res.end(JSON.stringify({ data: `${endpoint.url}/archive` }));
    else res.end(JSON.stringify({ data: { versions: [{ version: 'v1', status: 'ONLINE' }] } }));
  });
  const core = new AgentCore({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url,
    skillWorkspaceDir: await directory(), accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }) });
  try {
    const [first, second] = await Promise.all([core.skills.managed('test', { version: 'v1' }), core.skills.managed('test', { version: 'v1' })]);
    expect(second).toBe(first); expect(first.name).toBe('test');
    expect(first.root.endsWith('/ws-test/test/v1')).toBe(true);
    expect(await readFile(join(first.root, 'scripts/run.js'), 'utf8')).toContain('ran');
    expect(requests.filter((s) => s.includes('download-via-oss'))).toHaveLength(1);
    expect(core.config).toBeUndefined();
  } finally { await core.close(); await endpoint.close(); }
});

it('pins latest in process but retries failed loads', async () => {
  const data = await archive({ 'test/SKILL.md': 'Instructions' }); let attempts = 0;
  const skills = new Skills({ workspaceDir: await directory(), runtime: async () => ({ workspaceId: 'ws', provider: { getSkill: async () => { if (++attempts === 1) throw new Error('temporary'); return { version: 'v2', archive: data }; } } }) });
  await expect(skills.managed('test')).rejects.toThrow('temporary');
  const loaded = await skills.managed('test'); expect(await skills.managed('test')).toBe(loaded); expect(attempts).toBe(2);
});

it.each([
  ['rootless', { 'SKILL.md': 'instructions' }],
  ['foreign root', { 'test/SKILL.md': 'instructions', 'other/file': 'no' }],
  ['reserved metadata', { 'test/SKILL.md': 'instructions', 'test/.agentcore-skill.json': '{}' }],
  ['colliding path', { 'test/SKILL.md': 'instructions', 'test/file': 'a', 'test/file/child': 'b' }],
  ['expanded size', { 'test/SKILL.md': 'instructions', 'test/large': Buffer.alloc(10 * 1024 * 1024) }],
])('rejects invalid managed packages: %s', async (_label, files) => {
  const data = await archive(files);
  const skills = new Skills({ workspaceDir: await directory(), runtime: async () => ({ workspaceId: 'ws', provider: { getSkill: async () => ({ version: 'v1', archive: data }) } }) });
  await expect(skills.managed('test')).rejects.toThrow();
});

it('rejects local symlink files and invalid frontmatter', async () => {
  const root = await local(); const skills = new Skills();
  await symlink('/etc/passwd', join(root, 'linked'));
  await expect(skills.local(root)).rejects.toThrow('symbolic'); await rm(join(root, 'linked'));
  await writeFile(join(root, 'SKILL.md'), '---\nname: [invalid]\n---\n');
  await expect(skills.local(root)).rejects.toThrow('string');
});

it('exposes aligned skill tool names, JSON results, scoped file reads and a working default command directory', async () => {
  const root = await local(); await mkdir(join(root, 'scripts')); await writeFile(join(root, 'scripts/run.js'), 'console.log("skill-result")');
  const skills = await new Skills().local(root); const tools = skillTools(skills);
  expect(tools.map((t) => t.name)).toEqual(['load_skills', 'read_skill_file', 'execute_command']);
  const call = async (name: string, args = {}) => JSON.parse(await tools.find((t) => t.name === name)!.invoke(args) as string);
  expect(await call('load_skills')).toEqual({ skills: [{ name: 'test', description: 'A test skill' }] });
  expect(await call('load_skills', { name: 'test' })).toMatchObject({ instruction: expect.stringContaining('Use this skill'), files: ['SKILL.md', 'scripts/'] });
  expect(await call('read_skill_file', { name: 'test', relative_path: 'scripts' })).toEqual({ files: ['run.js'] });
  expect(await call('read_skill_file', { name: 'test', relative_path: '../outside' })).toHaveProperty('error');
  expect(await call('execute_command', { command: `"${process.execPath}" scripts/run.js` })).toMatchObject({ stdout: 'skill-result\n', exit_code: 0, timed_out: false });
});

it('preserves source files and agent-created files when another client materializes the same version', async () => {
  const workspaceDir = await directory(); const data = await archive({ 'test/SKILL.md': 'Use the skill' });
  const runtime = async () => ({ workspaceId: 'ws', provider: { getSkill: async () => ({ version: 'v1', archive: data }) } });
  const first = await new Skills({ workspaceDir, runtime }).managed('test');
  await writeFile(join(first.root, 'result.txt'), 'keep');
  await writeFile(join(first.root, 'generated.bin'), Buffer.alloc(11 * 1024 * 1024));
  const second = await new Skills({ workspaceDir, runtime }).managed('test');
  expect(second.root).toBe(first.root); expect(await readFile(join(second.root, 'result.txt'), 'utf8')).toBe('keep');
  expect(second.files).toEqual(['SKILL.md']);
});

it('does not replace an existing skill with an invalid new package', async () => {
  const workspaceDir = await directory(); let data = await archive({ 'test/SKILL.md': 'working instructions' });
  const runtime = async () => ({ workspaceId: 'ws', provider: { getSkill: async () => ({ version: 'v1', archive: data }) } });
  const first = await new Skills({ workspaceDir, runtime }).managed('test');
  data = await archive({ 'test/SKILL.md': '---\nname: [broken]\n---\n' });
  await expect(new Skills({ workspaceDir, runtime }).managed('test')).rejects.toThrow('string');
  expect(await readFile(join(first.root, 'SKILL.md'), 'utf8')).toBe('working instructions');
});

it('uses the shared Workspace directory for multiple managed skill commands', async () => {
  const skills = new Skills({ workspaceDir: await directory(), runtime: async () => ({ workspaceId: 'ws', provider: {
    getSkill: async (name: string) => ({ version: 'v1', archive: await archive({ [`${name}/SKILL.md`]: name }) }),
  } }) });
  const selected = await Promise.all([skills.managed('one'), skills.managed('two')]);
  const execute = skillTools(selected).at(-1)!;
  const result = JSON.parse(await execute.invoke({ command: `"${process.execPath}" -e 'const fs=require("node:fs"); console.log(fs.existsSync("one/v1/SKILL.md") && fs.existsSync("two/v1/SKILL.md"))'` }) as string);
  expect(result).toMatchObject({ stdout: 'true\n', exit_code: 0 });
});

it('uses the parent directory for local sibling skills and denies symlinks introduced after loading', async () => {
  const root = await directory();
  for (const name of ['one', 'two']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'SKILL.md'), name); }
  const selected = await new Skills().local(root); const tools = skillTools(selected);
  const result = JSON.parse(await tools.at(-1)!.invoke({ command: `"${process.execPath}" -e 'console.log(process.cwd())'` }) as string);
  expect(await realpath(result.stdout.trim())).toBe(await realpath(root));
  await symlink('/etc/passwd', join(root, 'one/link'));
  expect(JSON.parse(await tools[1]!.invoke({ name: 'one', relative_path: 'link' }) as string)).toHaveProperty('error');
});

it('respects command opt-out and approval; times out subprocesses and bounds output', async () => {
  const skills = await new Skills().local(await local());
  vi.stubEnv('ALLOW_EXECUTE_COMMAND', 'false'); expect(skillTools(skills)).toHaveLength(2); vi.unstubAllEnvs();
  const denied = skillTools(skills, { commandApproval: () => false }).at(-1)!;
  expect(JSON.parse(await denied.invoke({ command: 'echo disallowed' }) as string)).toHaveProperty('error');
  const execute = skillTools(skills).at(-1)!;
  const timeout = await execute.invoke({ command: `"${process.execPath}" -e 'setInterval(() => {}, 1000)'`, timeout: 1 });
  expect(JSON.parse(timeout as string)).toMatchObject({ timed_out: true, exit_code: -1 });
  const large = JSON.parse(await execute.invoke({ command: `"${process.execPath}" -e 'console.log("x".repeat(200000))'` }) as string);
  expect(large.stdout).toContain('output truncated'); expect(large.stdout.length).toBeLessThan(103000); expect(large.exit_code).toBe(0);
});
