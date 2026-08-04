import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { consumeApiRateLimit } from '@/lib/api-rate-limit';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { getR2UploadPresignedUrl } from '@/lib/cloudflare-r2';
import { hasVerifiedEmail, isTrustedMutationOrigin, uploadRequiresVerifiedEmail } from '@/lib/request-security';
import {
  getUploadMaxBytes,
  isAllowedUploadPair,
  presignRequestSchema,
} from '@/lib/upload-policy';

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
    if (!isTrustedMutationOrigin(request)) return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to upload files.', requestId);
    if (auth.accountStatus !== 'active') return apiError(403, 'ACCOUNT_RESTRICTED', 'This account cannot upload files.', requestId);
    if (uploadRequiresVerifiedEmail() && !hasVerifiedEmail(auth.user)) return apiError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email address before uploading.', requestId);
    const rateLimit = await consumeApiRateLimit(auth, 'upload.presign', request);
    if (!rateLimit.allowed) return apiError(429, 'RATE_LIMITED', `Too many upload requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`, requestId);

    const parsed = presignRequestSchema.safeParse(await request.json());
    if (!parsed.success) return apiError(400, 'INVALID_UPLOAD_METADATA', 'File name, type, size, or checksum is invalid.', requestId);
    if (parsed.data.sizeBytes > getUploadMaxBytes()) return apiError(413, 'FILE_TOO_LARGE', 'The file exceeds the configured upload limit.', requestId);
    if (!isAllowedUploadPair(parsed.data.fileName, parsed.data.contentType)) return apiError(415, 'UNSUPPORTED_FILE_TYPE', 'The file extension and content type are not an allowed pair.', requestId);

    const storageKey = `resources/${auth.user.id}/${randomUUID()}-${sanitizeFileName(parsed.data.fileName)}`;
    const expiresInSeconds = 900;
    const uploadUrl = await getR2UploadPresignedUrl(storageKey, parsed.data.contentType, expiresInSeconds);
    // Content-Type is the only signed header. Sending x-amz-checksum-sha256
    // here would invalidate the signature; see getR2UploadPresignedUrl.
    const requiredHeaders: Record<string, string> = { 'Content-Type': parsed.data.contentType };

    return apiSuccess({
      uploadUrl,
      storageKey,
      storageProvider: 'r2',
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      requiredHeaders,
    }, requestId);
  } catch {
    console.error('upload.presign.failed', { requestId });
    return apiError(500, 'UPLOAD_SESSION_FAILED', 'Could not prepare the upload.', requestId);
  }
}
