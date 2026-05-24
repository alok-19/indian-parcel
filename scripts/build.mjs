import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);"
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0")
  },
  external: ["better-sqlite3"],
  packages: "bundle",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  logLevel: "info"
});

await chmod("dist/server.js", 0o755);
