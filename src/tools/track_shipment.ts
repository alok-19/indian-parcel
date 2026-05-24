import { CarrierUnavailableError, InvalidAWBError, NotFoundError, ParseError } from "../carriers/base.js";
import { findMatchingAdapters, getAdapterByName } from "../carriers/registry.js";
import { trackingCache } from "../infra/cache.js";
import { observabilityStore } from "../infra/observability.js";
import { awbRateLimiter } from "../infra/rate_limit.js";
import { logger } from "../infra/logger.js";
import { detectCarrierByAwb } from "../intelligence/awb_detector.js";
import { reasonAboutShipment } from "../intelligence/deadline_reasoner.js";
import type { CarrierSlug, ScanEvent, ShipmentStatus } from "../types.js";

/**
 * Executes the main tracking flow: detect carrier, fetch, normalize, and reason.
 */
export async function trackShipmentTool(input: {
  awb: string;
  carrier?: CarrierSlug;
  needed_by?: string;
  purpose?: string;
  origin_pincode?: string;
  destination_pincode?: string;
}): Promise<ShipmentStatus> {
  const awb = input.awb.trim().toUpperCase();
  const cached = await trackingCache.get(awb);
  if (cached) {
    const status = reasonAboutShipment({
      raw: cached,
      ...(input.needed_by ? { neededBy: input.needed_by } : {}),
      ...(input.origin_pincode ? { originPin: input.origin_pincode } : {}),
      ...(input.destination_pincode ? { destinationPin: input.destination_pincode } : {})
    });
    observabilityStore.recordCacheHit(cached.carrier);
    return sanitizeShipmentStatus(status);
  }

  const adapter = input.carrier
    ? getAdapterByName(input.carrier)
    : findMatchingAdapters(awb)[0];

  if (!adapter) {
    const detection = detectCarrierByAwb(awb);
    return unknownStatus(
      awb,
      input.carrier ?? detection.carrier,
      `No supported India carrier matched this AWB format, so live tracking was not attempted.`
    );
  }

  if (!awbRateLimiter.canFetch(awb)) {
    observabilityStore.recordFailure(adapter.name, "rate_limited");
    return unknownStatus(
      awb,
      adapter.name,
      `Fresh tracking is temporarily rate limited for this AWB. Try again in about ${awbRateLimiter.retryAfterSeconds(
        awb
      )} seconds.`
    );
  }

  try {
    const raw = await adapter.track(awb);
    awbRateLimiter.markFetched(awb);
    trackingCache.set(awb, raw);
    const status = reasonAboutShipment({
      raw,
      ...(input.needed_by ? { neededBy: input.needed_by } : {}),
      ...(input.origin_pincode ? { originPin: input.origin_pincode } : {}),
      ...(input.destination_pincode ? { destinationPin: input.destination_pincode } : {})
    });
    observabilityStore.recordLiveSuccess(raw.carrier);
    return sanitizeShipmentStatus(status);
  } catch (error) {
    logger.warn({ err: error, carrier: adapter.name }, "Tracking failed");
    if (
      error instanceof InvalidAWBError ||
      error instanceof NotFoundError ||
      error instanceof CarrierUnavailableError ||
      error instanceof ParseError
    ) {
      recordKnownFailure(adapter.name, error);
      return unknownStatus(awb, adapter.name, buildFailureReasoning(error, adapter.displayName));
    }

    observabilityStore.recordFailure(adapter.name, "unexpected");
    return unknownStatus(
      awb,
      adapter.name,
      `Tracking could not be completed because ${adapter.displayName} returned an unexpected error.`
    );
  }
}

/**
 * Builds a structured unknown response on carrier failure.
 */
function unknownStatus(awb: string, carrier: string, reasoning: string): ShipmentStatus {
  return {
    awb,
    carrier,
    status: "unknown",
    normalized_phase: "unknown",
    events: [],
    reasoning,
    fetched_at: new Date().toISOString()
  };
}

/**
 * Removes parser-only event fields before crossing the MCP output-schema boundary.
 */
function sanitizeShipmentStatus(status: ShipmentStatus): ShipmentStatus {
  return {
    ...status,
    events: status.events.map(stripInternalEventFields)
  };
}

function stripInternalEventFields(event: ScanEvent): ScanEvent {
  return {
    timestamp: event.timestamp,
    location: event.location,
    status_code: event.status_code,
    description: event.description
  };
}

/**
 * Converts known adapter errors into user-safe reasoning.
 */
function buildFailureReasoning(error: Error, carrierDisplayName: string): string {
  if (error instanceof CarrierUnavailableError) {
    return `${carrierDisplayName} tracking is temporarily unavailable or blocked, so this result is returned as unknown instead of guessing.`;
  }
  if (error instanceof ParseError) {
    return `${carrierDisplayName} returned a page shape this server could not parse confidently, so the result is marked unknown.`;
  }
  if (error instanceof InvalidAWBError) {
    return `${carrierDisplayName} rejected the AWB format, so no tracking events were fetched.`;
  }
  if (error instanceof NotFoundError) {
    return `${carrierDisplayName} did not show any shipment for this AWB.`;
  }
  return `${carrierDisplayName} tracking could not be completed, so the result is marked unknown.`;
}

/**
 * Records a typed carrier failure for observability.
 */
function recordKnownFailure(carrier: string, error: Error): void {
  if (error instanceof CarrierUnavailableError) {
    observabilityStore.recordFailure(carrier, "unavailable");
    return;
  }

  if (error instanceof ParseError) {
    observabilityStore.recordFailure(carrier, "parse_error");
    observabilityStore.recordParserDrift(carrier, `${carrier}_parser`, error.message);
    return;
  }

  if (error instanceof NotFoundError) {
    observabilityStore.recordFailure(carrier, "not_found");
    return;
  }

  observabilityStore.recordFailure(carrier, "unexpected");
}
