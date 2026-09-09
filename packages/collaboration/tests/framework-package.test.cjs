const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, cpSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

test('packed Core and collaboration addon execute all framework/protocol combinations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentcore-collaboration-framework-'));
  const environment = { ...process.env };
  // The independent test runner must not inherit the parent's V8 reporter channel.
  delete environment.NODE_TEST_CONTEXT;
  const run = (command, args, cwd = directory) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: environment });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  };
  try {
    const pack = cwd => JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], cwd))[0].filename;
    const core = pack(resolve('../..')), addon = pack(process.cwd());
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, core), join(directory, addon),
      'langchain@1.5.10', '@langchain/core@1.2.9', '@langchain/langgraph@1.4.14', '@langchain/openai@1.5.11',
      '@google/adk@2.0.0', '@google/genai@2.21.0', '@mastra/core@1.64.0', 'ai@6.0.277',
      '@ai-sdk/provider@3.0.15', '@ai-sdk/openai@3.0.109', '@ai-sdk/anthropic@3.0.116', '@ai-sdk/openai-compatible@2.0.74', 'zod@4.5.4']);
    cpSync(join(process.cwd(), 'tests/fixtures/framework-agent.mjs'), join(directory, 'framework-agent.mjs'));
    const output = run(process.execPath, ['--test', '--test-reporter=tap', 'framework-agent.mjs']);
    assert.match(output, /# tests 8\b/); assert.match(output, /# fail 0\b/);
    console.log(output);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
