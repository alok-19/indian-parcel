/**
 * Returns Cloudflare Workers' shared default cache, or null in Node.js/test environments.
 * Isolated here so `caches.default` (Workers-only) compiles under both tsconfigs without
 * polluting shared infra files with type casts.
 */
export function getDefaultCache(): Cache | null {
  if (typeof caches === "undefined") return null;
  return (caches as unknown as { default?: Cache }).default ?? null;
}
