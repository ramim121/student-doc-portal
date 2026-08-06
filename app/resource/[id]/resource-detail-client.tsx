'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Star,
  Download,
  Eye,
  Bookmark,
  Check,
  Share2,
  Flag,
  BadgeCheck,
  Calendar,
  FileText,
  Tag,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { FILE_TYPE_META, type Resource } from '@/lib/catalog-types';
import { formatCount } from '@/components/resource-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function ResourceDetailClient() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const [resource, setResource] = useState<Resource | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [bookmarked, setBookmarked] = useState(false);
  const [savingBookmark, setSavingBookmark] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');

    fetch(`/api/resources/${encodeURIComponent(id)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? 'This resource does not exist or is not available to you.'
              : body.error?.message ?? 'Resource details could not be loaded.',
          );
        }
        setResource(body.resource);
      })
      .catch((fetchError) => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setResource(null);
        setLoadError(fetchError instanceof Error ? fetchError.message : 'Resource details could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [id]);

  // Reflect what is actually stored, not what this tab last clicked.
  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const response = await fetch(`/api/bookmarks/${id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) return;
      const body = await response.json();
      setBookmarked(Boolean(body.bookmarked));
    })();
  }, [id]);

  const toggleBookmark = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.push(`/auth?next=${encodeURIComponent(`/resource/${id}`)}`);
      return;
    }

    const next = !bookmarked;
    setSavingBookmark(true);
    setBookmarked(next); // optimistic; reverted below if the write fails

    const response = await fetch(`/api/bookmarks/${id}`, {
      method: next ? 'POST' : 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (!response.ok) {
      setBookmarked(!next);
    } else if (resource) {
      setResource({
        ...resource,
        bookmarks: Math.max(0, resource.bookmarks + (next ? 1 : -1)),
      });
    }
    setSavingBookmark(false);
  };

  const shareResource = async () => {
    const url = `${window.location.origin}/resource/${id}`;
    const title = resource?.title ?? 'StudyDock resource';

    // Native share on mobile, clipboard everywhere else. A cancelled share
    // rejects with AbortError, which is not a failure worth reporting.
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  const handleDownload = async () => {
    if (!resource) return;
    setDownloadError('');
    setDownloading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setDownloadError('Registration required. Only registered users can download study resources.');
        setTimeout(() => router.push(`/auth?next=${encodeURIComponent(`/resource/${id}`)}`), 1500);
        return;
      }

      const token = session.access_token;
      const res = await fetch(`/api/download/${id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error?.message || 'Failed to generate download link.');
      }

      const { downloadUrl } = await res.json();
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.target = '_blank';
      link.download = resource.title;
      link.click();
    } catch (err: any) {
      setDownloadError(err.message || 'Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-7xl items-center justify-center px-4 py-8" aria-label="Loading resource">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!resource) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center" role="alert">
        <div className="rounded-3xl border border-border bg-card p-10 shadow-soft">
          <h1 className="font-display text-2xl font-bold">Resource unavailable</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {loadError || 'This resource does not exist or is no longer visible.'}
          </p>
          <Button className="mt-6 rounded-xl" asChild>
            <Link href="/explore">Return to explore</Link>
          </Button>
        </div>
      </div>
    );
  }

  const ft = FILE_TYPE_META[resource.fileType] ?? FILE_TYPE_META.pdf;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <Link href="/explore" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-4 w-4" />
        Back to explore
      </Link>

      {/* On a phone this collapses to one column, and the action panel used to
          land at the bottom - Download sat two thirds down the page behind
          metadata nobody had asked for. Ordering puts actions first on mobile
          and keeps the sidebar on the right from lg. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3 lg:gap-8">
        {/* main content */}
        <div className="order-2 lg:order-1 lg:col-span-2">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('rounded-lg px-2.5 py-1 text-xs font-bold', ft.bg, ft.color)}>
                {ft.label}
              </span>
              {resource.featured && (
                <span className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-600 dark:bg-amber-500/10">
                  Featured
                </span>
              )}
            </div>

            <h1 className="mt-4 font-display text-2xl font-bold tracking-tight text-balance md:text-3xl">
              {resource.title}
            </h1>
            <p className="mt-3 text-muted-foreground">{resource.description}</p>

            {/* Only fields that were actually filled in. An empty cell reading
                "Not specified" is noise, and on a phone it costs a whole row. */}
            <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl border border-border bg-card p-4 shadow-soft sm:grid-cols-3 sm:p-5">
              {resource.courseCode && (
                <MetaItem icon={FileText} label="Course" value={resource.courseCode} hint={resource.courseTitle} />
              )}
              {resource.categoryName && <MetaItem label="Type" value={resource.categoryName} />}
              {resource.semester && <MetaItem icon={Calendar} label="Semester" value={resource.semester} />}
              <MetaItem label="Institution" value={resource.universityShort || resource.university} />
              {resource.department && <MetaItem label="Department" value={resource.department} />}
              <MetaItem label="File" value={`${ft.label} · ${resource.fileSize}`} />
              {resource.pages ? <MetaItem label="Pages" value={String(resource.pages)} /> : null}
              {resource.uploadDate && (
                <MetaItem label="Uploaded" value={new Date(resource.uploadDate).toLocaleDateString()} />
              )}
            </div>

            {resource.tags.length > 0 && (
              <div className="mt-5">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  Tags
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {resource.tags.map((tag) => (
                    <Link
                      key={tag}
                      href={`/explore?q=${encodeURIComponent(tag)}`}
                      className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                    >
                      #{tag}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Shown only when there is something to read. A card announcing
                that no summary exists is a whole screen of nothing on mobile. */}
            {(resource.aiSummary || resource.aiStatus === 'processing' || resource.aiStatus === 'queued') && (
              <div className="mt-6 rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/5 via-card to-card p-5 shadow-soft sm:p-6">
                <div className="flex items-center gap-2 font-display text-base font-bold text-primary sm:text-lg">
                  <Sparkles className="h-5 w-5" />
                  AI-generated summary
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {resource.aiSummary ?? 'Summary generation is in progress.'}
                </p>
                {resource.aiSummary && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    AI-generated content can contain errors. Verify important details against the original document.
                  </p>
                )}
              </div>
            )}

            {/* Comments are not in the persisted domain model, so the section
                that used to sit here was a permanently disabled textarea and an
                "Unavailable" button - a screen of dead space on a phone. It
                comes back when comments actually exist. */}
          </motion.div>
        </div>

        {/* sidebar */}
        <div className="order-1 lg:order-2 lg:col-span-1">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="sticky top-24 space-y-4"
          >
            {/* download card */}
            <div className="rounded-3xl border border-border bg-card p-6 shadow-soft">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Star className="h-5 w-5 fill-amber-500 text-amber-500" />
                  <span className="font-display text-2xl font-bold">{resource.rating}</span>
                  <span className="text-sm text-muted-foreground">/ 5</span>
                </div>
                <span className="text-xs text-muted-foreground">{resource.ratingCount} ratings</span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-muted/50 p-3">
                  <Download className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-1 text-sm font-bold">{formatCount(resource.downloads)}</div>
                  <div className="text-[10px] text-muted-foreground">Downloads</div>
                </div>
                <div className="rounded-xl bg-muted/50 p-3">
                  <Eye className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-1 text-sm font-bold">{formatCount(resource.views)}</div>
                  <div className="text-[10px] text-muted-foreground">Views</div>
                </div>
                <div className="rounded-xl bg-muted/50 p-3">
                  <Bookmark className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-1 text-sm font-bold">{formatCount(resource.bookmarks)}</div>
                  <div className="text-[10px] text-muted-foreground">Saves</div>
                </div>
              </div>

              {downloadError && (
                <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {downloadError}
                </p>
              )}

              <Button
                disabled={downloading}
                onClick={handleDownload}
                className="mt-5 h-12 w-full rounded-2xl bg-gradient-to-r from-primary to-secondary text-base shadow-glow disabled:opacity-50"
              >
                {downloading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Download className="mr-2 h-5 w-5" />}
                {downloading ? 'Preparing R2 Link...' : 'Download Content'}
              </Button>

              <div className="mt-2 grid grid-cols-3 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={savingBookmark}
                  aria-pressed={bookmarked}
                  aria-label={bookmarked ? 'Remove from saved' : 'Save this resource'}
                  onClick={() => void toggleBookmark()}
                >
                  <Bookmark className={cn('h-4 w-4', bookmarked && 'fill-primary text-primary')} />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  aria-label="Share this resource"
                  onClick={() => void shareResource()}
                >
                  {shareCopied ? <Check className="h-4 w-4 text-success" /> : <Share2 className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="sm" className="rounded-xl text-destructive hover:text-destructive">
                  <Flag className="h-4 w-4" />
                </Button>
              </div>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Cloudflare R2 Direct Stream • {resource.fileSize}
              </p>
            </div>

            {/* uploader card */}
            <div className="rounded-3xl border border-border bg-card p-6 shadow-soft">
              <h3 className="text-sm font-semibold">Uploaded by</h3>
              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-sm font-bold text-white">
                  {resource.uploaderAvatar}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold">{resource.uploader}</span>
                    {resource.uploaderVerified && <BadgeCheck className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-xs text-muted-foreground">{resource.university}</p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function MetaItem({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon?: any;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
