"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlusIcon, ReceiptIcon, ScaleIcon } from "./icons";
import { route } from "@/lib/routes";

const ITEMS = [
  { href: "/expenses", label: "Expenses", Icon: ReceiptIcon, match: /^\/(expenses(?!\/new)|$)/ },
  { href: "/balances", label: "Balances", Icon: ScaleIcon, match: /^\/(balances|settlements)/ },
] as const;

function useActive() {
  const pathname = usePathname();
  return (match: RegExp) => match.test(pathname);
}

/** Tabs in the header on wide screens. */
export function TopNav() {
  const isActive = useActive();
  return (
    <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
      {ITEMS.map(({ href, label, match }) => (
        <Link
          key={href}
          href={route(href)}
          aria-current={isActive(match) ? "page" : undefined}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            isActive(match)
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-surface-muted hover:text-foreground"
          }`}
        >
          {label}
        </Link>
      ))}
      <Link
        href={"/expenses/new"}
        className="ml-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-foreground hover:opacity-90"
      >
        <PlusIcon width={16} height={16} />
        Add expense
      </Link>
    </nav>
  );
}

/** Thumb-reach tab bar on phones, with the primary action in the middle. */
export function BottomNav() {
  const isActive = useActive();
  const adding = usePathname() === "/expenses/new";
  const [expenses, balances] = ITEMS;
  const tab = (item: (typeof ITEMS)[number]) => (
    <Link
      key={item.href}
      href={item.href}
      aria-current={isActive(item.match) ? "page" : undefined}
      className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
        isActive(item.match) ? "text-accent" : "text-muted"
      }`}
    >
      <item.Icon width={22} height={22} />
      {item.label}
    </Link>
  );
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <div className="mx-auto flex max-w-3xl items-center px-2">
        {tab(expenses)}
        <Link
          href={"/expenses/new"}
          aria-label="Add expense"
          aria-current={adding ? "page" : undefined}
          className="-mt-5 flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-lg ring-4 ring-background active:opacity-80"
        >
          <PlusIcon width={26} height={26} />
        </Link>
        {tab(balances)}
      </div>
    </nav>
  );
}
