/**
 * Scrape strategy:
 * Blue Dart exposes a server-rendered tracking result page that can be reached with a GET query string.
 * This adapter relies on a summary block plus the first tracking table containing date, location, and remarks.
 * If the live page shape drifts, fixture-backed parser tests should fail before production users do.
 */
import * as cheerio from "cheerio";
import { httpClient } from "../infra/http.js";
import { observabilityStore } from "../infra/observability.js";
import type { CarrierSlug, RawTrackingResult } from "../types.js";
import {
  CarrierUnavailableError,
  InvalidAWBError,
  ParseError,
  type CarrierAdapter,
  sortEvents,
  toIsoInIndia
} from "./base.js";

/**
 * Blue Dart adapter with live fetch and fixture-backed parsing.
 */
export class BlueDartAdapter implements CarrierAdapter {
  readonly name: CarrierSlug = "bluedart";
  readonly displayName = "Blue Dart";
  readonly liveSupported = true;

  /**
   * Returns true when the AWB fits Blue Dart's digit-only range.
   */
  matches(awb: string): boolean {
    return /^\d{8,11}$/.test(awb.trim());
  }

  /**
   * Returns the confidence for the AWB shape.
   */
  matchConfidence(awb: string): number {
    return this.matches(awb) ? 0.82 : 0;
  }

  /**
   * Fetches and parses Blue Dart tracking data.
   */
  async track(awb: string): Promise<RawTrackingResult> {
    if (!this.matches(awb)) {
      throw new InvalidAWBError("Blue Dart AWBs must be 8 to 11 digits.");
    }

    const responses = await fetchBlueDartCandidates(awb.trim());
    let lastCarrierError: CarrierUnavailableError | undefined;
    let lastParseError: ParseError | undefined;

    for (const response of responses) {
      if (response.status >= 500) {
        lastCarrierError = new CarrierUnavailableError(`Blue Dart returned HTTP ${response.status}.`);
        continue;
      }

      try {
        return parseBlueDartHtml(response.body, awb, "live");
      } catch (error) {
        if (error instanceof ParseError) {
          lastParseError = error;
          observabilityStore.recordParserDrift(
            "bluedart",
            "bluedart_parser",
            `Unable to parse Blue Dart response from ${response.url}: ${error.message}`
          );
          continue;
        }

        throw error;
      }
    }

    if (lastParseError) {
      throw lastParseError;
    }

    throw lastCarrierError ?? new CarrierUnavailableError("Blue Dart tracking returned no usable response.");
  }
}

/**
 * Parses Blue Dart tracking HTML into a normalized result.
 */
export function parseBlueDartHtml(html: string, awb: string, source: "live" | "fixture" = "fixture"): RawTrackingResult {
  const $ = cheerio.load(html);
  const text = $.text();
  if (/unable to locate|no records found|invalid/i.test(text)) {
    return {
      awb,
      carrier: "bluedart",
      raw_status: "No visible carrier events",
      events: [],
      fetched_at: new Date().toISOString(),
      liveSupported: true,
      source,
      notes: ["Blue Dart returned no matching events for the AWB."]
    };
  }

  const livePanel = $(`#${escapeSelector(`${awb}-rdrmv`)}`);
  if (livePanel.length > 0) {
    const parsed = parseLiveAccordionLayout($, awb, source);
    if (parsed) {
      return parsed;
    }
  }

  const rows = $("table tr")
    .toArray()
    .map((row) =>
      $(row)
        .find("td")
        .toArray()
        .map((cell) => $(cell).text().replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
    .filter((cells) => cells.length >= 3);

  const eventRows = rows.filter((cells) => toIsoInIndia(cells[0] ?? "") && cells.length >= 3);
  if (eventRows.length === 0) {
    throw new ParseError("Blue Dart HTML did not contain any recognizable tracking rows.");
  }

  const events = sortEvents(
    eventRows.map((cells) => ({
      timestamp: toIsoInIndia(cells[0] ?? "") ?? new Date().toISOString(),
      rawTimestampText: cells[0] ?? "",
      location: cells[1] ?? "Unknown",
      status_code: summarizeStatusCode(cells[2] ?? ""),
      description: cells.slice(2).join(" | ")
    }))
  );

  const latest = events.at(-1);
  const rawStatus =
    findLabeledValue($, /status/i) ??
    latest?.description ??
    $("strong, b")
      .toArray()
      .map((node) => $(node).text().trim())
      .find((candidate) => /delivered|transit|pickup|shipment/i.test(candidate));

  return {
    awb,
    carrier: "bluedart",
    ...(rawStatus ? { raw_status: rawStatus } : {}),
    ...(latest?.location ? { current_location: latest.location } : {}),
    events,
    fetched_at: new Date().toISOString(),
    liveSupported: true,
    source
  };
}

/**
 * Parses Blue Dart's current accordion-based live result layout.
 */
function parseLiveAccordionLayout(
  $: cheerio.CheerioAPI,
  awb: string,
  source: "live" | "fixture"
): RawTrackingResult | undefined {
  const panel = $(`#${escapeSelector(`${awb}-rdrmv`)}`).first();
  if (panel.length === 0) {
    return undefined;
  }

  const shipmentDetailsTable = panel.find(`#${escapeSelector(`SHIP${awb}`)} table`).first();
  const shipmentFields = extractKeyValueRows($, shipmentDetailsTable);
  const scanTable = panel.find(`#${escapeSelector(`SCAN${awb}`)} table`).first();
  const scanRows = scanTable.find("tbody tr").toArray();

  const events = sortEvents(
    scanRows
      .map((row) =>
        $(row)
          .find("td")
          .toArray()
          .map((cell) => $(cell).text().replace(/\s+/g, " ").trim())
          .filter(Boolean)
      )
      .filter((cells) => cells.length >= 4 && !/\*|- 24 Hr Format/i.test(cells.join(" ")))
      .map((cells) => {
        const rawTimestamp = `${cells[2]} ${cells[3]}`;
        return {
          timestamp: toIsoInIndia(rawTimestamp) ?? new Date().toISOString(),
          rawTimestampText: rawTimestamp,
          location: cells[0] ?? "Unknown",
          status_code: summarizeStatusCode(cells[1] ?? ""),
          description: cells[1] ?? "Unknown status"
        };
      })
  );

  if (events.length === 0) {
    return undefined;
  }

  const latest = events.at(-1);
  const rawStatus =
    shipmentFields.get("status") ??
    panel
      .find(".panel-bd-List p")
      .toArray()
      .map((node) => $(node).text().replace(/\s+/g, " ").trim())
      .find((value) => /transit|delivery|delivered|shipment/i.test(value));

  const currentLocation = latest?.location;
  const expectedDeliveryDate = parseBlueDartDate(shipmentFields.get("expected date of delivery"));
  return {
    awb,
    carrier: "bluedart",
    ...(rawStatus ? { raw_status: rawStatus } : {}),
    ...(currentLocation ? { current_location: currentLocation } : {}),
    ...(shipmentFields.get("from") ? { origin_city: shipmentFields.get("from") ?? "" } : {}),
    ...(shipmentFields.get("to") ? { destination_city: shipmentFields.get("to") ?? "" } : {}),
    ...(expectedDeliveryDate ? { expected_delivery_date: expectedDeliveryDate } : {}),
    events,
    fetched_at: new Date().toISOString(),
    liveSupported: true,
    source
  };
}

/**
 * Extracts a value adjacent to a label in the document text.
 */
function findLabeledValue($: cheerio.CheerioAPI, labelPattern: RegExp): string | undefined {
  const nodes = $("td, th, div, span").toArray();
  for (const node of nodes) {
    const text = $(node).text().replace(/\s+/g, " ").trim();
    if (labelPattern.test(text) && text.includes(":")) {
      const [, value] = text.split(":");
      if (value?.trim()) {
        return value.trim();
      }
    }
  }

  return undefined;
}

/**
 * Converts free-form carrier status text into a short status code.
 */
function summarizeStatusCode(description: string): string {
  if (/delivered/i.test(description)) {
    return "delivered";
  }
  if (/out for delivery/i.test(description)) {
    return "out_for_delivery";
  }
  if (/pickup|booked/i.test(description)) {
    return "picked_up";
  }
  if (/exception|undelivered|rto/i.test(description)) {
    return "exception";
  }
  return "in_transit";
}

/**
 * Extracts label-value rows from a two-column shipment details table.
 */
function extractKeyValueRows($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): Map<string, string> {
  const values = new Map<string, string>();
  table.find("tr").each((_, row) => {
    const cells = $(row)
      .find("th, td")
      .toArray()
      .map((cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (cells.length >= 2) {
      values.set(normalizeLabel(cells[0] ?? ""), cells[1] ?? "");
    }
  });
  return values;
}

/**
 * Normalizes table heading labels for easier lookup.
 */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").replace(/\*/g, "").trim();
}

/**
 * Escapes special characters for CSS id selectors.
 */
function escapeSelector(value: string): string {
  return value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
}

/**
 * Parses Blue Dart's summary date fields into ISO 8601 in India time.
 */
function parseBlueDartDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = toIsoInIndia(`${value.trim()} 23:59`);
  return parsed ?? undefined;
}

/**
 * Fetches Blue Dart tracking, falling back from www to apex only on failure.
 */
async function fetchBlueDartCandidates(awb: string) {
  const encoded = encodeURIComponent(awb);
  const urls = [
    `https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=${encoded}`,
    `https://bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=${encoded}`
  ];
  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      return [await httpClient.fetchText(url)];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new CarrierUnavailableError(`Blue Dart live fetch failed: ${lastError?.message}`);
}
