"use client";

import { useEffect, useRef, useState } from "react";

type Status = "idle" | "working" | "not-allowed" | "failed";

/** Telegram passes the signed launch data in the URL fragment of a Mini App (`tgWebAppData`). */
function readInitData(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData");
  return fromHash ?? window.Telegram?.WebApp?.initData ?? null;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?: () => void } };
  }
}

/**
 * Inside Telegram this signs the member in automatically; in a normal browser it renders nothing.
 * The verification happens on the server, so nothing read here is trusted.
 */
export function MiniAppSignIn({ next }: { next: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const started = useRef(false);

  useEffect(() => {
    const initData = readInitData();
    if (!initData || started.current) return;
    started.current = true;

    void (async () => {
      setStatus("working");
      try {
        const response = await fetch("/api/auth/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });
        if (response.ok) {
          window.Telegram?.WebApp?.ready?.();
          // A full navigation, so the server sees the new cookie on the very next request.
          window.location.replace(next);
          return;
        }
        setStatus(response.status === 403 ? "not-allowed" : "failed");
      } catch {
        setStatus("failed");
      }
    })();
  }, [next]);

  if (status === "idle") return null;
  const message = {
    working: "Signing you in with Telegram...",
    "not-allowed":
      "This Telegram account is not on the list for this trip. Ask the group owner to add it.",
    failed: "Telegram sign-in did not work. Close this window and open lullet from the bot again.",
  }[status];
  return (
    <p
      role={status === "working" ? "status" : "alert"}
      className="rounded-xl border border-border bg-accent-soft p-4 text-sm"
    >
      {message}
    </p>
  );
}
