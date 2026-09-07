import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "core/index": "src/core/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  outDir: "dist",
  outExtension: ({ format }) => ({ js: format === "esm" ? ".js" : ".cjs" }),
  // mesh-core must stay tree-shakeable without dragging mesh-pi (§29.1)
  splitting: false,
  treeshake: true
});
