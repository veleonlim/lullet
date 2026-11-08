/** Telegram messages are sent as HTML, so everything a person typed or a model read is escaped. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Shortens text to `max` characters, ending in an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** The hard cap Telegram puts on the text of one message. */
export const MESSAGE_LIMIT = 4096;
