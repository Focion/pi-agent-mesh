// 确定性 PRNG（G05 崩溃性质测试）：mulberry32 + 线性同余，离线、零依赖、可复现。
// 用于生成固定 seed 下的账户/会话/消息与崩溃步数，不用 fast-check（保持离线、毫秒级）。
export type Prng = () => number;

/** mulberry32（32 位状态，均匀 [0,1)） */
export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 返回 [lo, hi) 的整数 */
export function range(rand: Prng, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo));
}

/** 等概率从数组里取一个 */
export function pick<T>(rand: Prng, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

/** 以概率 p 返回 true */
export function bernoulli(rand: Prng, p: number): boolean {
  return rand() < p;
}

/** Fisher–Yates 洗牌（返回新数组，不动原数组） */
export function shuffle<T>(rand: Prng, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}