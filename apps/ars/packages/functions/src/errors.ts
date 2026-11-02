import type { ApiError, ApiErrorCode } from '@rayfin-app/shared';

/**
 * An expected, user-presentable failure. `message` must already be sanitized:
 * it is returned to the browser verbatim. Never put tokens, SQL text, provider
 * bodies or address content in it.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly extra: Omit<ApiError, 'code' | 'message'> = {}
  ) {
    super(message);
    this.name = 'AppError';
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

export const deny = (message = 'You do not have permission to perform this action.') =>
  new AppError('ACCESS_DENIED', message);

export const invalid = (message: string, fieldErrors?: Record<string, string>) =>
  new AppError('VALIDATION', message, fieldErrors ? { fieldErrors } : {});

export const notFound = (message = 'The record was not found or you cannot access it.') =>
  new AppError('NOT_FOUND', message);

/** Failure categories used in telemetry (LOG-01). */
export type FailureCategory =
  | 'validation'
  | 'authz'
  | 'authn'
  | 'ai'
  | 'storage'
  | 'audit'
  | 'config'
  | 'conflict'
  | 'internal';

export function categoryFor(code: ApiErrorCode): FailureCategory {
  switch (code) {
    case 'VALIDATION':
      return 'validation';
    case 'UNAUTHENTICATED':
      return 'authn';
    case 'ACCESS_DENIED':
    case 'NOT_FOUND':
      return 'authz';
    case 'CONFLICT':
    case 'DUPLICATE_IN_PROGRESS':
      return 'conflict';
    case 'AI_TIMEOUT':
    case 'AI_UNAVAILABLE':
    case 'AI_INVALID_OUTPUT':
      return 'ai';
    case 'STORAGE_FAILURE':
      return 'storage';
    case 'AUDIT_FAILURE':
      return 'audit';
    case 'CONFIG':
      return 'config';
    default:
      return 'internal';
  }
}
