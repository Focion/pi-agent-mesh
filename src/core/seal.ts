// ═══════════════════════════════════════════════════════════════════════════
// 消息 seal（§22.4）：HMAC-sha256 盖住消息本身（系统层 + 意图层 + payload/ext
// 摘要），不盖 grade/endpointId/path/state/attempts 等「投递过程字段」。
//
// - key 由宿主提供，仅内存持有，默认关闭（MeshOptions.seal 缺省=不签）。
// - 验签失败 = 拒绝投递 + invariant_violated，绝不静默修复（§22.4④）。
// - 字段序固定 i,c,s,f,t,k,e,to,m,r,ci,rt,lt,pd,ed；to/m 归一为数组，
//   rt 取行 intent 列（与 draft.requestType 同源），ed 是 ext 的 JSON 串摘要。
// ═══════════════════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Envelope } from "./types.js";
import { sha256Hex } from "./util.js";
import type { MessageRow } from "./envelope.js";

/** 参与 seal 的规范化字段（§22.4 表） */
export interface SealFields {
  i: string; // id
  c: string; // conversationId
  s: number; // seq
  f: string; // from
  t: string; // routedAt
  k: string; // kind
  e: string; // expect
  to: string[];
  m: string[]; // mentions
  r: string | undefined; // replyTo
  ci: string | undefined; // correlationId
  rt: string | undefined; // requestType
  lt: string | undefined; // logicalTs
  pd: string; // payload 摘要（hex）
  ed: string; // ext 摘要（hex）
}

function canonicalize(f: SealFields): string {
  return JSON.stringify({
    i: f.i,
    c: f.c,
    s: f.s,
    f: f.f,
    t: f.t,
    k: f.k,
    e: f.e,
    to: f.to,
    m: f.m,
    r: f.r,
    ci: f.ci,
    rt: f.rt,
    lt: f.lt,
    pd: f.pd,
    ed: f.ed,
  });
}

export function computeSealToken(key: string, fields: SealFields): string {
  return createHmac("sha256", key)
    .update(canonicalize(fields), "utf8")
    .digest("hex");
}

/** 从待签名草稿构建 SealFields（to/mentions 归一为数组，与落库行回读口径一致） */
export function sealFieldsFromDraft(
  draft: Envelope,
  seq: number,
  payloadJson: string,
): SealFields {
  return {
    i: draft.id,
    c: draft.conversationId,
    s: seq,
    f: draft.from,
    t: draft.routedAt,
    k: draft.kind,
    e: draft.expect,
    to: draft.to ?? [],
    m: draft.mentions ?? [],
    r: draft.replyTo,
    ci: draft.correlationId,
    rt: draft.requestType,
    lt: draft.logicalTs,
    pd: sha256Hex(payloadJson),
    ed: sha256Hex(draft.ext === undefined ? "" : JSON.stringify(draft.ext)),
  };
}

/** 从存储行构建 SealFields；rt 取 intent 列（§22.4 表划归 requestType） */
export function sealFieldsFromRow(row: MessageRow): SealFields {
  return {
    i: row.id,
    c: row.conversation_id,
    s: row.seq,
    f: row.from_account,
    t: row.routed_at,
    k: row.kind,
    e: row.expect,
    to: JSON.parse(row.to_accounts ?? "[]") as string[],
    m: JSON.parse(row.mentions ?? "[]") as string[],
    r: row.reply_to ?? undefined,
    ci: row.correlation_id ?? undefined,
    rt: row.intent ?? undefined,
    lt: row.logical_ts ?? undefined,
    pd: sha256Hex(row.payload),
    ed: sha256Hex(row.ext === null ? "" : row.ext),
  };
}

/** 验签：重算期望签 + 常量时间比较。seal 为 NULL 的历史行由调用方放行、不走此处。 */
export function sealValid(key: string, row: MessageRow): boolean {
  const expected = computeSealToken(key, sealFieldsFromRow(row));
  const actual = row.seal ?? "";
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(actual, "hex"),
  );
}