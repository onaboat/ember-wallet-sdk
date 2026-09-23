import type { ZodType } from 'zod';
import { base64Encode, sha256Hex, type EmberCrypto, utf8, webCrypto } from './encoding';
import {
  EmberAbortError,
  EmberApiError,
  EmberConfigurationError,
  EmberNetworkError,
  EmberResponseValidationError,
  EmberSigningError,
  EmberTimeoutError,
} from './errors';
import { canonicalizeHostBinding, type EmberHostBinding } from './challenge';
import type {
  ApiErrorResponse,
  IntegrationEnvironment,
  WalletClientBindingRequest,
} from './generated/types.gen';
import { zApiErrorResponse } from './generated/zod.gen';
import {
  walletRequestPayload,
  type EmberMessageSigner,
  type PersistedWalletSession,
} from './session';

export type EmberFetch = typeof globalThis.fetch;

export interface EmberRetryPolicy {
  maxBackoffMs?: number;
  maxRetries?: number;
  minBackoffMs?: number;
}

export interface EmberTimeouts {
  bootstrapMs?: number;
  decisionMs?: number;
  mutationMs?: number;
  readMs?: number;
}

export type EmberTelemetryEvent = {
  attempt: number;
  durationMs: number;
  operation: string;
  outcome: 'success' | 'api_error' | 'timeout' | 'aborted' | 'network_error';
  pathTemplate: string;
  status?: number;
};

export interface EmberRequestOptions {
  /**
   * Stable business-operation key for APIs that require idempotency. Reuse it
   * only for the exact same request body.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface EmberTransportConfig {
  baseUrl: string;
  crypto?: EmberCrypto;
  environment: IntegrationEnvironment;
  fetch?: EmberFetch;
  hostBinding: EmberHostBinding;
  now?: () => Date;
  retry?: EmberRetryPolicy;
  telemetry?: (event: EmberTelemetryEvent) => void;
  timeouts?: EmberTimeouts;
}

type RequestDefinition<T> = {
  body?: unknown;
  idempotent: boolean;
  method: 'GET' | 'POST';
  operation: string;
  options?: EmberRequestOptions;
  path: string;
  pathTemplate: string;
  schema: ZodType<T>;
  timeoutMs: number;
};

const DEFAULT_RETRY: Required<EmberRetryPolicy> = {
  maxBackoffMs: 10_000,
  maxRetries: 2,
  minBackoffMs: 250,
};

const DEFAULT_TIMEOUTS: Required<EmberTimeouts> = {
  bootstrapMs: 10_000,
  // Includes the server's bounded 12-second hydration and simulation budget.
  decisionMs: 15_000,
  mutationMs: 10_000,
  readMs: 5_000,
};

function normalizedBaseUrl(
  value: string,
  environment: IntegrationEnvironment,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmberConfigurationError('baseUrl must be an absolute HTTP(S) URL.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new EmberConfigurationError(
      'baseUrl must be an origin without credentials, path, query, or fragment.',
    );
  }
  const localSandboxHost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (environment === 'production' && url.protocol !== 'https:') {
    throw new EmberConfigurationError('Production Ember clients require HTTPS.');
  }
  if (
    environment === 'sandbox' &&
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && localSandboxHost)
  ) {
    throw new EmberConfigurationError(
      'Sandbox HTTP is allowed only for an exact localhost address.',
    );
  }
  return url.origin;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function toWalletClientBindingRequest(
  binding: EmberHostBinding,
): WalletClientBindingRequest {
  return binding.kind === 'native'
    ? { kind: 'native', applicationId: binding.applicationId }
    : { kind: 'browser' };
}

function hostBindingHeaders(binding: EmberHostBinding): Record<string, string> {
  return binding.kind === 'native'
    ? { 'x-ember-application-id': binding.applicationId }
    : {};
}

function retryAfterMs(response: Response, now: Date): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new EmberAbortError('retry backoff');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EmberAbortError('retry backoff'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class EmberTransport {
  readonly baseUrl: string;
  readonly crypto: EmberCrypto;
  readonly timeouts: Required<EmberTimeouts>;

  private readonly fetch: EmberFetch;
  private readonly hostBinding: EmberHostBinding;
  private readonly now: () => Date;
  private readonly retry: Required<EmberRetryPolicy>;

  constructor(private readonly config: EmberTransportConfig) {
    if (
      config.environment !== 'sandbox' &&
      config.environment !== 'production'
    ) {
      throw new EmberConfigurationError(
        'environment must be exactly sandbox or production.',
      );
    }
    this.hostBinding = canonicalizeHostBinding(
      config.hostBinding,
      config.environment,
    );
    this.baseUrl = normalizedBaseUrl(config.baseUrl, config.environment);
    // Browser and extension runtimes expose fetch as a host method. Preserve
    // its required WorkerGlobalScope/Window receiver when the SDK supplies the
    // platform default; otherwise `this.fetch(...)` can throw Illegal invocation
    // before a network request is made.
    this.fetch = config.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.fetch !== 'function') {
      throw new EmberConfigurationError(
        'Fetch is unavailable; provide an EmberFetch adapter.',
      );
    }
    this.crypto = config.crypto ?? webCrypto();
    this.now = config.now ?? (() => new Date());
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    if (
      Object.values(this.retry).some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      this.retry.maxBackoffMs < this.retry.minBackoffMs ||
      Object.values(this.timeouts).some(
        (timeout) => !Number.isSafeInteger(timeout) || timeout <= 0,
      )
    ) {
      throw new EmberConfigurationError(
        'Retry values must be nonnegative integers and timeouts must be positive integers.',
      );
    }
  }

  currentDate(): Date {
    return this.now();
  }

  walletClientBindingRequest(): WalletClientBindingRequest {
    return toWalletClientBindingRequest(this.hostBinding);
  }

  publicRequest<T>(
    definition: Omit<RequestDefinition<T>, 'idempotent'> & {
      idempotent?: boolean;
    },
  ): Promise<T> {
    return this.request(
      { ...definition, idempotent: definition.idempotent ?? false },
      async (body) => ({
        ...hostBindingHeaders(this.hostBinding),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }),
    );
  }

  signedRequest<T>(
    definition: RequestDefinition<T>,
    session: PersistedWalletSession,
    signer: EmberMessageSigner,
  ): Promise<T> {
    return this.request(definition, async (body, method, path) => {
      const timestamp = this.now().toISOString();
      const jti = `jti_${this.crypto.randomUuid().toLowerCase()}`;
      if (!/^jti_[a-z0-9-]{16,92}$/.test(jti)) {
        throw new EmberConfigurationError(
          'EmberCrypto.randomUuid returned a non-canonical identifier.',
        );
      }
      const bodySha256 = await sha256Hex(this.crypto, utf8(body ?? ''));
      const payload = walletRequestPayload({
        bodySha256,
        jti,
        method,
        pathAndQuery: path,
        sessionId: session.sessionId,
        timestamp,
      });
      let signature: Uint8Array;
      try {
        signature = await signer.signMessage(payload);
      } catch (cause) {
        throw new EmberSigningError('The Ember session signer failed.', { cause });
      }
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        throw new EmberConfigurationError(
          'Session signer must return an exact 64-byte Ed25519 signature.',
        );
      }
      return {
        'content-type': 'application/json',
        ...(definition.options?.idempotencyKey
          ? { 'idempotency-key': definition.options.idempotencyKey }
          : {}),
        ...hostBindingHeaders(this.hostBinding),
        'x-ember-wallet-jti': jti,
        'x-ember-wallet-session': session.sessionId,
        'x-ember-wallet-signature': base64Encode(signature),
        'x-ember-wallet-timestamp': timestamp,
      };
    });
  }

  private async request<T>(
    definition: RequestDefinition<T>,
    headersForAttempt: (
      body: string | undefined,
      method: string,
      path: string,
    ) => Promise<Record<string, string>>,
  ): Promise<T> {
    const body = definition.body === undefined ? undefined : JSON.stringify(definition.body);
    let lastError: unknown;
    const retries = definition.idempotent ? this.retry.maxRetries : 0;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        const exponential = this.retry.minBackoffMs * 2 ** (attempt - 1);
        const serverDelay =
          lastError instanceof EmberApiError ? lastError.retryAfterMs : undefined;
        await pause(
          Math.min(
            this.retry.maxBackoffMs,
            Math.max(exponential, serverDelay ?? 0),
          ),
          definition.options?.signal,
        );
      }
      try {
        return await this.attempt(
          definition,
          attempt,
          body,
          await headersForAttempt(body, definition.method, definition.path),
        );
      } catch (error) {
        lastError = error;
        if (
          attempt >= retries ||
          error instanceof EmberAbortError ||
          error instanceof EmberResponseValidationError ||
          error instanceof EmberConfigurationError ||
          error instanceof EmberSigningError ||
          (error instanceof EmberApiError && !retryableStatus(error.status))
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async attempt<T>(
    definition: RequestDefinition<T>,
    attempt: number,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, definition.timeoutMs);
    const callerSignal = definition.options?.signal;
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (callerSignal?.aborted) throw new EmberAbortError(definition.path);
      const response = await this.fetch(`${this.baseUrl}${definition.path}`, {
        method: definition.method,
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const parsed = await this.parseApiError(response);
        this.emit(definition, attempt, startedAt, 'api_error', response.status);
        throw new EmberApiError(
          response.status,
          parsed,
          retryAfterMs(response, this.now()),
        );
      }
      const value = await this.validatedJson(response, definition.path, definition.schema);
      this.emit(definition, attempt, startedAt, 'success', response.status);
      return value;
    } catch (error) {
      if (
        error instanceof EmberApiError ||
        error instanceof EmberResponseValidationError ||
        error instanceof EmberAbortError
      ) {
        throw error;
      }
      if (timedOut) {
        this.emit(definition, attempt, startedAt, 'timeout');
        throw new EmberTimeoutError(definition.path, definition.timeoutMs, {
          cause: error,
        });
      }
      if (callerSignal?.aborted) {
        this.emit(definition, attempt, startedAt, 'aborted');
        throw new EmberAbortError(definition.path, { cause: error });
      }
      this.emit(definition, attempt, startedAt, 'network_error');
      throw new EmberNetworkError(definition.path, { cause: error });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }

  private async parseApiError(response: Response): Promise<ApiErrorResponse | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await response.text()) as unknown;
    } catch {
      return undefined;
    }
    const parsed = zApiErrorResponse.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  private async validatedJson<T>(
    response: Response,
    path: string,
    schema: ZodType<T>,
  ): Promise<T> {
    let value: unknown;
    try {
      value = (await response.json()) as unknown;
    } catch (cause) {
      throw new EmberResponseValidationError(
        path,
        [{ path: '$', message: 'Response body is not valid JSON.' }],
        { cause },
      );
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new EmberResponseValidationError(
      path,
      parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? '$' : `$.${issue.path.join('.')}`,
        message: issue.message,
      })),
      { cause: parsed.error },
    );
  }

  private emit(
    definition: RequestDefinition<unknown>,
    attempt: number,
    startedAt: number,
    outcome: EmberTelemetryEvent['outcome'],
    status?: number,
  ): void {
    try {
      this.config.telemetry?.({
        attempt,
        durationMs: Math.max(0, Date.now() - startedAt),
        operation: definition.operation,
        outcome,
        pathTemplate: definition.pathTemplate,
        ...(status === undefined ? {} : { status }),
      });
    } catch {
      // Telemetry cannot affect signing, decisions, or evidence delivery.
    }
  }
}
