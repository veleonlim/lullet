import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/safe-path";
import { getSession } from "@/lib/auth/session";
import { MiniAppSignIn } from "./mini-app-sign-in";

export const metadata: Metadata = { title: "Sign in" };

const errors: Record<string, string> = {
  link: "That login link did not work. It may have expired or already been used. Ask the bot for a new one.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const destination = safeNextPath(next);
  if (await getSession()) redirect(destination as Route);

  const errorMessage = error ? errors[error] : undefined;

  return (
    <div className="mx-auto max-w-md space-y-6 py-4 sm:py-8">
      <section className="space-y-3">
        <p className="text-sm font-medium text-accent">Switzerland and Italy</p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Sign in with Telegram
        </h1>
        <p className="text-base text-pretty text-muted">
          lullet is private to the four people on this trip. There is no password: Telegram is how
          the app knows it is you.
        </p>
      </section>

      {errorMessage ? (
        <p role="alert" className="rounded-xl border border-border bg-accent-soft p-4 text-sm">
          {errorMessage}
        </p>
      ) : null}

      <MiniAppSignIn next={destination} />

      <section
        aria-labelledby="how-to"
        className="space-y-3 rounded-xl border border-border bg-surface p-4"
      >
        <h2 id="how-to" className="text-sm font-medium tracking-wide text-muted uppercase">
          How to sign in
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Open Telegram and start a chat with the lullet bot.</li>
          <li>
            Send <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono">/login</code>.
          </li>
          <li>
            Tap the link the bot sends back, then tap Continue. It works once and expires in 10
            minutes.
          </li>
        </ol>
        <p className="text-sm text-muted">
          Opened lullet from the bot&apos;s menu inside Telegram? You are signed in automatically.
          If the bot does not answer, your Telegram account is not on the list; ask the group owner
          to add it.
        </p>
      </section>
    </div>
  );
}
