import { inspect } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessKeyCredential, ResourceCredential } from '../src/auth/access-key';
import { ResourceSTSProvider, HIGH_CODE_SDK_PURPOSE } from '../src/auth/resource-sts';
import { WorkloadAccessTokenProvider } from '../src/auth/workload-access-token';
import { AuthenticationError, CredentialExchangeError, WorkloadIdentityNotConfiguredError } from '../src/errors';
import type { Logger } from '../src/logging';
import { httpServer } from './helpers';

const servers: Array<Awaited<ReturnType<typeof httpServer>>> = [];
const providers: Array<{ close(): void }> = [];
async function server(handler: Parameters<typeof httpServer>[0]) { const result = await httpServer(handler); servers.push(result); return result; }
afterEach(async () => { providers.splice(0).forEach((p) => p.close()); await Promise.all(servers.splice(0).map((s) => s.close())); vi.useRealTimers(); });
const stsResponse = () => ({
  access_key_id: 'test-ak', access_key_secret: 'test-sk', security_token: 'test-sts',
  expiration: new Date(Date.now() + 3_600_000).toISOString(),
});

describe('AccessKey', () => {
  it('supports AK/SK and optional STS without leaking values in inspection or JSON', () => {
    const key = new AccessKeyCredential({ accessKeyId: 'sensitive-ak', accessKeySecret: 'sensitive-sk' });
    expect(key.accessKeyId).toBe('sensitive-ak'); expect(key.securityToken).toBeUndefined();
    expect(inspect(key)).not.toContain('sensitive'); expect(JSON.stringify(key)).not.toContain('sensitive');
    const sts = new ResourceCredential({ accessKeyId: 'sensitive-ak', accessKeySecret: 'sensitive-sk', securityToken: 'sensitive-sts', expiration: new Date() });
    expect(inspect(sts)).not.toContain('sensitive'); expect(JSON.stringify(sts)).not.toContain('sensitive');
    expect(() => new AccessKeyCredential({ accessKeyId: '', accessKeySecret: 'sk' })).toThrow(TypeError);
  });
});

describe('Resource STS over HTTP', () => {
  it('sends an empty body with Bearer SA, caches per purpose and coalesces concurrent exchanges', async () => {
    const calls: Array<{ url?: string; authorization?: string; body: string }> = [];
    const endpoint = await server((req, res) => {
      let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        calls.push({ url: req.url, authorization: req.headers.authorization, body });
        res.end(JSON.stringify(stsResponse()));
      });
    });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'sa-token' }); providers.push(provider);
    const credentials = await Promise.all(Array.from({ length: 20 }, () => provider.get(HIGH_CODE_SDK_PURPOSE)));
    expect(new Set(credentials).size).toBe(1);
    await provider.get(HIGH_CODE_SDK_PURPOSE); await provider.get('agentidentitydata'); await provider.get();
    expect(calls).toEqual([
      { url: '/api/v1/credentials/sts?purpose=highcode_sdk', authorization: 'Bearer sa-token', body: '' },
      { url: '/api/v1/credentials/sts?purpose=agentidentitydata', authorization: 'Bearer sa-token', body: '' },
      { url: '/api/v1/credentials/sts', authorization: 'Bearer sa-token', body: '' },
    ]);
  });
  it('refreshes five minutes before expiry, without caching failed exchanges', async () => {
    let calls = 0;
    const endpoint = await server((_req, res) => { calls++; res.end(calls === 1 ? '{}' : JSON.stringify(stsResponse())); });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'sa' }); providers.push(provider);
    await expect(provider.get()).rejects.toBeInstanceOf(CredentialExchangeError);
    const initial = await provider.get();
    // Date-only fake clock leaves real network and timeout behavior untouched.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(initial.expiration.getTime() - 299_000));
    const renewed = await provider.get();
    expect(renewed).not.toBe(initial); expect(calls).toBe(3);
  });
  it('retries once with a changed SA on 401', async () => {
    const auth: Array<string | undefined> = [];
    const endpoint = await server((req, res) => {
      auth.push(req.headers.authorization);
      res.statusCode = auth.length === 1 ? 401 : 200; res.end(JSON.stringify(stsResponse()));
    });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'old', refresh: () => 'new' }); providers.push(provider);
    await provider.get(); expect(auth).toEqual(['Bearer old', 'Bearer new']);
  });
  it('does not retry a rejected unchanged SA or unauthorized purpose', async () => {
    let calls = 0; let status = 401;
    const endpoint = await server((_req, res) => { calls++; res.statusCode = status; res.end('{}'); });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'unchanged' }); providers.push(provider);
    await expect(provider.get()).rejects.toBeInstanceOf(AuthenticationError); expect(calls).toBe(1);
    status = 403; await expect(provider.get()).rejects.toThrow('HTTP 403'); expect(calls).toBe(2);
  });
  it.each([500, 502, 503, 504])('retries transient HTTP %i with useful safe diagnostics', async (status) => {
    let calls = 0;
    const logs: unknown[] = [];
    const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args: unknown[]) => logs.push(args)])) as unknown as Logger;
    const endpoint = await server((_req, res) => {
      calls++; res.statusCode = calls < 3 ? status : 200;
      res.setHeader('x-acs-request-id', 'controller-request-id');
      res.end(JSON.stringify(calls < 3 ? { message: 'upstream unavailable' } : stsResponse()));
    });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'sa-secret' }, { logger }); providers.push(provider);
    await provider.get(); expect(calls).toBe(3);
    const output = JSON.stringify(logs);
    expect(output).toContain(`${endpoint.url}/api/v1/credentials/sts`);
    expect(output).toContain('controller-request-id'); expect(output).toContain('upstream unavailable');
    expect(output).not.toContain('sa-secret'); expect(output).not.toContain('test-sk'); expect(output).not.toContain('test-sts');
  });
  it('does not follow redirects and leak SA credentials to the target', async () => {
    let targetCalls = 0;
    const target = await server((_req, res) => { targetCalls++; res.end('{}'); });
    const endpoint = await server((_req, res) => { res.statusCode = 307; res.setHeader('location', target.url); res.end(); });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'sa' }); providers.push(provider);
    await expect(provider.get()).rejects.toThrow('HTTP 307'); expect(targetCalls).toBe(0);
  });
  it('times out transport waits and closes an in-flight exchange', async () => {
    let calls = 0;
    const endpoint = await server(() => { calls++; });
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'sa' }, { timeoutMs: 30, maxAttempts: 1 }); providers.push(provider);
    await expect(provider.get()).rejects.toThrow('cannot reach'); expect(calls).toBe(1);
    const result = provider.get(); const assertion = expect(result).rejects.toThrow();
    await sleep(10); provider.close(); await assertion;
  });
  it('rejects expired, malformed, or non-STS responses', async () => {
    const endpoint = await server((_req, res) => res.end(JSON.stringify({ ...stsResponse(), expiration: '2020-01-01T00:00:00Z' })));
    const provider = new ResourceSTSProvider(endpoint.url, { get: () => 'sa' }); providers.push(provider);
    await expect(provider.get()).rejects.toThrow('invalid STS response');
  });
});

describe('opaque WAT', () => {
  it('caches and coalesces until invalidated, and ignores stale invalidations', async () => {
    let calls = 0;
    const endpoint = await server((req, res) => {
      expect(req.url).toBe('/api/v1/workload/token');
      calls++; res.end(JSON.stringify({ workloadAccessToken: `opaque-${calls}` }));
    });
    const provider = new WorkloadAccessTokenProvider(endpoint.url, { get: () => 'sa' }); providers.push(provider);
    expect(await Promise.all([provider.get(), provider.get()])).toEqual(['opaque-1', 'opaque-1']);
    await provider.invalidate('opaque-1'); expect(await provider.get()).toBe('opaque-2');
    await provider.invalidate('opaque-1'); expect(await provider.get()).toBe('opaque-2'); expect(calls).toBe(2);
  });
  it('serializes invalidation with an ongoing exchange', async () => {
    let calls = 0;
    const endpoint = await server((_req, res) => { calls++; res.end(JSON.stringify({ workloadAccessToken: 'opaque' })); });
    const provider = new WorkloadAccessTokenProvider(endpoint.url, { get: () => 'sa' }); providers.push(provider);
    const pending = provider.get(); await provider.invalidate(); await pending;
    await expect(provider.get()).resolves.toBe('opaque');
    expect(calls).toBe(2);
  });
  it('distinguishes missing identity from malformed token response', async () => {
    let status = 404;
    const endpoint = await server((_req, res) => { res.statusCode = status; res.end('{}'); });
    const provider = new WorkloadAccessTokenProvider(endpoint.url, { get: () => 'sa' }); providers.push(provider);
    await expect(provider.get()).rejects.toBeInstanceOf(WorkloadIdentityNotConfiguredError);
    status = 200; await expect(provider.get()).rejects.toThrow('empty workload access token');
  });
});
