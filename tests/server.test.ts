import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { Hono } from 'hono';
import { EventSchemas } from '@ag-ui/core';
import { AgentCoreServer, AgentEvent, EventType, OpenAIProtocolHandler, type InvokeHandler, type ProtocolHandler } from '../src/server';
import { currentContext } from '../src/runtime/context';
import { withHeartbeat } from '../src/server/sse';
import { ConfigError } from '../src/errors';

const servers: AgentCoreServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function start(invoke?: InvokeHandler) {
  const server = new AgentCoreServer({ invoke }); servers.push(server);
  return { server, url: await server.start({ port: 0, hostname: '127.0.0.1' }) };
}
describe('AgentCore Server real HTTP', () => {
  it('serves OpenAI JSON and streams through the official client with ordinary header context', async () => {
    const { url } = await start(async function* (request, context) {
      expect(request.protocol).toBe('openai');
      expect(context).toBe(currentContext());
      expect(context.headers['x-agentcore-session-id']).toBe('header-session');
      yield 'hello '; await Promise.resolve();
      expect(currentContext()).toBe(context);
      yield 'world';
    });
    const client = new OpenAI({ baseURL: url + '/openai/v1', apiKey: 'test', maxRetries: 0,
      defaultHeaders: { 'X-AgentCore-Session-ID': 'header-session' } });
    const args = { model: 'application-model', messages: [{ role: 'user' as const, content: 'hello' }] };
    const result = await client.chat.completions.create(args);
    expect(result.model).toBe('application-model');
    expect(result.choices[0]?.message.content).toBe('hello world');
    const chunks = [];
    for await (const chunk of await client.chat.completions.create({ ...args, stream: true })) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.choices[0]?.delta.content ?? '').join('')).toBe('hello world');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect((await client.models.list()).data[0]?.id).toBe('agentcore');
    expect(currentContext(false)).toBeUndefined();
  });
  it('emits AG-UI reasoning, text, tool and run lifecycle events', async () => {
    const { url } = await start(async function* () {
      yield new AgentEvent(EventType.REASONING, { delta: 'think' });
      yield 'using tool';
      yield new AgentEvent(EventType.TOOL_CALL, { id: 'call-1', name: 'echo', args: { text: 'hi' } });
      yield new AgentEvent(EventType.TOOL_RESULT, { id: 'call-1', result: 'hi' });
      yield 'done';
    });
    const response = await fetch(url + '/ag-ui/agent', { method: 'POST', body: JSON.stringify({
      threadId: 'thread-1', runId: 'run-1', messages: [], tools: [], context: [], state: {}, forwardedProps: {},
    }) });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await response.text()).split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    for (const event of events) {
      expect(EventSchemas.parse(event)).toBeDefined();
    }
    expect(events[0]).toMatchObject({ type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' });
    expect(events.map(event => event.type)).toEqual([
      'RUN_STARTED', 'REASONING_START', 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END', 'REASONING_END', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
    ]);
  });

  it('has independent health/readiness, startup/shutdown and no runtime/YAML requirement', async () => {
    const calls: string[] = [];
    const server = new AgentCoreServer({ startup: () => { calls.push('start'); }, shutdown: () => { calls.push('stop'); } });
    servers.push(server);
    const [url, same] = await Promise.all([server.start({ port: 0, hostname: '127.0.0.1' }), server.start()]);
    expect(same).toBe(url);
    expect((await fetch(url + '/healthz')).status).toBe(200);
    expect((await fetch(url + '/readyz')).status).toBe(503);
    expect((await fetch(url + '/ag-ui/agent', { method: 'POST', body: '{}' })).status).toBe(503);
    server.invoke(() => 'ready');
    expect((await fetch(url + '/readyz')).status).toBe(200);
    await Promise.all([server.close(), server.close()]);
    expect(calls).toEqual(['start', 'stop']);
    await expect(server.start()).rejects.toThrow('closed');
  });

  it('cleans up successful startup on port binding failure and can retry startup', async () => {
    const occupied = await start(() => 'occupied');
    const calls: string[] = [];
    const server = new AgentCoreServer({ startup: () => { calls.push('start'); }, shutdown: () => { calls.push('stop'); } });
    servers.push(server);
    await expect(server.start({ port: Number(new URL(occupied.url).port), hostname: '127.0.0.1' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(calls).toEqual(['start', 'stop']);
    await server.start({ port: 0, hostname: '127.0.0.1' });
    await server.close();
    expect(calls).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('does not listen on startup failure, and reports failed readiness as unavailable', async () => {
    const startup = vi.fn().mockRejectedValueOnce(new Error('not configured')).mockResolvedValue(undefined);
    const server = new AgentCoreServer({ startup, readiness: () => { throw new Error('unready'); } });
    servers.push(server);
    await expect(server.start({ port: 0, hostname: '127.0.0.1' })).rejects.toThrow('not configured');
    const url = await server.start({ port: 0, hostname: '127.0.0.1' });
    expect((await fetch(url + '/readyz')).status).toBe(503);
    expect((await fetch(url + '/healthz')).status).toBe(200);
  });

  it('maps OpenAI tools, multipart messages and raw model without using payload session as a header', async () => {
    const { url } = await start(request => {
      expect(request.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
      expect(request.messages[1]?.toolCalls?.[0]).toMatchObject({ id: 'old-call', function: { name: 'echo' } });
      expect(request.tools).toEqual([{ name: 'echo', description: '', parameters: {} }]);
      expect(currentContext()?.headers['x-agentcore-session-id']).toBeUndefined();
      expect(request.rawPayload.model).toBe('application-choice');
      return [new AgentEvent(EventType.REASONING, { delta: 'think' }),
        new AgentEvent(EventType.TOOL_CALL_CHUNK, { id: 'c', name: 'echo', args_delta: '{"x":' }),
        new AgentEvent(EventType.TOOL_CALL_CHUNK, { id: 'c', args_delta: '1}' })];
    });
    const response = await fetch(url + '/openai/v1/chat/completions', { method: 'POST', body: JSON.stringify({
      model: 'application-choice', sessionId: 'not-a-header', messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', tool_calls: [{ id: 'old-call', function: { name: 'echo' } }] },
      ], tools: [{ type: 'function', function: { name: 'echo' } }],
    }) });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: {
      reasoning_content: 'think', content: null, tool_calls: [{ id: 'c', function: { name: 'echo', arguments: '{"x":1}' } }],
    } });
  });

  it.each(['/openai/v1/chat/completions', '/ag-ui/agent'])('rejects malformed %s inputs before invocation', async path => {
    const invoke = vi.fn(() => 'must not run');
    const { url } = await start(invoke);
    for (const body of ['{', 'null', '{"messages":{}}']) {
      const response = await fetch(url + path, { method: 'POST', body });
      const text = await response.text();
      if (path.startsWith('/openai')) expect(response.status).toBe(400);
      else expect(text).toContain('RUN_ERROR');
      expect(text).not.toContain('RUN_STARTED');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports handler errors safely in JSON and both SSE protocols, with local stack logs', async () => {
    const error = vi.fn();
    const server = new AgentCoreServer({ logger: { debug() {}, info() {}, warn() {}, error }, invoke: () => { throw new Error('local detail'); } });
    servers.push(server);
    const url = await server.start({ port: 0, hostname: '127.0.0.1' });
    const json = await fetch(url + '/openai/v1/chat/completions', { method: 'POST', body: '{"messages":[]}' });
    expect(json.status).toBe(500);
    expect(await json.text()).not.toContain('local detail');
    for (const [path, body] of [
      ['/openai/v1/chat/completions', { messages: [], stream: true }],
      ['/ag-ui/agent', { threadId: 't', runId: 'r', messages: [], tools: [], context: [], state: {}, forwardedProps: {} }],
    ] as const) {
      const response = await fetch(url + path, { method: 'POST', headers: { 'x-request-id': 'req-id' }, body: JSON.stringify(body) });
      const text = await response.text();
      expect(text).toContain('handler failed');
      expect(text).not.toContain('local detail');
      expect(text).not.toContain('RUN_FINISHED');
      expect(text).not.toContain('"finish_reason":"stop"');
    }
    expect(error.mock.calls.some(call => call[1]?.stack?.includes('local detail') && call[1]?.requestId === 'req-id')).toBe(true);
  });

  it.each(['/openai/v1/chat/completions', '/ag-ui/agent'])('cancels %s work and closes the user iterator on client disconnect', async path => {
    let entered!: () => void, cleaned!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finished = new Promise<void>(resolve => { cleaned = resolve; });
    const { url } = await start(async function* (request) {
      try {
        entered();
        await new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
        yield 'not reached';
      } finally { cleaned(); }
    });
    const controller = new AbortController();
    const response = await fetch(url + path, { method: 'POST', signal: controller.signal,
      body: JSON.stringify({ stream: true, messages: [], threadId: 't', runId: 'r', state: {}, tools: [], context: [], forwardedProps: {} }) });
    const reader = response.body!.getReader();
    await reader.read(); await started;
    controller.abort();
    await finished;
    await reader.cancel().catch(() => undefined);
  });

  it('isolates concurrent request context across asynchronous iterator resumes', async () => {
    const { url } = await start(async function* (_request, context) {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(currentContext()).toBe(context);
      yield context.headers['x-user']!;
      await Promise.resolve();
      expect(currentContext()).toBe(context);
    });
    const result = await Promise.all(['alice', 'bob'].map(async user => {
      const response = await fetch(url + '/openai/v1/chat/completions', { method: 'POST', headers: { 'x-user': user }, body: '{"messages":[]}' });
      return (await response.json()).choices[0].message.content;
    }));
    expect(result).toEqual(['alice', 'bob']);
  });

  it('mounts custom protocol routes and custom OpenAI prefix through the same invoker', async () => {
    const custom: ProtocolHandler = { name: 'custom', routes(invoker) {
      const app = new Hono();
      app.post('/custom', async c => c.json(await invoker.invoke({ protocol: 'custom', messages: [], stream: false,
        rawRequest: c.req.raw, rawPayload: {}, signal: c.req.raw.signal })));
      return app;
    } };
    const server = new AgentCoreServer({ protocols: [custom, new OpenAIProtocolHandler('/v1', 'my-agent')], invoke: request => request.protocol });
    servers.push(server);
    const url = await server.start({ port: 0, hostname: '127.0.0.1' });
    expect(await (await fetch(url + '/custom', { method: 'POST' })).json()).toEqual([{ type: 'TEXT', delta: 'custom' }]);
    expect((await (await fetch(url + '/v1/models')).json()).data[0].id).toBe('my-agent');
    expect((await fetch(url + '/ag-ui/agent', { method: 'POST' })).status).toBe(404);
  });

  it('maps explicit configuration errors to OpenAI 400', async () => {
    const { url } = await start(() => { throw new ConfigError('bad config'); });
    const response = await fetch(url + '/openai/v1/chat/completions', { method: 'POST', body: '{"messages":[]}' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('CONFIG_INVALID');
  });

  it('both actual HTTP streams send an idle heartbeat after 15 seconds and resume normally', async () => {
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const { url } = await start(async function* () { await waiting; yield 'resumed'; });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      await Promise.all(['/openai/v1/chat/completions', '/ag-ui/agent'].map(async path => {
        const response = await fetch(url + path, { method: 'POST', body: JSON.stringify({ messages: [], stream: true,
          threadId: 't', runId: 'r', state: {}, tools: [], context: [], forwardedProps: {},
        }) });
        const reader = response.body!.getReader(); readers.push(reader);
        let text = new TextDecoder().decode((await reader.read()).value);
        const started = Date.now();
        while (!text.includes(': ping\n\n')) text += new TextDecoder().decode((await reader.read()).value);
        expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
      }));
      resume();
      for (const reader of readers) {
        let text = '';
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
        expect(text).toContain('resumed');
      }
    } finally { resume(); await Promise.all(readers.map(reader => reader.cancel())); }
  }, 20_000);
});

it('SSE heartbeat waits 15 seconds without creating concurrent iterator pulls', async () => {
  vi.useFakeTimers();
  let resolve!: (value: IteratorResult<string>) => void;
  const next = vi.fn(() => new Promise<IteratorResult<string>>(done => { resolve = done; }));
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const stream = withHeartbeat({ [Symbol.asyncIterator]: () => ({ next, return: close }) });
  try {
    const first = stream.next();
    await vi.advanceTimersByTimeAsync(14_999); expect(next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect((await first).value).toBe(': ping\n\n');
    const second = stream.next();
    await vi.advanceTimersByTimeAsync(15_000); expect((await second).value).toBe(': ping\n\n');
    expect(next).toHaveBeenCalledTimes(1);
    resolve({ done: false, value: 'data: hello\n\n' });
    expect((await stream.next()).value).toBe('data: hello\n\n');
    await stream.return(undefined); expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
