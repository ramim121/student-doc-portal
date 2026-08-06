'use client';

import { motion, useScroll, useTransform } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Search,
  ArrowRight,
  Upload,
  Sparkles,
  TrendingUp,
  Trophy,
  BadgeCheck,
  Star,
  Users,
  FileStack,
  Download,
  Zap,
  ShieldCheck,
  Globe,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnimatedCounter } from '@/components/animated-counter';
import { ResourceCard, CategoryIcon, formatCount } from '@/components/resource-card';
import type { PublicContributor, Resource, UniversitySummary } from '@/lib/catalog-types';
import { achievementDefinitions } from '@/lib/gamification';

type HomeCategory = { id: string; name: string; icon: string; description: string; count: number };
type PlatformStats = { resources: number; students: number; universities: number; downloads: number };

export default function HomePage() {
  const heroRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  });
  const heroY = useTransform(scrollYProgress, [0, 1], [0, 150]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.8], [1, 0]);
  const meshY = useTransform(scrollYProgress, [0, 1], [0, 100]);
  const [trending, setTrending] = useState<Resource[]>([]);
  const [universities, setUniversities] = useState<UniversitySummary[]>([]);
  const [contributors, setContributors] = useState<PublicContributor[]>([]);
  const [categories, setCategories] = useState<HomeCategory[]>([]);
  const [platformStats, setPlatformStats] = useState<PlatformStats>({ resources: 0, students: 0, universities: 0, downloads: 0 });
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeError, setHomeError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setHomeLoading(true);
    setHomeError('');
    fetch('/api/home', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? 'Live platform information could not be loaded.');
        setTrending(body.resources ?? []);
        setUniversities(body.universities ?? []);
        setContributors(body.contributors ?? []);
        setCategories(body.categories ?? []);
        setPlatformStats(body.stats ?? { resources: 0, students: 0, universities: 0, downloads: 0 });
      })
      .catch((fetchError) => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setHomeError(fetchError instanceof Error ? fetchError.message : 'Live platform information could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setHomeLoading(false); });
    return () => controller.abort();
  }, [retryKey]);

  const stats = [
    { label: 'Approved resources', value: platformStats.resources, suffix: '', display: formatCount(platformStats.resources) },
    { label: 'Students', value: platformStats.students, suffix: '', display: formatCount(platformStats.students) },
    { label: 'Universities', value: platformStats.universities, suffix: '', display: formatCount(platformStats.universities) },
    { label: 'Downloads', value: platformStats.downloads, suffix: '', display: formatCount(platformStats.downloads) },
  ];

  return (
    <div className="overflow-hidden">
      {/* ===== HERO ===== */}
      <section ref={heroRef} className="relative min-h-[92vh]">
        {/* animated mesh background */}
        <motion.div style={{ y: meshY }} className="pointer-events-none absolute inset-0">
          <div className="mesh-bg absolute inset-0" />
          <motion.div
            className="absolute left-[10%] top-[15%] h-72 w-72 rounded-full bg-primary/30 blur-[100px]"
            animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.5, 0.3] }}
            transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute right-[8%] top-[20%] h-80 w-80 rounded-full bg-secondary/30 blur-[110px]"
            animate={{ scale: [1.1, 1, 1.1], opacity: [0.25, 0.45, 0.25] }}
            transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute bottom-[10%] left-[40%] h-72 w-72 rounded-full bg-accent/25 blur-[100px]"
            animate={{ scale: [1, 1.15, 1], opacity: [0.2, 0.4, 0.2] }}
            transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
          />
        </motion.div>

        {/* floating glass shapes */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <motion.div
            className="absolute left-[12%] top-[60%] h-16 w-16 rounded-2xl glass shadow-glass"
            animate={{ y: [0, -20, 0], rotate: [0, 8, 0] }}
            transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute right-[15%] top-[55%] h-12 w-12 rounded-full glass shadow-glass"
            animate={{ y: [0, -16, 0], x: [0, 10, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
          />
          <motion.div
            className="absolute left-[80%] top-[70%] h-20 w-20 rounded-3xl glass shadow-glass"
            animate={{ y: [0, -24, 0], rotate: [0, -6, 0] }}
            transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
          />
        </div>

        <motion.div
          style={{ y: heroY, opacity: heroOpacity }}
          className="relative z-10 mx-auto flex max-w-5xl flex-col items-center px-4 pt-20 text-center"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="glass inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium shadow-soft"
          >
            <span className="flex h-2 w-2 rounded-full bg-success animate-pulse-glow" />
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {homeLoading ? 'Loading live community totals…' : `${formatCount(platformStats.resources)} approved resources shared by students`}
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="mt-6 font-display text-5xl font-bold tracking-tight text-balance sm:text-6xl md:text-7xl"
          >
            Find, Share & <span className="gradient-text">Learn</span> Together.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mt-6 max-w-2xl text-lg text-muted-foreground text-balance"
          >
            Access thousands of reports, assignments, presentations, case
            studies, and study notes shared by university students.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="mt-8 flex flex-col items-center gap-3 sm:flex-row"
          >
            <Button
              size="lg"
              className="h-12 rounded-2xl bg-gradient-to-r from-primary to-secondary px-7 text-base shadow-glow transition-transform hover:scale-105"
              asChild
            >
              <Link href="/explore">
                Explore Resources
                <ArrowRight className="ml-2 h-4.5 w-4.5" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 rounded-2xl border-border bg-card/60 px-7 text-base backdrop-blur-xl transition-transform hover:scale-105"
              asChild
            >
              <Link href="/upload">
                <Upload className="mr-2 h-4.5 w-4.5" />
                Upload Notes
              </Link>
            </Button>
          </motion.div>

          {/* hero search bar */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="mt-10 w-full max-w-2xl"
          >
            <HeroSearch />
          </motion.div>

          {/* trust badges */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.5 }}
            className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-success" /> Verified contributors
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-accent" /> Instant downloads
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Globe className="h-4 w-4 text-primary" /> {formatCount(platformStats.universities)} universities
            </span>
          </motion.div>
        </motion.div>
      </section>

      {homeError && (
        <div className="mx-auto mt-8 max-w-3xl px-4" role="alert">
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-center text-sm text-muted-foreground">
            {homeError}{' '}
            <button className="font-semibold text-primary underline" onClick={() => setRetryKey((value) => value + 1)}>Try again</button>
          </div>
        </div>
      )}

      {/* ===== STATS ===== */}
      <section className="relative z-10 mx-auto max-w-7xl px-4">
        <div className="grid grid-cols-2 gap-4 rounded-3xl border border-border/60 bg-card/50 p-6 backdrop-blur-xl shadow-soft md:grid-cols-4 md:p-8">
          {stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
              className="text-center"
            >
              <div className="font-display text-3xl font-bold text-foreground md:text-4xl">
                <AnimatedCounter value={stat.value} display={stat.display} suffix={stat.suffix} />
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ===== CATEGORIES ===== */}
      <section className="mx-auto mt-16 max-w-7xl px-4 sm:mt-32">
        <SectionHeading
          eyebrow="Browse by type"
          title="Everything you need, organized"
          subtitle="From lecture notes to past papers — find exactly the type of resource you're looking for."
        />
        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {categories.map((cat, i) => (
            <motion.div
              key={cat.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.4, delay: Math.min(i * 0.04, 0.3), ease: [0.22, 1, 0.36, 1] }}
            >
              <Link href={`/explore?category=${cat.id}`}>
                <div className="card-hover group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-soft">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
                    <CategoryIcon name={cat.icon} className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{cat.name}</div>
                    <div className="text-xs text-muted-foreground">{formatCount(cat.count)} resources</div>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ===== TRENDING ===== */}
      <section className="mx-auto mt-16 max-w-7xl px-4 sm:mt-32">
        <div className="flex items-end justify-between gap-4">
          <SectionHeading
            eyebrow="Trending now"
            title="What students are downloading"
            subtitle="The most popular resources this week across all universities."
            align="left"
          />
          <Link
            href="/explore"
            className="group hidden shrink-0 items-center gap-1 text-sm font-medium text-primary md:flex"
          >
            View all
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {trending.map((resource, i) => (
            <ResourceCard key={resource.id} resource={resource} index={i} />
          ))}
        </div>
      </section>

      {/* ===== UNIVERSITIES ===== */}
      <section className="mx-auto mt-16 max-w-7xl px-4 sm:mt-32">
        <SectionHeading
          eyebrow="Global community"
          title={`${formatCount(platformStats.universities)} universities, one platform`}
          subtitle="Explore resources from top universities around the world."
        />
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {universities.map((uni, i) => (
            <motion.div
              key={uni.id}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5, delay: Math.min(i * 0.08, 0.3), ease: [0.22, 1, 0.36, 1] }}
            >
              <Link href={`/universities/${uni.id}`}>
                <div className="card-hover relative overflow-hidden rounded-3xl border border-border bg-card p-6 shadow-soft">
                  <div className={`absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gradient-to-br ${uni.color} opacity-10 blur-2xl`} />
                  <div className="flex items-center gap-4">
                    <div className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${uni.color} text-lg font-bold text-white shadow-lg`}>
                      {uni.short}
                    </div>
                    <div>
                      <h3 className="font-display text-base font-semibold leading-tight">{uni.name}</h3>
                    </div>
                  </div>
                  <div className="mt-5 flex items-center gap-6 text-sm">
                    <div>
                      <div className="font-semibold">{formatCount(uni.resources)}</div>
                      <div className="text-xs text-muted-foreground">Resources</div>
                    </div>
                    <div>
                      <div className="font-semibold">{formatCount(uni.contributors)}</div>
                      <div className="text-xs text-muted-foreground">Contributors</div>
                    </div>
                    <div>
                      <div className="font-semibold">{uni.departments}</div>
                      <div className="text-xs text-muted-foreground">Departments</div>
                    </div>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Button variant="outline" className="rounded-xl" asChild>
            <Link href="/universities">
              View all universities
              <ChevronRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* ===== LEADERBOARD ===== */}
      <section className="mx-auto mt-16 max-w-7xl px-4 sm:mt-32">
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <SectionHeading
              eyebrow="Gamification"
              title="Earn rewards for sharing"
              subtitle="Climb the leaderboard, earn badges, and become a top contributor."
              align="left"
            />
            <div className="mt-8 grid grid-cols-2 gap-3">
              {achievementDefinitions.map((badge, i) => (
                <motion.div
                  key={badge.name}
                  initial={{ opacity: 0, scale: 0.9 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-soft"
                >
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${badge.color} text-white shadow-md`}>
                    <Trophy className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{badge.name}</div>
                    <div className="text-xs text-muted-foreground">{badge.description}</div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          <div>
            <SectionHeading
              eyebrow="Top contributors"
              title="All-time leaders"
              subtitle="The highest-ranked members of the live community leaderboard."
              align="left"
            />
            <div className="mt-8 space-y-3">
              {contributors.slice(0, 5).map((c, i) => (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.06 }}
                >
                  <Link href="/leaderboard">
                    <div className="card-hover flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-soft">
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${
                        c.rank === 1 ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400' :
                        c.rank === 2 ? 'bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300' :
                        c.rank === 3 ? 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {c.rank}
                      </div>
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-sm font-bold text-white">
                        {c.avatar}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{c.name}</span>
                          {c.verified && <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{c.university}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold text-primary">{formatCount(c.points)}</div>
                        <div className="text-xs text-muted-foreground">XP</div>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== FEATURES STRIP ===== */}
      <section className="mx-auto mt-16 max-w-7xl px-4 sm:mt-32">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { icon: FileStack, title: '13 resource types', desc: 'Reports, assignments, slides, lab reports, thesis & more — all supported.', color: 'from-primary to-secondary' },
            { icon: ShieldCheck, title: 'Trust & quality', desc: 'Verified contributors, community ratings, and content moderation.', color: 'from-success to-accent' },
            { icon: Zap, title: 'Built for speed', desc: 'Instant search, fast downloads, and a 90+ Lighthouse score.', color: 'from-accent to-primary' },
          ].map((feat, i) => (
            <motion.div
              key={feat.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="rounded-3xl border border-border bg-card p-6 shadow-soft"
            >
              <div className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ${feat.color} text-white shadow-lg`}>
                <feat.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold">{feat.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{feat.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section className="mx-auto mt-16 max-w-7xl px-4 sm:mt-32">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-[2rem] border border-border bg-gradient-to-br from-primary via-secondary to-accent p-10 text-center shadow-glass-lg md:p-16"
        >
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-[10%] top-[10%] h-40 w-40 rounded-full bg-white/20 blur-3xl" />
            <div className="absolute bottom-[10%] right-[10%] h-52 w-52 rounded-full bg-white/15 blur-3xl" />
          </div>
          <div className="relative z-10">
            <h2 className="font-display text-3xl font-bold text-white text-balance md:text-5xl">
              Have notes worth sharing?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-white/80 text-balance">
              Upload your study materials and help thousands of students while
              earning XP, badges, and recognition.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                size="lg"
                className="h-12 rounded-2xl bg-white px-7 text-base text-primary shadow-lg transition-transform hover:scale-105"
                asChild
              >
                <Link href="/upload">
                  <Upload className="mr-2 h-4.5 w-4.5" />
                  Upload your first resource
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 rounded-2xl border-white/30 bg-white/10 px-7 text-base text-white backdrop-blur-xl hover:bg-white/20"
                asChild
              >
                <Link href="/explore">
                  Browse resources
                  <ArrowRight className="ml-2 h-4.5 w-4.5" />
                </Link>
              </Button>
            </div>
          </div>
        </motion.div>
      </section>
    </div>
  );
}

function HeroSearch() {
  return (
    <div className="glass-strong relative flex items-center gap-2 rounded-2xl p-2 shadow-glass">
      <Search className="ml-3 h-5 w-5 text-muted-foreground" />
      <input
        type="text"
        placeholder="Search by subject, course code, university..."
        className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onFocus={(e) => (e.currentTarget.placeholder = 'Try "Machine Learning" or "CS229"...')}
        onBlur={(e) => (e.currentTarget.placeholder = 'Search by subject, course code, university...')}
      />
      <Button
        size="sm"
        className="h-11 rounded-xl bg-gradient-to-r from-primary to-secondary px-5"
        asChild
      >
        <Link href="/explore">Search</Link>
      </Button>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  align?: 'center' | 'left';
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}
    >
      <span className="text-sm font-semibold uppercase tracking-wider text-primary">
        {eyebrow}
      </span>
      <h2 className="mt-2 font-display text-3xl font-bold tracking-tight text-balance md:text-4xl">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-3 text-base text-muted-foreground text-balance">{subtitle}</p>
      )}
    </motion.div>
  );
}
