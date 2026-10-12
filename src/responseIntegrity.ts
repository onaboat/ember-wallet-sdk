import { EmberResponseMismatchError } from './errors';

export interface EvidenceUploadGrantInput {
  expiresAt: string;
  headers: Readonly<Record<string, string>>;
  method: string;
  url: string;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_UPLOAD_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
  'x-api-key',
]);

function unsafeGrant(field: string): never {
  throw new EmberResponseMismatchError(
    'claims.evidence.begin',
    field,
    'unsafe_upload_grant',
  );
}

/** Validate a short-lived evidence grant before a host can upload bytes. */
export function assertEvidenceUploadGrant(
  grant: EvidenceUploadGrantInput,
  now: Date,
): void {
  if (grant.method !== 'PUT') unsafeGrant('upload.method');

  let url: URL;
  try {
    url = new URL(grant.url);
  } catch {
    unsafeGrant('upload.url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    unsafeGrant('upload.url');
  }

  const expiry = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    unsafeGrant('upload.expiresAt');
  }

  for (const [name, value] of Object.entries(grant.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      FORBIDDEN_UPLOAD_HEADERS.has(normalizedName) ||
      normalizedName.startsWith('x-ember-') ||
      value.includes('\r') ||
      value.includes('\n')
    ) {
      unsafeGrant('upload.headers');
    }
  }
}
