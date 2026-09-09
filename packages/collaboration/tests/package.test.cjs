const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

test('independent addon tarballs share Core contracts across ESM/CJS and upgrade without replacing Core', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'agentcore-collaboration-package-'));
  const run = (command, args, cwd = temporary) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  };
  const pack = cwd => JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], cwd))[0].filename;
  try {
    const corePackage = pack(resolve('../..')), addonPackage = pack(process.cwd());
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, corePackage), join(temporary, addonPackage)]);
    const assertions = `(async () => {
      assert.equal(addon.CollaborationTaskUnavailableError, contract.CollaborationTaskUnavailableError);
      assert.ok(new addon.CollaborationConfigError('bad') instanceof root.ConfigError);
      const header = Buffer.from(JSON.stringify({ version: 1, teamId: 'team', roomKind: 'task', roomId: '!room', eventId: '$event' })).toString('base64url');
      const app = new api.AgentCoreServer({ invoke: () => {
        assert.equal(addon.currentCollaborationContext(), contract.currentCollaborationContext());
        return addon.currentCollaborationContext().eventId;
      } });
      const endpoint = await app.start({ port: 0, hostname: '127.0.0.1' });
      try {
        const result = await fetch(endpoint + '/openai/v1/chat/completions', { method: 'POST', headers: { 'x-agentcore-collaboration-context': header }, body: '{"messages":[]}' });
        assert.equal((await result.json()).choices[0].message.content, '$event');
      } finally { await app.close(); }
      assert.equal(addon.currentCollaborationContext(false), undefined);
      const worker = new addon.WorkerCollaboration(() => undefined, {}, process.cwd());
      assert.equal(worker.tools().length, 24);
      assert.deepEqual((await worker.skills()).map(skill => skill.name), ['file-sharing', 'task-execution']);
      const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer test-token');
        if (req.url === '/v1/tasks/task') res.end('{"taskId":"task","roomId":"!room"}');
        else if (req.url === '/v1/sub-tasks/sub') res.end('{"taskId":"task"}');
        else { assert.equal(req.url, '/v1/sub-tasks/sub/ack'); res.end('{"accepted":true}'); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const client = new addon.TaskServiceClient({ endpointProvider: () => 'http://127.0.0.1:' + server.address().port, tokenProvider: () => 'test-token' });
      try {
        assert.deepEqual(await client.getTask({ matrixTokenEnv: 'TOKEN' }, 'task'), { taskId: 'task', roomId: '!room' });
        await fs.writeFile('teams.yaml', JSON.stringify({ apiVersion: 'agentteams.io/v1alpha1', kind: 'TeamsConfig', metadata: { runtimeName: 'runtime' }, spec: {
          self: { name: 'worker', runtimeName: 'runtime', matrixUserId: '@worker:local' }, matrix: { tokenEnv: 'TOKEN' },
          teams: [{ name: 'team', membership: { role: 'worker' }, members: [] }]
        } }));
        await fs.writeFile('env', 'export TOKEN=test-token\\nexport AGENTCORE_TASK_SERVICE_ENDPOINT=http://127.0.0.1:' + server.address().port + '\\n');
        const core = root.AgentCore.auto({ teamsPath: 'teams.yaml', envPath: 'env' });
        const [one, two] = await Promise.all([core.collaboration.worker(), core.collaboration.worker()]);
        assert.equal(one, two); assert.equal(core.config, undefined);
        assert.equal((await one.skills()).length, 2);
        assert.deepEqual(await one.tools().find(tool => tool.name === 'agentteams_get_task').invoke({ task_id: 'task' }), { ok: true, data: { taskId: 'task', roomId: '!room' } });
        const workerApp = new api.AgentCoreServer({ invoke: async () => JSON.stringify(await one.tools().find(tool => tool.name === 'agentteams_ack_subtask').invoke({ subtask_id: 'sub' })) });
        const workerEndpoint = await workerApp.start({ port: 0, hostname: '127.0.0.1' });
        try {
          const response = await fetch(workerEndpoint + '/openai/v1/chat/completions', { method: 'POST', headers: { 'x-agentcore-collaboration-context': header }, body: '{"messages":[]}' });
          assert.deepEqual(JSON.parse((await response.json()).choices[0].message.content), { ok: true, data: { accepted: true } });
        } finally { await workerApp.close(); }
        const handle = core.collaboration; await core.close();
        await assert.rejects(handle.worker(), /closed/);
      }
      finally { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    writeFileSync(join(temporary, 'consumer.mjs'), `import assert from 'node:assert/strict'; import * as http from 'node:http'; import * as fs from 'node:fs/promises'; import * as root from '@alibabacloud/agentcore-sdk'; import * as api from '@alibabacloud/agentcore-sdk/server'; import * as contract from '@alibabacloud/agentcore-sdk/collaboration'; import * as addon from '@alibabacloud/agentcore-collaboration'; ${assertions}`);
    writeFileSync(join(temporary, 'consumer.cjs'), `const assert = require('node:assert/strict'); const http = require('node:http'); const fs = require('node:fs/promises'); const root = require('@alibabacloud/agentcore-sdk'); const api = require('@alibabacloud/agentcore-sdk/server'); const contract = require('@alibabacloud/agentcore-sdk/collaboration'); const addon = require('@alibabacloud/agentcore-collaboration'); ${assertions}`);
    run(process.execPath, ['consumer.mjs']); run(process.execPath, ['consumer.cjs']);
    const coreManifest = join(temporary, 'node_modules/@alibabacloud/agentcore-sdk/package.json');
    const coreBefore = readFileSync(coreManifest, 'utf8');
    const staged = join(temporary, 'addon-next'); cpSync(join(process.cwd(), 'dist'), join(staged, 'dist'), { recursive: true });
    cpSync(join(process.cwd(), 'worker-skills'), join(staged, 'worker-skills'), { recursive: true });
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')); manifest.version = '0.1.1'; delete manifest.devDependencies;
    writeFileSync(join(staged, 'package.json'), JSON.stringify(manifest));
    const next = pack(staged); run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, next)]);
    assert.equal(readFileSync(coreManifest, 'utf8'), coreBefore);
    assert.equal(JSON.parse(readFileSync(join(temporary, 'node_modules/@alibabacloud/agentcore-collaboration/package.json'))).version, '0.1.1');
    run(process.execPath, ['consumer.mjs']); run(process.execPath, ['consumer.cjs']);
    writeFileSync(join(temporary, 'consumer.ts'), `import { TeamsProvider, TaskServiceClient, currentCollaborationContext } from '@alibabacloud/agentcore-collaboration';
      const client = new TaskServiceClient({ endpointProvider: () => 'http://localhost', tokenProvider: name => name });
      const snapshot = await new TeamsProvider().snapshot(); if (snapshot) await client.getTask(snapshot, 'task');
      const room: string = currentCollaborationContext().roomId; void room; client.close();`);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts']);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
