import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getR2ObjectBytes } from '@/lib/cloudflare-r2';
import { createServiceRoleSupabaseClient } from '@/lib/supabase-admin';

/**
 * Serves a profile photo to anyone.
 *
 * The bucket is private, so the row stores an object key and the bytes are
 * streamed through here - a presigned URL expires and is useless as a stable
 * <img src>. Only profiles.avatar_key is read; the key never comes from the
 * request, so this cannot be aimed at documents elsewhere in the bucket.
 */

const idSchema = z.string().uuid();
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function contentTypeFor(key: string) {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid profile id.' }, { status: 400 });
  }

  const supabase = createServiceRoleSupabaseClient();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('avatar_key')
    .eq('id', id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Lookup failed.' }, { status: 500 });
  if (!profile?.avatar_key) {
    // Not an error: most people render as initials instead.
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  let bytes: Uint8Array;
  try {
    bytes = await getR2ObjectBytes(profile.avatar_key, MAX_AVATAR_BYTES);
  } catch {
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const body = new Uint8Array(bytes).buffer as ArrayBuffer;
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(profile.avatar_key),
      'Content-Length': String(bytes.byteLength),
      // The URL does not change when a photo is replaced or removed, so the
      // window stays short rather than letting an edge serve a stale face.
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
