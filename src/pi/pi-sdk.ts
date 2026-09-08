// ═══════════════════════════════════════════════════════════════════════════
// pi SDK 加载器（mesh-pi 的唯一 pi 入口点）。
//
// 环境避坑（实测）：pi 的 clipboard 原生模块在 import 时即 dlopen，本环境
// 会挂死进程。pi 的守卫条件是「无 TERMUX_VERSION 且有 display」，因此先设
// TERMUX_VERSION="1" 再加载 pi 即可完全跳过原生模块。
//
// ESM 的 import 会被提升，所以本模块：
//  ① 顶层（副作用）先设环境变量——任何 import 本模块的入口都自动获得保护；
//  ② pi 本体只能经 loadPiSdk() 动态加载——静态 import 会在本模块求值前执行。
//
// 注意：若宿主自己先静态 import 了 pi，本卫兵来不及生效——集成契约要求
// mesh-pi 必须先于宿主的 pi import 被加载（或宿主自行设 TERMUX_VERSION）。
// pi 是 optional peerDependency：类型解析依赖本地安装，运行时缺失时
// loadPiSdk() 抛出带指引的错误。
// ═══════════════════════════════════════════════════════════════════════════

/** pi SDK 的模块面（type-only，编译期擦除，不构成运行时依赖） */
export type PiSdk = typeof import("@earendil-works/pi-coding-agent");

// 卫兵必须在任何 pi import 之前执行（模块副作用）
process.env.TERMUX_VERSION ??= "1";

let cached: PiSdk | undefined;

/** 已加载的 pi SDK（幂等；未加载过则动态 import） */
export async function loadPiSdk(): Promise<PiSdk> {
  if (cached) return cached;
  try {
    cached = (await import("@earendil-works/pi-coding-agent")) as PiSdk;
  } catch (err) {
    throw new Error(
      "mesh-pi: failed to load optional peer @earendil-works/pi-coding-agent — " +
        "install it (npm i @earendil-works/pi-coding-agent) or provide your own " +
        `sessionFactory / StreamPort. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return cached;
}

/** 测试用：清除缓存（不影响已设的 TERMUX_VERSION 卫兵） */
export function resetPiSdkCache(): void {
  cached = undefined;
}
