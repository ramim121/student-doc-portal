'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  FileText,
  Presentation,
  Scale,
  BookOpen,
  FlaskConical,
  Microscope,
  FileQuestion,
  NotebookPen,
  GraduationCap,
  ScrollText,
  Map,
  ClipboardList,
  Star,
  Download,
  Eye,
  Bookmark,
  BadgeCheck,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FILE_TYPE_META, type Resource } from '@/lib/catalog-types';

const iconMap: Record<string, LucideIcon> = {
  FileText,
  Presentation,
  Scale,
  BookOpen,
  FlaskConical,
  Microscope,
  FileQuestion,
  NotebookPen,
  GraduationCap,
  ScrollText,
  Map,
  ClipboardList,
};

const categoryIcons: Record<string, LucideIcon> = iconMap;

export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const Icon = categoryIcons[name] ?? FileText;
  return <Icon className={className} />;
}

export function ResourceCard({
  resource,
  index = 0,
}: {
  resource: Resource;
  index?: number;
}) {
  const ft = FILE_TYPE_META[resource.fileType] ?? FILE_TYPE_META.pdf;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{
        duration: 0.5,
        delay: Math.min(index * 0.06, 0.3),
        ease: [0.22, 1, 0.36, 1],
      }}
      className="group"
    >
      <Link href={`/resource/${resource.id}`} className="block">
        <div className="card-hover relative h-full overflow-hidden rounded-3xl border border-border bg-card p-5 shadow-soft">
          {/* gradient glow on hover */}
          <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-primary/20 to-secondary/20 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />

          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl', ft.bg)}>
                <span className={cn('text-xs font-bold', ft.color)}>{ft.label}</span>
              </div>
              {/* Document type. The file-type tile says how it is stored;
                  this says what it actually is - assignment, research, notes. */}
              {resource.categoryName && (
                <span className="truncate rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-[11px] font-semibold text-primary">
                  {resource.categoryName}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {resource.featured && (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:bg-amber-500/10">
                  Featured
                </span>
              )}
              {resource.premium && (
                <span className="rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                  Premium
                </span>
              )}
              <button
                onClick={(e) => {
                  e.preventDefault();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                aria-label="Bookmark"
              >
                <Bookmark className="h-4 w-4" />
              </button>
            </div>
          </div>

          <h3 className="mt-4 line-clamp-2 font-display text-base font-semibold leading-snug">
            {resource.title}
          </h3>

          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            {resource.description}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="font-medium text-foreground/70">{resource.courseCode}</span>
            </span>
            <span className="text-border">•</span>
            <span className="inline-flex items-center gap-1">
              <span className="font-medium text-foreground/70">{resource.universityShort}</span>
            </span>
            <span className="text-border">•</span>
            <span>{resource.fileSize}</span>
            {resource.pages && (
              <>
                <span className="text-border">•</span>
                <span>{resource.pages}p</span>
              </>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-[10px] font-bold text-white">
                {resource.uploaderAvatar}
              </div>
              <span className="flex items-center gap-1 text-xs font-medium">
                {resource.uploader.split(' ')[0]}
                {resource.uploaderVerified && (
                  <BadgeCheck className="h-3.5 w-3.5 text-primary" />
                )}
              </span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 dark:bg-amber-500/10">
              <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
              <span className="text-xs font-bold text-amber-700 dark:text-amber-400">
                {resource.rating}
              </span>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Download className="h-3.5 w-3.5" />
              {formatCount(resource.downloads)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3.5 w-3.5" />
              {formatCount(resource.views)}
            </span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

export function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}
