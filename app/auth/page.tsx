'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Sparkles,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSafeRedirectPath } from '@/lib/safe-redirect';
import { supabase } from '@/lib/supabase';

function AuthForm() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verificationPending, setVerificationPending] = useState(false);
  const [resendCoolingDown, setResendCoolingDown] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = getSafeRedirectPath(searchParams.get('next'), '/dashboard');
  const callbackErrorValue = searchParams.get('error');
  const callbackError = callbackErrorValue === 'account_unavailable'
    ? 'This account is unavailable. Contact support if you believe this is an error.'
    : callbackErrorValue === 'The authentication link is invalid or has expired. Please try again.'
      ? callbackErrorValue
      : '';
  const callbackNotice = searchParams.get('message') === 'Password updated. Sign in with your new password.'
    ? 'Password updated. Sign in with your new password.'
    : '';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);

    try {
      if (mode === 'signup') {
        if (fullName.trim().length < 2) {
          throw new Error('Enter your full name.');
        }
        if (password.length < 8) {
          throw new Error('Use a password with at least 8 characters.');
        }

        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: fullName.trim() },
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
          },
        });
        if (signUpError) throw signUpError;

        if (!data.session) {
          setVerificationPending(true);
          setNotice('Check your email to verify your account, then return to sign in.');
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      }

      router.replace(nextPath);
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      if (/invalid login credentials/i.test(message)) {
        setError('The email or password is incorrect.');
      } else if (/already registered|user already/i.test(message)) {
        setError('Unable to create the account. Try signing in or resetting your password.');
      } else {
        setError(message || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    if (!email.trim() || resendCoolingDown) return;
    setError('');
    setResendCoolingDown(true);
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}` },
    });
    if (resendError) setError('Verification email could not be resent yet. Wait and try again.');
    else setNotice('If verification is still required, a new email is on its way.');
    window.setTimeout(() => setResendCoolingDown(false), 60_000);
  };

  const handleOAuth = async (provider: 'google') => {
    setError('');
    setNotice('');
    setLoading(true);

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
      },
    });

    if (oauthError) {
      setError('Google sign-in is unavailable. Use email instead.');
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-[calc(100vh-5rem)] overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="mesh-bg absolute inset-0" />
        <motion.div
          className="absolute left-[15%] top-[20%] h-72 w-72 rounded-full bg-primary/20 blur-[100px]"
          animate={{ scale: [1, 1.15, 1], opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 8, repeat: Infinity }}
        />
        <motion.div
          className="absolute bottom-[20%] right-[15%] h-80 w-80 rounded-full bg-secondary/20 blur-[110px]"
          animate={{ scale: [1.1, 1, 1.1], opacity: [0.2, 0.35, 0.2] }}
          transition={{ duration: 10, repeat: Infinity }}
        />
      </div>

      <div className="relative z-10 mx-auto flex max-w-md flex-col items-center px-4 py-12">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary shadow-glow">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <span className="font-display text-xl font-bold tracking-tight">StudyDock</span>
        </Link>

        <motion.div
          key={mode}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="glass-strong mt-8 w-full rounded-3xl p-8 shadow-glass"
        >
          <h1 className="font-display text-2xl font-bold">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {mode === 'login'
              ? 'Sign in to access your dashboard and resources.'
              : 'Join students sharing knowledge worldwide.'}
          </p>

          <div className="mt-6">
            <button
              type="button"
              disabled={loading}
              onClick={() => handleOAuth('google')}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm font-medium transition-all hover:border-primary/40 hover:shadow-soft disabled:opacity-60"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Google
            </button>
          </div>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or continue with email</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label htmlFor="full-name" className="mb-1.5 block text-sm font-semibold">Full name</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    required
                    id="full-name"
                    type="text"
                    autoComplete="name"
                    placeholder="Jane Doe"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    className="form-input pl-10"
                  />
                </div>
              </div>
            )}
            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-semibold">Email</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  required
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@university.edu"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="form-input pl-10"
                />
              </div>
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-semibold">Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  required
                  id="password"
                  minLength={8}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="8+ characters"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="form-input px-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {(error || callbackError) && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error || callbackError}
              </p>
            )}

            {(notice || callbackNotice) && (
              <p role="status" className="flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                {notice || callbackNotice}
              </p>
            )}

            {verificationPending && (
              <button type="button" disabled={resendCoolingDown} onClick={() => void resendVerification()} className="text-sm font-semibold text-primary hover:underline disabled:opacity-50">
                {resendCoolingDown ? 'Resend available in one minute' : 'Resend verification email'}
              </button>
            )}

            {mode === 'login' && (
              <div className="flex justify-end">
                <Link href="/auth/forgot" className="text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="h-12 w-full rounded-2xl bg-gradient-to-r from-primary to-secondary text-base shadow-glow"
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>
                  {mode === 'login' ? 'Sign in' : 'Create account'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setError('');
                setNotice('');
              }}
              className="font-semibold text-primary hover:underline"
            >
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </motion.div>

        {mode === 'signup' && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Use an address you can access so account verification and recovery work reliably.
          </p>
        )}
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <AuthForm />
    </Suspense>
  );
}
