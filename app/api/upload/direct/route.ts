import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { consumeApiRateLimit } from '@/lib/api-rate-limit';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { putR2Object } from '@/lib/cloudflare-r2';
import { hasVerifiedEmail, isTrustedMutationOrigin, uploadRequiresVerifiedEmail } from '@/lib/request-security';
import { getUploadMaxBytes, isAllowedUploadPair } from '@/lib/upload-policy';

/**
 * Fallback upload path: the browser sends the file here and the server writes
 * it to R2.
 *
 * The fast path is still the presigned PUT straight to R2 - it keeps the bytes
 * off our functions. But that PUT is a cross-origin request, so it only works
 * while the bucket's CORS policy names the exact origin the site is served
 * from. Moving to a custom domain silently broke it: the browser reported
 * "fetch failed" with no server log, because the request never reached anyone.
 *
 * Rather than leave uploading dependent on a bucket setting no deploy can
 * verify, the client falls back here when the direct PUT fails at network
 * level. Same auth, same limits, same key layout.
 */

/** Vercel accepts 100MB request bodies; stay under it with room for overhead. */
const MAX_PROXY_BYTES = 90 * 1024 * 1024;

function sanitizeFileName(fileName: string) {
  const safe = fileName
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(-160);
  return safe || 'resource.bin';
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  try {
    if (!isTrustedMutationOrigin(request)) {
      return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    }
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to upload files.', requestId);
    if (auth.accountStatus !== 'active') {
      return apiError(403, 'ACCOUNT_RESTRICTED', 'This account cannot upload files.', requestId);
    }
    if (uploadRequiresVerifiedEmail() && !hasVerifiedEmail(auth.user)) {
      return apiError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email address before uploading.', requestId);
    }
    const rateLimit = await consumeApiRateLimit(auth, 'upload.presign', request);
    if (!rateLimit.allowed) {
      return apiError(429, 'RATE_LIMITED', `Too many upload requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`, requestId);
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return apiError(400, 'NO_FILE', 'No file was received.', requestId);
    }
    if (file.size > Math.min(getUploadMaxBytes(), MAX_PROXY_BYTES)) {
      return apiError(413, 'FILE_TOO_LARGE', 'The file exceeds the upload limit for this route.', requestId);
    }
    if (!isAllowedUploadPair(file.name, file.type)) {
      return apiError(415, 'UNSUPPORTED_FILE_TYPE', 'The file extension and content type are not an allowed pair.', requestId);
    }

    // Derived from the signed-in user, never sent by the client, so nobody can
    // write over another account's objects.
    const storageKey = `resources/${auth.user.id}/${randomUUID()}-${sanitizeFileName(file.name)}`;

    try {
      await putR2Object(storageKey, new Uint8Array(await file.arrayBuffer()), file.type);
    } catch {
      console.error('upload.direct.store_failed', { requestId });
      return apiError(502, 'UPLOAD_FAILED', 'The file could not be stored.', requestId);
    }

    return apiSuccess({ storageKey, storageProvider: 'r2' }, requestId);
  } catch {
    console.error('upload.direct.failed', { requestId });
    return apiError(500, 'UPLOAD_SESSION_FAILED', 'Could not complete the upload.', requestId);
  }
}
