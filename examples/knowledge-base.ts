import { AgentCore } from 'alibabacloud-agentcore-sdk';

const core = AgentCore.auto();
try {
  const kb = core.knowledgeBase('你的知识库 ID');
  const result = await kb.search('产品如何配置？', { topK: 5 });
  for (const chunk of result.chunks) {
    console.log(chunk.fileName ?? chunk.assetName, chunk.content);
  }
} finally {
  await core.close();
}
