import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
  test: { root: ".", include: ["test/**/*.test.ts"], environment: "node" },
});
