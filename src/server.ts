#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { logger } from "./infra/logger.js";
import { observabilityStore } from "./infra/observability.js";
import {
  detectCarrierInputSchema,
  diagnoseShipmentInputSchema,
  estimateEtaInputSchema,
  observabilitySnapshotSchema,
  refreshWatchesInputSchema,
  removeWatchInputSchema,
  shipmentStatusSchema,
  watchSchema,
  watchRefreshItemSchema,
  watchShipmentInputSchema
} from "./types.js";
import { detectCarrierTool } from "./tools/detect_carrier.js";
import { diagnoseShipmentTool } from "./tools/diagnose_shipment.js";
import { estimateEtaTool } from "./tools/estimate_eta.js";
import { trackShipmentTool } from "./tools/track_shipment.js";
import { listWatchesTool, refreshWatchesTool, removeWatchTool, watchShipmentTool } from "./tools/watchlist.js";
import { anomalySchema, escalationStepSchema, trackShipmentInputSchema } from "./types.js";

declare const __PACKAGE_VERSION__: string;

const server = new McpServer({
  name: "indian-parcel-mcp",
  version: __PACKAGE_VERSION__
});

server.registerTool(
  "track_shipment",
  {
    description:
      "Track an Indian courier shipment by AWB or tracking number and return deadline-aware reasoning. Use this when a user asks to track a package in India, including bare numeric tracking numbers. Auto-detects Blue Dart, DTDC, Delhivery, and India Post when possible, so do not ask for the carrier first unless detection fails.",
    inputSchema: trackShipmentInputSchema,
    outputSchema: shipmentStatusSchema.shape
  },
  async (args) => {
    const result = await trackShipmentTool(normalizeTrackArgs(args));
    return toolResult(result);
  }
);

server.registerTool(
  "track_india_parcel",
  {
    description:
      "Track an India parcel or shipment by AWB or tracking number. Prefer this for India package tracking requests with bare numeric tracking numbers. Auto-detects Blue Dart, DTDC, Delhivery, and India Post when possible.",
    inputSchema: trackShipmentInputSchema,
    outputSchema: shipmentStatusSchema.shape
  },
  async (args) => {
    const result = await trackShipmentTool(normalizeTrackArgs(args));
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
        z.object({
          carrier: z.string(),
          confidence: z.number()
        })
      )
    }
  },
  async (args) => {
    const result = await detectCarrierTool(args);
    return toolResult(result);
  }
);

server.registerTool(
  "detect_india_carrier",
  {
    description:
      "Detect the likely Indian courier for an AWB or tracking number. Prefer this for India parcel requests when the carrier is not given.",
    inputSchema: detectCarrierInputSchema,
    outputSchema: {
      carrier: z.string(),
      confidence: z.number(),
      alternatives: z.array(
        z.object({
          carrier: z.string(),
          confidence: z.number()
        })
      )
    }
  },
  async (args) => {
    const result = await detectCarrierTool(args);
    return toolResult(result);
  }
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
    const result = await estimateEtaTool(normalizeEtaArgs(args));
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
    const result = await diagnoseShipmentTool(normalizeDiagnoseArgs(args));
    return toolResult(result);
  }
);

server.registerTool(
  "watch_shipment",
  {
    description: "Persist an Indian shipment watch in local SQLite storage for later refresh checks.",
    inputSchema: watchShipmentInputSchema,
    outputSchema: {
      watch_id: z.string().uuid()
    }
  },
  async (args) => {
    const result = await watchShipmentTool(normalizeWatchArgs(args));
    return toolResult(result);
  }
);

server.registerTool(
  "list_watches",
  {
    description: "List all locally persisted watched Indian shipments.",
    outputSchema: {
      watches: z.array(watchSchema)
    }
  },
  async () => {
    const watches = await listWatchesTool();
    return toolResult({ watches });
  }
);

server.registerTool(
  "refresh_watches",
  {
    description: "Refresh one watched Indian shipment or all watches and persist monitoring state.",
    inputSchema: refreshWatchesInputSchema,
    outputSchema: {
      refreshed_at: z.string(),
      watches: z.array(watchRefreshItemSchema)
    }
  },
  async (args) => {
    const result = await refreshWatchesTool({
      ...(args.watch_id ? { watch_id: args.watch_id } : {})
    });
    return toolResult(result);
  }
);

server.registerTool(
  "remove_watch",
  {
    description: "Remove a watched Indian shipment from local SQLite storage.",
    inputSchema: removeWatchInputSchema,
    outputSchema: {
      removed: z.boolean()
    }
  },
  async (args) => {
    const result = await removeWatchTool(args);
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

/**
 * Wraps structured output into MCP content plus JSON.
 */
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

/**
 * Removes undefined optionals for strict TypeScript interop.
 */
function normalizeTrackArgs(args: z.output<z.ZodObject<typeof trackShipmentInputSchema>>) {
  return {
    awb: args.awb,
    ...(args.carrier ? { carrier: args.carrier } : {}),
    ...(args.needed_by ? { needed_by: args.needed_by } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.origin_pincode ? { origin_pincode: args.origin_pincode } : {}),
    ...(args.destination_pincode ? { destination_pincode: args.destination_pincode } : {})
  };
}

/**
 * Removes undefined optionals for ETA tool input.
 */
function normalizeEtaArgs(args: z.output<z.ZodObject<typeof estimateEtaInputSchema>>) {
  return {
    carrier: args.carrier,
    origin_pincode: args.origin_pincode,
    destination_pincode: args.destination_pincode,
    ...(args.service_type ? { service_type: args.service_type } : {})
  };
}

/**
 * Removes undefined optionals for diagnosis tool input.
 */
function normalizeDiagnoseArgs(args: z.output<z.ZodObject<typeof diagnoseShipmentInputSchema>>) {
  return {
    awb: args.awb,
    ...(args.carrier ? { carrier: args.carrier } : {}),
    ...(args.needed_by ? { needed_by: args.needed_by } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {})
  };
}

/**
 * Removes undefined optionals for watch input.
 */
function normalizeWatchArgs(args: z.output<z.ZodObject<typeof watchShipmentInputSchema>>) {
  return {
    awb: args.awb,
    ...(args.needed_by ? { needed_by: args.needed_by } : {}),
    ...(args.label ? { label: args.label } : {})
  };
}

/**
 * Starts the stdio MCP server.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("indian-parcel-mcp server started on stdio");
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal server error");
  process.exit(1);
});
