// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — 纯工具函数（零依赖，mesh-core / mesh-pi / tests 共用）
// ═══════════════════════════════════════════════════════════════════════════

import { createHash, randomBytes } from "node:crypto";

// ─── ULID（单调；§11.3：id 建议而非约束）──────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let mod: number;
  let out = "";
  let time = now;
  for (let i = len; i > 0; i--) {
    mod = time % ENCODING_LEN;
    out = CROCKFORD[mod]! + out;
    time = (time - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += CROCKFORD[bytes[i]! % ENCODING_LEN];
  }
  return out;
}

function incrementBase32(str: string): string {
  // 单调递增：同一毫秒内把随机部分 +1（ULID monotonic 语义）
  const chars = str.split("");
  let i = chars.length - 1;
  for (; i >= 0; i--) {
    const v = CROCKFORD.indexOf(chars[i]!);
    if (v < ENCODING_LEN - 1) {
      chars[i] = CROCKFORD[v + 1]!;
      return chars.join("");
    }
    chars[i] = "0";
  }
  return chars.join(""); // 溢出：回到全 0（概率可忽略）
}

let lastTime = -1;
let lastRandom = "";

/** 单调 ULID。同毫秒内保证字典序递增（进程内串行调用前提下）。 */
export function ulid(nowMs: number = Date.now()): string {
  if (nowMs === lastTime && lastRandom !== "") {
    lastRandom = incrementBase32(lastRandom);
  } else {
    lastTime = nowMs;
    lastRandom = encodeRandom();
  }
  return encodeTime(nowMs, TIME_LEN) + lastRandom;
}

// ─── 哈希与派生 id（§5.5 §9.1）────────────────────────────────────────────

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** idempotencyKey = sha256(convId + " " + from + " " + clientToken)。不得含 seq（§5.5） */
export function idempotencyKey(conversationId: string, from: string, clientToken: string): string {
  return sha256Hex(`${conversationId} ${from} ${clientToken}`);
}

/** direct 会话确定性派生 id（§9.1）：对称、幂等、可离线计算 */
export function directConversationId(a: string, b: string): string {
  const pair = [a, b].sort();
  const h = createHash("sha1").update(pair.join(" "), "utf8").digest("hex");
  return `d:${h.slice(0, 20)}`;
}

// ─── 时间（§11 约定⑤：TEXT ISO-8601 UTC）─────────────────────────────────

export function isoNow(): string {
  return new Date().toISOString();
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function msFromIso(s: string): number {
  return Date.parse(s);
}

/** 计数器小时桶（附录 E：YYYY-MM-DDTHH） */
export function hourBucket(iso: string = isoNow()): string {
  return iso.slice(0, 13);
}

// ─── JSON 与截断 ─────────────────────────────────────────────────────────

export function jsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function jsonText(v: unknown): string | null {
  if (v === undefined) return null;
  return JSON.stringify(v);
}

/** mesh_inbox preview 截断（§10.4：40 字） */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ─── 等待 ────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
