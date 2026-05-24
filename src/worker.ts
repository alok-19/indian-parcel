import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "./infra/http.js";
import { registerStatelessTools } from "./mcp.js";

// One origin per supported carrier — robots.txt is fetched per host, so only
// the hostname matters. Pre-warming these at DO init means the first tracking
// request hits the carrier directly without paying a robots.txt round-trip.
const CARRIER_ORIGINS = [
  "https://www.bluedart.com/",
  "https://www.dtdc.in/",
  "https://www.delhivery.com/",
  "https://www.indiapost.gov.in/"
];

export interface Env {
  INDIAN_PARCEL_MCP: DurableObjectNamespace;
}

export class IndianParcelMCP extends McpAgent<Env> {
  server: McpServer = new McpServer({ name: "indian-parcel-mcp", version: "1.1.0" });

  async init(): Promise<void> {
    registerStatelessTools(this.server);
    // Fire-and-forget: warm robots.txt cache for all carriers in parallel.
    // By the time a user sends the first tracking request the cache is already
    // populated, so fetchText pays zero extra latency for the robots check.
    void httpClient.warmRobots(CARRIER_ORIGINS);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return IndianParcelMCP.serve("/mcp", { binding: "INDIAN_PARCEL_MCP" }).fetch(
      request,
      env,
      ctx
    );
  },
} satisfies ExportedHandler<Env>;
