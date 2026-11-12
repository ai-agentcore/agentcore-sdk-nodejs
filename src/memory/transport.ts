import Client from '@alicloud/agentcore20260804';
import { $OpenApiUtil, OpenApiUtil } from '@alicloud/openapi-core';
import * as Dara from '@darabonba/typescript';
import { RuntimeOptions } from '@darabonba/typescript';
import type { AccessKeyCredential, CredentialProvider } from '../auth/access-key';
import { HIGH_CODE_SDK_PURPOSE } from '../auth/resource-sts';
import { AddMemoriesOutcomeUnknownError, CreateEventsOutcomeUnknownError, MemoryAPIError, MemoryContractError, MemoryRequestAbortedError, MemoryRequestTimeoutError, MemoryValidationError, ResourceNotConfiguredError, type MemoryErrorDetails } from '../errors';
import { nullLogger, type Logger } from '../logging';
import type { MemoryCallOptions } from './context-models';

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
export type MemoryOperation = 'AddMemories' | 'GetMemoryTask' | 'SearchMemories' | 'ListMemories' | 'GetMemory' | 'UpdateMemory' | 'DeleteMemory' | 'ListMemorySessions' | 'ListMemorySessionMessages' | 'CreateEvents' | 'ListEvents';
export const pathComponent = (value: string): string => DaraURL.percentEncode(value);

/** Memory methods absent from the public generated package, using its existing POP transport. */
export class MemoryTransport {
  constructor(private readonly store: string, private readonly runtime: () => Promise<MemoryRuntime>, private readonly logger: Logger = nullLogger,
    private readonly purpose = HIGH_CODE_SDK_PURPOSE) {}
  request<T>(operation: MemoryOperation, method: string, path: string, map: (body: Record<string, unknown>, details: MemoryErrorDetails) => T,
    body?: Record<string, unknown>, query?: Record<string, unknown>, options: MemoryCallOptions = {}): Promise<T> {
    let dispatched = false;
    return withDeadline(operation, options, () => dispatched && operation === 'CreateEvents', async check => {
      const runtime = await this.runtime();
      check();
      const credential = runtime.accessKeyCredential ?? await runtime.resourceSTS?.get(this.purpose);
      check();
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
        check();
        dispatched = true;
        raw = await client.callApi(params, request, new RuntimeOptions({ autoretry: false, maxAttempts: 1,
          connectTimeout: options.timeoutMs ?? (add ? 120_000 : undefined), readTimeout: options.timeoutMs ?? (add ? 120_000 : undefined) }));
      } catch (cause) {
        if (cause instanceof MemoryRequestAbortedError || cause instanceof MemoryRequestTimeoutError) throw cause;
        const details = errorDetails(cause);
        const uncertain = details.httpStatusCode === undefined || details.httpStatusCode >= 500;
        const error = operation === 'CreateEvents' && uncertain ? new CreateEventsOutcomeUnknownError(operation, details)
          : add && uncertain ? new AddMemoriesOutcomeUnknownError(operation, details) : new MemoryAPIError(operation, details);
        this.logFailure(error); throw error;
      }
      const response = record(raw); const payload = record(response.body);
      const httpStatus = integer(response.statusCode);
      const details: MemoryErrorDetails = { serviceCode: text(payload.code), httpStatusCode: this.purpose === 'context'
        ? httpStatus ?? integer(payload.httpStatusCode) : integer(payload.httpStatusCode) ?? httpStatus,
        requestId: text(payload.requestId) ?? headerRequestId(response.headers), serviceMessage: text(payload.message) };
      try {
        if ((httpStatus ?? 0) >= 400 || this.purpose === 'context' && (details.httpStatusCode ?? 0) >= 400 || payload.success === false) {
          throw operation === 'CreateEvents' && (details.httpStatusCode ?? 0) >= 500 ? new CreateEventsOutcomeUnknownError(operation, details)
            : add && (details.httpStatusCode ?? 0) >= 500 ? new AddMemoriesOutcomeUnknownError(operation, details) : new MemoryAPIError(operation, details);
        }
        if (payload.success !== true) throw new MemoryContractError(operation, 'body.success must be true', details.requestId);
        const result = map(payload, details);
        if (add && body?.sync === false) this.logger.info('agentcore.memory.request.submitted', {
          operation, memory_store_name: this.store, task_id: text(record(result).taskId), request_id: details.requestId ?? '-',
        });
        return result;
      } catch (cause) {
        const malformed = cause instanceof MemoryContractError;
        const failure = malformed ? { ...details, serviceMessage: details.serviceMessage ?? cause.detail } : details;
        const error = operation === 'CreateEvents' && malformed ? new CreateEventsOutcomeUnknownError(operation, failure)
          : add && malformed ? new AddMemoriesOutcomeUnknownError(operation, failure)
          : malformed ? new MemoryContractError(operation, cause.detail, details.requestId) : cause;
        if (error instanceof MemoryAPIError || error instanceof MemoryContractError) this.logFailure(error);
        throw error;
      }
    });
  }
  private logFailure(error: MemoryAPIError | MemoryContractError): void {
    this.logger.warn('agentcore.memory.request.failed', { operation: error.operation, memory_store_name: this.store, error_type: error.name,
      status: error instanceof MemoryAPIError ? error.httpStatusCode ?? '-' : '-',
      service_code: error instanceof MemoryAPIError ? error.serviceCode ?? '-' : '-',
      request_id: error instanceof MemoryAPIError ? error.requestId ?? '-' : '-',
      message: error instanceof MemoryAPIError ? error.serviceMessage ?? '-' : error.detail });
  }
}

function withDeadline<T>(operation: MemoryOperation, options: MemoryCallOptions, uncertain: () => boolean,
  call: (check: () => void) => Promise<T>): Promise<T> {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)) {
    throw new MemoryValidationError('timeoutMs must be a positive safe timer duration');
  }
  return new Promise<T>((resolve, reject) => {
    let stopped: MemoryRequestAbortedError | MemoryRequestTimeoutError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => { if (stopped) throw stopped; };
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { stopped = new MemoryRequestAbortedError(operation, uncertain(), options.signal?.reason); cleanup(); reject(stopped); };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      stopped = new MemoryRequestTimeoutError(operation, uncertain()); cleanup(); reject(stopped);
    }, options.timeoutMs);
    // The generated POP client has no abort hook. Stop waiting and prevent a later dispatch.
    void call(check).then(resolve, reject).finally(cleanup);
  });
}
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
// The generated client stringifies missing error fields as "undefined".
function text(value: unknown): string | undefined { return typeof value === 'string' && value && value !== 'undefined' ? value : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) ? value : undefined; }
function headerRequestId(headers: unknown): string | undefined {
  return text(Object.entries(record(headers)).find(([key]) => key.toLowerCase() === 'x-acs-request-id')?.[1]);
}
function errorDetails(error: unknown): MemoryErrorDetails {
  let current = record(error); const result: MemoryErrorDetails = {};
  for (let i = 0; i < 4; i++) {
    const data = record(current.data); const response = record(current.response);
    result.serviceCode ??= text(current.code) ?? text(data.code) ?? text(data.Code);
    result.httpStatusCode ??= integer(current.statusCode) ?? integer(data.statusCode) ?? integer(data.StatusCode) ?? integer(response.statusCode);
    result.requestId ??= text(current.requestId) ?? text(data.requestId) ?? text(data.RequestId)
      ?? headerRequestId(data.headers) ?? headerRequestId(response.headers);
    result.serviceMessage ??= text(data.message) ?? text(data.Message) ?? text(current.message);
    if (!current.innerException) break;
    current = record(current.innerException);
  }
  return result;
}
