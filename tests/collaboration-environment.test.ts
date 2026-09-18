import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/errors';
import { RuntimeEnvironmentProvider } from '../src/runtime/environment';

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'agentcore-env-')); dirs.push(dir); return dir; }
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('uses process fallback, prefers the file, and observes file updates', async () => {
  vi.stubEnv('TEST_MATRIX_TOKEN', 'process-token');
  vi.stubEnv('AGENTCORE_TASK_SERVICE_ENDPOINT', 'https://process.example.com');
  const path = join(await directory(), 'env');
  const provider = new RuntimeEnvironmentProvider(path);
  expect(await provider.value('TEST_MATRIX_TOKEN')).toBe('process-token');
  expect(await provider.taskServiceEndpoint()).toBe('https://process.example.com');
  for (const value of ['first', 'rotated']) {
    await writeFile(path, `export TEST_MATRIX_TOKEN='${value}'\nexport AGENTCORE_TASK_SERVICE_ENDPOINT='https://${value}.example.com'\n`);
    expect(await provider.value('TEST_MATRIX_TOKEN')).toBe(value);
    expect(await provider.taskServiceEndpoint()).toBe(`https://${value}.example.com`);
  }
  await writeFile(path, "export UNUSED='value'\n");
  expect(await provider.value('TEST_MATRIX_TOKEN')).toBe('process-token');
  expect(await provider.taskServiceEndpoint()).toBe('https://process.example.com');
});

it('still requires collaboration values when the file is absent', async () => {
  for (const name of ['TEST_MATRIX_TOKEN', 'AGENTCORE_TASK_SERVICE_ENDPOINT', 'AGENTTEAMS_MATRIX_URL']) vi.stubEnv(name, undefined);
  const provider = new RuntimeEnvironmentProvider(join(await directory(), 'missing'));
  await expect(provider.value('TEST_MATRIX_TOKEN')).rejects.toThrow('TEST_MATRIX_TOKEN');
  await expect(provider.taskServiceEndpoint()).rejects.toThrow('Task Service endpoint');
});

it.each(['malformed', 'unreadable'])('does not fall back for a %s file', async (failure) => {
  vi.stubEnv('TEST_MATRIX_TOKEN', 'process-token');
  vi.stubEnv('AGENTCORE_TASK_SERVICE_ENDPOINT', 'https://process.example.com');
  const dir = await directory();
  const path = failure === 'unreadable' ? dir : join(dir, 'env');
  if (failure === 'malformed') await writeFile(path, 'invalid assignment\n');
  const provider = new RuntimeEnvironmentProvider(path);
  await expect(provider.value('TEST_MATRIX_TOKEN')).rejects.toBeInstanceOf(ConfigError);
  await expect(provider.taskServiceEndpoint()).rejects.toBeInstanceOf(ConfigError);
});
