import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { END, START, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AgentCore } from 'alibabacloud-agentcore-sdk';
import { model, tools, skillTools } from 'alibabacloud-agentcore-sdk/integrations/langgraph';

const core = AgentCore.auto({ logger: console });
try {
  const client = await core.model('test-mc', { model: 'qwen3.8-max' });
  const mcp = await core.mcp('test-mcp');
  const skill = await core.skills.managed('test-skill');
  const selected = [...tools(await mcp.listTools()), ...skillTools([skill])];
  const chat = (await model(client)).bindTools(selected);
  const agent = new StateGraph(MessagesAnnotation)
    .addNode('model', async (state) => ({ messages: [await chat.invoke(state.messages)] }))
    .addNode('tools', new ToolNode(selected))
    .addEdge(START, 'model')
    .addConditionalEdges('model', state => {
      const reply = state.messages.at(-1);
      return AIMessage.isInstance(reply) && reply.tool_calls?.length ? 'tools' : END;
    })
    .addEdge('tools', 'model')
    .compile();
  const result = await agent.invoke({
    messages: [new HumanMessage('加载可用 Skill，按其说明完成一个示范。')],
  });
  console.log(result.messages.at(-1)?.content);
} finally {
  await core.close();
}
