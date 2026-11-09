/**
 * Same-origin `next` allowlist for auth redirects. A value is accepted only as a
 * single-leading-slash path with no backslash and no control characters; anything
 * else (protocol-relative //, backslash paths, absolute URLs, CR/LF) falls back.
 * Browsers treat backslashes as slashes, so /\evil.example must never pass.
 */
export function safeNextPath(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f]/.test(raw)) return fallback;
  return raw;
}
