import type { ReactNode } from "react";

/**
 * Mobile-first page frame shared by every route: a sticky header, a centred
 * content column that respects device safe areas, and a quiet footer.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4 pt-[env(safe-area-inset-top)] sm:px-6">
          <span className="text-lg font-semibold tracking-tight">lullet</span>
          <span className="text-sm text-muted">Europe Split</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      <footer className="border-t border-border text-muted">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs sm:px-6">
          Shared expenses for four.
        </div>
      </footer>
    </div>
  );
}
