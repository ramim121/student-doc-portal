import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getR2ObjectBytes } from '@/lib/cloudflare-r2';
import { createServiceRoleSupabaseClient } from '@/lib/supabase-admin';

/**
 * Serves an institution logo to anyone, signed in or not.
 *
 * The bucket is private, so the row stores an object key and the bytes are
 * streamed through here. A presigned URL would have been less work but expires,
 * which makes it useless as a stable <img src>.
 *
 * Only universities.logo_key is ever read - the key never comes from the
 * request - so this cannot be pointed at documents elsewhere in the bucket.
 */

const idSchema = z.string().uuid();

/** Logos are small; anything larger is a mistake rather than a logo. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

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
    return NextResponse.json({ error: 'Invalid institution id.' }, { status: 400 });
  }

  const supabase = createServiceRoleSupabaseClient();
  const { data: university, error } = await supabase
    .from('universities')
    .select('logo_key, logo_updated_at')
    .eq('id', id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Lookup failed.' }, { status: 500 });
  if (!university?.logo_key) {
    // Not an error: most institutions render as a monogram instead.
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  let bytes: Uint8Array;
  try {
    bytes = await getR2ObjectBytes(university.logo_key, MAX_LOGO_BYTES);
  } catch {
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  // A fresh ArrayBuffer, not the Uint8Array's own: TypeScript types the latter
  // as ArrayBufferLike, which BodyInit does not accept.
  const body = new Uint8Array(bytes).buffer as ArrayBuffer;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(university.logo_key),
      'Content-Length': String(bytes.byteLength),
      // The URL stays the same when a logo is replaced or removed, so the
      // window is kept short deliberately. A day-long stale-while-revalidate
      // would let an edge keep serving a logo that has already been deleted.
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      ETag: `"${university.logo_updated_at ?? 'none'}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
