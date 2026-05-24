import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { detectCarrierTool } from "./tools/detect_carrier.js";
import { diagnoseShipmentTool } from "./tools/diagnose_shipment.js";
import { estimateEtaTool } from "./tools/estimate_eta.js";
import { trackShipmentTool } from "./tools/track_shipment.js";
import { observabilityStore } from "./infra/observability.js";
import {
  anomalySchema,
  detectCarrierInputSchema,
  diagnoseShipmentInputSchema,
  escalationStepSchema,
  estimateEtaInputSchema,
  observabilitySnapshotSchema,
  shipmentStatusSchema,
  trackShipmentInputSchema
} from "./types.js";

/**
 * Registers the 7 stateless tracking tools onto the given McpServer.
 * Does not import better-sqlite3 or any Node-only native modules — safe for
 * Cloudflare Workers. Called by both src/server.ts (stdio) and src/worker.ts (Worker).
 */
export function registerStatelessTools(server: McpServer): void {
  server.registerTool(
    "track_shipment",
    {
      description:
        "Track an Indian courier shipment by AWB or tracking number and return deadline-aware reasoning. Use this when a user asks to track a package in India, including bare numeric tracking numbers. Auto-detects Blue Dart, DTDC, Delhivery, and India Post when possible, so do not ask for the carrier first unless detection fails.",
      inputSchema: trackShipmentInputSchema,
      outputSchema: shipmentStatusSchema.shape
    },
    async (args) => {
      const result = await trackShipmentTool({
        awb: args.awb,
        ...(args.carrier ? { carrier: args.carrier } : {}),
        ...(args.needed_by ? { needed_by: args.needed_by } : {}),
        ...(args.purpose ? { purpose: args.purpose } : {}),
        ...(args.origin_pincode ? { origin_pincode: args.origin_pincode } : {}),
        ...(args.destination_pincode ? { destination_pincode: args.destination_pincode } : {})
      });
      return toolResult(result);
    }
  );

  server.registerTool(
    "detect_carrier",
    {
      description:
        "Detect the most likely Indian carrier for an AWB or tracking number. Use this for India shipment numbers when the carrier is unknown instead of guessing from non-India couriers.",
      inputSchema: detectCarrierInputSchema,
      outputSchema: {
        carrier: z.string(),
        confidence: z.number(),
        alternatives: z.array(
          z.object({ carrier: z.string(), confidence: z.number() })
        )
      }
    },
    async (args) => toolResult(await detectCarrierTool(args))
  );

  server.registerTool(
    "estimate_eta",
    {
      description: "Estimate delivery windows between two India PIN codes for supported Indian carriers.",
      inputSchema: estimateEtaInputSchema,
      outputSchema: {
        p50_hours: z.number(),
        p90_hours: z.number(),
        basis: z.enum(["historical_data", "heuristic", "default"])
      }
    },
    async (args) => {
      const result = await estimateEtaTool({
        carrier: args.carrier,
        origin_pincode: args.origin_pincode,
        destination_pincode: args.destination_pincode,
        ...(args.service_type ? { service_type: args.service_type } : {})
      });
      return toolResult(result);
    }
  );

  server.registerTool(
    "diagnose_shipment",
    {
      description:
        "Track an Indian shipment, detect anomalies, and produce escalation guidance. Use this after tracking when the shipment looks delayed, stuck, or exception-prone.",
      inputSchema: diagnoseShipmentInputSchema,
      outputSchema: {
        status: shipmentStatusSchema,
        anomalies: z.array(anomalySchema),
        escalation_playbook: z.array(escalationStepSchema),
        reasoning: z.string()
      }
    },
    async (args) => {
      const result = await diagnoseShipmentTool({
        awb: args.awb,
        ...(args.carrier ? { carrier: args.carrier } : {}),
        ...(args.needed_by ? { needed_by: args.needed_by } : {}),
        ...(args.purpose ? { purpose: args.purpose } : {})
      });
      return toolResult(result);
    }
  );

  server.registerTool(
    "get_observability",
    {
      description: "Return a lightweight health snapshot for carrier failures, parser drift, and watch refresh activity.",
      outputSchema: observabilitySnapshotSchema.shape
    },
    async () => toolResult(observabilityStore.snapshot())
  );
}

function toolResult<T>(structuredContent: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent: structuredContent as Record<string, unknown>
  };
}
