import Client from '@alicloud/agentcore20260804';
import { $OpenApiUtil, OpenApiUtil } from '@alicloud/openapi-core';
import * as Dara from '@darabonba/typescript';
import { RuntimeOptions } from '@darabonba/typescript';
import type { AccessKeyCredential, CredentialProvider } from '../auth/access-key';
import { HIGH_CODE_SDK_PURPOSE } from '../auth/resource-sts';
import { AddMemoriesOutcomeUnknownError, MemoryAPIError, MemoryContractError, ResourceNotConfiguredError, type MemoryErrorDetails } from '../errors';
import { nullLogger, type Logger } from '../logging';

const GeneratedClient = typeof Client === 'function' ? Client : (Client as unknown as { default: typeof Client }).default;
// CJS exposes URL directly; native ESM only exposes it on module.exports/default.
const DaraURL = Dara.URL ?? (Dara as unknown as { default: typeof Dara }).default.URL;
export interface MemoryRuntime {
  workspaceId: string;
  regionId: string;
  endpoint?: string;
  accessKeyCredential?: AccessKeyCredential;
  resourceSTS?: CredentialProvider;
}
export type MemoryOperation = 'AddMemories' | 'SearchMemories' | 'ListMemories' | 'GetMemory' | 'UpdateMemory' | 'DeleteMemory' | 'ListMemorySessions' | 'ListMemorySessionMessages';
export const pathComponent = (value: string): string => DaraURL.percentEncode(value);

/** Memory methods absent from the public generated package, using its existing POP transport. */
export class MemoryTransport {
  constructor(private readonly store: string, private readonly runtime: () => Promise<MemoryRuntime>, private readonly logger: Logger = nullLogger) {}
  async request<T>(operation: MemoryOperation, method: string, path: string, map: (body: Record<string, unknown>) => T,
    body?: Record<string, unknown>, query?: Record<string, unknown>): Promise<T> {
    const runtime = await this.runtime();
    const credential = runtime.accessKeyCredential ?? await runtime.resourceSTS?.get(HIGH_CODE_SDK_PURPOSE);
    if (!credential) throw new ResourceNotConfiguredError('AgentCore Memory data-plane credentials are not configured');
    const url = runtime.endpoint ? new URL(runtime.endpoint.includes('://') ? runtime.endpoint : `https://${runtime.endpoint}`) : undefined;
    const client = new GeneratedClient(new $OpenApiUtil.Config({ accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
      securityToken: credential.securityToken, regionId: runtime.regionId, endpoint: url?.host, protocol: url?.protocol.slice(0, -1) }));
    const params = new $OpenApiUtil.Params({ action: operation, version: '2026-08-04', protocol: 'HTTPS',
      pathname: `/workspaces/${pathComponent(runtime.workspaceId)}/memorystores/${pathComponent(this.store)}${path}`,
      method, authType: 'AK', style: 'ROA', reqBodyType: body === undefined ? 'json' : 'formData', bodyType: 'json' });
    // The generated Python contract wraps JSON in the form field `body`.
    const request = new $OpenApiUtil.OpenApiRequest({ headers: {}, query: OpenApiUtil.query(query ?? {}),
      body: body === undefined ? undefined : { body: JSON.stringify(body) } });
    const add = operation === 'AddMemories';
    let raw: unknown;
    this.logger.debug('agentcore.memory.request.started', { operation, memory_store_name: this.store });
    try {
      // httpx also uses connectTimeout as socket inactivity timeout while awaiting the response.
      raw = await client.callApi(params, request, new RuntimeOptions({ autoretry: false, maxAttempts: 1,
        connectTimeout: add ? 120_000 : undefined, readTimeout: add ? 120_000 : undefined }));
    } catch (cause) {
      const details = errorDetails(cause);
      const error = add && (details.httpStatusCode === undefined || details.httpStatusCode >= 500)
        ? new AddMemoriesOutcomeUnknownError(operation, details) : new MemoryAPIError(operation, details);
      this.logFailure(error); throw error;
    }
    const response = record(raw); const payload = record(response.body);
    const details: MemoryErrorDetails = { serviceCode: text(payload.code), httpStatusCode: integer(payload.httpStatusCode) ?? integer(response.statusCode),
      requestId: text(payload.requestId) ?? text(record(response.headers)['x-acs-request-id']) };
    try {
      if ((integer(response.statusCode) ?? 0) >= 400 || payload.success === false) {
        throw add && (details.httpStatusCode ?? 0) >= 500 ? new AddMemoriesOutcomeUnknownError(operation, details) : new MemoryAPIError(operation, details);
      }
      if (payload.success !== true) throw new MemoryContractError(operation, 'body.success must be true');
      return map(payload);
    } catch (cause) {
      const error = add && cause instanceof MemoryContractError ? new AddMemoriesOutcomeUnknownError(operation, details) : cause;
      if (error instanceof MemoryAPIError || error instanceof MemoryContractError) this.logFailure(error);
      throw error;
    }
  }
  private logFailure(error: MemoryAPIError | MemoryContractError): void {
    this.logger.warn('agentcore.memory.request.failed', { operation: error.operation, memory_store_name: this.store, error_type: error.name,
      status: error instanceof MemoryAPIError ? error.httpStatusCode : undefined,
      service_code: error instanceof MemoryAPIError ? error.serviceCode : undefined,
      request_id: error instanceof MemoryAPIError ? error.requestId : undefined });
  }
}
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) ? value : undefined; }
function errorDetails(error: unknown): MemoryErrorDetails {
  let current = record(error); const result: MemoryErrorDetails = {};
  for (let i = 0; i < 4; i++) {
    const data = record(current.data); const response = record(current.response);
    result.serviceCode ??= text(current.code) ?? text(data.code) ?? text(data.Code);
    result.httpStatusCode ??= integer(current.statusCode) ?? integer(data.statusCode) ?? integer(data.StatusCode) ?? integer(response.statusCode);
    result.requestId ??= text(current.requestId) ?? text(data.requestId) ?? text(data.RequestId) ?? text(record(response.headers)['x-acs-request-id']);
    if (!current.innerException) break;
    current = record(current.innerException);
  }
  return result;
}
