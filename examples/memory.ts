import { AgentCore } from 'alibabacloud-agentcore-sdk';

const core = AgentCore.auto();
try {
  const store = core.memoryStore('test-memory');
  const submission = await store.addMemories({
    scope: { userId: 'example-user', sessionId: 'session-1' },
    text: '用户喜欢简短的中文回答。',
  });

  console.log('Memory task:', submission.taskId);
  const task = await store.getMemoryTask(submission.taskId);
  console.log('Task status:', task.status);
  // To wait for extraction instead, pass sync: true to addMemories and read result.memoryIds.

  // Search existing memories; the submitted task may still be pending.
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
