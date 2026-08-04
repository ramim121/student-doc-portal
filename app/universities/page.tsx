'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Building2, ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react';
import { formatCount } from '@/components/resource-card';
import { Button } from '@/components/ui/button';
import type { UniversitySummary } from '@/lib/catalog-types';

export default function UniversitiesPage() {
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [universities, setUniversities] = useState<UniversitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ q: query, page: String(page), pageSize: '24' });
    fetch(`/api/universities?${params.toString()}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? 'Universities could not be loaded.');
        setUniversities(body.universities ?? []);
        setTotal(body.total ?? 0);
        setTotalPages(body.totalPages ?? 0);
      })
      .catch((fetchError) => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setUniversities([]);
        setError(fetchError instanceof Error ? fetchError.message : 'Universities could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, query, retryKey]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Universities</h1>
        <p className="mt-2 text-muted-foreground">
          {loading ? 'Loading the live university catalog…' : `Explore approved resources from ${total} universities.`}
        </p>
      </motion.div>

      <div className="relative mt-8 max-w-xl">
        <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder="Search universities, abbreviations, or countries..."
          aria-label="Search universities"
          className="h-12 w-full rounded-2xl border border-border bg-card pl-12 pr-4 text-sm shadow-soft outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {loading ? (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading universities">
          {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-56 animate-pulse rounded-3xl border border-border bg-card" />)}
        </div>
      ) : error ? (
        <div className="mt-12 rounded-3xl border border-destructive/30 bg-destructive/5 p-8 text-center" role="alert">
          <h2 className="font-display text-lg font-semibold">Universities could not be loaded</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button className="mt-5 rounded-xl" onClick={() => setRetryKey((value) => value + 1)}>Try again</Button>
        </div>
      ) : universities.length > 0 ? (
        <>
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {universities.map((university, index) => (
              <motion.div key={university.id} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: Math.min(index * 0.08, 0.4) }}>
                <Link href={`/universities/${university.id}`}>
                  <div className="card-hover relative overflow-hidden rounded-3xl border border-border bg-card p-6 shadow-soft">
                    <div className={`absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-to-br ${university.color} opacity-10 blur-2xl`} />
                    <div className="flex items-center gap-4">
                      <div className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${university.color} text-lg font-bold text-white shadow-lg`}>{university.short}</div>
                      <div className="min-w-0"><h2 className="font-display text-base font-semibold leading-tight">{university.name}</h2></div>
                    </div>
                    <div className="mt-5 flex items-center gap-6 text-sm">
                      <Metric value={formatCount(university.resources)} label="Resources" />
                      <Metric value={formatCount(university.contributors)} label="Contributors" />
                      <Metric value={String(university.departments)} label="Depts" />
                    </div>
                    <div className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-primary">Explore resources<ChevronRight className="h-4 w-4" /></div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
          {totalPages > 1 && (
            <nav className="mt-10 flex items-center justify-center gap-3" aria-label="University pages">
              <Button variant="outline" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="mr-1 h-4 w-4" />Previous</Button>
              <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="outline" className="rounded-xl" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight className="ml-1 h-4 w-4" /></Button>
            </nav>
          )}
        </>
      ) : (
        <div className="mt-16 flex flex-col items-center justify-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted"><Building2 className="h-7 w-7 text-muted-foreground" /></div>
          <h2 className="mt-4 font-display text-lg font-semibold">No universities found</h2>
          <p className="mt-1 text-sm text-muted-foreground">Try a different search.</p>
        </div>
      )}

      <div className="mt-12 rounded-3xl border border-border bg-gradient-to-br from-primary/5 to-secondary/5 p-8 text-center">
        <h2 className="font-display text-xl font-semibold">Don&apos;t see your university?</h2>
        <p className="mt-2 text-sm text-muted-foreground">Authenticated users can propose it during upload for administrator review.</p>
        <Button className="mt-4 rounded-xl" asChild><Link href="/upload">Upload your first resource</Link></Button>
      </div>
    </div>
  );
}
function Metric({ value, label }: { value: string; label: string }) {
  return <div><div className="font-semibold">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div>;
}
