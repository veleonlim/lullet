import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";

export interface ShellMember {
  readonly displayName: string;
}

/**
 * Mobile-first page frame shared by every route: a sticky header, a centred
 * content column that respects device safe areas, and a quiet footer. When someone is
 * signed in the header shows who, a link to the members page and Sign out.
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
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 pt-[env(safe-area-inset-top)] sm:px-6">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            lullet
          </Link>
          {member ? (
            <nav aria-label="Account" className="flex items-center gap-3 text-sm">
              <Link href="/members" className="text-muted hover:text-foreground">
                Members
              </Link>
              <span className="max-w-24 truncate text-muted" data-testid="signed-in-as">
                {member.displayName}
              </span>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="rounded-lg border border-border px-2.5 py-1 font-medium"
                >
                  Sign out
                </button>
              </form>
            </nav>
          ) : (
            <span className="text-sm text-muted">Europe Split</span>
          )}
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
