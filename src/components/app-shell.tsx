import Link from "next/link";
import type { ReactNode } from "react";
import { BottomNav, TopNav } from "./nav";

/**
 * Mobile-first page frame shared by every route: a sticky header with the wordmark and
 * tagline, a centred content column that respects device safe areas, and (on phones) a
 * tab bar within thumb reach.
 */
export function AppShell({
  children,
  member,
}: {
  children: ReactNode;
  member?: ShellMember | null;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 pt-[env(safe-area-inset-top)] sm:px-6">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="text-lg font-semibold tracking-tight">lullet</span>
            <span className="truncate text-sm text-muted">Split trip costs, fairly</span>
          </div>
          <TopNav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-5 pb-28 sm:px-6 sm:pt-8 sm:pb-12">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
