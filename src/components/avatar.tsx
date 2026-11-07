const TONES = [
  "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200",
] as const;

/** A member's initial on a colour fixed by their position in the group, the same everywhere. */
export function Avatar({
  name,
  position,
  size = "md",
}: {
  name: string;
  position: number;
  size?: "sm" | "md";
}) {
  const tone = TONES[position % TONES.length];
  const box = size === "sm" ? "size-7 text-xs" : "size-10 text-sm";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${box} ${tone}`}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
