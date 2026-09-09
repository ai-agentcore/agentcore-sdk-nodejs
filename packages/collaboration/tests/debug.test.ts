import { afterEach, expect, it, vi } from 'vitest';
import { ConfigError } from '@alibabacloud/agentcore-sdk';
import { CollaborationConfigError } from '@alibabacloud/agentcore-sdk/collaboration';
import { DebugCollaborationRuntime } from '../src/debug';
import { teamsConfig } from './helpers';
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function fixture() {
  let loads = 0, exchanges = 0; let data: Uint8Array | undefined = Buffer.from(JSON.stringify(teamsConfig()));
  let failure = false;
  const runtime = new DebugCollaborationRuntime({ matrixUrl: 'http://gateway',
    async loadTeamsConfig() { loads++; if (failure) throw new ConfigError('network unavailable'); return data; },
    async exchangeMatrixToken() { exchanges++; return 'matrix-' + exchanges; },
  });
  return { runtime, data: (value: Uint8Array | undefined) => { data = value; }, fail: () => { failure = true; }, loads: () => loads, exchanges: () => exchanges };
}
it('coalesces refresh and caches Matrix tokens; stale 401s reuse the replacement', async () => {
  const env = fixture(); const snapshots = await Promise.all([env.runtime.teamsSnapshot(), env.runtime.teamsSnapshot()]);
  expect(snapshots[0]).toBe(snapshots[1]); expect(env.loads()).toBe(1);
  expect(await Promise.all([env.runtime.token('ignored'), env.runtime.token('ignored')])).toEqual(['matrix-1', 'matrix-1']);
  expect(await Promise.all([env.runtime.refreshToken('ignored', 'matrix-1'), env.runtime.refreshToken('ignored', 'matrix-1')])).toEqual(['matrix-2', 'matrix-2']);
  expect(env.exchanges()).toBe(2);
});
it('refreshes changed identity atomically and clears the token when collaboration is removed', async () => {
  vi.useFakeTimers(); const env = fixture();
  await env.runtime.teamsSnapshot(); await env.runtime.token('ignored');
  const config = teamsConfig(); config.spec.self.matrixUserId = '@new-worker:server'; env.data(Buffer.from(JSON.stringify(config)));
  vi.advanceTimersByTime(60_001); expect((await env.runtime.teamsSnapshot())!.selfMatrixUserId).toBe('@new-worker:server');
  expect(await env.runtime.token('ignored')).toBe('matrix-2');
  env.data(undefined); vi.advanceTimersByTime(60_001); expect(await env.runtime.teamsSnapshot()).toBeUndefined();
  await expect(env.runtime.token('ignored')).rejects.toThrow(CollaborationConfigError);
});
it('retains last good on a failed update, but does not hide initial failures', async () => {
  vi.useFakeTimers(); const env = fixture(), initial = await env.runtime.teamsSnapshot(); env.fail(); vi.advanceTimersByTime(60_001);
  expect(await env.runtime.teamsSnapshot()).toBe(initial); expect(await env.runtime.teamsSnapshot()).toBe(initial); expect(env.loads()).toBe(2);
  const fresh = fixture(); fresh.fail(); await expect(fresh.runtime.teamsSnapshot()).rejects.toThrow(CollaborationConfigError);
});
it('uses the debug Matrix gateway or explicit Task Service endpoint without doubling the path', () => {
  vi.stubEnv('AGENTCORE_TASK_SERVICE_ENDPOINT', ''); expect(fixture().runtime.endpoint()).toBe('http://gateway/agentteams-app');
  vi.stubEnv('AGENTCORE_TASK_SERVICE_ENDPOINT', 'https://override/agentteams-app/'); expect(fixture().runtime.endpoint()).toBe('https://override/agentteams-app');
  vi.stubEnv('AGENTCORE_TASK_SERVICE_ENDPOINT', 'https://user:secret@override'); expect(() => fixture().runtime.endpoint()).toThrow(CollaborationConfigError);
});
