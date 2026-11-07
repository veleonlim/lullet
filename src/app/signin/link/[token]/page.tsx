import type { Metadata } from "next";
import { peekLoginToken } from "@/lib/auth/db/login-links";

export const metadata: Metadata = {
  title: "Confirm sign in",
  // The token is in this URL: never leak it through the Referer header to another site.
  referrer: "same-origin",
  robots: { index: false },
};

/**
 * Landing page of a one-time login link. Opening it changes nothing; the link is only used up
 * when the person taps Continue. That keeps link previews and prefetchers from burning it.
 */
export default async function LoginLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const pending = token.length <= 256 ? await peekLoginToken(token) : null;

  if (!pending) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-4 sm:py-8">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          This link no longer works
        </h1>
        <p className="text-base text-pretty text-muted">
          Login links work once and expire after 10 minutes. Send /login to the lullet bot in
          Telegram to get a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6 py-4 sm:py-8">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Sign in as {pending.displayName}?
        </h1>
        <p className="text-base text-pretty text-muted">
          This will sign this browser in to lullet. If you did not ask the bot for a link, close
          this page.
        </p>
      </section>
      <form action="/api/auth/link" method="post">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="w-full rounded-xl bg-accent px-4 py-3 text-base font-medium text-background"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
