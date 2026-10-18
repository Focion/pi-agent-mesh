// ═══════════════════════════════════════════════════════════════════════════
// 信封物化（§7 投递语义 / §22.1 信封模型）。唯一权威的「存储行 → Envelope」
// 构造器，收敛 observer（L6）、router/mailbox（L2）四处各自硬编码的 rowwToEnvelope
// 偏差（I06）：ext / payload.data / payload.attachments / claim / seal /
// requestType / fromEndpoint / idempotencyKey 无一丢弃。
//
// 分层（§3.4）：本文件是零 pi 依赖的叶子模块，observer / router / mailbox 都
// 向下引用它，避免 L2 → L6 回边。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  Envelope,
  EnvelopePayload,
  ExpectKind,
  MessageKind,
  Priority,
} from "./types.js";
import { jsonParse } from "./util.js";

// ─── 行类型（mesh_messages 的本地投影，全列镜像）───────────────────────────

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  from_account: string;
  from_endpoint: string | null;
  kind: string;
  expect: string;
  priority: string | null;
  to_accounts: string | null;
  mentions: string | null;
  reply_to: string | null;
  correlation_id: string | null;
  intent: string | null;
  late: number;
  logical_ts: string | null;
  routed_at: string;
  payload: string;
  idempotency_key: string;
  seal: string | null;
  tombstoned_by: string | null;
  ext: string | null;
}

export function rowToEnvelope(r: MessageRow): Envelope {
  const payload = jsonParse<Partial<EnvelopePayload>>(r.payload, {});
  return {
    id: r.id,
    seq: r.seq,
    from: r.from_account,
    fromEndpoint: r.from_endpoint,
    routedAt: r.routed_at,
    idempotencyKey: r.idempotency_key,
    seal: r.seal ?? undefined,
    conversationId: r.conversation_id,
    to:
      r.to_accounts === null
        ? undefined
        : jsonParse<string[]>(r.to_accounts, []),
    kind: r.kind as MessageKind,
    expect: r.expect as ExpectKind,
    priority: (r.priority as Priority) ?? undefined,
    mentions:
      r.mentions === null ? undefined : jsonParse<string[]>(r.mentions, []),
    replyTo: r.reply_to ?? undefined,
    correlationId: r.correlation_id ?? undefined,
    requestType: r.intent ?? undefined,
    logicalTs: r.logical_ts ?? undefined,
    late: r.late === 1 ? true : undefined,
    // I12（§17）：claim 归属已下移到 mesh_deliveries 列，正文不再含 $.claim；
    // 无 delivery 上下文物化时 claim 恒 undefined。事件信封若需携带，由 mailbox 从
    // claimed_by/claimed_at 派生注入。
    payload: {
      text: payload.text,
      data: payload.data,
      attachments: payload.attachments,
    },
    ext: r.ext === null ? undefined : jsonParse<unknown>(r.ext, undefined),
  };
}