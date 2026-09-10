import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/publish-npm.yml', 'utf8'));
const packages = [
  { prefix: 'sdk-v', directory: '.' },
  { prefix: 'collaboration-v', directory: 'packages/collaboration' },
];

for (const { prefix, directory } of packages) {
  const metadata = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
  it.each([true, false])(`validates ${prefix} version (matches=%s)`, matches => {
    const temp = mkdtempSync(join(tmpdir(), 'agentcore-release-'));
    const output = join(temp, 'output');
    try {
      const step = workflow.jobs.build.steps.find((step: { id?: string }) => step.id === 'package');
      const tag = prefix + (matches ? metadata.version : '999999.0.0');
      const result = spawnSync('bash', ['-e', '-c', step.run], {
        encoding: 'utf8', env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output },
      });
      if (matches) {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe(
          `directory=${directory}\npackage=${metadata.name}\nfilename=${metadata.name}-${metadata.version}.tgz\n`,
        );
      } else {
        expect(result.status).not.toBe(0);
        expect(existsSync(output)).toBe(false);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

it.each(['v0.1.0', 'sdk-v0.1.0-beta.1', 'sdk-v01.0.0'])('rejects unsupported tag %s', tag => {
  const step = workflow.jobs.build.steps.find((step: { id?: string }) => step.id === 'package');
  const result = spawnSync('bash', ['-e', '-c', step.run], {
    encoding: 'utf8', env: { ...process.env, RELEASE_TAG: tag },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Unsupported release tag');
});

it('publishes only the built artifact with OIDC and matching repository metadata', () => {
  expect(workflow.on.push.tags).toEqual(['sdk-v*', 'collaboration-v*']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe('build');
  expect(publish.if).toBe("github.repository == 'ai-agentcore/agentcore-sdk-nodejs'");
  expect(publish.environment.name).toBe('npm');
  expect(publish.permissions).toEqual({ 'id-token': 'write' });
  expect(publish.steps.at(-1).run).toBe('npm publish "./release/$PACKAGE_FILENAME" --ignore-scripts --access public --registry=https://registry.npmjs.org');
  for (const { directory } of packages) {
    const metadata = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
    expect(metadata.repository.url).toBe('git+https://github.com/ai-agentcore/agentcore-sdk-nodejs.git');
  }
});
