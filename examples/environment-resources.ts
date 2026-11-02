/** Set the resource-selection environment variables documented in README before starting. */
import { AgentCore } from 'alibabacloud-agentcore-sdk';

const core = AgentCore.auto();
try {
  const model = await core.model();
  const mcps = await core.mcpsFromEnv();
  const skills = await core.skills.fromEnv();
  const template = await core.templates.get();

  console.log('Model:', model.descriptor?.modelName);
  for (const mcp of mcps) console.log('MCP tools:', (await mcp.listTools()).map(tool => tool.name));
  console.log('Skills:', skills.map(skill => skill.name));
  console.log('AgentSpec:', template.name, template.version);
  // Load AgentSpec Skills explicitly when needed:
  // const templateSkills = await template.loadSkills();
  // Pass these resources to the corresponding framework adapters.
} finally {
  await core.close();
}
