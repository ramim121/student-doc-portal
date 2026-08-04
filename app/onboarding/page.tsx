'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowRight, Building2, GraduationCap, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchableSelect, type SearchableOption } from '@/components/searchable-select';
import { allCountries, countryCodeForName, countryNameForCode } from '@/lib/countries';
import { getSafeRedirectPath } from '@/lib/safe-redirect';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type InstitutionType = 'university' | 'high_school';

type InstitutionRow = {
  id: string;
  name: string;
  short: string;
  country: string;
  institution_type: InstitutionType;
  resource_count: number;
};

function toOption(row: InstitutionRow): SearchableOption {
  return {
    id: row.id,
    label: row.name,
    sublabel: row.short,
    hint: row.resource_count > 0 ? `${row.resource_count} resources` : undefined,
  };
}

function OnboardingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = getSafeRedirectPath(searchParams.get('next'), '/dashboard');

  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [countryCode, setCountryCode] = useState('');
  const [institutionType, setInstitutionType] = useState<InstitutionType | ''>('');
  const [institutionId, setInstitutionId] = useState('');

  const [institutions, setInstitutions] = useState<InstitutionRow[]>([]);
  const [loadingInstitutions, setLoadingInstitutions] = useState(false);
  const [search, setSearch] = useState('');

  const countries = useMemo(() => allCountries(), []);
  const countryName = countryNameForCode(countryCode);

  // Prefill from the profile: someone revisiting this page, or arriving via
  // Google where we may already know something, should not start blank.
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace(`/auth?next=${encodeURIComponent('/onboarding')}`);
        return;
      }
      const { data } = await supabase
        .from('profiles')
        .select('country, institution_type, university_id')
        .eq('id', session.user.id)
        .maybeSingle();

      if (data?.country) setCountryCode(countryCodeForName(data.country));
      if (data?.institution_type) setInstitutionType(data.institution_type as InstitutionType);
      if (data?.university_id) setInstitutionId(data.university_id);
      setReady(true);
    })();
  }, [router]);

  const loadInstitutions = useCallback(
    async (query: string) => {
      if (!countryName || !institutionType) return;
      setLoadingInstitutions(true);
      const { data, error: rpcError } = await supabase.rpc('list_institutions', {
        p_country: countryName,
        p_institution_type: institutionType,
        p_query: query,
        p_limit: 30,
      });
      if (!rpcError) setInstitutions((data ?? []) as InstitutionRow[]);
      setLoadingInstitutions(false);
    },
    [countryName, institutionType],
  );

  // Reload whenever the country or the kind of institution changes.
  useEffect(() => {
    setInstitutions([]);
    if (countryName && institutionType) void loadInstitutions('');
  }, [countryName, institutionType, loadInstitutions]);

  useEffect(() => {
    if (!search.trim()) return;
    const timer = window.setTimeout(() => void loadInstitutions(search), 250);
    return () => window.clearTimeout(timer);
  }, [search, loadInstitutions]);

  // list_institutions already puts the caller's own country first, so the
  // leading few are the likely answer and are worth surfacing as chips.
  const quickPicks = useMemo(
    () => institutions.filter((row) => row.country === countryName).slice(0, 4).map(toOption),
    [institutions, countryName],
  );

  const canContinue = Boolean(countryCode && institutionType && institutionId) && !saving;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canContinue) return;
    setSaving(true);
    setError('');

    const { error: rpcError } = await supabase.rpc('complete_onboarding', {
      p_country: countryName,
      p_institution_type: institutionType,
      p_university_id: institutionId || null,
    });

    if (rpcError) {
      setError(rpcError.message || 'We could not save that. Please try again.');
      setSaving(false);
      return;
    }

    // A hard navigation, not router.replace. Getting here means proxy.ts
    // already bounced the target back to /onboarding once, and that redirect
    // sits in the client router cache - replace() simply replays it and the
    // user stays on this page even though the profile saved. A full load
    // re-runs the middleware, which now lets them through.
    window.location.assign(next);
  };

  if (!ready) {
    return (
      <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:py-14">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="flex items-center gap-2 text-primary">
          <Sparkles className="h-5 w-5" />
          <span className="text-sm font-semibold">One quick step</span>
        </div>
        <h1 className="mt-3 font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Where do you study?
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          Tell us where you study so we can recommend the most relevant study materials.
        </p>
      </motion.div>

      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="mt-8 rounded-3xl border border-border bg-card p-6 shadow-soft sm:p-8"
      >
        <div>
          <label htmlFor="country" className="mb-1.5 block text-sm font-semibold">
            Your country
          </label>
          <select
            id="country"
            value={countryCode}
            onChange={(event) => setCountryCode(event.target.value)}
            className="filter-select w-full"
          >
            <option value="">Select your country</option>
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-5">
          <span className="mb-1.5 block text-sm font-semibold">You are currently in</span>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-background p-1">
            {([
              { value: 'university', label: 'University', Icon: Building2 },
              { value: 'high_school', label: 'High School', Icon: GraduationCap },
            ] as const).map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setInstitutionType(value)}
                aria-pressed={institutionType === value}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  institutionType === value
                    ? 'bg-primary/10 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {countryCode && institutionType && (
          <div className="mt-5">
            <label className="mb-1.5 block text-sm font-semibold">I study at</label>
            <SearchableSelect
              options={institutions.map(toOption)}
              value={institutionId}
              onChange={setInstitutionId}
              onSearch={setSearch}
              loading={loadingInstitutions}
              quickPicks={quickPicks}
              quickPicksLabel="Quick picks for you"
              placeholder={
                institutionType === 'university'
                  ? 'Type your university name'
                  : 'Type your school name'
              }
              emptyMessage={`No ${institutionType === 'university' ? 'universities' : 'schools'} found here yet.`}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Cannot find yours? Pick the closest for now - you can add it when you upload.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={!canContinue}
          className="mt-6 h-12 w-full rounded-2xl bg-gradient-to-r from-primary to-secondary text-base shadow-glow disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <>
              Continue
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </motion.form>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <OnboardingForm />
    </Suspense>
  );
}
