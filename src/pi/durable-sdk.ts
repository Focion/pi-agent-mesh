// ═══════════════════════════════════════════════════════════════════════════
// durable-sdk：pi-durable / pi-ai / chord 的惰性装载器。
//
// 与旧 pi-sdk.ts 同为「core-only 使用者不加载 pi」的隔离边界：本模块文件被
// src/index.ts 顶层 import，但只在运行时（loadDurableSdk）才真正 import
// pi-durable / pi-ai / chord 的 JS。类型只用 import type（编译期擦除），静态
// import 本模块不触发任何 pi 相关值加载。
//
// 同时保留 TERMUX_VERSION 守卫（与 pi 1.1.0 一致），test 环境（vitest forks）
// 依赖它规避某些 SDK 的环境探测路径。
// ═══════════════════════════════════════════════════════════════════════════

import type { Context } from "@earendil-works/chord";

export interface DurableSdk {
  readonly durable: typeof import("@earendil-works/pi-durable");
  readonly piai: typeof import("@earendil-works/pi-ai");
  readonly builtinModels: typeof import("@earendil-works/pi-ai/providers/all").builtinModels;
  readonly openNodeSqliteStorage: typeof import("@earendil-works/pi-durable/storage/sqlite/node").openNodeSqliteStorage;
  readonly BackgroundContext: Context;
}

let cached: DurableSdk | undefined;

/** 一次性装载 pi-durable / pi-ai / chord（缓存，可 export 重置用于测试）。 */
export async function loadDurableSdk(): Promise<DurableSdk> {
  if (cached) return cached;
  process.env.TERMUX_VERSION ??= "1";
  const [durable, piai, builtin, nodeSqlite, chordContext] = await Promise.all([
    import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/providers/all"),
    import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("@earendil-works/chord/context"),
  ]);
  cached = {
    durable,
    piai,
    builtinModels: builtin.builtinModels,
    openNodeSqliteStorage: nodeSqlite.openNodeSqliteStorage,
    BackgroundContext: chordContext.BACKGROUND_CONTEXT,
  };
  return cached;
}

/** 仅供测试：清缓存强制下次重装（fixture 需要独立实例时使用）。 */
export function resetDurableSdkCache(): void {
  cached = undefined;
}