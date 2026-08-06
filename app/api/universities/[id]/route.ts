import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';
import { mapCatalogResource } from '@/lib/catalog';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  const parsedId = z.string().uuid().safeParse((await params).id);
  if (!parsedId.success) {
    return apiError(404, 'UNIVERSITY_NOT_FOUND', 'University not found.', requestId);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data: university, error: universityError } = await supabase
      .from('universities')
      .select('id, name, short, country, color, departments_count, logo_key')
      .eq('id', parsedId.data)
      .maybeSingle();
    if (universityError) {
      console.error('universities.detail.failed', { requestId, code: universityError.code });
      return apiError(503, 'CATALOG_UNAVAILABLE', 'University details are temporarily unavailable.', requestId);
    }
    if (!university) {
      return apiError(404, 'UNIVERSITY_NOT_FOUND', 'University not found.', requestId);
    }

    const [departmentsResult, subjectsResult, contributorsResult, contributorCountResult, resourcesResult] = await Promise.all([
      supabase.from('departments').select('name').eq('university_id', parsedId.data).order('name').limit(100),
      supabase.from('subjects').select('name').eq('university_id', parsedId.data).order('name').limit(100),
      supabase.from('profiles').select('id, full_name, avatar, points, level, uploads, downloads, badge, verified').eq('university_id', parsedId.data).order('points', { ascending: false }).limit(5),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('university_id', parsedId.data),
      supabase.rpc('search_resources_v2', {
        query_text: '', university_filter: parsedId.data, course_filter: null,
        category_filter: null, file_type_filter: null, sort_by: 'trending',
        page_number: 1, page_size: 12,
      }),
    ]);

    const firstError = departmentsResult.error ?? subjectsResult.error ?? contributorsResult.error ?? contributorCountResult.error ?? resourcesResult.error;
    if (firstError) {
      console.error('universities.detail.related_failed', { requestId, code: firstError.code });
      return apiError(503, 'CATALOG_UNAVAILABLE', 'University content is temporarily unavailable.', requestId);
    }

    const resourceRows = (resourcesResult.data ?? []) as Record<string, unknown>[];
    const resourceCount = resourceRows.length ? Number(resourceRows[0].total_count ?? 0) : 0;
    const contributors = (contributorsResult.data ?? []).map((profile, index) => ({
      id: profile.id,
      name: profile.full_name,
      avatar: profile.avatar || 'SD',
      university: university.name,
      points: profile.points,
      level: profile.level,
      uploads: profile.uploads,
      downloads: profile.downloads,
      badge: profile.badge,
      verified: profile.verified,
      rank: index + 1,
    }));

    return apiSuccess({
      university: {
        id: university.id,
        name: university.name,
        short: university.short,
        country: university.country,
        color: university.color || 'from-primary to-secondary',
        // Only the flag: the storage key stays server-side.
        hasLogo: Boolean(university.logo_key),
        departments: university.departments_count,
        resources: resourceCount,
        contributors: contributorCountResult.count ?? 0,
        departments_list: (departmentsResult.data ?? []).map((item) => item.name),
        popularSubjects: (subjectsResult.data ?? []).map((item) => item.name),
      },
      contributors,
      resources: resourceRows.map(mapCatalogResource),
    }, requestId);
  } catch {
    console.error('universities.detail.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'University details could not be loaded.', requestId);
  }
}
