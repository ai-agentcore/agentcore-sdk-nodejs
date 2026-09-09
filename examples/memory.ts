import { AgentCore } from '../src';

const core = AgentCore.auto();
try {
  const store = core.memoryStore('test-memory');
  await store.addMemories({
    scope: { userId: 'example-user', sessionId: 'session-1' },
    text: '用户喜欢简短的中文回答。',
  });

  // Newly added memories may take time to become searchable.
  const result = await store.searchMemories('用户有哪些回答偏好？', {
    scope: { userId: 'example-user' },
    topK: 5,
  });
  for (const hit of result.memories) {
    console.log(hit.memory.content.text);
  }
} finally {
  await core.close();
}
