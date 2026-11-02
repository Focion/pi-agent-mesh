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
  // R3（A25）：开 splitting 让 core 与 root 共享同一份错误类模块，统一跨入口 instanceof
  // 身份；否则每个入口各自打包一份 MeshRejectError / InvariantViolationError，跨入口判定失败。
  // §29.1 的 tree-shakeable 由 treeshake:true 保证，不因 splitting 破坏。
  splitting: true,
  treeshake: true
});
