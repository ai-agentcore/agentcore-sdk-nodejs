import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/auth/index.ts', 'src/runtime/index.ts', 'src/controlplane/index.ts', 'src/model/index.ts', 'src/mcp/index.ts', 'src/skill/index.ts', 'src/memory/index.ts', 'src/server/index.ts', 'src/collaboration/index.ts', 'src/integrations/langgraph.ts', 'src/integrations/langchain.ts', 'src/integrations/ai-sdk.ts', 'src/integrations/google-adk.ts', 'src/integrations/mastra.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  splitting: true,
  clean: true,
  target: 'node20',
});
