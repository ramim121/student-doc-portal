import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateRequest } from '@/lib/api-auth';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { isTrustedMutationOrigin } from '@/lib/request-security';

/**
 * Bookmark ownership lives in resource_bookmarks; resources.bookmarks is kept
 * in sync by a database trigger, so the count cannot drift from the rows.
 *
 * The UI previously held "saved" in React state, so the star reset on every
 * navigation and nothing was ever persisted.
 */

const idSchema = z.string().uuid();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const { id } = await params;

  try {
    if (!isTrustedMutationOrigin(request)) {
      return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    }
    if (!idSchema.safeParse(id).success) {
      return apiError(400, 'INVALID_RESOURCE_ID', 'The resource identifier is invalid.', requestId);
    }
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to save resources.', requestId);
    if (auth.accountStatus !== 'active') {
      return apiError(403, 'ACCOUNT_RESTRICTED', 'This account cannot save resources.', requestId);
    }

    // Idempotent: saving twice is a no-op rather than a duplicate-key error.
    // ignoreDuplicates makes this ON CONFLICT DO NOTHING. A plain upsert emits
    // DO UPDATE, which RLS rejects because the table has no UPDATE policy - a
    // double tap then 409'd and the optimistic star flipped back to unsaved
    // even though the row was there. Nothing in the row is mutable anyway.
    const { error } = await auth.supabase
      .from('resource_bookmarks')
      .upsert(
        { user_id: auth.user.id, resource_id: id },
        { onConflict: 'user_id,resource_id', ignoreDuplicates: true },
      );

    if (error) {
      console.error('bookmark.add.failed', { requestId, code: error.code });
      return apiError(409, 'BOOKMARK_FAILED', 'The resource could not be saved.', requestId);
    }

    return apiSuccess({ bookmarked: true }, requestId);
  } catch {
    console.error('bookmark.add.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'The resource could not be saved.', requestId);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const { id } = await params;

  try {
    if (!isTrustedMutationOrigin(request)) {
      return apiError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.', requestId);
    }
    if (!idSchema.safeParse(id).success) {
      return apiError(400, 'INVALID_RESOURCE_ID', 'The resource identifier is invalid.', requestId);
    }
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to manage saved resources.', requestId);

    const { error } = await auth.supabase
      .from('resource_bookmarks')
      .delete()
      .eq('user_id', auth.user.id)
      .eq('resource_id', id);

    if (error) {
      console.error('bookmark.remove.failed', { requestId, code: error.code });
      return apiError(409, 'BOOKMARK_FAILED', 'The resource could not be unsaved.', requestId);
    }

    return apiSuccess({ bookmarked: false }, requestId);
  } catch {
    console.error('bookmark.remove.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'The resource could not be unsaved.', requestId);
  }
}

/** Whether the signed-in user has saved this resource. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const { id } = await params;

  try {
    if (!idSchema.safeParse(id).success) {
      return apiError(400, 'INVALID_RESOURCE_ID', 'The resource identifier is invalid.', requestId);
    }
    const auth = await authenticateRequest(request);
    // Anonymous visitors simply have nothing saved; that is not an error.
    if (!auth) return apiSuccess({ bookmarked: false }, requestId);

    const { data } = await auth.supabase
      .from('resource_bookmarks')
      .select('resource_id')
      .eq('user_id', auth.user.id)
      .eq('resource_id', id)
      .maybeSingle();

    return apiSuccess({ bookmarked: Boolean(data) }, requestId);
  } catch {
    console.error('bookmark.status.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'The bookmark state could not be read.', requestId);
  }
}
