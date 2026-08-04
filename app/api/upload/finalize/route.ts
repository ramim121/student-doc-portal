import { type NextRequest } from 'next/server';
import { authenticateRequest, type AuthenticatedRequest } from '@/lib/api-auth';
import { consumeApiRateLimit } from '@/lib/api-rate-limit';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { deleteR2Object, headR2Object } from '@/lib/cloudflare-r2';
import { isGeminiConfigured } from '@/lib/gemini';
import { hasVerifiedEmail, isTrustedMutationOrigin, uploadRequiresVerifiedEmail } from '@/lib/request-security';
import {
  finalizeUploadSchema,
  getUploadMaxBytes,
  isAllowedUploadPair,
  keyBelongsToUser,
  resourceFileType,
} from '@/lib/upload-policy';

async function existingFinalization(auth: AuthenticatedRequest, storageKey: string) {
  const { data } = await auth.supabase
    .from('resources')
    .select('id, status, ai_status')
    .eq('storage_provider', 'r2')
    .eq('storage_key', storageKey)
    .maybeSingle();
  return data;
}

async function cleanOrQueue(auth: AuthenticatedRequest, storageKey: string, reason: string, requestId: string) {
  try {
    await deleteR2Object(storageKey);
    return 'deleted' as const;
  } catch {
    const { error } = await auth.supabase.rpc('enqueue_own_storage_cleanup', {
      p_storage_key: storageKey,
      p_reason: reason,
    });
    if (error) console.error('upload.cleanup.enqueue_failed', { requestId, code: error.code });
    return error ? 'untracked' as const : 'queued' as const;
  }
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  try {
    if (!isTrustedMutationOrigin(request)) return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to finalize uploads.', requestId);
    if (auth.accountStatus !== 'active') return apiError(403, 'ACCOUNT_RESTRICTED', 'This account cannot finalize uploads.', requestId);
    if (uploadRequiresVerifiedEmail() && !hasVerifiedEmail(auth.user)) return apiError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email address before finalizing uploads.', requestId);
    const rateLimit = await consumeApiRateLimit(auth, 'upload.finalize', request);
    if (!rateLimit.allowed) return apiError(429, 'RATE_LIMITED', `Too many finalization requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`, requestId);

    const parsed = finalizeUploadSchema.safeParse(await request.json());
    if (!parsed.success) {
      // Naming the offending fields is the difference between a user fixing
      // their form and giving up. Values are never echoed back.
      const fields = Array.from(
        new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
      );
      return apiError(
        400,
        'INVALID_FINALIZATION',
        `Check these fields and try again: ${fields.join(', ')}.`,
        requestId,
        fields,
      );
    }
    const input = parsed.data;
    if (input.sizeBytes > getUploadMaxBytes()) return apiError(413, 'FILE_TOO_LARGE', 'The uploaded file exceeds the configured limit.', requestId);
    if (!isAllowedUploadPair(input.fileName, input.contentType)) return apiError(415, 'UNSUPPORTED_FILE_TYPE', 'The file extension and content type are not an allowed pair.', requestId);
    if (!keyBelongsToUser(input.storageKey, auth.user.id)) return apiError(403, 'INVALID_STORAGE_KEY', 'The storage key does not belong to this account.', requestId);

    const existing = await existingFinalization(auth, input.storageKey);
    if (existing) {
      return apiSuccess({ resourceId: existing.id, status: existing.status, aiStatus: existing.ai_status, idempotent: true }, requestId);
    }

    let objectMetadata: Awaited<ReturnType<typeof headR2Object>>;
    try {
      objectMetadata = await headR2Object(input.storageKey);
    } catch {
      return apiError(409, 'OBJECT_NOT_FOUND', 'The uploaded object could not be verified. Upload the file again.', requestId);
    }

    const actualContentType = objectMetadata.contentType?.split(';', 1)[0].trim().toLowerCase();
    const expectedContentType = input.contentType.toLowerCase();
    const mismatch = objectMetadata.contentLength !== input.sizeBytes
      || actualContentType !== expectedContentType
      || (input.checksumSha256 && objectMetadata.checksumSha256 && input.checksumSha256 !== objectMetadata.checksumSha256);
    if (mismatch) {
      const cleanup = await cleanOrQueue(auth, input.storageKey, 'upload_metadata_mismatch', requestId);
      console.warn('upload.finalize.metadata_mismatch', { requestId, cleanup });
      return apiError(409, 'OBJECT_METADATA_MISMATCH', 'The uploaded object does not match the expected file metadata.', requestId);
    }

    const { data, error } = await auth.supabase.rpc('finalize_resource_upload', {
      p_storage_key: input.storageKey,
      p_original_file_name: input.fileName,
      p_mime_type: input.contentType,
      p_size_bytes: input.sizeBytes,
      p_checksum_sha256: input.checksumSha256 ?? null,
      p_title: input.title,
      p_description: input.description,
      p_university_id: input.universityId,
      p_course_id: input.courseId,
      p_category_id: input.categoryId ?? null,
      p_department: input.department,
      p_course_code: input.courseCode,
      p_semester: input.semester,
      p_subject: input.subject,
      p_file_type: resourceFileType(input.fileName),
      p_tags: Array.from(new Set(input.tags.map((tag) => tag.toLowerCase()))),
      p_ai_requested: input.contentType === 'application/pdf' && isGeminiConfigured(),
    });

    if (error) {
      const committed = await existingFinalization(auth, input.storageKey);
      if (committed) return apiSuccess({ resourceId: committed.id, status: committed.status, aiStatus: committed.ai_status, idempotent: true }, requestId);
      const cleanup = await cleanOrQueue(auth, input.storageKey, 'database_finalization_failed', requestId);
      console.error('upload.finalize.database_failed', { requestId, code: error.code, cleanup });
      return apiError(409, 'FINALIZATION_FAILED', 'The resource record could not be finalized. The uploaded object was cleaned up or queued for cleanup.', requestId);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return apiSuccess({
      resourceId: row?.id,
      status: row?.status ?? 'pending',
      aiStatus: row?.ai_status ?? 'not_requested',
      idempotent: false,
    }, requestId);
  } catch {
    console.error('upload.finalize.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'The upload could not be finalized.', requestId);
  }
}
