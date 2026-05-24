import { LRUCache } from "lru-cache";
import type { RawTrackingResult } from "../types.js";
import { getDefaultCache } from "./workers_cache.js";

const CACHE_URL_BASE = "https://indian-parcel-cache.internal/v1/tracking/";
const TTL_SECONDS = 90;

/**
 * Two-level cache for normalized tracking fetches.
 * L1: in-process LRU (instant, per-DO-instance).
 * L2: Workers Cache API (shared across all DO instances at the same PoP, 90s TTL).
 * In Node.js/test environments L2 is a no-op since caches.default is unavailable.
 */
export class TrackingCache {
  private readonly lru = new LRUCache<string, RawTrackingResult>({
    max: 1000,
    ttl: TTL_SECONDS * 1000
  });

  async get(awb: string): Promise<RawTrackingResult | undefined> {
    const hit = this.lru.get(awb);
    if (hit) return hit;

    const cache = getDefaultCache();
    if (cache) {
      const response = await cache.match(
        new Request(`${CACHE_URL_BASE}${encodeURIComponent(awb)}`)
      );
      if (response) {
        const result = (await response.json()) as RawTrackingResult;
        this.lru.set(awb, result);
        return result;
      }
    }

    return undefined;
  }

  set(awb: string, result: RawTrackingResult): void {
    this.lru.set(awb, result);

    const cache = getDefaultCache();
    if (cache) {
      void cache.put(
        new Request(`${CACHE_URL_BASE}${encodeURIComponent(awb)}`),
        new Response(JSON.stringify(result), {
          headers: { "Cache-Control": `public, max-age=${TTL_SECONDS}` }
        })
      );
    }
  }
}

/**
 * Shared cache singleton.
 */
export const trackingCache = new TrackingCache();
