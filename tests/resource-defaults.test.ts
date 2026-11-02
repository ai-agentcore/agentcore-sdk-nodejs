import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { AccessKeyCredential } from '../src/auth/access-key';
import { configMapping, httpServer } from './helpers';
import { ResourceDefaults } from '../src/resource-defaults';
import { AgentCore } from '../src/client';
import { Templates } from '../src/templates';
import { Skills } from '../src/skill/loader';

afterEach(() => vi.unstubAllEnvs());

it('pairs defaults without applying global model/version to explicit resources', () => {
  const defaults = new ResourceDefaults({
    AGENTCORE_MODEL_CONNECTION_NAME: 'mc', AGENTCORE_MODEL_NAME: 'model',
    AGENTCORE_AGENT_SPEC_NAME: 'spec', AGENTCORE_AGENT_SPEC_VERSION: 'v1',
  });
  expect(defaults.model()).toEqual({ name: 'mc', model: 'model' });
  expect(defaults.model(undefined, 'override')).toEqual({ name: 'mc', model: 'override' });
  expect(defaults.model('other')).toEqual({ name: 'other', model: undefined });
  expect(defaults.agentSpec()).toEqual({ name: 'spec', version: 'v1' });
  expect(defaults.agentSpec('other')).toEqual({ name: 'other', version: undefined });
  expect(defaults.agentSpec(undefined, 'v2')).toEqual({ name: 'spec', version: 'v2' });
});

it('parses ordered MCP and versioned Skill arrays', () => {
  const defaults = new ResourceDefaults({
    AGENTCORE_MCP_NAMES: '["a","b"]', AGENTCORE_SKILLS: '[{"name":"s1"},{"name":"s2","version":"2"}]',
  });
  expect(defaults.mcpNames()).toEqual(['a', 'b']);
  expect(defaults.skills()).toEqual([{ name: 's1' }, { name: 's2', version: '2' }]);
  expect(new ResourceDefaults({}).skills()).toEqual([]);
  expect(new ResourceDefaults({}).mcpNames()).toEqual([]);
});

it.each([
  ['AGENTCORE_MCP_NAMES', 'bad'], ['AGENTCORE_MCP_NAMES', '{}'],
  ['AGENTCORE_MCP_NAMES', '[""]'], ['AGENTCORE_MCP_NAMES', '[1]'],
  ['AGENTCORE_SKILLS', 'null'], ['AGENTCORE_SKILLS', '["s"]'],
  ['AGENTCORE_SKILLS', '[{"name":"s","version":1}]'], ['AGENTCORE_SKILLS', '[{}]'],
])('validates %s lazily', (key, value) => {
  const defaults = new ResourceDefaults({ [key]: value });
  expect(() => key === 'AGENTCORE_MCP_NAMES' ? defaults.mcpNames() : defaults.skills()).toThrow(key);
  expect(defaults.model('explicit')).toEqual({ name: 'explicit', model: undefined });
});

it('reports missing default resource names before runtime discovery', async () => {
  vi.stubEnv('AGENTCORE_MODEL_CONNECTION_NAME', '');
  vi.stubEnv('AGENTCORE_AGENT_SPEC_NAME', '');
  const core = AgentCore.auto();
  try {
    await expect(core.model()).rejects.toThrow('AGENTCORE_MODEL_CONNECTION_NAME');
    await expect(core.templates.get()).rejects.toThrow('AGENTCORE_AGENT_SPEC_NAME');
  } finally { await core.close(); }
});

it('delegates bulk loading and keeps the constructor-time snapshot', async () => {
  vi.stubEnv('AGENTCORE_MCP_NAMES', '["a","b"]');
  vi.stubEnv('AGENTCORE_SKILLS', '[{"name":"s1"},{"name":"s2","version":"2"}]');
  const core = AgentCore.auto();
  const mcp = vi.spyOn(core, 'mcp').mockResolvedValue({} as never);
  const skill = vi.spyOn(core.skills, 'managed').mockResolvedValue({} as never);
  vi.stubEnv('AGENTCORE_MCP_NAMES', '["changed"]');
  try {
    expect(await core.mcpsFromEnv()).toHaveLength(2);
    expect(mcp.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(await core.skills.fromEnv()).toHaveLength(2);
    expect(skill.mock.calls).toEqual([['s1', { version: undefined }], ['s2', { version: '2' }]]);
  } finally { await core.close(); }
});

it('passes default AgentSpec selection to the existing provider', async () => {
  vi.stubEnv('AGENTCORE_AGENT_SPEC_NAME', 'spec');
  vi.stubEnv('AGENTCORE_AGENT_SPEC_VERSION', 'v1');
  const getTemplate = vi.fn().mockRejectedValue(new Error('provider reached'));
  const loader = new Templates(async () => ({ workspaceId: 'ws-test', provider: { getTemplate, resolveSkillVersion: vi.fn() } }), new Skills());
  await expect(loader.get()).rejects.toThrow('provider reached');
  expect(getTemplate).toHaveBeenCalledWith('spec', 'v1');
});

it('uses selected model defaults on the actual control-plane HTTP requests', async () => {
  vi.stubEnv('AGENTCORE_MODEL_CONNECTION_NAME', 'default-mc');
  vi.stubEnv('AGENTCORE_MODEL_NAME', 'default-model');
  const requests: URL[] = [];
  const endpoint = await httpServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); requests.push(url);
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/model-connections'))
      res.end(JSON.stringify({ items: [{ name: url.searchParams.get('name'), connectionId: 'mc-1', protocol: 'OpenAI/v1' }] }));
    else if (url.pathname.endsWith('/models'))
      res.end(JSON.stringify({ items: [{ modelName: url.searchParams.get('modelName') || 'only-model', modelId: 'model-1' }] }));
    else res.end('{"id":"reply"}');
  });
  const dir = await mkdtemp(join(tmpdir(), 'agentcore-defaults-'));
  const mapping = configMapping(); mapping.spec.model.gatewayUrl = endpoint.url + '/model-connection';
  const configPath = join(dir, 'agent.yaml'); await writeFile(configPath, stringify(mapping));
  const core = AgentCore.auto({ configPath, controlPlaneEndpoint: endpoint.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'fixture-ak', accessKeySecret: 'fixture-sk' }) });
  try {
    const client = await core.model();
    expect((await client.completion([{ role: 'user', content: 'hello' }])).id).toBe('reply');
    expect(await core.model()).toBe(client);
    await core.model('explicit-mc');
    expect(requests.filter(r => r.pathname.endsWith('/model-connections')).map(r => r.searchParams.get('name')))
      .toEqual(['default-mc', 'explicit-mc']);
    expect(requests.filter(r => r.pathname.endsWith('/models')).map(r => r.searchParams.get('modelName')))
      .toEqual(['default-model', null]);
  } finally { await core.close(); await endpoint.close(); await rm(dir, { recursive: true, force: true }); }
});
