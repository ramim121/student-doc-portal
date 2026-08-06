import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  query: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
});

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const parsed = listSchema.safeParse({
    query: request.nextUrl.searchParams.get('q') ?? '',
    page: request.nextUrl.searchParams.get('page') ?? 1,
    pageSize: request.nextUrl.searchParams.get('pageSize') ?? 24,
  });
  if (!parsed.success) {
    return apiError(400, 'INVALID_UNIVERSITY_SEARCH', 'University search parameters are invalid.', requestId);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('list_universities_v2', {
      query_text: parsed.data.query,
      page_number: parsed.data.page,
      page_size: parsed.data.pageSize,
    });
    if (error) {
      console.error('universities.list.failed', { requestId, code: error.code });
      return apiError(503, 'CATALOG_UNAVAILABLE', 'Universities are temporarily unavailable.', requestId);
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    const total = rows.length ? Number(rows[0].total_count ?? 0) : 0;
    const totalPages = total ? Math.ceil(total / parsed.data.pageSize) : 0;
    return apiSuccess({
      universities: rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        short: String(row.short),
        country: String(row.country),
        color: typeof row.color === 'string' && row.color ? row.color : 'from-primary to-secondary',
        departments: Number(row.departments_count ?? 0),
        resources: Number(row.resource_count ?? 0),
        contributors: Number(row.contributor_count ?? 0),
        hasLogo: Boolean(row.has_logo),
      })),
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages,
      hasMore: parsed.data.page < totalPages,
    }, requestId);
  } catch {
    console.error('universities.list.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'Universities could not be loaded.', requestId);
  }
}
