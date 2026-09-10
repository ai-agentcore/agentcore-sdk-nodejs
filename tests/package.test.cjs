const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('packed ESM and CJS consumers share classes and request context across subpath exports' + (process.env.AGENTCORE_PACKAGE_TEST_SCOPE === 'base' ? ' (base only)' : ' (with frameworks)'), () => {
  const temp = mkdtempSync(join(tmpdir(), 'agentcore-package-'));
  function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }
  try {
    const output = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], process.cwd());
    const pack = JSON.parse(output)[0];
    writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, pack.filename)], temp);
    const assertions = `
      const assert = require('node:assert/strict');
      assert.ok(new auth.ResourceCredential({ accessKeyId: 'ak', accessKeySecret: 'sk', securityToken: 'sts', expiration: new Date() }) instanceof root.AccessKeyCredential);
      assert.throws(() => runtime.parseAgentConfig(''), root.ConfigError);
      assert.ok(skill.skillTools([])[0] instanceof root.Tool);
      assert.equal(typeof model.ModelClient.direct, 'function');
      assert.equal(typeof mcp.MCPClient.direct, 'function');
      assert.ok(!JSON.stringify(new auth.BoundCredential('provider', 'secret-value')).includes('secret-value'));
      assert.throws(() => require.resolve('@langchain/core/messages'), { code: 'MODULE_NOT_FOUND' });
      assert.throws(() => require.resolve('langchain'), { code: 'MODULE_NOT_FOUND' });
      assert.throws(() => require.resolve('ai'), { code: 'MODULE_NOT_FOUND' });
      runtime.useContext(new runtime.RequestContext({ test: 'value' }), () => assert.equal(root.currentContext().headers.test, 'value'));
      (async () => {
        const server = require('node:http').createServer((req, res) => res.end(JSON.stringify(req.headers['x-acs-action'] === 'ListMemories' ? { success: true, items: [] } : { items: [{ name: 'test', mcpServerId: 'mcp-1' }] })));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const cp = new controlplane.AgentCoreControlPlane({ workspaceId: 'ws', regionId: 'cn-hangzhou', endpoint: 'http://127.0.0.1:' + server.address().port, accessKeyCredential: new root.AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) });
        const core = new root.AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: 'http://127.0.0.1:' + server.address().port, accessKeyCredential: new root.AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) });
        try {
          assert.equal((await cp.resolveMCP('test')).mcpServerId, 'mcp-1');
          assert.ok(core.memoryStore('mem') instanceof memory.MemoryStore);
          assert.throws(() => core.memoryStore(' '), root.MemoryValidationError);
          assert.deepEqual((await core.memoryStore('mem').listMemories()).items, []);
        }
        finally { await core.close(); cp.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    writeFileSync(join(temp, 'consumer.cjs'), `const root = require('alibabacloud-agentcore-sdk'); const auth = require('alibabacloud-agentcore-sdk/auth'); const runtime = require('alibabacloud-agentcore-sdk/runtime'); const controlplane = require('alibabacloud-agentcore-sdk/controlplane'); const skill = require('alibabacloud-agentcore-sdk/skill'); const model = require('alibabacloud-agentcore-sdk/model'); const mcp = require('alibabacloud-agentcore-sdk/mcp'); const memory = require('alibabacloud-agentcore-sdk/memory'); ${assertions}`);
    writeFileSync(join(temp, 'consumer.mjs'), `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); import * as root from 'alibabacloud-agentcore-sdk'; import * as auth from 'alibabacloud-agentcore-sdk/auth'; import * as runtime from 'alibabacloud-agentcore-sdk/runtime'; import * as controlplane from 'alibabacloud-agentcore-sdk/controlplane'; import * as skill from 'alibabacloud-agentcore-sdk/skill'; import * as model from 'alibabacloud-agentcore-sdk/model'; import * as mcp from 'alibabacloud-agentcore-sdk/mcp'; import * as memory from 'alibabacloud-agentcore-sdk/memory'; ${assertions}`);
    run(process.execPath, ['consumer.mjs'], temp);
    run(process.execPath, ['consumer.cjs'], temp);
    writeFileSync(join(temp, 'consumer.ts'), `import { AgentCore, AccessKeyCredential } from 'alibabacloud-agentcore-sdk';
      import type { MemoryScope } from 'alibabacloud-agentcore-sdk/memory';
      const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) });
      const scope: MemoryScope = { userId: 'u' };
      void core.memoryStore('mem').addMemories({ scope, text: 'fact' });
      void core.memoryStore('mem').addMemories({ text: 'default scope' });
      void core.memoryStore('mem').listMemorySessionMessages('s', { userId: 'u' });
      // @ts-expect-error text and messages are mutually exclusive
      void core.memoryStore('mem').addMemories({ scope, text: 'fact', messages: [] });
      void core.close();`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], temp);
    // Optional frameworks have their own Node requirements; validate the base package separately on its minimum version.
    if (process.env.AGENTCORE_PACKAGE_TEST_SCOPE === 'base') return;
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@google/adk@2.0.0', '@google/genai@2.21.0'], temp);
    const adkAssertions = `(async () => {
      assert.throws(() => require.resolve('ai'), { code: 'MODULE_NOT_FOUND' });
      const core = new root.AgentCore();
      try {
        const service = new adapter.AgentCoreMemoryService(core.memoryStore('mem'), { partitionResolver: () => '' });
        await assert.rejects(service.searchMemory({ appName: 'app', userId: 'user', query: 'hello' }), root.MemoryValidationError);
        const [tool] = adapter.tools([new root.Tool({ name: 'echo', description: 'Echo', parameters: { type: 'object' }, invoke: args => args })]);
        assert.ok(framework.isBaseTool(tool));
        assert.deepEqual(tool._getDeclaration().parametersJsonSchema, { type: 'object' });
        assert.deepEqual(await tool.runAsync({ args: { text: 'echoed' } }), { text: 'echoed' });
      } finally { await core.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'adk-memory.mjs'), `import assert from 'node:assert/strict'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); import * as root from 'alibabacloud-agentcore-sdk'; import * as adapter from 'alibabacloud-agentcore-sdk/integrations/google-adk'; import * as framework from '@google/adk'; ${adkAssertions}`);
    writeFileSync(join(temp, 'adk-memory.cjs'), `const assert = require('node:assert/strict'); const root = require('alibabacloud-agentcore-sdk'); const adapter = require('alibabacloud-agentcore-sdk/integrations/google-adk'); const framework = require('@google/adk'); ${adkAssertions}`);
    run(process.execPath, ['adk-memory.mjs'], temp); run(process.execPath, ['adk-memory.cjs'], temp);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', 'ai@6.0.277', '@ai-sdk/provider@3.0.15', '@ai-sdk/openai-compatible@2.0.74', '@ai-sdk/openai@3.0.109', '@ai-sdk/anthropic@3.0.116', '@ai-sdk/google@3.0.121'], temp);
    const providerAssertions = `(async () => {
      const server = http.createServer((req, res) => {
        assert.equal(req.headers['x-goog-api-key'], 'local-key');
        assert.equal(req.url, '/v1beta/models/gemini-test:generateContent');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'packed provider' }] }, finishReason: 'STOP' }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const core = new root.AgentCore();
      const provider = createGoogleGenerativeAI({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1beta', apiKey: 'local-key' });
      const client = core.directModel({ languageModel: provider('gemini-test') });
      try {
        assert.ok(client instanceof models.ProviderModelClient);
        assert.equal((await client.invoke([{ role: 'user', content: 'hello' }])).text, 'packed provider');
        await core.close();
        await assert.rejects(client.invoke([{ role: 'user', content: 'closed' }]));
      } finally { await core.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'provider.mjs'), `import assert from 'node:assert/strict'; import http from 'node:http'; import * as root from 'alibabacloud-agentcore-sdk'; import * as models from 'alibabacloud-agentcore-sdk/model'; import { createGoogleGenerativeAI } from '@ai-sdk/google'; ${providerAssertions}`);
    writeFileSync(join(temp, 'provider.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const root = require('alibabacloud-agentcore-sdk'); const models = require('alibabacloud-agentcore-sdk/model'); const { createGoogleGenerativeAI } = require('@ai-sdk/google'); ${providerAssertions}`);
    run(process.execPath, ['provider.mjs'], temp); run(process.execPath, ['provider.cjs'], temp);
    writeFileSync(join(temp, 'provider.ts'), `import { AgentCore } from 'alibabacloud-agentcore-sdk';
      import { createGoogleGenerativeAI } from '@ai-sdk/google';
      const google = createGoogleGenerativeAI({ apiKey: 'local-key' });
      const client = new AgentCore().directModel({ languageModel: google('gemini-test'), embeddingModel: google.embeddingModel('embedding-test') });
      const text: string = (await client.invoke([{ role: 'user', content: 'hello' }])).text;
      const vectors: number[][] = (await client.embedding(['one', 'two'])).embeddings;
      // @ts-expect-error provider owns model identity
      await client.invoke([{ role: 'user', content: 'hello' }], { model: google('other') });`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'provider.ts'], temp);
    const aiAssertions = `(async () => {
      const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer local-key');
        assert.equal(req.url, '/v1/chat/completions');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'c1', created: 1, model: 'custom', choices: [{ index: 0, message: { role: 'assistant', content: 'packed' }, finish_reason: 'stop' }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const core = new root.AgentCore();
      const client = core.directModel({ model: 'custom', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'local-key' });
      try {
        const result = await ai.generateText({ model: adapter.languageModel(client), prompt: 'hello', maxRetries: 0 });
        assert.equal(result.text, 'packed');
        assert.deepEqual(Object.keys(adapter.tools([])), []);
      } finally { await core.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'ai.mjs'), `import assert from 'node:assert/strict'; import * as http from 'node:http'; import * as root from 'alibabacloud-agentcore-sdk'; import * as adapter from 'alibabacloud-agentcore-sdk/integrations/ai-sdk'; import * as ai from 'ai'; ${aiAssertions}`);
    writeFileSync(join(temp, 'ai.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const root = require('alibabacloud-agentcore-sdk'); const adapter = require('alibabacloud-agentcore-sdk/integrations/ai-sdk'); const ai = require('ai'); ${aiAssertions}`);
    run(process.execPath, ['ai.mjs'], temp); run(process.execPath, ['ai.cjs'], temp);
    const adkModelAssertions = `(async () => {
      const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer local-key');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'packed ADK' }, finish_reason: 'stop' }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const core = new root.AgentCore();
      try {
        const model = await adapter.model(core.directModel({ model: 'custom', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'local-key' }));
        assert.ok(framework.isBaseLlm(model));
        const runner = new framework.InMemoryRunner({ agent: new framework.LlmAgent({ name: 'agent', model }), appName: 'app' });
        const events = [];
        for await (const event of runner.runEphemeral({ userId: 'user', newMessage: { role: 'user', parts: [{ text: 'Hello' }] } })) events.push(event);
        assert.equal(events.at(-1).content.parts[0].text, 'packed ADK');
      } finally { await core.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'adk-model.mjs'), `import assert from 'node:assert/strict'; import * as http from 'node:http'; import * as root from 'alibabacloud-agentcore-sdk'; import * as adapter from 'alibabacloud-agentcore-sdk/integrations/google-adk'; import * as framework from '@google/adk'; ${adkModelAssertions}`);
    writeFileSync(join(temp, 'adk-model.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const root = require('alibabacloud-agentcore-sdk'); const adapter = require('alibabacloud-agentcore-sdk/integrations/google-adk'); const framework = require('@google/adk'); ${adkModelAssertions}`);
    run(process.execPath, ['adk-model.mjs'], temp); run(process.execPath, ['adk-model.cjs'], temp);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@mastra/core@1.64.0'], temp);
    const mastraAssertions = `(async () => {
      const actions = [];
      const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part;
        res.setHeader('content-type', 'application/json');
        if (req.headers['x-acs-action']) {
          const action = req.headers['x-acs-action']; actions.push(action);
          res.end(JSON.stringify(action === 'SearchMemories' ? { success: true, data: { memories: [{ memory: { memoryId: 'm', content: { text: 'Likes coffee' }, scope: {} }, score: 1, similarity: 1 }] } }
            : { success: true, data: { memoryIds: ['saved'] } })); return;
        }
        assert.equal(req.headers.authorization, 'Bearer local-key');
        const body = JSON.parse(raw); assert.match(JSON.stringify(body.messages), /Likes coffee/);
        if (!body.stream) {
          res.end(JSON.stringify({ id: 'r', model: 'custom', choices: [{ index: 0, message: { role: 'assistant', content: 'packed Mastra' }, finish_reason: 'stop' }] })); return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ id: 'r', model: 'custom', choices: [{ index: 0, delta: { content: 'packed Mastra' }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + server.address().port;
      const core = new root.AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: url,
        accessKeyCredential: new root.AccessKeyCredential({ accessKeyId: 'ak', accessKeySecret: 'sk' }) });
      try {
        const memory = new adapter.AgentCoreMemoryProcessor(core.memoryStore('mem'), { scopeResolver: () => ({ read: { agentId: 'a' }, write: { agentId: 'a', sessionId: 's' } }), writeBack: true });
        const agent = new framework.Agent({ id: 'agent', name: 'agent', instructions: 'Answer',
          model: await adapter.model(core.directModel({ model: 'custom', baseURL: url + '/v1', apiKey: 'local-key' })),
          tools: adapter.tools([new root.Tool({ name: 'echo', description: 'Echo', parameters: { type: 'object' }, invoke: args => args })]),
          inputProcessors: [memory], outputProcessors: [memory] });
        assert.equal((await agent.generate('Hello')).text, 'packed Mastra');
        assert.deepEqual(actions, ['SearchMemories', 'AddMemories']);
      } finally { await core.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'mastra.mjs'), `import assert from 'node:assert/strict'; import * as http from 'node:http'; import * as root from 'alibabacloud-agentcore-sdk'; import * as adapter from 'alibabacloud-agentcore-sdk/integrations/mastra'; import * as framework from '@mastra/core/agent'; ${mastraAssertions}`);
    writeFileSync(join(temp, 'mastra.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const root = require('alibabacloud-agentcore-sdk'); const adapter = require('alibabacloud-agentcore-sdk/integrations/mastra'); const framework = require('@mastra/core/agent'); ${mastraAssertions}`);
    run(process.execPath, ['mastra.mjs'], temp); run(process.execPath, ['mastra.cjs'], temp);
    writeFileSync(join(temp, 'mastra.ts'), `import { AgentCore } from 'alibabacloud-agentcore-sdk';
      import { model, tools, skillTools, AgentCoreMemoryProcessor } from 'alibabacloud-agentcore-sdk/integrations/mastra';
      import { Agent } from '@mastra/core/agent';
      const core = new AgentCore(); const processor = new AgentCoreMemoryProcessor(core.memoryStore('mem'), { scopeResolver: () => ({ read: { agentId: 'a' } }) });
      new Agent({ id: 'agent', name: 'agent', instructions: 'Answer', model: await model(core.directModel({ model: 'm', baseURL: 'http://localhost/v1' })),
        tools: { ...tools([]), ...skillTools([]) }, inputProcessors: [processor], outputProcessors: [processor] });`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'mastra.ts'], temp);
    writeFileSync(join(temp, 'adk.ts'), `import { AgentCore } from 'alibabacloud-agentcore-sdk';
      import { model, AgentCoreMemoryService } from 'alibabacloud-agentcore-sdk/integrations/google-adk';
      import { LlmAgent, Runner, InMemorySessionService } from '@google/adk';
      const core = new AgentCore(); const native = await model(core.directModel({ model: 'custom', baseURL: 'http://localhost/v1' }));
      const memory = new AgentCoreMemoryService(core.memoryStore('mem'), { partitionResolver: (app, user) => app + ':' + user });
      new Runner({ appName: 'app', agent: new LlmAgent({ name: 'agent', model: native }), memoryService: memory, sessionService: new InMemorySessionService() });`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'adk.ts'], temp);
    writeFileSync(join(temp, 'ai.ts'), `import { AgentCore } from 'alibabacloud-agentcore-sdk';
      import { ModelClient } from 'alibabacloud-agentcore-sdk/model';
      import { languageModel } from 'alibabacloud-agentcore-sdk/integrations/ai-sdk';
      const core = new AgentCore();
      const model: ModelClient = core.directModel({ model: 'custom', baseURL: 'http://localhost/v1' });
      const language = languageModel(model); void language.doGenerate; void core.close();`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'node', 'ai.ts'], temp);
    const serverAssertions = `(async () => {
      const server = new api.AgentCoreServer({ invoke: (_request, context) => {
        assert.equal(root.currentContext(), context);
        return new api.AgentEvent(api.EventType.TEXT, { delta: 'served' });
      } });
      try {
        const url = await server.start({ port: 0, hostname: '127.0.0.1' });
        const response = await fetch(url + '/openai/v1/chat/completions', { method: 'POST', body: '{"messages":[]}' });
        assert.equal((await response.json()).choices[0].message.content, 'served');
      } finally { await server.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'server.cjs'), `const assert = require('node:assert/strict'); const root = require('alibabacloud-agentcore-sdk'); const api = require('alibabacloud-agentcore-sdk/server'); ${serverAssertions}`);
    writeFileSync(join(temp, 'server.mjs'), `import assert from 'node:assert/strict'; import * as root from 'alibabacloud-agentcore-sdk'; import * as api from 'alibabacloud-agentcore-sdk/server'; ${serverAssertions}`);
    run(process.execPath, ['server.cjs'], temp); run(process.execPath, ['server.mjs'], temp);
    writeFileSync(join(temp, 'server.ts'), `import { AgentCoreServer, AgentEvent, EventType, type ProtocolHandler } from 'alibabacloud-agentcore-sdk/server';
      const server = new AgentCoreServer({ invoke: async function* (request, context) {
        request.signal.throwIfAborted(); void context.headers;
        yield new AgentEvent(EventType.TEXT, { delta: 'hello' });
      } });
      const protocol: ProtocolHandler = { name: 'custom', routes: () => server.app }; void protocol;`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'server.ts'], temp);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@langchain/core@1.2.9', '@langchain/langgraph@1.4.14'], temp);
    const graphAssertions = `(async () => {
      const core = new root.AgentCore();
      try {
        const nodes = new graph.AgentCoreMemoryNodes(core.memoryStore('mem'));
        assert.deepEqual(await nodes.recall({ memoryQuery: '', memoryReadScope: { agentId: 'a' } }), { memoryText: '' });
        await assert.rejects(nodes.recall({ memoryQuery: '', memoryReadScope: {} }), root.MemoryValidationError);
      } finally { await core.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'graph.mjs'), `import assert from 'node:assert/strict'; import * as root from 'alibabacloud-agentcore-sdk'; import * as graph from 'alibabacloud-agentcore-sdk/integrations/langgraph'; ${graphAssertions}`);
    writeFileSync(join(temp, 'graph.cjs'), `const assert = require('node:assert/strict'); const root = require('alibabacloud-agentcore-sdk'); const graph = require('alibabacloud-agentcore-sdk/integrations/langgraph'); ${graphAssertions}`);
    run(process.execPath, ['graph.mjs'], temp); run(process.execPath, ['graph.cjs'], temp);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', 'langchain@1.5.10', 'zod@4.5.4'], temp);
    const chainAssertions = `(async () => {
      const core = new root.AgentCore();
      try {
        const middleware = chain.agentCoreMemoryMiddleware(core.memoryStore('mem'), { scopeResolver: () => ({ read: { agentId: 'agent' } }) });
        const agent = framework.createAgent({ model: new framework.FakeToolCallingModel(), middleware: [middleware] });
        const result = await agent.invoke({ messages: [new framework.AIMessage('Continuation')] });
        assert.equal(result.agentcoreMemoryText, '');
        assert.deepEqual(result.agentcoreMemoryInput, []);
        assert.equal(core.config, undefined);
      } finally { await core.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'chain.mjs'), `import assert from 'node:assert/strict'; import * as root from 'alibabacloud-agentcore-sdk'; import * as chain from 'alibabacloud-agentcore-sdk/integrations/langchain'; import * as framework from 'langchain'; ${chainAssertions}`);
    writeFileSync(join(temp, 'chain.cjs'), `const assert = require('node:assert/strict'); const root = require('alibabacloud-agentcore-sdk'); const chain = require('alibabacloud-agentcore-sdk/integrations/langchain'); const framework = require('langchain'); ${chainAssertions}`);
    run(process.execPath, ['chain.mjs'], temp); run(process.execPath, ['chain.cjs'], temp);
    writeFileSync(join(temp, 'chain.ts'), `import { AgentCore } from 'alibabacloud-agentcore-sdk';
      import { agentCoreMemoryMiddleware } from 'alibabacloud-agentcore-sdk/integrations/langchain';
      import { createAgent, FakeToolCallingModel } from 'langchain'; import { z } from 'zod';
      const middleware = agentCoreMemoryMiddleware(new AgentCore().memoryStore('mem'), {
        contextSchema: z.object({ agentId: z.string(), sessionId: z.string() }),
        scopeResolver: (context) => {
          // @ts-expect-error undeclared context field
          context.userId;
          return { read: { agentId: context.agentId }, write: context };
        }, writeBack: true,
      });
      const agent = createAgent({ model: new FakeToolCallingModel(), middleware: [middleware] });
      void agent.invoke({ messages: [] }, { context: { agentId: 'a', sessionId: 's' } });`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'chain.ts'], temp);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@langchain/openai@1.5.11'], temp);
    const chainModelAssertions = `(async () => {
      assert.throws(() => require.resolve('@langchain/anthropic'), { code: 'MODULE_NOT_FOUND' });
      const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer local-key');
        assert.equal(req.url, '/v1/chat/completions');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'c1', created: 1, model: 'custom', choices: [{ index: 0, message: { role: 'assistant', content: 'packed' }, finish_reason: 'stop' }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const core = new root.AgentCore();
      try {
        const client = core.directModel({ model: 'custom', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'local-key' });
        const model = await chain.model(client);
        assert.equal((await model.invoke('hello')).content, 'packed');
        const [tool] = chain.tools([new root.Tool({ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, invoke: args => args.text })]);
        assert.equal(await tool.invoke({ text: 'echoed' }), 'echoed');
        await assert.rejects(tool.invoke({ text: 42 }));
      } finally { await core.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'chain-model.mjs'), `import assert from 'node:assert/strict'; import * as http from 'node:http'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); import * as root from 'alibabacloud-agentcore-sdk'; import * as chain from 'alibabacloud-agentcore-sdk/integrations/langchain'; ${chainModelAssertions}`);
    writeFileSync(join(temp, 'chain-model.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const root = require('alibabacloud-agentcore-sdk'); const chain = require('alibabacloud-agentcore-sdk/integrations/langchain'); ${chainModelAssertions}`);
    run(process.execPath, ['chain-model.mjs'], temp); run(process.execPath, ['chain-model.cjs'], temp);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@langchain/anthropic@1.5.9'], temp);
    writeFileSync(join(temp, 'chain-model.ts'), `import { AgentCore, Tool } from 'alibabacloud-agentcore-sdk';
      import { model, tools } from 'alibabacloud-agentcore-sdk/integrations/langchain';
      import { createAgent } from 'langchain';
      const client = new AgentCore().directModel({ model: 'custom', baseURL: 'http://localhost/v1' });
      const native = await model(client, { temperature: 0.2 });
      createAgent({ model: native, tools: tools([new Tool({ name: 'test', description: '', parameters: { type: 'object' }, invoke: () => 'done' })]) });
      // @ts-expect-error identity belongs to ModelClient
      await model(client, { model: 'override' });
      // @ts-expect-error transport belongs to ModelClient
      await model(client, { configuration: { baseURL: 'http://other' } });`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'chain-model.ts'], temp);
    const chainProviderAssertions = `(async () => {
      const server = http.createServer((req, res) => {
        assert.equal(req.headers['x-goog-api-key'], 'local-key');
        assert.equal(req.url, '/v1beta/models/gemini-test:generateContent');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'packed LangChain provider' }] }, finishReason: 'STOP' }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const core = new root.AgentCore();
      const google = createGoogleGenerativeAI({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1beta', apiKey: 'local-key' });
      const native = await chain.model(core.directModel({ languageModel: google('gemini-test') }));
      try {
        assert.equal((await native.invoke('hello')).text, 'packed LangChain provider');
        await core.close(); await assert.rejects(native.invoke('closed'));
      } finally { await core.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temp, 'chain-provider.mjs'), `import assert from 'node:assert/strict'; import http from 'node:http'; import * as root from 'alibabacloud-agentcore-sdk'; import * as chain from 'alibabacloud-agentcore-sdk/integrations/langchain'; import { createGoogleGenerativeAI } from '@ai-sdk/google'; ${chainProviderAssertions}`);
    writeFileSync(join(temp, 'chain-provider.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const root = require('alibabacloud-agentcore-sdk'); const chain = require('alibabacloud-agentcore-sdk/integrations/langchain'); const { createGoogleGenerativeAI } = require('@ai-sdk/google'); ${chainProviderAssertions}`);
    run(process.execPath, ['chain-provider.mjs'], temp); run(process.execPath, ['chain-provider.cjs'], temp);
    writeFileSync(join(temp, 'chain-provider.ts'), `import { AgentCore } from 'alibabacloud-agentcore-sdk';
      import { model } from 'alibabacloud-agentcore-sdk/integrations/langchain';
      import { createGoogleGenerativeAI } from '@ai-sdk/google';
      import { createAgent } from 'langchain';
      const client = new AgentCore().directModel({ languageModel: createGoogleGenerativeAI()('gemini-test') });
      const native = await model(client, { maxOutputTokens: 100 });
      createAgent({ model: native, tools: [] });
      await native.invoke('hello', { tool_choice: 'none' });
      // @ts-expect-error endpoint belongs to the provider
      await model(client, { baseURL: 'http://other' });`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'chain-provider.ts'], temp);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
