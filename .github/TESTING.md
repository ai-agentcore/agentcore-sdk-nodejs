# Continuous integration

`ci.yml` runs on pull requests, pushes to `main`, and manual dispatch.
It does not publish packages or require cloud credentials.

- Node 22 and 24 run type checks, Vitest tests and builds for the SDK and
  collaboration package. These versions also satisfy the current optional
  frameworks' Node requirements.
- Node 22 additionally tests packed packages in temporary consumer projects,
  including ESM / CommonJS imports and framework integrations.
- Tests use mocks and local HTTP/MCP services, including AG-UI / OpenAI protocol
  output. They are not cloud end-to-end tests.

To reproduce the checks:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm --prefix packages/collaboration ci
npm --prefix packages/collaboration run typecheck
npm --prefix packages/collaboration test
npm --prefix packages/collaboration run build
node --test tests/package.test.cjs
cd packages/collaboration
node --test tests/package.test.cjs
node --test tests/framework-package.test.cjs
```
