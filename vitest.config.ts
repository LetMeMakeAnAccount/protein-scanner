import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.{test,spec}.{ts,tsx}"],
          exclude: ["tests/ui/**"],
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "ui",
          include: ["tests/ui/**/*.{test,spec}.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
