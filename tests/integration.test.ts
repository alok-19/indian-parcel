import { beforeEach, describe, expect, it, vi } from "vitest";
import { trackShipmentTool } from "../src/tools/track_shipment.js";
import { parseBlueDartHtml } from "../src/carriers/bluedart.js";
import { trackingCache } from "../src/infra/cache.js";
import { awbRateLimiter } from "../src/infra/rate_limit.js";

const fixtureHtml = `<html><body><div>Status: In Transit</div><table>
<tr><td>22/05/2026 10:30</td><td>Muzaffarpur</td><td>Shipment Picked Up</td></tr>
<tr><td>23/05/2026 21:10</td><td>Delhi Hub</td><td>Forwarded to Destination</td></tr>
</table></body></html>`;

describe("trackShipmentTool integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns structured tracking reasoning for Blue Dart", async () => {
    const awb = "1234567893";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const value = String(input);
      if (value.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /");
      }
      return new Response(fixtureHtml, { status: 200 });
    });

    const result = await trackShipmentTool({
      awb,
      needed_by: "2026-05-26T12:00:00+05:30",
      origin_pincode: "842001",
      destination_pincode: "560001"
    });

    expect(result.carrier).toBe("bluedart");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]).not.toHaveProperty("rawTimestampText");
    expect(result.predicted_delivery?.basis).toBe("historical_data");
  });

  it("returns unknown when the carrier fetch fails", async () => {
    const awb = "1234567891";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });

    const result = await trackShipmentTool({ awb });
    expect(result.status).toBe("unknown");
  });

  it("uses normalized raw results consistently", async () => {
    const parsed = parseBlueDartHtml(fixtureHtml, "1234567892");
    trackingCache.set("1234567892", parsed);
    expect((await trackingCache.get("1234567892"))?.events).toHaveLength(2);
    expect(awbRateLimiter.canFetch("1234567892")).toBe(true);
  });
});
