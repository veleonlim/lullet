/**
 * Only same-site absolute paths may be used as a post-login destination, so a crafted
 * `?next=` cannot bounce a freshly signed-in user to another site.
 */
export function safeNextPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // Control characters and backslashes are how parsers disagree about where the host ends.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  return value;
}
