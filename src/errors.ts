export class AgentCoreError extends Error {
  readonly code: string = 'AGENTCORE_ERROR';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends AgentCoreError { override readonly code: string = 'CONFIG_INVALID'; }
export class ContextError extends AgentCoreError { override readonly code: string = 'CONTEXT_INVALID'; }
export class AuthenticationError extends AgentCoreError { override readonly code: string = 'AUTHENTICATION_FAILED'; }
export class CredentialExchangeError extends AuthenticationError { override readonly code: string = 'CREDENTIAL_EXCHANGE_FAILED'; }
export class WorkloadIdentityNotConfiguredError extends AuthenticationError { override readonly code = 'WORKLOAD_IDENTITY_NOT_CONFIGURED'; }
export class WorkloadAccessTokenRejectedError extends CredentialExchangeError { override readonly code = 'WORKLOAD_ACCESS_TOKEN_REJECTED'; }
export class ResourceNotConfiguredError extends AgentCoreError { override readonly code: string = 'RESOURCE_NOT_CONFIGURED'; }
export class ModelConnectionNotFoundError extends ResourceNotConfiguredError { override readonly code = 'MODEL_CONNECTION_NOT_FOUND'; }
export class MCPServerNotFoundError extends ResourceNotConfiguredError { override readonly code = 'MCP_SERVER_NOT_FOUND'; }
export class InvocationError extends AgentCoreError { override readonly code = 'INVOCATION_FAILED'; }
export class UnsupportedFeatureError extends AgentCoreError { override readonly code = 'UNSUPPORTED_FEATURE'; }

export class MemoryValidationError extends AgentCoreError { override readonly code = 'MEMORY_VALIDATION_FAILED'; }
export interface MemoryErrorDetails { serviceCode?: string; httpStatusCode?: number; requestId?: string; }
export class MemoryAPIError extends AgentCoreError {
  override readonly code: string = 'MEMORY_API_FAILED';
  readonly serviceCode?: string;
  readonly httpStatusCode?: number;
  readonly requestId?: string;
  constructor(readonly operation: string, details: MemoryErrorDetails = {}) {
    super(`AgentCore Memory operation ${operation} failed`);
    this.serviceCode = details.serviceCode; this.httpStatusCode = details.httpStatusCode; this.requestId = details.requestId;
  }
}
export class MemoryContractError extends AgentCoreError {
  override readonly code = 'MEMORY_RESPONSE_INVALID';
  constructor(readonly operation: string, readonly detail: string) { super(`AgentCore Memory ${operation} returned an invalid response: ${detail}`); }
}
export class AddMemoriesOutcomeUnknownError extends MemoryAPIError {
  override readonly code = 'ADD_MEMORIES_OUTCOME_UNKNOWN';
  constructor(operation: string, details: MemoryErrorDetails = {}) {
    super(operation, details); this.message = 'AgentCore Memory AddMemories outcome is unknown; the write may have succeeded';
  }
}
