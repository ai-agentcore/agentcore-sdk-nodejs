import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAgent } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { LlmAgent, Runner, InMemorySessionService, PRELOAD_MEMORY, StreamingMode } from '@google/adk';
import { Agent as MastraAgent } from '@mastra/core/agent';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EventSchemas } from '@ag-ui/core';
import { AgentCore, AccessKeyCredential } from '../src';
import { ModelClient } from '../src/model';
import { MCPClient } from '../src/mcp';
import { Skills } from '../src/skill';
import { model, tools, skillTools, agentCoreMemoryMiddleware, AgentCoreConverter } from '../src/integrations/langchain';
import * as adk from '../src/integrations/google-adk';
import * as mastra from '../src/integrations/mastra';
import { AgentCoreServer, type InvokeHandler } from '../src/server';
import { parseAgentConfigMapping } from '../src/runtime/config';
import { configMapping, httpServer } from './helpers';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(['langchain', 'google-adk', 'mastra'].flatMap(framework => ['agui', 'openai'].map(protocol => ({ framework, protocol }))))(
  'serves a $framework model/MCP/Skill/Memory agent over $protocol', async ({ framework, protocol }) => {
  const modelRequests: Record<string, any>[] = [], memoryRequests: { action: string; body: Record<string, any> }[] = [];
  const mcpCalls: unknown[] = [], auth: { path: string; value?: string }[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const mcpServers: Server[] = [];
  const endpoint = await httpServer((req, res) => {
    void (async () => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url!.startsWith('/mcp-servers/')) {
        auth.push({ path: req.url!, value: req.headers.authorization });
        const input = raw ? JSON.parse(raw) : undefined;
        const id = req.headers['mcp-session-id'] as string | undefined;
        let transport = id ? sessions.get(id) : undefined;
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
            onsessioninitialized: value => { sessions.set(value, transport!); } });
          const server = new Server({ name: 'tools', version: '1' }, { capabilities: { tools: {} } }); mcpServers.push(server);
          server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'timezone', description: 'Lookup timezone',
            inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] }));
          server.setRequestHandler(CallToolRequestSchema, async request => {
            mcpCalls.push(request.params.arguments); return { content: [{ type: 'text', text: 'Asia/Shanghai' }] };
          });
          await server.connect(transport);
        }
        await transport.handleRequest(req, res, input); return;
      }
      if (req.headers['x-acs-action']) {
        const action = String(req.headers['x-acs-action']); memoryRequests.push({ action, body: JSON.parse(new URLSearchParams(raw).get('body')!) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(action === 'SearchMemories' ? { success: true, data: { memories: [{ memory: { memoryId: 'm',
          content: { text: 'User prefers concise answers' }, scope: {} }, score: 1, similarity: 1 }] } }
          : { success: true, data: { memoryIds: ['saved'] } })); return;
      }
      auth.push({ path: req.url!, value: req.headers.authorization });
      const body = JSON.parse(raw); modelRequests.push(body);
      const number = modelRequests.length;
      const call = (index: number, name: string, args: unknown) => ({ index, id: `call-${number}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const calls = number === 1 ? [call(0, 'timezone', { city: '杭州' }), call(1, 'load_skills', { name: 'guide' })]
        : number === 2 ? [call(0, 'read_skill_file', { name: 'guide', relative_path: 'note.txt' })] : [];
      const delta = calls.length ? { role: 'assistant', content: number === 1 ? '先查询时区。' : '', tool_calls: calls } : { role: 'assistant', content: '杭州位于 Asia/Shanghai。' };
      res.setHeader('content-type', 'text/event-stream');
      res.end([ { id: `answer-${number}`, model: 'custom-model', created: 1, choices: [{ index: 0, delta, finish_reason: null }] },
        { id: `answer-${number}`, model: 'custom-model', created: 1, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
    })().catch(error => { res.statusCode = 500; res.end(String(error)); });
  }); cleanup.push(() => endpoint.close(), () => Promise.all(mcpServers.map(s => s.close())));
  const mapping = configMapping(); mapping.spec.model.gatewayUrl = endpoint.url; mapping.spec.mcp.gatewayUrl = endpoint.url;
  const config = parseAgentConfigMapping(mapping);
  const client = ModelClient.platform(config, { connectionId: 'mc-1', connectionName: 'test-mc', modelId: 'm-1', modelName: 'custom-model',
    protocol: 'OpenAI/v1', providerType: 'custom', maxTokens: 1024, capabilities: {} }); cleanup.push(() => client.close());
  const mcp = MCPClient.platform(config, { name: 'test-mcp', mcpServerId: 'mcp-1', protocol: 'SSE', type: 'CUSTOM', status: 'RUNNING' }); cleanup.push(() => mcp.close());
  const directory = await mkdtemp(join(tmpdir(), 'agentcore-chain-skill-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'SKILL.md'), '---\nname: guide\ndescription: City guide\n---\nRead note.txt for the guide.\n');
  await writeFile(join(directory, 'note.txt'), 'Use the MCP timezone result.');
  const core = new AgentCore({ workspaceId: 'ws', regionId: 'cn-hangzhou', controlPlaneEndpoint: endpoint.url,
    accessKeyCredential: new AccessKeyCredential({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }) }); cleanup.push(() => core.close());
  const canonicalTools = await mcp.listTools(), skills = await new Skills().local(directory);
  let invoke: InvokeHandler;
  if (framework === 'langchain') {
    const agent = createAgent({ model: await model(client), tools: [...tools(canonicalTools), ...skillTools(skills)],
      middleware: [agentCoreMemoryMiddleware(core.memoryStore('test-memory'), {
        scopeResolver: () => ({ read: { agentId: 'agent' }, write: { agentId: 'agent', sessionId: 'session' } }), writeBack: true,
      })],
    });
    invoke = async function* (request) {
      const input = request.messages.at(-1)!.content as string;
      const converter = new AgentCoreConverter();
      for await (const event of agent.streamEvents({ messages: [new HumanMessage(input)] }, { version: 'v2', signal: request.signal })) {
        yield* converter.convert(event);
      }
    };
  } else if (framework === 'mastra') {
    const memory = new mastra.AgentCoreMemoryProcessor(core.memoryStore('test-memory'), {
      scopeResolver: () => ({ read: { agentId: 'agent' }, write: { agentId: 'agent', sessionId: 'session' } }), writeBack: true,
    });
    const agent = new MastraAgent({ id: 'agent', name: 'agent', instructions: 'Use the tools', model: await mastra.model(client),
      tools: { ...mastra.tools(canonicalTools), ...mastra.skillTools(skills) }, inputProcessors: [memory], outputProcessors: [memory] });
    invoke = async function* (request) {
      const output = await agent.stream(request.messages.at(-1)!.content as string, { abortSignal: request.signal, maxSteps: 5, modelSettings: { maxRetries: 0 } });
      const converter = new mastra.AgentCoreConverter();
      for await (const part of output.fullStream) {
        yield* converter.convert(part);
      }
    };
  } else {
    const memory = new adk.AgentCoreMemoryService(core.memoryStore('test-memory'), { partitionResolver: () => 'agent' });
    const agent = new LlmAgent({ name: 'agent', model: await adk.model(client), tools: [PRELOAD_MEMORY, ...adk.tools(canonicalTools), ...adk.skillTools(skills)] });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({ appName: 'app', agent, sessionService, memoryService: memory });
    await sessionService.createSession({ appName: 'app', userId: 'user', sessionId: 'session' });
    invoke = async function* (request) {
      const converter = new adk.AgentCoreConverter();
      for await (const event of runner.runAsync({ userId: 'user', sessionId: 'session', newMessage: { role: 'user', parts: [{ text: request.messages.at(-1)!.content as string }] },
        runConfig: { streamingMode: StreamingMode.SSE }, abortSignal: request.signal })) {
        yield* converter.convert(event);
      }
      await memory.addSessionToMemory((await sessionService.getSession({ appName: 'app', userId: 'user', sessionId: 'session' }))!);
    };
  }
  const application = new AgentCoreServer({ invoke }); cleanup.push(() => application.close());
  const url = await application.start({ port: 0, hostname: '127.0.0.1' });
  const payload = protocol === 'agui' ? { threadId: 'thread', runId: 'run', messages: [{ id: 'user', role: 'user', content: '杭州时区？' }],
    tools: [], context: [], state: {}, forwardedProps: {} } : { model: 'application', messages: [{ role: 'user', content: '杭州时区？' }], stream: true };
  const response = await fetch(url + (protocol === 'agui' ? '/ag-ui/agent' : '/openai/v1/chat/completions'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  const wire = await response.text(); const data = wire.split('\n').filter(line => line.startsWith('data: ') && !line.endsWith('[DONE]')).map(line => JSON.parse(line.slice(6)));
  if (protocol === 'agui') {
    data.forEach(event => EventSchemas.parse(event));
    expect(data.at(-1).type).toBe('RUN_FINISHED');
    expect(data.filter(e => e.type === 'TEXT_MESSAGE_CONTENT').map(e => e.delta).join('')).toBe('先查询时区。杭州位于 Asia/Shanghai。');
    const starts = data.filter(e => e.type === 'TEXT_MESSAGE_START');
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map(e => e.messageId)).size).toBe(2);
    expect(data.filter(e => e.type === 'TEXT_MESSAGE_END').map(e => e.messageId)).toEqual(starts.map(e => e.messageId));
    const calls = data.filter(e => e.type === 'TOOL_CALL_START'), results = data.filter(e => e.type === 'TOOL_CALL_RESULT');
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);
    expect(results.map(e => e.toolCallId).sort()).toEqual(calls.map(e => e.toolCallId).sort());
    for (const result of results) expect(data.indexOf(result)).toBeGreaterThan(data.findIndex(e => e.type === 'TOOL_CALL_START' && e.toolCallId === result.toolCallId));
    expect(data.indexOf(starts[1])).toBeGreaterThan(data.indexOf(results.at(-1)));
  } else {
    expect(data.map(e => e.choices?.[0]?.delta?.content ?? '').join('')).toBe('先查询时区。杭州位于 Asia/Shanghai。');
    expect(data.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []).filter(e => e.id)).toHaveLength(3);
    expect(wire).toContain('data: [DONE]');
  }
  expect(modelRequests).toHaveLength(3); expect(mcpCalls).toEqual([{ city: '杭州' }]); expect(sessions.size).toBe(1);
  expect(auth.every(entry => entry.value === 'Bearer consumer-secret')).toBe(true);
  expect(modelRequests[0]!.tools.map((t: any) => t.function.name)).toEqual(['timezone', 'load_skills', 'read_skill_file', 'execute_command']);
  expect(JSON.stringify(modelRequests[0]!.messages)).toContain('User prefers concise answers');
  expect(JSON.stringify(modelRequests[1]!.messages)).toContain('Read note.txt');
  expect(JSON.stringify(modelRequests[2]!.messages)).toContain('Use the MCP timezone result.');
  expect(memoryRequests.map(r => r.action)).toEqual([...(framework === 'google-adk' ? ['SearchMemories', 'SearchMemories', 'SearchMemories'] : ['SearchMemories']), 'AddMemories']);
  expect(memoryRequests.at(-1)!.body.messages).toEqual([{ role: 'user', content: '杭州时区？' }, { role: 'assistant', content: '杭州位于 Asia/Shanghai。' }]);
});
