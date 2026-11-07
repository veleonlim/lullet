"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * A moment in the viewer's own time zone. The server cannot know that zone, so it renders
 * UTC and the browser swaps in local time as soon as it hydrates (no mismatch warning).
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => format(iso, undefined),
    () => format(iso, "UTC"),
  );
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}

function format(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso);
  const text = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
  return timeZone === "UTC" ? `${text} UTC` : text;
}
