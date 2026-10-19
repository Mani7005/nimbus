/** Used by `vite` (development) and tests when VITE_API_URL is not set. */
export const DEVELOPMENT_API_URL = "http://localhost:3000";

/**
 * True for names and addresses that mean "this machine": localhost and *.localhost (with or without a trailing dot),
 * 127.0.0.0/8, 0.0.0.0, ::1, :: and IPv4-mapped loopback. Expects URL#hostname, which already normalizes alternative
 * IPv4 spellings (127.1, 2130706433, 0x7f000001) to dotted form and compresses IPv6.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "0.0.0.0") return true;
  return host === "[::1]" || host === "[::]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

export interface ApiUrlSource {
  VITE_API_URL?: string;
  /** True for production builds (`vite build`), where VITE_API_URL is required. */
  production: boolean;
}

/**
 * The API base URL, without a trailing slash. Throws instead of falling back to localhost in production, so a build
 * missing VITE_API_URL fails rather than shipping an app that calls the visitor's own machine. Production URLs must
 * use https: (the app is served over HTTPS, and browsers block http: requests from it) and must not be local.
 */
export function resolveApiBaseUrl({ VITE_API_URL, production }: ApiUrlSource): string {
  const raw = VITE_API_URL?.trim();
  if (!raw) {
    if (production) throw new Error("VITE_API_URL must be set for production builds, e.g. VITE_API_URL=https://api.example.com");
    return DEVELOPMENT_API_URL;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`VITE_API_URL must be an absolute http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`VITE_API_URL must use http:// or https://, got "${raw}"`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`VITE_API_URL must not contain credentials, a query or a fragment, got "${raw}"`);
  }
  if (production && url.protocol !== "https:") throw new Error(`VITE_API_URL must use https:// in production builds, got "${raw}"`);
  if (production && isLocalHostname(url.hostname)) throw new Error(`VITE_API_URL must not point to a local address in production builds, got "${raw}"`);

  return url.href.replace(/\/+$/, "");
}
