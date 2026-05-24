#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { logger } from "./infra/logger.js";
import { registerStatelessTools } from "./mcp.js";
import {
  refreshWatchesInputSchema,
  removeWatchInputSchema,
  watchRefreshItemSchema,
  watchSchema,
  watchShipmentInputSchema
} from "./types.js";
import { listWatchesTool, refreshWatchesTool, removeWatchTool, watchShipmentTool } from "./tools/watchlist.js";

declare const __PACKAGE_VERSION__: string;

const server = new McpServer({
  name: "indian-parcel-mcp",
  version: __PACKAGE_VERSION__
});

registerStatelessTools(server);

// Watch tools — stdio only (better-sqlite3 native module; not available in Cloudflare Workers)

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
    const result = await watchShipmentTool({
      awb: args.awb,
      ...(args.needed_by ? { needed_by: args.needed_by } : {}),
      ...(args.label ? { label: args.label } : {})
    });
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("indian-parcel-mcp server started on stdio");
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal server error");
  process.exit(1);
});
