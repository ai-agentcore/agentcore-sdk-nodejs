import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { afterEach, expect, it } from 'vitest';
import { AgentCore, AccessKeyCredential } from '../src';
import { skillTools } from '../src/skill';
import { httpServer } from './helpers';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function archive(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new ZipFile(); for (const [name, value] of Object.entries(files)) zip.addBuffer(Buffer.from(value), name);
  const parts: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', (part: Buffer) => parts.push(part)); zip.outputStream.on('end', () => resolve(Buffer.concat(parts))); zip.outputStream.on('error', reject); });
  zip.end(); return result;
}
async function fixture(files: Record<string, string | Buffer>, options: { labels?: Record<string, string> } = {}) {
  const data = await archive(files);
  const skill = await archive({ 'remote/SKILL.md': 'Remote instructions' });
  const calls: Array<{ action: string; path: string }> = []; let fail = false;
  const endpoint = await httpServer((req, res) => {
    if (req.url === '/template.zip') { res.end(data); return; }
    if (req.url === '/skill.zip') { res.end(skill); return; }
    const action = String(req.headers['x-acs-action']); calls.push({ action, path: req.url! });
    expect(req.headers.authorization).toBeDefined(); res.setHeader('content-type', 'application/json');
    if (action === 'DownloadSkillVersionViaOss' && fail) { res.statusCode = 403; res.end(JSON.stringify({ Code: 'Forbidden', Message: 'No skill permission', RequestId: 'request-fixture' })); return; }
    const value = action === 'GetAgentSpec' ? { labels: { latest: 'v1' } }
      : action === 'GetSkillDetail' ? { labels: options.labels ?? { latest: 'v2', stable: 'v3' }, versions: [{ version: 'v9', status: 'online' }] }
      : action === 'DownloadAgentSpecViaOss' ? `${endpoint.url}/template.zip`
      : action === 'DownloadSkillVersionViaOss' ? `${endpoint.url}/skill.zip` : null;
    res.end(JSON.stringify({ data: value }));
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agentcore-template-')); directories.push(workspaceDir);
  const core = new AgentCore({ workspaceId: 'ws-test', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url, skillWorkspaceDir: workspaceDir,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'fixture-ak', accessKeySecret: 'fixture-sk' }) });
  return { core, calls, setFailure: (value: boolean) => { fail = value; }, close: async () => { await core.close(); await endpoint.close(); } };
}

it('loads signed AgentSpec and mixed Skills lazily with stable concurrent results', async () => {
  const f = await fixture({ 'manifest.json': JSON.stringify({ skills: [{ name: 'static' }, { name: 'remote', sourceType: 'REFERENCE', versionSelector: { type: 'LABEL', value: 'stable' } }] }),
    'config/AGENTS.md': 'Main instructions', 'config/SOUL.md': 'Personality', 'config/subagents/helper/AGENTS.md': 'Not the main prompt',
    'skills/static/SKILL.md': 'Static instructions', 'skills/static/assets/file.bin': Buffer.from([0, 255]), 'skills/static/scripts/run.js': 'console.log("ok")' });
  try {
    const template = await f.core.templates.get('assistant');
    expect(template.version).toBe('v1'); expect(template.instruction).toBe('## AGENTS.md\n\nMain instructions\n\n## SOUL.md\n\nPersonality');
    expect(f.calls.map((call) => call.action)).toEqual(['GetAgentSpec', 'DownloadAgentSpecViaOss']);
    const [first, second] = await Promise.all([template.loadSkills(), template.loadSkills()]);
    expect(first.map((skill) => skill.name)).toEqual(['static', 'remote']); expect(first[0]).toBe(second[0]); expect(first[1]).toBe(second[1]);
    expect(first[1]!.version).toBe('v3'); expect(await readFile(join(first[0]!.root, 'assets/file.bin'))).toEqual(Buffer.from([0, 255]));
    expect(skillTools(first)).toHaveLength(3);
    expect(f.calls.filter((call) => call.action === 'DownloadSkillVersionViaOss')).toHaveLength(1);
    expect(f.calls.find((call) => call.action === 'DownloadAgentSpecViaOss')!.path).toContain('agentSpecVersion=v1');
  } finally { await f.close(); }
});

it('keeps Prompt available on Skill failure and permits retry without caching errors', async () => {
  const f = await fixture({ 'manifest.json': JSON.stringify({ skills: [{ name: 'remote', sourceType: 'REFERENCE' }] }), 'config/SOUL.md': 'Hello' });
  try {
    const template = await f.core.templates.get('assistant', { version: 'v1' }); f.setFailure(true);
    await expect(template.loadSkills()).rejects.toThrow(); expect(template.instruction).toBe('Hello');
    f.setFailure(false); expect((await template.loadSkills())[0]!.version).toBe('v2');
    expect(f.calls.some((call) => call.action === 'GetAgentSpec')).toBe(false);
  } finally { await f.close(); }
});

it('does not substitute an online version when a reference label is absent', async () => {
  const f = await fixture({ 'manifest.json': JSON.stringify({ skills: [{ name: 'remote', sourceType: 'REFERENCE' }] }) }, { labels: {} });
  try { await expect((await f.core.templates.get('assistant', { version: 'v1' })).loadSkills()).rejects.toThrow('no label'); }
  finally { await f.close(); }
});

it('loads explicit Skill versions without a label lookup and supports Prompt-only templates', async () => {
  const f = await fixture({ 'manifest.json': JSON.stringify({ skills: [{ name: 'remote', sourceType: 'REFERENCE', versionSelector: { type: 'VERSION', value: 'v4' } }] }) });
  try {
    expect((await (await f.core.templates.get('assistant', { version: 'v1' })).loadSkills())[0]!.version).toBe('v4');
    expect(f.calls.some((call) => call.action === 'GetSkillDetail')).toBe(false);
  } finally { await f.close(); }
  const empty = await fixture({ 'manifest.json': '{}', 'config/AGENTS.md': 'Hello' });
  try { expect(await (await empty.core.templates.get('empty', { version: 'v1' })).loadSkills()).toEqual([]); }
  finally { await empty.close(); }
});

const invalidTemplates: Array<Record<string, string | Buffer>> = [
  { 'manifest.json': '{broken' },
  { 'manifest.json': JSON.stringify({ skills: [{ name: 'missing' }] }) },
  { 'manifest.json': JSON.stringify({ skills: [{ name: 'remote', sourceType: 'REFERENCE' }] }), 'skills/remote/SKILL.md': 'Conflict' },
];
it.each(invalidTemplates)('rejects malformed or inconsistent template content', async (files) => {
  const f = await fixture(files);
  try {
    const load = async () => (await f.core.templates.get('assistant', { version: 'v1' })).loadSkills();
    await expect(load()).rejects.toThrow();
  }
  finally { await f.close(); }
});
