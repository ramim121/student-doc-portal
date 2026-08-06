import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(3).max(50).default(20),
});

/** Initials for a contributor who has no stored avatar text. */
function initialsFrom(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'SD';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const parsed = paginationSchema.safeParse({
    page: request.nextUrl.searchParams.get('page') ?? 1,
    pageSize: request.nextUrl.searchParams.get('pageSize') ?? 20,
  });
  if (!parsed.success) return apiError(400, 'INVALID_PAGE', 'Leaderboard pagination is invalid.', requestId);

  try {
    const from = (parsed.data.page - 1) * parsed.data.pageSize;
    const to = from + parsed.data.pageSize - 1;
    const supabase = await createServerSupabaseClient();
    // Staff are excluded inside the function rather than here: authenticated
    // cannot read profiles.role, and granting it just to filter would publish
    // who holds admin.
    const { data, error } = await supabase.rpc('list_leaderboard', {
      page_number: parsed.data.page,
      page_size: parsed.data.pageSize,
    });
    if (error) {
      console.error('leaderboard.list.failed', { requestId, code: error.code });
      return apiError(503, 'LEADERBOARD_UNAVAILABLE', 'Leaderboard is temporarily unavailable.', requestId);
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const total = rows.length ? Number(rows[0].total_count ?? 0) : 0;
    const totalPages = total ? Math.ceil(total / parsed.data.pageSize) : 0;
    const contributors = rows.map((profile, index) => {
      const name = typeof profile.full_name === 'string' ? profile.full_name.trim() : '';
      return {
        id: String(profile.id),
        // Someone who has not set a name yet still occupies a rank, so the row
        // needs a label rather than being blank.
        name: name || 'Unnamed contributor',
        avatar: (profile.avatar as string) || initialsFrom(name),
        avatarKey: (profile.avatar_key as string) || null,
        university: (profile.university_name as string) || 'Independent',
        points: Number(profile.points ?? 0),
        level: Number(profile.level ?? 1),
        uploads: Number(profile.uploads ?? 0),
        downloads: Number(profile.downloads ?? 0),
        badge: profile.badge as string,
        verified: Boolean(profile.verified),
        rank: from + index + 1,
      };
    });

    return apiSuccess({ contributors, page: parsed.data.page, pageSize: parsed.data.pageSize, total, totalPages, hasMore: parsed.data.page < totalPages }, requestId);
  } catch {
    console.error('leaderboard.list.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'Leaderboard could not be loaded.', requestId);
  }
}
