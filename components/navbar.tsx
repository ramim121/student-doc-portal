'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Upload, Menu, X, Bell, LayoutDashboard, Sparkles, NotebookPen, LogIn, LogOut, UserRoundCog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';

// Dashboard is intentionally absent: signed-in users already get a dedicated
// Dashboard button in the actions group, and listing it here rendered it twice.
const navLinks = [
  { href: '/explore', label: 'Explore' },
  { href: '/universities', label: 'Universities' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setSignedIn(Boolean(data.user));
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session?.user));
      setAuthReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSignedIn(false);
    router.replace('/');
    router.refresh();
  };

  return (
    <>
      <motion.header
        initial={{ y: -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="fixed inset-x-0 top-0 z-50 px-4 pt-3"
      >
        <div
          className={cn(
            'mx-auto flex max-w-7xl items-center justify-between rounded-2xl px-4 py-2.5 transition-all duration-500',
            scrolled
              ? 'glass-strong shadow-glass'
              : 'border border-transparent bg-transparent'
          )}
        >
          <Link href="/" className="flex items-center gap-2.5">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary shadow-glow">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight">
              StudyDock
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'relative rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                  pathname === link.href || pathname.startsWith(link.href + '/')
                    ? 'text-blue-700 dark:text-blue-300'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {link.label}
                {(pathname === link.href || pathname.startsWith(link.href + '/')) && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 -z-10 rounded-lg bg-blue-100 dark:bg-blue-950/50"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
              </Link>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-xl"
              asChild
            >
              <Link href="/explore" aria-label="Search resources">
                <Search className="h-4.5 w-4.5" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-xl"
              asChild
            >
              <Link href="/dashboard" aria-label="Notifications">
                <Bell className="h-4.5 w-4.5" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-xl"
              asChild
            >
              <Link href="/dashboard">
                <LayoutDashboard className="mr-1.5 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-xl"
              asChild
            >
              <Link href="/study-notes">
                <NotebookPen className="mr-1.5 h-4 w-4" />
                In class Study Notes
              </Link>
            </Button>
            {authReady && (
              signedIn ? (
                <><Button variant="ghost" size="icon" className="rounded-xl" asChild><Link href="/account" aria-label="Account settings"><UserRoundCog className="h-4 w-4" /></Link></Button><Button variant="ghost" size="sm" className="rounded-xl" onClick={handleSignOut}><LogOut className="mr-1.5 h-4 w-4" />Sign out</Button></>
              ) : (
                <Button variant="ghost" size="sm" className="rounded-xl" asChild>
                  <Link href="/auth">
                    <LogIn className="mr-1.5 h-4 w-4" />
                    Sign in
                  </Link>
                </Button>
              )
            )}
            <Button
              size="sm"
              className="rounded-xl bg-gradient-to-r from-primary to-secondary text-white shadow-glow"
              asChild
            >
              <Link href="/upload">
                <Upload className="mr-1.5 h-4 w-4" />
                Upload
              </Link>
            </Button>
          </div>

          <button
            className="flex h-10 w-10 items-center justify-center rounded-xl text-foreground md:hidden"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-2 max-w-7xl overflow-hidden md:hidden"
            >
              <div className="glass-strong rounded-2xl p-3 shadow-glass">
                {navLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="block rounded-xl px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-primary/5 hover:text-primary"
                  >
                    {link.label}
                  </Link>
                ))}
                <Link
                  href="/study-notes"
                  className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-primary/5 hover:text-primary"
                >
                  <NotebookPen className="h-4 w-4" />
                  In class Study Notes
                </Link>
                {signedIn && <Link href="/account" className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-primary/5 hover:text-primary"><UserRoundCog className="h-4 w-4" />Account settings</Link>}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {signedIn ? (
                    <Button variant="outline" size="sm" className="rounded-xl" onClick={handleSignOut}>
                      <LogOut className="mr-1.5 h-4 w-4" />
                      Sign out
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="rounded-xl" asChild>
                      <Link href="/auth">
                        <LogIn className="mr-1.5 h-4 w-4" />
                        Sign in
                      </Link>
                    </Button>
                  )}
                  <Button size="sm" className="rounded-xl" asChild>
                    <Link href="/upload">
                      <Upload className="mr-1.5 h-4 w-4" />
                      Upload
                    </Link>
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.header>
    </>
  );
}
