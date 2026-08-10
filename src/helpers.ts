// =============================================================================
// helpers.ts — URL utils · request ID
// =============================================================================

const SENSITIVE = new Set([
  "apikey","api_key","token","access_token","accesstoken",
  "auth","authorization","password","secret","key","api-key",
]);

export function maskUrl(url: string): string {
  try {
    const u      = new URL(url);
    const masked = new URLSearchParams();
    for (const [k, v] of u.searchParams)
      masked.set(k, SENSITIVE.has(k.toLowerCase()) ? (v.length > 10 ? `${v.slice(0, 3)}***` : "***") : v);
    u.search = masked.toString();
    return u.toString();
  } catch {
    return url.split("?")[0] + (url.includes("?") ? "?***" : "");
  }
}

export const generateRequestId = (): string => crypto.randomUUID();

export function getPathname(request: Request): string {
  return request.url.replace(new URL(request.url).origin, "");
}

export function cleanPathname(pathname: string): string {
  let out = pathname;
  for (const param of ["key"]) {
    const re = new RegExp(`[?&]${param}=([^&]*)`, "g");
    out = out.replace(re, (match, _v, offset, str: string) =>
      match.startsWith("?") ? (str.indexOf("&", offset + match.length) !== -1 ? "?" : "") : "");
  }
  return out.replace(/\?\&/, "?");
}
