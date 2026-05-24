import pino from "pino";

const opts = {
  name: "indian-parcel-mcp",
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["awb", "*.awb", "args.awb"],
    censor: "[redacted]"
  }
};

/**
 * Shared structured logger. In Node.js (stdio build) writes to stderr fd 2 via
 * sonic-boom to avoid corrupting the MCP stdio transport. In Cloudflare Workers
 * pino.destination is not available, so we fall back to basic pino (process.stdout).
 */
export const logger =
  typeof pino.destination === "function"
    ? pino(opts, pino.destination(2))
    : pino(opts);
