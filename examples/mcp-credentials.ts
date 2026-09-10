import { AgentCore } from 'alibabacloud-agentcore-sdk';

// Run in AgentCore with a named MCP Header credential allowed for test-mcp.
const core = AgentCore.auto();
try {
  const mcp = await core.mcp('test-mcp', {
    credentialName: 'my-mcp-credential',
    headers: { 'x-business-id': 'example-app' },
  });
  console.log('MCP tools:', (await mcp.listTools()).map(tool => tool.name));
  // Framework adapters reuse this client's fixed headers for tool calls.

  // Explicit retrieval is also available. Do not log credential.value or headers.
  const credential = await core.credentials.get('my-mcp-credential');
  const headers = credential.asHeaders(); // Only mcpHeader credentials support this method.
  console.log('Header names:', Object.keys(headers));
  // For apiKey credentials, use credential.value; it remains a string.
} finally {
  await core.close();
}
