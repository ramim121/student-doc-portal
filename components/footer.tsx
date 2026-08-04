'use client';

import Link from 'next/link';
import { Sparkles, Github } from 'lucide-react';

const footerLinks = {
  Product: [
    { label: 'Explore', href: '/explore' },
    { label: 'Universities', href: '/universities' },
    { label: 'Leaderboard', href: '/leaderboard' },
    { label: 'Dashboard', href: '/dashboard' },
  ],
  Community: [
    { label: 'Upload', href: '/upload' },
    { label: 'Guidelines', href: '/platform-info#guidelines' },
    { label: 'Contributors', href: '/leaderboard' },
    { label: 'Help Center', href: '/platform-info#help' },
  ],
  Company: [
    { label: 'About', href: '/platform-info#about' },
    { label: 'Blog', href: '/platform-info#updates' },
    { label: 'Careers', href: '/platform-info#careers' },
    { label: 'Contact', href: '/platform-info#contact' },
  ],
  Legal: [
    { label: 'Privacy', href: '/platform-info#privacy' },
    { label: 'Terms', href: '/platform-info#terms' },
    { label: 'Copyright', href: '/platform-info#copyright' },
    { label: 'DMCA', href: '/platform-info#dmca' },
  ],
};

export function Footer() {
  return (
    <footer className="relative mt-32 border-t border-border/60">
      <div className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-6">
          <div className="col-span-2">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary shadow-glow">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
              <span className="font-display text-lg font-bold tracking-tight">
                StudyDock
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              A student-focused academic resource-sharing community. Find,
              share and learn together.
            </p>
            <div className="mt-5 flex gap-2">
              {[
                { Icon: Github, label: 'StudyDock on GitHub', href: 'https://github.com/ramim121/student-doc-portal' },
              ].map(({ Icon, label, href }) => (
                <Link
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={label}
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground transition-all hover:border-primary/40 hover:text-primary"
                >
                  <Icon className="h-4 w-4" />
                </Link>
              ))}
            </div>
          </div>

          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h4 className="text-sm font-semibold">{title}</h4>
              <ul className="mt-4 space-y-2.5">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground transition-colors hover:text-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border/60 pt-8 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} StudyDock. All rights reserved.</p>
          <p className="flex items-center gap-1.5">
            Built for students, by students
          </p>
        </div>
      </div>
    </footer>
  );
}
