import { createEvent, createSession } from '@google/adk';
import { expect, it, vi } from 'vitest';
import { MemoryValidationError } from '../src';
import { recallMemory, recordMemory } from '../src/integrations/memory/common';
import { AgentCoreMemoryService } from '../src/integrations/google-adk';
import { setup } from './context-memory-helpers';

it('checks individual receipts, logs request IDs and never retries partial writes', async () => {
  let calls = 0;
  const { client, logger } = await setup(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    calls++;
    res.setHeader('x-acs-request-id', 'partial-request');
    res.end(JSON.stringify({ success: true, data: { results: [
      { inputIndex: 0, status: 'STORED', eventId: 'e1' },
      { inputIndex: 1, status: 'REJECTED', code: 'PolicyDenied', message: 'Write rejected' },
    ] } }));
  });
  const messages = [{ role: 'user' as const, content: 'q' }, { role: 'assistant' as const, content: 'a' }];
  await expect(recordMemory(client, messages, { teamId: 'team' })).rejects.toMatchObject({ requestId: 'partial-request', serviceCode: 'PolicyDenied' });
  expect(calls).toBe(1);
  await recordMemory(client, messages, { teamId: 'team' }, { bestEffort: true, logger });
  expect(calls).toBe(2);
  expect(logger.warn).toHaveBeenCalledWith('agentcore.memory.adapter.write.failed', expect.objectContaining({ upstream_request_id: 'partial-request', api_operation: 'CreateEvents' }));
  expect(logger.info).not.toHaveBeenCalledWith('agentcore.memory.adapter.events.stored', expect.anything());
});

it('batches explicit imports at 100 events and keeps concurrent scopes separate', async () => {
  const writes: any[] = [];
  const { client } = await setup(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(new URLSearchParams(raw).get('body')!);
    if (req.headers['x-acs-action'] === 'SearchMemories') {
      res.end(JSON.stringify({ success: true, data: { memories: [{ memory: {
        memoryId: 'm', content: { text: `fact-${body.scope.userId}` }, scope: body.scope,
      }, score: 1, similarity: 1 }] } }));
    } else {
      writes.push(body);
      res.end(JSON.stringify({ success: true, data: { results: body.events.map((_: unknown, inputIndex: number) => ({ inputIndex, status: 'STORED', eventId: `e${inputIndex}` })) } }));
    }
  });
  const results = await Promise.all(['alice', 'bob'].map(async userId => {
    const scope = { userId };
    const text = await recallMemory(client, 'q', scope, { topK: 100 });
    await recordMemory(client, Array.from({ length: 101 }, (_, i) => ({ role: 'user' as const, content: `${userId}-${i}` })), scope);
    return text;
  }));
  expect(results).toEqual(['fact-alice', 'fact-bob']);
  for (const user of ['alice', 'bob']) {
    const batches = writes.filter(w => w.scope.userId === user);
    expect(batches.map(w => w.events.length)).toEqual([100, 1]);
    expect(batches.flatMap(w => w.events.map((e: any) => e.data.content[0].text))).toEqual(Array.from({ length: 101 }, (_, i) => `${user}-${i}`));
  }
});

it('rejects unsupported ADK metadata before dispatch rather than dropping it', async () => {
  const handler = vi.fn();
  const { client } = await setup(handler);
  const memory = new AgentCoreMemoryService(client, { partitionResolver: () => 'agent' });
  await expect(memory.addEventsToMemory({ appName: 'app', userId: 'user', events: [], customMetadata: { key: 'value' } })).rejects.toBeInstanceOf(MemoryValidationError);
  expect(handler).not.toHaveBeenCalled();
});


it.each([false, true])('preserves ADK event timestamps (wholeSession=%s)', async wholeSession => {
  const writes: any[] = [];
  const { client } = await setup(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(new URLSearchParams(raw).get('body')!); writes.push(body);
    res.end(JSON.stringify({ success: true, data: { results: body.events.map((_: unknown, inputIndex: number) => ({ inputIndex, status: 'STORED', eventId: `e${inputIndex}` })) } }));
  });
  const memory = new AgentCoreMemoryService(client, { partitionResolver: () => 'a' });
  const events = [
    createEvent({ author: 'user', timestamp: 1609459200125, content: { role: 'user', parts: [{ text: 'question' }] } }),
    createEvent({ author: 'assistant', timestamp: 1609459201250, partial: true, content: { role: 'model', parts: [{ text: 'partial' }] } }),
    createEvent({ author: 'assistant', timestamp: 1609459202500, content: { role: 'model', parts: [{ text: 'answer' }] } }),
  ];
  if (wholeSession) await memory.addSessionToMemory(createSession({ appName: 'app', userId: 'u', id: 's', events }));
  else await memory.addEventsToMemory({ appName: 'app', userId: 'u', sessionId: 's', events });
  expect(writes).toHaveLength(1);
  expect(writes[0].scope).toEqual({ agentId: 'a', sessionId: 's' });
  expect(writes[0].events.map((e: any) => e.timestamp)).toEqual([1609459200125, 1609459202500]);
  expect(writes[0].events.map((e: any) => e.data.content[0].text)).toEqual(['question', 'answer']);
  expect(events.map(e => e.timestamp)).toEqual([1609459200125, 1609459201250, 1609459202500]);
});
