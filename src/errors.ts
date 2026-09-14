import type { ApiErrorResponse, IntegrationEnvironment } from './generated/types.gen';

export interface EmberResponseValidationIssue {
  path: string;
  message: string;
}

export class EmberConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmberConfigurationError';
  }
}

export type EmberChallengeValidationReason =
  | 'authority_mismatch'
  | 'expired'
  | 'invalid_response'
  | 'not_yet_valid';

export class EmberChallengeValidationError extends Error {
  constructor(readonly reason: EmberChallengeValidationReason) {
    super(`Ember wallet challenge validation failed: ${reason}.`);
    this.name = 'EmberChallengeValidationError';
  }
}

export class EmberSessionRequiredError extends Error {
  constructor(message = 'A live Ember wallet session is required.') {
    super(message);
    this.name = 'EmberSessionRequiredError';
  }
}

export type EmberSessionPersistenceOperation = 'clear' | 'save';

export class EmberSessionPersistenceError extends Error {
  constructor(
    readonly operation: EmberSessionPersistenceOperation,
    options?: ErrorOptions,
  ) {
    super(`Ember wallet session persistence ${operation} failed.`, options);
    this.name = 'EmberSessionPersistenceError';
  }
}

export class EmberSigningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmberSigningError';
  }
}

export class EmberEnvironmentMismatchError extends Error {
  constructor(
    readonly expected: IntegrationEnvironment,
    readonly received: string,
    context: string,
  ) {
    super(
      `Ember ${context} environment mismatch: expected ${expected}, received ${received}.`,
    );
    this.name = 'EmberEnvironmentMismatchError';
  }
}

export type EmberQuoteVerificationReason =
  | 'authority_mismatch'
  | 'environment_mismatch'
  | 'expired'
  | 'hash_mismatch'
  | 'invalid_signature'
  | 'untrusted_key'
  | 'unsupported_schema';

export class EmberQuoteVerificationError extends Error {
  constructor(readonly reason: EmberQuoteVerificationReason) {
    super(`Ember quote verification failed: ${reason}.`);
    this.name = 'EmberQuoteVerificationError';
  }
}

export class EmberApiError extends Error {
  constructor(
    readonly status: number,
    readonly response: ApiErrorResponse | undefined,
    readonly retryAfterMs: number | undefined,
  ) {
    super(response?.message ?? `Ember API returned HTTP ${status}.`);
    this.name = 'EmberApiError';
  }

  get code(): ApiErrorResponse['error'] | undefined {
    return this.response?.error;
  }

  get requestId(): string | undefined {
    return this.response?.requestId;
  }
}

export class EmberResponseValidationError extends Error {
  constructor(
    readonly path: string,
    readonly issues: ReadonlyArray<EmberResponseValidationIssue>,
    options?: ErrorOptions,
  ) {
    super(`Ember API returned an invalid success response for ${path}.`, options);
    this.name = 'EmberResponseValidationError';
  }
}

export type EmberResponseMismatchReason =
  | 'authority_mismatch'
  | 'expired'
  | 'request_mismatch'
  | 'resource_mismatch'
  | 'unexpected_state'
  | 'unsafe_upload_grant';

/**
 * A success response passed its wire schema but does not belong to the
 * request or active wallet authority that produced it.
 *
 * Expected and received values are deliberately omitted so identifiers and
 * wallet-linked data are not copied into logs by default.
 */
export class EmberResponseMismatchError extends Error {
  constructor(
    readonly operation: string,
    readonly field: string,
    readonly reason: EmberResponseMismatchReason,
  ) {
    super(`Ember returned a mismatched success response for ${operation} (${field}).`);
    this.name = 'EmberResponseMismatchError';
  }
}

export class EmberTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Ember API request to ${path} exceeded ${timeoutMs}ms.`, options);
    this.name = 'EmberTimeoutError';
  }
}

export class EmberAbortError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Ember API request to ${path} was aborted.`, options);
    this.name = 'EmberAbortError';
  }
}

export class EmberNetworkError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Ember API request to ${path} failed before a response was received.`, options);
    this.name = 'EmberNetworkError';
  }
}
