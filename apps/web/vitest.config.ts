import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the app build is unaffected. Tests cover framework-free modules and static
// rendering, so plain Node is enough (no DOM emulation).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
