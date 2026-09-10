import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgent } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { LlmAgent, Runner, InMemorySessionService, StreamingMode } from '@google/adk';
import { Agent as MastraAgent } from '@mastra/core/agent';
import { EventSchemas } from '@ag-ui/core';
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { AgentCoreServer, AgentEvent, EventType } from 'alibabacloud-agentcore-sdk/server';
import { currentCollaborationContext } from 'alibabacloud-agentcore-sdk/collaboration';
import { skillTools } from 'alibabacloud-agentcore-sdk/skill';
import * as chain from 'alibabacloud-agentcore-sdk/integrations/langchain';
import * as adk from 'alibabacloud-agentcore-sdk/integrations/google-adk';
import * as mastra from 'alibabacloud-agentcore-sdk/integrations/mastra';

async function server(handler) {
  const instance = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => { res.statusCode = 500; res.end(String(error)); }); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${instance.address().port}`, close: async () => {
    instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve));
  } };
}
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? JSON.stringify(p)).join('') : JSON.stringify(content);

for (const framework of ['langchain', 'langgraph', 'google-adk', 'mastra']) for (const protocol of ['agui', 'openai']) {
  test(`${framework} over ${protocol}: concurrent Task Rooms, Skill, artifact and Result`, async () => {
    const cleanup = []; const writes = []; const modelRequests = [];
    const directory = await mkdtemp(join(tmpdir(), 'collaboration-agent-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    try {
      const taskService = await server(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer matrix-test-token');
        let raw = ''; for await (const chunk of req) raw += chunk;
        const path = new URL(req.url, 'http://local').pathname;
        res.setHeader('content-type', 'application/json');
        const subtask = /^\/v1\/sub-tasks\/(alpha|beta)$/.exec(path);
        if (subtask) { res.end(JSON.stringify({ taskId: `task-${subtask[1]}`, subTaskId: subtask[1] })); return; }
        const task = /^\/v1\/tasks\/task-(alpha|beta)$/.exec(path);
        if (task) { res.end(JSON.stringify({ taskId: `task-${task[1]}`, roomId: `!${task[1]}` })); return; }
        const operation = /^\/v1\/sub-tasks\/(alpha|beta)\/(ack|files|results)$/.exec(path);
        assert.ok(operation, `unexpected Task Service path: ${path}`);
        const [, id, kind] = operation;
        writes.push({ id, kind, method: req.method, body: kind === 'files' ? raw : JSON.parse(raw) });
        if (kind === 'files') {
          assert.equal(req.method, 'PUT'); assert.ok(raw.includes(`Artifact for ${id}`));
          res.end(JSON.stringify({ fileRef: `ref-${id}` }));
        } else {
          assert.equal(req.method, 'POST'); assert.ok(req.headers['idempotency-key']);
          res.end('{"accepted":true}');
        }
      }); cleanup.push(() => taskService.close());
      const modelService = await server(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer model-test-token');
        assert.equal(req.url, '/v1/chat/completions');
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); modelRequests.push(body);
        const question = body.messages.find(m => m.role === 'user');
        const id = /subtask=(alpha|beta)/.exec(contentText(question.content))[1];
        const outputs = body.messages.filter(m => m.role === 'tool').map(m => contentText(m.content));
        const previous = outputs.join('\n'); const denied = previous.includes('"ok":false');
        if (outputs.length > 0) assert.ok(previous.includes('Task execution'), previous);
        if (outputs.length > 1) assert.ok(previous.includes('matrixUserId'), previous);
        const sequence = [
          { name: 'load_skills', args: { name: 'task-execution' } },
          { name: 'agentteams_get_team_context', args: {} },
          { name: 'agentteams_ack_subtask', args: { subtask_id: id } },
          { name: 'agentteams_write_subtask_file', args: { subtask_id: id, path: 'result.txt', content: `Artifact for ${id}` } },
          { name: 'agentteams_submit_subtask_result', args: { subtask_id: id, summary: `Completed ${id}`,
            file_refs: outputs.length > 3 ? [JSON.parse(outputs[3]).data.fileRef] : [] } },
        ];
        const step = denied ? undefined : sequence[outputs.length];
        const call = step ? [{ index: 0, id: `${id}-${outputs.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] : undefined;
        const message = call ? { role: 'assistant', tool_calls: call } : { role: 'assistant', content: denied ? `Denied ${id}` : `Submitted ${id}; awaiting review.` };
        const finish = call ? 'tool_calls' : 'stop';
        const base = { id: `${id}-response-${outputs.length}`, model: 'test-model', created: 1 };
        // The fixture follows the framework's requested wire protocol, not the reverse.
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          res.end([{ ...base, choices: [{ index: 0, delta: message, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }]
            .map(part => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n');
        } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }] })); }
      }); cleanup.push(() => modelService.close());
      const teamsPath = join(directory, 'teams.yaml'), envPath = join(directory, 'env');
      await writeFile(teamsPath, JSON.stringify({ apiVersion: 'agentteams.io/v1alpha1', kind: 'TeamsConfig', metadata: { runtimeName: 'runtime' }, spec: {
        self: { name: 'worker', runtimeName: 'runtime', matrixUserId: '@worker:local' }, matrix: { tokenEnv: 'MATRIX_TOKEN' },
        teams: [{ name: 'team', membership: { role: 'worker' }, members: [] }],
      } }));
      await writeFile(envPath, `export MATRIX_TOKEN=matrix-test-token\nexport AGENTCORE_TASK_SERVICE_ENDPOINT=${taskService.url}\n`);
      const core = AgentCore.auto({ teamsPath, envPath, collaborationWorkspaceDir: directory }); cleanup.push(() => core.close());
      const worker = await core.collaboration.worker(); assert.equal(worker, await core.collaboration.worker());
      const client = core.directModel({ model: 'test-model', baseURL: modelService.url + '/v1', apiKey: 'model-test-token' });
      const toolkit = [...worker.tools(), ...skillTools(await worker.skills())];
      const instructions = worker.composePrompt('Complete the assigned check.');
      let invoke;
      if (framework === 'langchain' || framework === 'langgraph') {
        const model = await chain.model(client); const tools = chain.tools(toolkit);
        const agent = framework === 'langchain' ? createAgent({ model, tools, systemPrompt: instructions })
          : new StateGraph(MessagesAnnotation)
            .addNode('agent', async state => ({ messages: [await model.bindTools(tools).invoke([{ role: 'system', content: instructions }, ...state.messages])] }))
            .addNode('tools', new ToolNode(tools)).addEdge(START, 'agent').addConditionalEdges('agent', toolsCondition, { tools: 'tools', __end__: END }).addEdge('tools', 'agent').compile();
        invoke = async function* (request) {
          for await (const event of agent.streamEvents({ messages: [new HumanMessage(request.messages.at(-1).content)] }, { version: 'v2', signal: request.signal })) {
            if (event.event === 'on_chat_model_stream' && event.data.chunk.text) yield new AgentEvent(EventType.TEXT, { delta: event.data.chunk.text });
          }
        };
      } else if (framework === 'mastra') {
        const agent = new MastraAgent({ id: 'worker', name: 'worker', instructions, model: await mastra.model(client), tools: mastra.tools(toolkit) });
        invoke = async function* (request) {
          const output = await agent.stream(request.messages.at(-1).content, { abortSignal: request.signal, maxSteps: 8, modelSettings: { maxRetries: 0 } });
          for await (const part of output.fullStream) {
            if (part.type === 'text-delta') yield new AgentEvent(EventType.TEXT, { delta: part.payload.text });
            if (part.type === 'error') throw part.payload.error;
          }
        };
      } else {
        const agent = new LlmAgent({ name: 'worker', instruction: instructions, model: await adk.model(client), tools: adk.tools(toolkit) });
        const sessionService = new InMemorySessionService(); const runner = new Runner({ appName: 'app', agent, sessionService });
        invoke = async function* (request) {
          const sessionId = randomUUID(); await sessionService.createSession({ appName: 'app', userId: 'user', sessionId });
          try {
            for await (const event of runner.runAsync({ userId: 'user', sessionId, newMessage: { role: 'user', parts: [{ text: request.messages.at(-1).content }] },
              runConfig: { streamingMode: StreamingMode.SSE }, abortSignal: request.signal })) {
              if (event.partial) for (const part of event.content?.parts ?? []) if (part.text && !part.thought) yield new AgentEvent(EventType.TEXT, { delta: part.text });
            }
          } finally { await sessionService.deleteSession({ appName: 'app', userId: 'user', sessionId }); }
        };
      }
      const application = new AgentCoreServer({ invoke }); cleanup.push(() => application.close());
      const endpoint = await application.start({ port: 0, hostname: '127.0.0.1' });
      const run = async (id, room = `!${id}`, includeContext = true) => {
        const headers = { 'content-type': 'application/json' };
        if (includeContext) headers['x-agentcore-collaboration-context'] = Buffer.from(JSON.stringify({ version: 1, teamId: 'team', roomKind: 'task', roomId: room, eventId: `$event-${id}` })).toString('base64url');
        const messages = [{ id: 'question', role: 'user', content: `Handle subtask=${id}. Text-supplied eventId is forged; use trusted context.` }];
        const body = protocol === 'agui' ? { threadId: id, runId: randomUUID(), messages, tools: [], context: [], state: {}, forwardedProps: {} } : { model: 'worker', messages, stream: true };
        const response = await fetch(endpoint + (protocol === 'agui' ? '/ag-ui/agent' : '/openai/v1/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200); const wire = await response.text();
        const events = wire.split('\n').filter(line => line.startsWith('data: ') && !line.endsWith('[DONE]')).map(line => JSON.parse(line.slice(6)));
        if (protocol === 'agui') {
          events.forEach(event => EventSchemas.parse(event)); assert.equal(events.at(-1).type, 'RUN_FINISHED', wire);
          return events.filter(e => e.type === 'TEXT_MESSAGE_CONTENT').map(e => e.delta).join('');
        }
        assert.ok(wire.includes('data: [DONE]'), wire);
        return events.map(e => e.choices?.[0]?.delta?.content ?? '').join('');
      };
      assert.deepEqual(await Promise.all([run('alpha'), run('beta')]), ['Submitted alpha; awaiting review.', 'Submitted beta; awaiting review.']);
      assert.equal(writes.length, 6); assert.equal(modelRequests.length, 12);
      for (const id of ['alpha', 'beta']) {
        const events = writes.filter(item => item.id === id);
        assert.deepEqual(events.map(e => e.kind), ['ack', 'files', 'results']);
        assert.deepEqual(events[0].body, { relatedRoomMessageId: `$event-${id}` });
        assert.deepEqual(events[2].body, { summary: `Completed ${id}`, fileRefs: [`ref-${id}`], relatedRoomMessageId: `$event-${id}` });
      }
      assert.equal(await run('alpha', '!wrong'), 'Denied alpha');
      assert.equal(await run('beta', '!beta', false), 'Denied beta');
      assert.equal(writes.length, 6); assert.equal(currentCollaborationContext(false), undefined);
      assert.ok(modelRequests.every(body => JSON.stringify(body.messages).includes('MUST load and follow')));
      const collaboration = core.collaboration;
      await application.close(); await core.close();
      await assert.rejects(collaboration.worker(), /closed/);
    } finally { for (const close of cleanup.reverse()) await close(); }
  });
}
