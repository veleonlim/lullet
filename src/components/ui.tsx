import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { AlertIcon, ChevronLeftIcon } from "./icons";
import { route } from "@/lib/routes";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-foreground hover:opacity-90 active:opacity-80",
  secondary:
    "border border-border-strong bg-surface text-foreground hover:bg-surface-muted active:bg-surface-muted",
  ghost: "text-accent hover:bg-accent-soft active:bg-accent-soft",
  danger:
    "border border-border-strong bg-surface text-negative hover:bg-negative-soft active:bg-negative-soft",
};

export function buttonClass(variant: Variant = "secondary", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export function ButtonLink({
  variant = "secondary",
  className = "",
  href,
  children,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { variant?: Variant; href: string }) {
  return (
    <Link href={route(href)} className={buttonClass(variant, className)} {...props}>
      {children}
    </Link>
  );
}

export function Card({ className = "", ...props }: ComponentProps<"section">) {
  return (
    <section
      className={`rounded-2xl border border-border bg-surface ${className}`.trim()}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 space-y-3 sm:mb-6">
      {back ? (
        <Link
          href={route(back.href)}
          className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-lg pr-3 text-sm font-medium text-muted hover:text-foreground"
        >
          <ChevronLeftIcon width={18} height={18} />
          {back.label}
        </Link>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {title}
          </h1>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="hidden shrink-0 sm:block">{actions}</div> : null}
      </div>
    </div>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </h2>
  );
}

const NOTICE_TONES = {
  info: "border-border bg-surface-muted text-foreground",
  warning: "border-warning/30 bg-warning-soft text-foreground",
  error: "border-negative/30 bg-negative-soft text-foreground",
  success: "border-positive/30 bg-positive-soft text-foreground",
} as const;

export function Notice({
  tone = "info",
  children,
  action,
  role,
}: {
  tone?: keyof typeof NOTICE_TONES;
  children: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 text-sm ${NOTICE_TONES[tone]}`}
    >
      {tone === "warning" || tone === "error" ? (
        <AlertIcon width={18} height={18} className="shrink-0" />
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "positive" | "negative" | "warning";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-surface-muted text-muted",
    positive: "bg-positive-soft text-positive",
    negative: "bg-negative-soft text-negative",
    warning: "bg-warning-soft text-warning",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function SignedOut() {
  return (
    <Card className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">You are signed out</h1>
      <p className="mt-2 text-sm text-muted">
        Sign in to see your group&apos;s expenses and balances.
      </p>
    </Card>
  );
}
