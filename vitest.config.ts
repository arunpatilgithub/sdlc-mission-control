import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ui/src is covered too: the plan parser is pure TypeScript (no JSX) precisely so
    // it can be tested here without a DOM or React renderer.
    include: ["src/**/*.test.ts", "ui/src/**/*.test.ts"],
  },
});
