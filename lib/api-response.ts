import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

export function getRequestId(existing: string | null) {
  const candidate = existing?.trim();
  return candidate && /^[a-zA-Z0-9._-]{8,128}$/.test(candidate)
    ? candidate
    : randomUUID();
}

export function apiError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  /**
   * Names of the request fields that failed validation. Field names only —
   * never the submitted values, which would echo user content into logs.
   */
  fields?: string[],
) {
  return NextResponse.json(
    {
      error: { code, message, ...(fields?.length ? { fields } : {}) },
      requestId,
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
      },
    },
  );
}

export function apiSuccess(body: Record<string, unknown>, requestId: string) {
  return NextResponse.json(
    { ...body, requestId },
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
      },
    },
  );
}
