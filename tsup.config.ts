import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      react: "src/react/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    platform: "neutral",
    splitting: false,
    external: [
      "ws",
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@noxius/transferit",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:stream",
      "node:stream/promises",
    ],
  },
  {
    entry: { "sw-download": "src/sw-download.ts" },
    format: ["iife"],
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    minify: false,
    dts: false,
    outExtension() {
      return { js: ".js" };
    },
  },
]);
