'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowLeft, Building2, ChevronRight, FileStack, Loader2, TrendingUp, Users } from 'lucide-react';
import { ResourceCard, formatCount } from '@/components/resource-card';
import { Button } from '@/components/ui/button';
import type { PublicContributor, Resource, UniversityDetail } from '@/lib/catalog-types';
import { InstitutionMark } from '@/components/institution-mark';
import { monogramGradient } from '@/lib/monogram';

export default function UniversityDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const [university, setUniversity] = useState<UniversityDetail | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [contributors, setContributors] = useState<PublicContributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(`/api/universities/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(response.status === 404 ? 'This university is not available.' : body.error?.message ?? 'University could not be loaded.');
        setUniversity(body.university);
        setResources(body.resources ?? []);
        setContributors(body.contributors ?? []);
      })
      .catch((fetchError) => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setUniversity(null);
        setError(fetchError instanceof Error ? fetchError.message : 'University could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, retryKey]);

  if (loading) return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  if (!university) return (
    <div className="mx-auto max-w-3xl px-4 py-20 text-center" role="alert"><div className="rounded-3xl border border-border bg-card p-10 shadow-soft"><h1 className="font-display text-2xl font-bold">University unavailable</h1><p className="mt-3 text-sm text-muted-foreground">{error}</p><div className="mt-6 flex justify-center gap-3"><Button onClick={() => setRetryKey((value) => value + 1)}>Try again</Button><Button variant="outline" asChild><Link href="/universities">All universities</Link></Button></div></div></div>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <Link href="/universities" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"><ArrowLeft className="h-4 w-4" />All universities</Link>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="relative mt-6 overflow-hidden rounded-[2rem] border border-border bg-card p-8 shadow-soft md:p-12">
        <div className={`absolute -right-20 -top-20 h-60 w-60 rounded-full bg-gradient-to-br ${monogramGradient(university.color)} opacity-15 blur-3xl`} />
        <div className="relative z-10 flex flex-col items-start gap-6 md:flex-row md:items-center">
          <InstitutionMark
            id={university.id}
            short={university.short}
            color={university.color}
            hasLogo={university.hasLogo}
            className="h-20 w-20 rounded-3xl"
            textClassName="text-2xl"
          />
          <div className="flex-1"><h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">{university.name}</h1>
            <div className="mt-4 flex flex-wrap gap-4 text-sm"><HeroMetric icon={FileStack} value={formatCount(university.resources)} label="resources" /><HeroMetric icon={Users} value={formatCount(university.contributors)} label="contributors" /><HeroMetric icon={Building2} value={String(university.departments)} label="departments" /></div>
          </div>
        </div>
      </motion.div>

      <section className="mt-12"><h2 className="font-display text-xl font-semibold">Departments</h2>
        {university.departments_list.length ? <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{university.departments_list.map((department, index) => <motion.div key={department} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: Math.min(index * 0.05, 0.3) }}><Link href={`/explore?q=${encodeURIComponent(department)}&university=${university.id}`}><div className="card-hover flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-soft"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Building2 className="h-5 w-5" /></div><span className="text-sm font-medium">{department}</span></div></Link></motion.div>)}</div> : <p className="mt-4 text-sm text-muted-foreground">No department metadata has been published yet.</p>}
      </section>

      {university.popularSubjects.length > 0 && <section className="mt-12"><h2 className="font-display text-xl font-semibold">Popular Subjects</h2><div className="mt-5 flex flex-wrap gap-3">{university.popularSubjects.map((subject, index) => <motion.div key={subject} initial={{ opacity: 0, scale: 0.9 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: index * 0.06 }}><Link href={`/explore?q=${encodeURIComponent(subject)}&university=${university.id}`}><div className="card-hover inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium shadow-soft"><TrendingUp className="h-4 w-4 text-primary" />{subject}</div></Link></motion.div>)}</div></section>}

      {contributors.length > 0 && <section className="mt-12"><h2 className="font-display text-xl font-semibold">Top Contributors</h2><div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{contributors.map((contributor, index) => <motion.div key={contributor.id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: index * 0.1 }} className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-soft"><div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-sm font-bold text-white">{contributor.avatar}</div><div className="flex-1"><div className="text-sm font-semibold">{contributor.name}</div><div className="text-xs text-muted-foreground">Level {contributor.level} · {contributor.uploads} uploads</div></div><div className="text-right"><div className="text-sm font-bold text-primary">{formatCount(contributor.points)}</div><div className="text-xs text-muted-foreground">XP</div></div></motion.div>)}</div></section>}

      <section className="mt-12"><div className="flex items-center justify-between"><h2 className="font-display text-xl font-semibold">Resources from {university.short}</h2><Link href={`/explore?university=${university.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-primary">View all<ChevronRight className="h-4 w-4" /></Link></div><div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">{resources.length ? resources.map((resource, index) => <ResourceCard key={resource.id} resource={resource} index={index} />) : <p className="col-span-full text-sm text-muted-foreground">No approved resources yet for this university.</p>}</div></section>
    </div>
  );
}
function HeroMetric({ icon: Icon, value, label }: { icon: typeof FileStack; value: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><Icon className="h-4 w-4 text-primary" /><span className="font-semibold">{value}</span>{label}</span>;
}
