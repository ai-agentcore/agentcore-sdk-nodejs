import { mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { CollaborationConfigError } from '@alibabacloud/agentcore-sdk/collaboration';
import { TeamsProvider, parseTeamsConfig } from '../src/teams';
import { teamsConfig } from './helpers';

it('projects immutable Teams without credentials and permits unknown fields', () => {
  const config = teamsConfig(); const result = parseTeamsConfig(JSON.stringify({ ...config, future: 'ignored' }));
  expect(result).toMatchObject({ runtimeName: 'runtime', selfName: 'worker', matrixTokenEnv: 'MATRIX_TOKEN', defaultTeamName: 'team' });
  expect(result.teams.team!.members).toHaveLength(2); expect(Object.isFrozen(result.teams.team!.members[0])).toBe(true);
  expect(() => { (result.teams as Record<string, unknown>).other = {}; }).toThrow();
});
it.each([
  (c: any) => { c.spec.self.runtimeName = 'other'; },
  (c: any) => { c.spec.self.matrixUserId = ''; },
  (c: any) => { delete c.spec.self.matrixUserId; },
  (c: any) => { c.spec.matrix.tokenEnv = 'TOKEN=oops'; },
  (c: any) => { c.spec.teams.push(c.spec.teams[0]); },
  (c: any) => { c.spec.teams[0].name = '../team'; },
  (c: any) => { c.spec.teams[0].membership.role = 'owner'; },
  (c: any) => { c.spec.teams[0].members.push(c.spec.teams[0].members[0]); },
  (c: any) => { c.spec.teams[0].members[0].matrixUserId = '@worker:server'; },
  (c: any) => { c.spec.teams[0].members[1].runtimeName = 'human-runtime'; },
  (c: any) => { c.spec.defaultTeamName = 'missing'; },
])('rejects inconsistent membership metadata %#', mutate => {
  const config = teamsConfig(); mutate(config); expect(() => parseTeamsConfig(JSON.stringify(config))).toThrow(CollaborationConfigError);
});
it.each([undefined, null])('accepts configuration before Matrix registration (%s) and reloads membership', async matrix => {
  const directory = await mkdtemp(join(tmpdir(), 'collab-unbound-')); const path = join(directory, 'teams.yaml');
  try {
    await writeFile(path, JSON.stringify({ apiVersion: 'agentteams.io/v1alpha1', kind: 'TeamsConfig', metadata: { runtimeName: 'runtime' },
      spec: { self: { name: 'worker', runtimeName: 'runtime' }, matrix, teams: [] } }));
    const provider = new TeamsProvider(path); const initial = await provider.snapshot();
    expect(initial).toMatchObject({ runtimeName: 'runtime', teams: {} });
    expect(initial!.matrixTokenEnv).toBeUndefined(); expect(initial!.selfMatrixUserId).toBeUndefined();
    await writeFile(path, JSON.stringify(teamsConfig()));
    expect((await provider.snapshot())!.matrixTokenEnv).toBe('MATRIX_TOKEN');
    expect((await provider.snapshot())!.teams.team!.role).toBe('worker');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('does not treat absent Matrix identities as roster conflicts', () => {
  const config: any = teamsConfig(); delete config.spec.matrix; delete config.spec.self.matrixUserId;
  for (const member of config.spec.teams[0].members) delete member.matrixUserId;
  expect(parseTeamsConfig(JSON.stringify(config)).teams.team!.members).toHaveLength(2);
});
it.each(['', 'key: 1\nkey: 2', 'key: &anchor secret\ncopy: *anchor', 'x'.repeat(1024 * 1024 + 1), new Uint8Array([255])])('rejects invalid YAML %#', data => {
  expect(() => parseTeamsConfig(data)).toThrow(CollaborationConfigError);
});
it('reloads changed teams, coalesces reads, retains last good, and disables on removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collab-teams-')); const path = join(directory, 'teams.yaml');
  const warnings: unknown[] = []; const provider = new TeamsProvider(path, { debug() {}, info() {}, error() {}, warn: (_name, fields) => warnings.push(fields) });
  try {
    expect(await provider.snapshot()).toBeUndefined(); await writeFile(path, 'invalid'); await expect(provider.snapshot()).rejects.toThrow(CollaborationConfigError);
    await writeFile(path, JSON.stringify(teamsConfig())); const [first, same] = await Promise.all([provider.snapshot(), provider.snapshot()]); expect(first).toBe(same);
    await writeFile(path, 'broken: ['); expect(await provider.snapshot()).toBe(first); expect(await provider.snapshot()).toBe(first); expect(warnings).toHaveLength(1);
    const update = teamsConfig(); update.spec.teams[0]!.membership.role = 'leader';
    await writeFile(join(directory, 'replacement'), JSON.stringify(update)); await rename(join(directory, 'replacement'), path);
    expect((await provider.snapshot())!.teams.team!.role).toBe('leader');
    await rm(path); expect(await provider.snapshot()).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
