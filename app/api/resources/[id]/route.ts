import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { mapCatalogResource } from '@/lib/catalog';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const resourceIdSchema = z.string().uuid();
const resourceSelect = `
  id, title, description, department, course_code, semester, subject,
  file_type, file_size, size_bytes, pages, rating, rating_count, downloads, views,
  bookmarks, tags, trending, featured, premium, category_id, created_at,
  ai_summary, ai_topics, ai_status,
  universities(id, name, short),
  courses(id, code, title),
  categories(id, name),
  profiles(id, full_name, avatar, verified)
`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const parsedId = resourceIdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return apiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found.', requestId);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('resources')
      .select(resourceSelect)
      .eq('id', parsedId.data)
      .maybeSingle();

    if (error) {
      console.error('catalog.detail.failed', { requestId, code: error.code });
      return apiError(503, 'CATALOG_UNAVAILABLE', 'Resource details are temporarily unavailable.', requestId);
    }

    if (!data) {
      return apiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found.', requestId);
    }

    const resource = mapCatalogResource(data as unknown as Record<string, unknown>);

    // This route is fetched once per visit to the resource page, so it is where
    // a view is counted. Deliberately not awaited into the response: a counter
    // that cannot be written is no reason to fail the page. The RPC ignores
    // anything that is not approved.
    void supabase
      .rpc('increment_resource_view', { resource_id: resource.id })
      .then(({ error: viewError }) => {
        if (viewError) console.warn('catalog.view.count_failed', { requestId, code: viewError.code });
      });

    let related: ReturnType<typeof mapCatalogResource>[] = [];

    if (resource.category) {
      const { data: relatedData, error: relatedError } = await supabase
        .from('resources')
        .select(resourceSelect)
        .eq('category_id', resource.category)
        .neq('id', resource.id)
        .order('created_at', { ascending: false })
        .limit(3);

      if (relatedError) {
        console.error('catalog.related.failed', { requestId, code: relatedError.code });
      } else {
        related = (relatedData ?? []).map((row) =>
          mapCatalogResource(row as unknown as Record<string, unknown>),
        );
      }
    }

    return apiSuccess({ resource, related }, requestId);
  } catch {
    console.error('catalog.detail.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'Resource details could not be loaded.', requestId);
  }
}
