import { type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { deleteR2Object, putR2Object } from '@/lib/cloudflare-r2';
import { isTrustedMutationOrigin } from '@/lib/request-security';

/**
 * Profile photo upload and removal.
 *
 * Same shape as the institution logo: bytes go to R2 under a prefix, the row
 * keeps only the key, and the image is served back through its own route. The
 * key is derived from the signed-in user, never from the request, so nobody can
 * point their profile at another object in the bucket.
 */

/** Profile photos are small; the cap is what keeps the bucket sane. */
const MAX_BYTES = 1024 * 1024;

/** No SVG: it can carry script and these render on our own origin. */
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  try {
    if (!isTrustedMutationOrigin(request)) {
      return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    }
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to change your photo.', requestId);
    if (auth.accountStatus !== 'active') {
      return apiError(403, 'ACCOUNT_RESTRICTED', 'This account cannot change its photo.', requestId);
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return apiError(400, 'NO_FILE', 'Attach a PNG, JPEG or WebP image.', requestId);
    }
    const extension = ALLOWED[file.type];
    if (!extension) {
      return apiError(415, 'UNSUPPORTED_TYPE', 'Use a PNG, JPEG or WebP image.', requestId);
    }
    if (file.size > MAX_BYTES) {
      return apiError(413, 'TOO_LARGE', 'Photos must be 1 MB or smaller.', requestId);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const key = `avatars/${auth.user.id}/${crypto.randomUUID()}.${extension}`;

    try {
      await putR2Object(key, bytes, file.type);
    } catch {
      return apiError(502, 'UPLOAD_FAILED', 'The photo could not be stored.', requestId);
    }

    const { data: previousKey, error } = await auth.supabase.rpc('set_my_avatar', {
      p_avatar_key: key,
    });
    if (error) {
      // Nothing points at the object just written, so it must not be left.
      await deleteR2Object(key).catch(() => {});
      return apiError(409, 'AVATAR_NOT_SET', 'The photo could not be saved.', requestId);
    }
    if (previousKey && previousKey !== key) {
      await deleteR2Object(previousKey as string).catch(() => {});
    }

    return apiSuccess({ status: 'updated' }, requestId);
  } catch {
    console.error('profile.avatar.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'The photo could not be updated.', requestId);
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  try {
    if (!isTrustedMutationOrigin(request)) {
      return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    }
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to change your photo.', requestId);

    const { data: previousKey, error } = await auth.supabase.rpc('set_my_avatar', {
      p_avatar_key: null,
    });
    if (error) return apiError(409, 'AVATAR_NOT_CLEARED', 'The photo could not be removed.', requestId);
    if (previousKey) await deleteR2Object(previousKey as string).catch(() => {});

    return apiSuccess({ status: 'removed' }, requestId);
  } catch {
    console.error('profile.avatar.remove_unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'The photo could not be removed.', requestId);
  }
}
