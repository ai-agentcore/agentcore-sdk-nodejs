import { AgentCoreError, ConfigError, ContextError } from '../errors';

export class CollaborationError extends AgentCoreError {
  override readonly code: string = 'COLLABORATION_ERROR';
  readonly retryable: boolean = false;
}
export class CollaborationConfigError extends ConfigError {
  override readonly code = 'COLLABORATION_CONFIG_INVALID';
  readonly retryable = true;
}
export class CollaborationContextError extends ContextError {
  override readonly code = 'COLLABORATION_CONTEXT_INVALID';
  readonly retryable = false;
}
export class CollaborationDisabledError extends CollaborationError { override readonly code = 'COLLABORATION_DISABLED'; }
export class CollaborationContextRequiredError extends CollaborationError { override readonly code = 'COLLABORATION_CONTEXT_REQUIRED'; }
export class CollaborationTeamUnavailableError extends CollaborationError { override readonly code = 'COLLABORATION_TEAM_UNAVAILABLE'; }
export class CollaborationRoleUnsupportedError extends CollaborationError { override readonly code = 'COLLABORATION_ROLE_UNSUPPORTED'; }
export class CollaborationToolArgumentError extends CollaborationError { override readonly code = 'COLLABORATION_ARGUMENT_INVALID'; }
export class CollaborationTaskUnauthorizedError extends CollaborationError { override readonly code = 'COLLABORATION_TASK_UNAUTHORIZED'; }
export class CollaborationTaskInvalidError extends CollaborationError { override readonly code = 'COLLABORATION_TASK_INVALID'; }
export class CollaborationTaskNotFoundError extends CollaborationError { override readonly code = 'COLLABORATION_TASK_NOT_FOUND'; }
export class CollaborationTaskConflictError extends CollaborationError { override readonly code = 'COLLABORATION_TASK_CONFLICT'; }
export class CollaborationFileTooLargeError extends CollaborationError { override readonly code = 'COLLABORATION_FILE_TOO_LARGE'; }
export class CollaborationTaskUnavailableError extends CollaborationError {
  override readonly code = 'COLLABORATION_TASK_UNAVAILABLE';
  override readonly retryable = true;
}
