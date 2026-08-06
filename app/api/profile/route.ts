import { type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { apiError, apiSuccess, getRequestId } from '@/lib/api-response';

/**
 * Everything the profile page needs in one call: the account's own details,
 * what it has saved, and what it has uploaded.
 *
 * Three round trips from the browser would each re-authenticate and re-check
 * RLS for the same user, so they are collected here instead.
 */

export const dynamic = 'force-dynamic';

type Relation = Record<string, unknown> | Record<string, unknown>[] | null;

function relation(value: Relation) {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function text(value: Relation, key: string, fallback = '') {
  const row = relation(value);
  const found = row ? row[key] : null;
  return typeof found === 'string' && found.trim() ? found : fallback;
}

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request.headers.get('x-request-id'));
  try {
    const auth = await authenticateRequest(request);
    if (!auth) return apiError(401, 'AUTH_REQUIRED', 'Sign in to view your profile.', requestId);

    const [profileResult, savesResult, uploadsResult] = await Promise.all([
      auth.supabase
        .from('profiles')
        .select(
          'id, full_name, avatar, avatar_key, date_of_birth, country, institution_type, university_id, points, level, uploads, downloads, badge, verified, created_at, universities(name, short)',
        )
        .eq('id', auth.user.id)
        .maybeSingle(),
      auth.supabase
        .from('resource_bookmarks')
        .select(
          'created_at, resources(id, title, file_type, status, downloads, views, universities(name), courses(code))',
        )
        .eq('user_id', auth.user.id)
        .order('created_at', { ascending: false })
        .limit(50),
      auth.supabase
        .from('resources')
        .select(
          'id, title, description, file_type, status, downloads, views, bookmarks, created_at, moderation_reason, course_id, category_id, department, semester, universities(name), courses(code, title), categories(name)',
        )
        .eq('uploader_id', auth.user.id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    if (profileResult.error || !profileResult.data) {
      console.error('profile.load.failed', { requestId, code: profileResult.error?.code });
      return apiError(503, 'PROFILE_UNAVAILABLE', 'Your profile is temporarily unavailable.', requestId);
    }

    const row = profileResult.data;
    const profile = {
      id: row.id,
      email: auth.user.email ?? '',
      fullName: (row.full_name ?? '').trim(),
      avatar: row.avatar ?? '',
      hasPhoto: Boolean(row.avatar_key),
      dateOfBirth: row.date_of_birth ?? '',
      country: row.country ?? '',
      institutionType: row.institution_type ?? '',
      universityId: row.university_id ?? '',
      universityName: text(row.universities as Relation, 'name'),
      universityShort: text(row.universities as Relation, 'short'),
      points: row.points ?? 0,
      level: row.level ?? 1,
      uploads: row.uploads ?? 0,
      downloads: row.downloads ?? 0,
      badge: row.badge ?? 'Newbie',
      verified: Boolean(row.verified),
      memberSince: row.created_at,
    };

    const saves = (savesResult.data ?? [])
      .map((entry) => {
        const resource = relation(entry.resources as Relation);
        if (!resource) return null;
        return {
          id: String(resource.id),
          title: String(resource.title ?? ''),
          fileType: (resource.file_type as string) ?? null,
          status: String(resource.status ?? ''),
          downloads: Number(resource.downloads ?? 0),
          views: Number(resource.views ?? 0),
          university: text(resource.universities as Relation, 'name', 'No institution'),
          courseCode: text(resource.courses as Relation, 'code') || null,
          savedAt: entry.created_at as string,
        };
      })
      .filter(Boolean);

    const uploads = (uploadsResult.data ?? []).map((resource) => ({
      id: String(resource.id),
      title: String(resource.title ?? ''),
      description: (resource.description as string) ?? '',
      fileType: (resource.file_type as string) ?? null,
      status: String(resource.status ?? ''),
      downloads: Number(resource.downloads ?? 0),
      views: Number(resource.views ?? 0),
      bookmarks: Number(resource.bookmarks ?? 0),
      createdAt: resource.created_at as string,
      moderationReason: (resource.moderation_reason as string) ?? '',
      courseId: (resource.course_id as string) ?? '',
      categoryId: (resource.category_id as string) ?? '',
      department: (resource.department as string) ?? '',
      semester: (resource.semester as string) ?? '',
      university: text(resource.universities as Relation, 'name', 'No institution'),
      courseCode: text(resource.courses as Relation, 'code') || null,
      category: text(resource.categories as Relation, 'name') || null,
    }));

    return apiSuccess({ profile, saves, uploads }, requestId);
  } catch {
    console.error('profile.load.unexpected', { requestId });
    return apiError(500, 'INTERNAL_ERROR', 'Your profile could not be loaded.', requestId);
  }
}
