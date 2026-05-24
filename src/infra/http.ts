import robotsParser from "robots-parser";
import { logger } from "./logger.js";
import { getDefaultCache } from "./workers_cache.js";

const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
];

interface RobotsPolicy {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

const robotsCache = new Map<string, RobotsPolicy>();
const concurrencyState = new Map<string, number>();
const parseRobots = robotsParser as unknown as (url: string, body: string) => RobotsPolicy;

/**
 * Error raised when a carrier robots policy disallows scraping a path.
 */
export class RobotsDisallowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotsDisallowedError";
  }
}

/**
 * Shared HTTP response shape returned to carrier adapters.
 */
export interface HttpResponse {
  status: number;
  body: string;
  url: string;
  headers: Headers;
}

/**
 * Small helper for polite carrier scraping in Phase 1.
 */
export class HttpClient {
  private readonly maxConcurrencyPerHost = 2;

  /**
   * Fetches a page with timeout, retry, UA rotation, and robots awareness.
   * robots.txt is checked in parallel with slot acquisition so it doesn't
   * add sequential latency on cache misses.
   */
  async fetchText(
    url: string,
    options: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    } = {}
  ): Promise<HttpResponse> {
    const target = new URL(url);

    // Kick off robots check immediately — resolves from cache instantly if warm,
    // otherwise fetches in parallel with acquireHostSlot.
    const robotsPromise = this.ensureRobotsAllowed(target);

    await this.acquireHostSlot(target.host);
    await robotsPromise;

    const attempts = [1, 2];
    try {
      for (const attempt of attempts) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          const headers: Record<string, string> = {
            "user-agent": userAgents[(attempt - 1) % userAgents.length]!,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ...options.headers
          };
          if (options.body) {
            headers["content-type"] = "application/x-www-form-urlencoded";
          }

          const response = await fetch(target, {
            method: options.method ?? "GET",
            headers,
            ...(options.body ? { body: options.body } : {}),
            redirect: "follow",
            signal: controller.signal
          });
          clearTimeout(timer);
          const body = await response.text();

          return {
            status: response.status,
            body,
            url: response.url,
            headers: response.headers
          };
        } catch (error) {
          if (attempt === attempts.length) {
            throw error;
          }

          logger.warn({ err: error, url }, "Retrying carrier fetch after transient error");
          await this.sleep(200);
        }
      }

      throw new Error("Unexpected fetch flow");
    } finally {
      this.releaseHostSlot(target.host);
    }
  }

  /**
   * Pre-warms the robots.txt cache for a list of origin URLs.
   * Call this at Worker/server startup so the first tracking request
   * doesn't pay the robots.txt fetch cost.
   */
  async warmRobots(origins: string[]): Promise<void> {
    await Promise.allSettled(
      origins.map((o) => this.ensureRobotsAllowed(new URL(o)))
    );
  }

  /**
   * Best-effort robots fetch and policy evaluation.
   * L1: module-level Map (instant, per-DO-instance).
   * L2: Workers Cache API (shared across DOs at same PoP, 1h TTL) — skips network
   *     re-fetch on new sessions as long as the PoP cache is warm.
   * L3: Network fetch with 3s timeout so a slow host never blocks the request path.
   */
  private async ensureRobotsAllowed(target: URL): Promise<void> {
    const robotsUrl = `${target.protocol}//${target.host}/robots.txt`;
    const robotsCacheKey = `https://indian-parcel-cache.internal/v1/robots/${encodeURIComponent(target.host)}`;
    let parser = robotsCache.get(robotsUrl);

    if (!parser) {
      const cache = getDefaultCache();
      let body: string | undefined;

      if (cache) {
        const cached = await cache.match(new Request(robotsCacheKey));
        if (cached) body = await cached.text();
      }

      if (body === undefined) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3_000);
          const response = await fetch(robotsUrl, {
            headers: { "user-agent": userAgents[0]! },
            signal: controller.signal
          });
          clearTimeout(timer);
          body = response.ok ? await response.text() : "";

          if (cache) {
            void cache.put(
              new Request(robotsCacheKey),
              new Response(body, { headers: { "Cache-Control": "public, max-age=3600" } })
            );
          }
        } catch {
          body = "";
        }
      }

      parser = parseRobots(robotsUrl, body);
      robotsCache.set(robotsUrl, parser);
    }

    if (!parser.isAllowed(target.toString(), userAgents[0]!)) {
      throw new RobotsDisallowedError(`Robots policy disallows ${target.pathname}`);
    }
  }

  /**
   * Waits until a per-host concurrency slot becomes available.
   */
  private async acquireHostSlot(host: string): Promise<void> {
    while ((concurrencyState.get(host) ?? 0) >= this.maxConcurrencyPerHost) {
      await this.sleep(50);
    }

    concurrencyState.set(host, (concurrencyState.get(host) ?? 0) + 1);
  }

  /**
   * Releases a previously acquired host slot.
   */
  private releaseHostSlot(host: string): void {
    const next = Math.max((concurrencyState.get(host) ?? 1) - 1, 0);
    concurrencyState.set(host, next);
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Shared HTTP client singleton.
 */
export const httpClient = new HttpClient();
