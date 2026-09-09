import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError, ContextError } from '../src/errors';
import { parseAgentConfig, parseAgentConfigMapping } from '../src/runtime/config';
import { ManagedRuntimeSource } from '../src/runtime/managed';
import { RuntimeEnvironmentProvider, parseRuntimeEnvironment } from '../src/runtime/environment';
import { RequestContext, currentContext, useContext } from '../src/runtime/context';
import { configMapping } from './helpers';

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'agentcore-node-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('agent.yaml projection', () => {
  it('parses current Controller fields and keeps the snapshot immutable', () => {
    const mapping = { ...configMapping(), extra: { supportedFutureField: true } };
    const config = parseAgentConfig(stringify(mapping));
    expect(config.workspaceId).toBe('ws-test');
    expect(config.gatewayHeaders.authorization).toBe('Bearer consumer-secret');
    expect(config.name).toBe('test-agent');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.gatewayHeaders)).toBe(true);
  });
  it.each(['', 'null', '[]', 'apiVersion: x\napiVersion: x', 'root: &ref value\nother: *ref', '42: value'])('rejects invalid YAML: %s', (yaml) => {
    expect(() => parseAgentConfig(yaml)).toThrow(ConfigError);
  });
  it('does not expose YAML source on parse errors', () => {
    try { parseAgentConfig('key: [consumer-secret'); } catch (error) {
      expect(inspect(error)).not.toContain('consumer-secret');
    }
  });
  it('rejects anchors and non-string keys even in otherwise valid extensible config', () => {
    const yaml = stringify(configMapping());
    expect(() => parseAgentConfig(`${yaml}future: &unused value\n`)).toThrow(/invalid agent.yaml/);
    expect(() => parseAgentConfig(`${yaml}42: value\n`)).toThrow(/invalid agent.yaml/);
  });
  it.each(['https://u:password@example.com', 'https://example.com/?token=secret', 'file:///tmp/agent'])('rejects unsafe gateway URL %s', (url) => {
    const mapping = configMapping(); mapping.spec.model.gatewayUrl = url;
    expect(() => parseAgentConfigMapping(mapping)).toThrow(ConfigError);
  });
  it('rejects duplicate headers and inline model credentials', () => {
    const mapping = configMapping();
    mapping.spec.credentials.header.push({ key: 'authorization', value: 'Bearer second' });
    expect(() => parseAgentConfigMapping(mapping)).toThrow(/duplicate gateway header/);
    const other = configMapping(); Object.assign(other.spec.model, { apiKey: 'bad' });
    expect(() => parseAgentConfigMapping(other)).toThrow(/inline credentials/);
  });
});

describe('mounted runtime', () => {
  it('loads lazily, waits for delayed mount, coalesces resolves and does not hot reload', async () => {
    const dir = await directory(); const path = join(dir, 'agent.yaml');
    vi.stubEnv('AGENTCORE_CONFIG_WAIT_TIMEOUT', '2');
    const source = new ManagedRuntimeSource({ configPath: path });
    const pending = Promise.all([source.resolve(), source.resolve()]);
    await sleep(30); await writeFile(path, stringify(configMapping()));
    const [first, second] = await pending;
    expect(first).toBe(second);
    await writeFile(path, 'invalid');
    expect(await source.resolve()).toBe(first);
    source.close();
  });
  it('fails immediately for malformed existing YAML and can retry after correction', async () => {
    const dir = await directory(); const path = join(dir, 'agent.yaml');
    await writeFile(path, '');
    const source = new ManagedRuntimeSource({ configPath: path });
    await expect(source.resolve()).rejects.toBeInstanceOf(ConfigError);
    await writeFile(path, stringify(configMapping()));
    expect((await source.resolve()).config.workspaceId).toBe('ws-test'); source.close();
  });
  it('supports zero wait and cancellation of a pending mount', async () => {
    const dir = await directory(); const path = join(dir, 'missing');
    vi.stubEnv('AGENTCORE_CONFIG_WAIT_TIMEOUT', '0');
    await expect(new ManagedRuntimeSource({ configPath: path }).resolve()).rejects.toThrow('cannot read agent.yaml');
    vi.stubEnv('AGENTCORE_CONFIG_WAIT_TIMEOUT', '10');
    const source = new ManagedRuntimeSource({ configPath: path });
    const result = source.resolve();
    const assertion = expect(result).rejects.toThrow();
    await sleep(10); source.close(); await assertion;
  });
  it.each(['-1', 'NaN', '1.5', 'Infinity'])('rejects malformed timeout %s', async (timeout) => {
    vi.stubEnv('AGENTCORE_CONFIG_WAIT_TIMEOUT', timeout);
    await expect(new ManagedRuntimeSource().resolve()).rejects.toThrow(/non-negative integer/);
  });
});

describe('runtime environment', () => {
  it('parses Controller shell quotes without executing substitutions', () => {
    expect(parseRuntimeEnvironment("export NAME='a'\\''b'\nexport TOKEN='$(do-not-run)'\n")).toEqual({ NAME: "a'b", TOKEN: '$(do-not-run)' });
  });
  it.each(['X=value', 'export X=1\nexport X=2', "export X='unclosed", 'export X=1; echo bad'])('rejects invalid env line', (line) => {
    expect(() => parseRuntimeEnvironment(line)).toThrow(ConfigError);
  });
  it('prefers AGENTCORE file names, falls back to legacy, and re-reads SA files', async () => {
    const dir = await directory(); const envPath = join(dir, 'env'); const saPath = join(dir, 'sa'); const configPath = join(dir, 'agent.yaml');
    await writeFile(configPath, stringify(configMapping())); await writeFile(saPath, 'first-sa');
    await writeFile(envPath, `export AGENTTEAMS_CONTROLLER_URL='https://legacy.example'\nexport AGENTCORE_CONTROLLER_URL='https://current.example'\nexport AGENTTEAMS_AUTH_TOKEN_FILE='${saPath}'\n`);
    const environment = await new RuntimeEnvironmentProvider(envPath).snapshot();
    expect(environment.controllerUrl).toBe('https://current.example');
    const source = new ManagedRuntimeSource({ configPath, envPath });
    const bindings = await source.resolve();
    expect(await bindings.agentSATokens!.get()).toBe('first-sa');
    await writeFile(saPath, 'rotated-sa');
    expect(await bindings.agentSATokens!.get()).toBe('rotated-sa'); source.close();
  });
});

it('isolates concurrent request headers without assigning special session semantics', async () => {
  expect(() => currentContext()).toThrow(ContextError);
  const values = await Promise.all(['session-a', 'session-b'].map((session) => useContext(new RequestContext({ 'X-AgentCore-Session-ID': session }), async () => {
    await sleep(5);
    return currentContext()!.headers['x-agentcore-session-id'];
  })));
  expect(values).toEqual(['session-a', 'session-b']);
  expect(currentContext(false)).toBeUndefined();
  expect(inspect(new RequestContext({ authorization: 'secret' }))).not.toContain('secret');
});
