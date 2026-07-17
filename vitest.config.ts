import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.smoke.ts"],
    testTimeout: 120_000,
  },
});
