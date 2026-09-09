// Opt-in cloud test. Run explicitly with Node 22.22+; never part of npm test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'yaml';
import GeneratedClient from '@alicloud/agentcore20260804';
import { AgentCore, AccessKeyCredential, Tool } from '../../dist/index.js';
import { skillTools } from '../../dist/skill/index.js';

const configPath = process.env.LIVE_CONFIG_PATH ?? '/tmp/agentcore-live-a3kuVR/agent.yaml';
const endpoint = process.env.LIVE_CONTROL_ENDPOINT ?? 'https://agentcore-pre.aliyuncs.com';
const connection = process.env.LIVE_MODEL_CONNECTION ?? 'test-mcp';
const directory = await mkdtemp(join(tmpdir(), 'agentcore-node-live-'));
const report = [], secrets = [];
function redact(value) { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]'); return text; }
function emit(stage, values) {
  const item = JSON.parse(redact(JSON.stringify({ stage, ...values })));
  report.push(item); console.log(JSON.stringify(item));
  return writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function check(stage, operation) {
  const start = Date.now();
  try { const result = await operation(); await emit(stage, { ok: true, seconds: (Date.now() - start) / 1000, result }); return result; }
  catch (error) { await emit(stage, { ok: false, seconds: (Date.now() - start) / 1000,
    error: { type: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 700), requestId: error?.requestId,
      status: error?.httpStatusCode, serviceCode: error?.serviceCode } }); }
}
function credentials() {
  const raw = execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' });
  let values;
  try { const data = JSON.parse(raw); values = { accessKeyId: data.accessKeyId ?? data.AccessKeyId ?? data.access_key_id,
    accessKeySecret: data.accessKeySecret ?? data.AccessKeySecret ?? data.access_key_secret,
    securityToken: data.securityToken ?? data.SecurityToken ?? data.security_token }; } catch {
    const ids = raw.match(/LTAI[A-Za-z0-9]+/g) ?? [];
    const keys = (raw.match(/[A-Za-z0-9]{25,64}/g) ?? []).filter(value => !value.startsWith('LTAI'));
    assert.equal(ids.length, 1, 'Clipboard must contain exactly one AK/SK pair (or STS JSON)');
    assert.equal(keys.length, 1, 'Clipboard must contain exactly one AK/SK pair (or STS JSON)');
    values = { accessKeyId: ids[0], accessKeySecret: keys[0] };
  }
  secrets.push(...Object.values(values).filter(Boolean));
  return new AccessKeyCredential(values);
}

const credential = credentials();
if (process.env.LIVE_MEMORY_DIAGNOSTICS === '1') {
  const Generated = typeof GeneratedClient === 'function' ? GeneratedClient : GeneratedClient.default;
  const call = Generated.prototype.callApi;
  Generated.prototype.callApi = async function(params, request, runtime) {
    try { return await call.call(this, params, request, runtime); }
    catch (error) {
      if (params.action.includes('Memor')) {
        const chain = []; let current = error;
        for (let i = 0; current && i < 4; i++, current = current.innerException ?? current.cause) {
          chain.push({ type: current.constructor?.name, code: current.code, message: String(current.message).slice(0, 500), statusCode: current.statusCode });
        }
        await emit('memory.transport.diagnostic', { operation: params.action, readTimeout: runtime.readTimeout, connectTimeout: runtime.connectTimeout, chain });
      }
      throw error;
    }
  };
}
const config = parse(await readFile(configPath, 'utf8'));
for (const header of config.spec.credentials.header) secrets.push(header.value, header.value.replace(/^Bearer /i, ''));
// Third-party frameworks can log provider errors. Redact the known test credentials too.
for (const output of [process.stdout, process.stderr]) {
  const write = output.write.bind(output);
  output.write = (chunk, ...args) => write(redact(Buffer.isBuffer(chunk) ? chunk.toString() : chunk), ...args);
}
delete process.env.AGENTCORE_DEBUG_TOKEN;
delete process.env.AGENTCORE_ENV_PATH;
const core = new AgentCore({ configPath, accessKeyCredential: credential, controlPlaneEndpoint: endpoint,
  skillWorkspaceDir: join(directory, 'skills') });
const store = core.memoryStore('test-memory');
const partition = `node-live-${randomUUID()}`;
let model, mcp, skill, canonical = [], memoryReady = false;
const knownIds = new Set();
export const env = { core, store, partition, directory, check, emit, knownIds,
  get model() { return model; }, get canonical() { return canonical; } };

try {
  await emit('environment', { workspace: config.metadata.workspaceId, region: config.metadata.regionId,
    endpoint, connection, model: 'qwen3.8-max', mcp: 'test-mcp', skill: 'test-skill', memory: 'test-memory', partition, directory });
  await check('model.resolve', async () => { model = await core.model(connection, { model: 'qwen3.8-max', timeoutMs: 90_000 }); return { protocol: model.descriptor.protocol }; });
  if (model) {
    await check('model.chat', async () => { const reply = await model.completion([{ role: 'user', content: 'Reply only OK' }], { max_tokens: 64 });
      assert.ok(reply.choices?.[0]?.message?.content); return { text: reply.choices[0].message.content }; });
    await check('model.chat.stream', async () => { let text = '', events = 0;
      for await (const event of model.stream([{ role: 'user', content: 'Reply only OK' }], { max_tokens: 64 })) { events++; text += event.choices?.[0]?.delta?.content ?? ''; }
      assert.ok(text); return { text, events }; });
    await check('model.responses', async () => { const result = await model.responses('Reply only OK', { max_output_tokens: 64 });
      assert.equal(result.status, 'completed'); return { status: result.status, outputs: result.output?.length }; });
    await check('model.responses.stream', async () => { const types = new Set(); for await (const event of model.responsesStream('Reply only OK', { max_output_tokens: 64 })) types.add(event.type);
      assert.ok(types.has('response.completed')); return { types: [...types] }; });
  }
  await check('mcp.initialize.list.call', async () => {
    mcp = await core.mcp('test-mcp', { sessionMs: 30_000, metadataMs: 60_000, toolMs: 60_000 });
    canonical = await mcp.listTools(); assert.ok(canonical.some(tool => tool.name === 'get-current-time'));
    const result = await mcp.callTool('get-current-time', { timeZone: 'Asia/Shanghai' }); assert.ok(!result.isError);
    return { tools: canonical.map(tool => tool.name), result: result.content };
  });
  await check('skill.download.load.read', async () => {
    skill = await core.skills.managed('test-skill');
    const tools = skillTools([skill]).filter(tool => tool.name !== 'execute_command');
    for (const tool of tools) { const result = JSON.parse(await tool.invoke({ name: skill.name, relative_path: 'SKILL.md' })); assert.ok(!result.error); }
    canonical.push(...tools); return { name: skill.name, version: skill.version, root: skill.root };
  });
  await check('memory.write.search', async () => {
    const result = await store.addMemories({ scope: { agentId: partition, sessionId: 'seed' },
      messages: [{ role: 'user', content: '请记住：我喜欢无糖蓝莓汽水，平时只喝无糖的。' },
        { role: 'assistant', content: '记住了，你喜欢无糖蓝莓汽水。' }] });
    result.memoryIds.forEach(id => knownIds.add(id));
    for (let i = 0; i < 10; i++) {
      const found = await store.searchMemories('我喜欢喝什么饮料？', { scope: { agentId: partition }, topK: 5 });
      if (found.memories.length) { memoryReady = true; found.memories.forEach(hit => knownIds.add(hit.memory.memoryId));
        return { written: result.memoryIds.length, hits: found.memories.length, text: found.memories.map(hit => hit.memory.content.text) }; }
      await sleep(2000);
    }
    throw new Error('Memory write completed but search is not yet visible');
  });
  if (process.env.LIVE_PREFLIGHT_ONLY !== '1' && model && mcp && skill && memoryReady) {
    const { frameworks } = await import('./real-frameworks.mjs');
    await frameworks(env);
  }
} finally {
  await check('memory.cleanup', async () => {
    let nextToken;
    do { const page = await store.listMemories({ agentId: partition, nextToken, maxResults: 100 });
      for (const memory of page.items) { assert.equal(memory.scope.agentId, partition); knownIds.add(memory.memoryId); }
      nextToken = page.nextToken;
    } while (nextToken);
    for (const id of knownIds) await store.deleteMemory(id);
    return { deleted: knownIds.size, partition };
  });
  await core.close();
  await emit('summary', { passed: report.filter(row => row.ok).length, failed: report.filter(row => row.ok === false).length,
    reportPath: join(directory, 'report.json') });
  if (report.some(row => row.ok === false)) process.exitCode = 1;
}
