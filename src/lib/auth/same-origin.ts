/**
 * Cookie-setting POST endpoints refuse requests that a browser reports as coming from another
 * site. The session cookie is SameSite=Lax, so this is a second layer against login CSRF.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be forged by page scripts, so it decides when
 * present (it is also reliable when a Referrer-Policy hides the Origin as "null"). Otherwise the
 * Origin must match the host. Requests with neither header (non-browser clients) are not
 * browser-driven CSRF and pass.
 */
export function isSameOrigin(headers: Headers): boolean {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = headers.get("origin");
  if (origin === null) return true;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
