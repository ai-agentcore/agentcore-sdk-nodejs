import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { CollaborationContextError, CollaborationContextRequiredError, bindCollaborationContext, currentCollaborationContext, parseCollaborationContext } from '../src/collaboration';
import { AgentCoreServer, AgentEvent, EventType } from '../src/server';

const payload = { version: 1, teamId: 'team-a', roomKind: 'task', roomId: '!task:server', eventId: '$event' };
const headers = (data: unknown = payload) => ({ 'X-AgentCore-Collaboration-Context': Buffer.from(JSON.stringify(data)).toString('base64url'), 'X-AgentCore-Session-ID': 'session' });

it('parses the existing context contract, ignores future fields, and redacts routing metadata', () => {
  const value = parseCollaborationContext(headers({ ...payload, future: 'ignored' }))!;
  expect(value.teamId).toBe('team-a'); expect(value.roomId).toBe('!task:server'); expect(value.eventId).toBe('$event'); expect(value.sessionId).toBe('session');
  expect(JSON.stringify(value)).not.toContain('$event'); expect(inspect(value)).not.toContain('!task');
  expect(Object.isFrozen(value)).toBe(true); expect(parseCollaborationContext({})).toBeUndefined();
  expect(parseCollaborationContext(headers({ version: 1, roomKind: 'dm', roomId: '!dm', eventId: '$e' }))!.teamId).toBeUndefined();
});
it.each([{}, { ...payload, version: 2 }, { ...payload, teamId: null }, { ...payload, roomKind: 'other' }, { ...payload, roomId: '' }, { ...payload, eventId: 'a'.repeat(1025) }])('rejects invalid collaboration metadata %j', value => {
  expect(() => parseCollaborationContext(headers(value))).toThrow(CollaborationContextError);
});
it.each(['', '%secret', 'abcd\n', 'a', 'a'.repeat(8193), Buffer.from([0xff]).toString('base64')])('rejects invalid encoded metadata without echoing it', encoded => {
  expect(() => parseCollaborationContext({ 'x-agentcore-collaboration-context': encoded })).toThrow('collaboration context header is invalid');
});
it('isolates nested and concurrent request contexts and restores after failure', async () => {
  await Promise.all(['a', 'b'].map(eventId => bindCollaborationContext(headers({ ...payload, eventId }), async () => {
    await new Promise(resolve => setTimeout(resolve, 5)); expect(currentCollaborationContext().eventId).toBe(eventId);
    expect(() => bindCollaborationContext({}, () => currentCollaborationContext())).toThrow(CollaborationContextRequiredError);
    expect(currentCollaborationContext().eventId).toBe(eventId);
  })));
  expect(currentCollaborationContext(false)).toBeUndefined(); expect(() => currentCollaborationContext()).toThrow(CollaborationContextRequiredError);
});
it.each(['agui', 'openai'])('binds collaboration through the %s HTTP handler and async iterator', async protocol => {
  const observed: string[] = []; let invoked = 0;
  const server = new AgentCoreServer({ invoke: async function* () {
    invoked++;
    try {
      const event = currentCollaborationContext().eventId;
      await new Promise(resolve => setTimeout(resolve, 5)); expect(currentCollaborationContext().eventId).toBe(event);
      observed.push(event); yield new AgentEvent(EventType.TEXT, { delta: event });
    } finally { observed.push('closed:' + currentCollaborationContext().eventId); }
  } });
  const url = await server.start({ hostname: '127.0.0.1', port: 0 });
  try {
    const body = protocol === 'agui' ? { threadId: 'session', runId: 'run', messages: [], tools: [], context: [], state: {}, forwardedProps: {} } : { messages: [], stream: true };
    const endpoint = url + (protocol === 'agui' ? '/ag-ui/agent' : '/openai/v1/chat/completions');
    await Promise.all(['one', 'two'].map(async eventId => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers({ ...payload, eventId }) }, body: JSON.stringify(body) });
      expect(await response.text()).toContain(eventId);
    }));
    expect(observed.sort()).toEqual(['closed:one', 'closed:two', 'one', 'two']);
    const invalid = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers({ ...payload, version: 9 }) }, body: JSON.stringify(body) });
    expect(await invalid.text()).toContain('COLLABORATION_CONTEXT_INVALID'); expect(invoked).toBe(2);
  } finally { await server.close(); }
  expect(currentCollaborationContext(false)).toBeUndefined();
});
