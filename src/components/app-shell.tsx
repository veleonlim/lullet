import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";
import { BottomNav, TopNav } from "./nav";

export interface ShellMember {
  readonly displayName: string;
}

/**
 * Mobile-first page frame shared by every route: a sticky header with the wordmark and
 * tagline, a centred content column that respects device safe areas, and (on phones) a
 * tab bar within thumb reach. When someone is signed in the header shows who, a link to
 * the members page and Sign out.
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
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 pt-[env(safe-area-inset-top)] sm:px-6">
          <div className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-2.5">
            <span className="text-lg leading-tight font-semibold tracking-tight">lullet</span>
            <span className="truncate text-xs leading-tight text-muted md:hidden lg:inline lg:text-sm">
              Split trip costs, fairly
            </span>
          </div>
          {member ? (
            <div className="flex shrink-0 items-center gap-3">
              <TopNav />
              <nav aria-label="Account" className="flex items-center gap-2 text-sm sm:gap-3">
                <Link href="/members" className="text-muted hover:text-foreground">
                  Members
                </Link>
                <span
                  className="max-w-16 truncate text-muted sm:max-w-24"
                  data-testid="signed-in-as"
                >
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
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-28 sm:px-6 sm:pt-8 md:pb-12">
        {children}
      </main>
      {member ? <BottomNav /> : null}
    </div>
  );
}
