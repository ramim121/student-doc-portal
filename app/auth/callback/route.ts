import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { getSafeRedirectPath } from '@/lib/safe-redirect';

/**
 * Two different things land here.
 *
 * 1. OAuth (Google) finishes with `?code=`, exchanged for a session.
 * 2. Emailed links carry `?token_hash=&type=`, verified with verifyOtp.
 *
 * Only the first was handled, so every confirmation and password-reset link
 * fell through to the error branch. Supabase's `{{ .ConfirmationURL }}` goes
 * via /auth/v1/verify, which returns the session in a URL *fragment* that a
 * server route can never read — hence the token_hash form in the templates.
 */
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
];

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && EMAIL_OTP_TYPES.includes(value as EmailOtpType);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  const next = getSafeRedirectPath(params.get('next'), '/dashboard');

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.url));
  } else if (tokenHash && isEmailOtpType(type)) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, request.url));
  }

  const errorUrl = new URL('/auth', request.url);
  errorUrl.searchParams.set(
    'error',
    'The authentication link is invalid or has expired. Please try again.',
  );
  return NextResponse.redirect(errorUrl);
}
