/**
 * Response headers for every page and route. Kept as plain data so next.config.ts and a unit test
 * share it.
 *
 * The Content Security Policy allows inline scripts and styles because Next.js writes its own
 * inline bootstrap script and a nonce policy would force every page to render per request. The
 * policy still blocks every other origin: no third party script, frame, form target or connection
 * can be loaded. `frame-ancestors` lets Telegram's web clients show the app as a Mini App and
 * nobody else frame it (which is why there is no X-Frame-Options header: it cannot say "Telegram").
 * In development the policy is left out, since React's dev tooling needs eval and websockets.
 */

export interface HeaderRule {
  readonly key: string;
  readonly value: string;
}

export const TELEGRAM_FRAME_ANCESTORS = [
  "https://web.telegram.org",
  "https://*.web.telegram.org",
  "https://telegram.org",
  "https://*.telegram.org",
] as const;

export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors 'self' ${TELEGRAM_FRAME_ANCESTORS.join(" ")}`,
  ].join("; ");
}

export function securityHeaders(options: { readonly development: boolean }): HeaderRule[] {
  const rules: HeaderRule[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Login links carry their token in the address, so never send it on as a referrer.
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: "geolocation=(), microphone=(), payment=(), usb=()" },
  ];
  if (!options.development) {
    rules.push(
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      { key: "Content-Security-Policy", value: contentSecurityPolicy() },
    );
  }
  return rules;
}
