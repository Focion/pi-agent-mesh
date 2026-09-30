// ═══════════════════════════════════════════════════════════════════════════
// Observer（§12.4 §23）：宿主唯一的读入口，全库唯一保证只读的对象。
// - 没有 write 方法、不 lazy 初始化、不发事件不计投递指标（§12.4 三条要求）
// - C1–C16 全部纯 SQL 判定（§23.4）：空集 = 通过，返回行 = 违规样本
// - 规范示例 SQL 里的 datetime('now') 不可与 ISO-8601 TEXT 字典序比较，
//   截止时间一律在应用层算好再以 ? 参数绑定（§11 约定⑤）
// - C5 口径：pending = state IN ('routed','queued','parked','delivered')。
//   规范原文只列三态，但 Router 在同事务里建行(state=routed)并加计数，
//   故 routed 必须计入——与 SqliteStore.recomputeInboxCaches 同口径。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type { MeshRegistry } from "./registry.js";
import { REGISTERED_COUNTERS, type SqliteStore } from "./store.js";
import type {
  Cap,
  ConversationId,
  ConversationSummary,
  DeliveryState,
  DeliveryTrace,
  Envelope,
  EnvelopePayload,
  ExpectKind,
  InboxState,
  InboxView,
  InvariantReport,
  Limits,
  MessageKind,
  MessageId,
  Observer,
  Priority,
  RecentPreview,
  ReplayResult,
  StreamEntry,
} from "./types.js";
import { MeshUnsupportedError } from "./types.js";
import {
  hourBucket,
  isoFromMs,
  isoNow,
  jsonParse,
  msFromIso,
  truncate,
} from "./util.js";

// ─── 行类型（mesh_messages / mesh_deliveries 的本地投影）───────────────────

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
  logical_ts: string | null;
  routed_at: string;
  payload: string;
  idempotency_key: string;
  seal: string | null;
  tombstoned_by: string | null;
  ext: string | null;
}

interface DeliveryRow {
  id: string;
  message_id: string;
  account_id: string;
  endpoint_id: string | null;
  grade: string | null;
  path: string | null;
  woke: number;
  state: string;
  partial: number;
  parked_reason: string | null;
  drop_reason: string | null;
  entry_id: string | null;
  attempts: number;
  claim_until: string | null;
  parked_at: string | null;
  queued_at: string | null;
  delivered_at: string | null;
  consumed_at: string | null;
  handoff_at: string | null;
  state_changed_at: string;
  note: string | null;
}

const DELIVERY_STATES: readonly DeliveryState[] = [
  "routed",
  "queued",
  "parked",
  "delivered",
  "consumed",
  "dropped",
  "claimed",
  "acked",
];

/** C5 口径：哪些状态算「还在收件箱里」 */
const PENDING_STATES = "('routed','queued','parked','delivered')";

export function rowToEnvelope(r: MessageRow): Envelope {
  const payload = jsonParse<
    Partial<EnvelopePayload> & { claim?: { by: string; at: string } }
  >(r.payload, {});
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
    claim: payload.claim,
    payload: {
      text: payload.text,
      data: payload.data,
      attachments: payload.attachments,
    },
    ext: r.ext === null ? undefined : jsonParse<unknown>(r.ext, undefined),
  };
}

/** pending 投递的原文预览（≤3 条，40 字，§10.4） */
function toPreview(
  env: Envelope,
  me: string,
  nameOf: (id: string) => string,
): RecentPreview {
  return {
    seq: env.seq,
    from: env.from,
    name: nameOf(env.from),
    preview: truncate(env.payload.text ?? "", 40),
    mentionsMe: env.mentions?.includes(me) ?? false,
    expectsMyAck: env.expect !== "none" && (env.to?.includes(me) ?? true),
  };
}

function deadlineIn(deadline: string, nowMs: number): string {
  const remaining = msFromIso(deadline) - nowMs;
  const sec = Math.round(Math.abs(remaining) / 1000);
  return remaining >= 0 ? `${sec}s` : `overdue ${sec}s`;
}

// ─── Observer ─────────────────────────────────────────────────────────────

export interface ObserverDeps {
  store: SqliteStore;
  registry: MeshRegistry;
  limits: Limits;
}

export class MeshObserver implements Observer {
  private readonly db: Database.Database;
  private readonly registry: MeshRegistry;
  private readonly limits: Limits;
  private ftsAvailable: boolean | null = null;

  constructor(deps: ObserverDeps) {
    this.db = deps.store.db;
    this.registry = deps.registry;
    this.limits = deps.limits;
  }

  // ── 内部：参数化只读查询 ──

  private rows(
    sql: string,
    args: unknown[] = [],
  ): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  }

  private one(
    sql: string,
    args: unknown[] = [],
  ): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...args) as
      | Record<string, unknown>
      | undefined;
  }

  private nameOf(id: string): string {
    return this.registry.getAccount(id)?.displayName ?? id;
  }

  // ── 消息与轨迹 ──

  async messages(q: {
    conversationId?: string;
    from?: string;
    kind?: MessageKind;
    sinceSeq?: number;
    limit?: number;
  }): Promise<Envelope[]> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    let sql = "SELECT * FROM mesh_messages WHERE 1 = 1";
    const args: unknown[] = [];
    if (q.conversationId !== undefined && q.conversationId !== "") {
      sql += " AND conversation_id = ?";
      args.push(q.conversationId);
    }
    if (q.from !== undefined && q.from !== "") {
      sql += " AND from_account = ?";
      args.push(q.from);
    }
    if (q.kind !== undefined) {
      sql += " AND kind = ?";
      args.push(q.kind);
    }
    if (q.sinceSeq !== undefined) {
      sql += " AND seq > ?";
      args.push(q.sinceSeq);
    }
    sql += " ORDER BY conversation_id, seq LIMIT ?";
    args.push(limit);
    return this.rows(sql, args).map((r) => {
      // SAFETY: rows come from SELECT * on mesh_messages; MessageRow mirrors its columns 1:1
      return rowToEnvelope(r as unknown as MessageRow);
    });
  }

  async search(q: {
    text: string;
    conversationId?: string;
    limit?: number;
  }): Promise<Envelope[]> {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const raw = q.text.trim();
    // trigram 分词器要求查询串 ≥3 字符（§23.4 前提；短词命中无意义）
    if (raw.length < 3) return [];
    if (!this.hasFts()) return []; // FTS 表缺失：降级为空结果，不抛（迁移缺失的容错）
    // 引号包裹消解 FTS 语法（防注入）；内部引号双写转义；结尾 * 视为前缀通配
    let wildcard = false;
    let text = raw;
    if (text.endsWith("*")) {
      wildcard = true;
      text = text.slice(0, -1).trimEnd();
    }
    if (text.replace(/"/g, "").length < 3) return [];
    const phrase =
      '"' + text.replaceAll('"', '""') + '"' + (wildcard ? " *" : "");
    let sql =
      "SELECT m.* FROM mesh_messages m JOIN mesh_messages_fts f ON f.rowid = m.rowid " +
      "WHERE mesh_messages_fts MATCH ?";
    const args: unknown[] = [phrase];
    if (q.conversationId !== undefined && q.conversationId !== "") {
      sql += " AND m.conversation_id = ?";
      args.push(q.conversationId);
    }
    sql += " ORDER BY m.conversation_id, m.seq LIMIT ?";
    args.push(limit);
    return this.rows(sql, args).map((r) => {
      // SAFETY: rows come from SELECT m.* on mesh_messages; MessageRow mirrors its columns 1:1
      return rowToEnvelope(r as unknown as MessageRow);
    });
  }

  async trace(messageId: string): Promise<DeliveryTrace[]> {
    const rows = this.rows(
      "SELECT * FROM mesh_deliveries WHERE message_id = ? ORDER BY state_changed_at, account_id",
      [messageId],
    );
    // createdAt：mesh_deliveries 无独立建行时间列；行与消息同事务创建，
    // 消息的 routed_at 即建行时刻。
    const msg = this.one("SELECT routed_at FROM mesh_messages WHERE id = ?", [
      messageId,
    ]);
    const createdAt = (msg?.["routed_at"] as string | undefined) ?? "";
    return rows.map((raw) => {
      // SAFETY: rows come from SELECT * on mesh_deliveries; DeliveryRow mirrors its columns 1:1
      const r = raw as unknown as DeliveryRow;
      return {
        deliveryId: r.id,
        messageId: r.message_id,
        accountId: r.account_id,
        endpointId: r.endpoint_id,
        state: r.state as DeliveryState,
        grade: (r.grade as DeliveryTrace["grade"]) ?? null,
        partial: r.partial === 1,
        reason: (r.parked_reason ??
          r.drop_reason ??
          null) as DeliveryTrace["reason"],
        attempts: r.attempts,
        woke: r.woke === 1,
        path: (r.path as DeliveryTrace["path"]) ?? null,
        handoffAt: r.handoff_at,
        parkedAt: r.parked_at,
        stateChangedAt: r.state_changed_at,
        createdAt,
      };
    });
  }

  // ── 收件箱 ──

  async inboxOf(accountId: string): Promise<InboxView> {
    const nowMs = Date.now();
    const account = this.registry.getAccount(accountId);
    const sinkLike =
      account !== undefined && account.endpointClass !== "stream";

    // 会话集：收件箱行 ∪ 仍有 pending 投递的（账号, 会话）对
    const convRows = this.rows(
      "SELECT i.conversation_id AS cid, c.type AS type, c.topic AS topic, c.next_seq AS next_seq, " +
        "i.overflow_count AS overflow_count, i.overflow_summary AS overflow_summary, c.config AS config " +
        "FROM mesh_inboxes i JOIN mesh_conversations c ON c.id = i.conversation_id WHERE i.account_id = ?",
      [accountId],
    );
    const pendingAgg = this.rows(
      "SELECT m.conversation_id AS cid, COUNT(*) AS n, MAX(m.seq) AS max_seq, MAX(m.routed_at) AS last_at " +
        "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
        "WHERE d.account_id = ? AND d.state IN " +
        PENDING_STATES +
        " GROUP BY m.conversation_id",
      [accountId],
    );
    const convById = new Map<string, Record<string, unknown>>();
    for (const r of convRows) convById.set(r["cid"] as string, r);
    for (const r of pendingAgg) {
      if (!convById.has(r["cid"] as string)) {
        const c = this.one(
          "SELECT id AS cid, type AS type, topic AS topic, next_seq AS next_seq, " +
            "0 AS overflow_count, NULL AS overflow_summary, config AS config FROM mesh_conversations WHERE id = ?",
          [r["cid"]],
        );
        if (c) convById.set(r["cid"] as string, c);
      }
    }

    // 原文预算（§7.4）：direct 恒在预算内；从未发言且从未被 @ 恒超预算；
    // 其余 gap ≤ K，且拿原文的会话数 ≤ maxVerbatimConversations（按最近
    // 发言/@ 排序挤出）。sink/external 恒全量。
    const membershipRows = this.rows(
      "SELECT conversation_id AS cid, last_spoke_seq AS s, last_mentioned_seq AS m, verbatim_pinned AS pinned " +
        "FROM mesh_memberships WHERE account_id = ? AND left_at IS NULL",
      [accountId],
    );
    const verbatim = new Map<string, boolean>();
    const candidates: Array<{ cid: string; recency: number }> = [];
    for (const ms of membershipRows) {
      const cid = ms["cid"] as string;
      const conv = convById.get(cid);
      const kind = (conv?.["type"] ??
        this.registry.getConversation(cid)?.kind) as string | undefined;
      const pinned = ms["pinned"];
      if (sinkLike || kind === "direct") {
        verbatim.set(cid, true);
        continue;
      }
      if (pinned === 1) {
        verbatim.set(cid, true);
        continue;
      }
      if (pinned === 0) {
        verbatim.set(cid, false);
        continue;
      }
      const recency = Math.max(ms["s"] as number, ms["m"] as number);
      const nextSeq =
        conv?.["next_seq"] ??
        (this.registry.getConversation(cid)?.lastSeq ?? 0) + 1;
      const gap = (nextSeq as number) - 1 - recency;
      if (recency > 0 && gap <= this.limits.verbatimGapK)
        candidates.push({ cid, recency });
    }
    candidates.sort((a, b) => b.recency - a.recency);
    for (let i = 0; i < candidates.length; i++) {
      verbatim.set(
        candidates[i]!.cid,
        i < this.limits.maxVerbatimConversations,
      );
    }

    const conversations: InboxState[] = [];
    for (const [cid, conv] of convById) {
      const kind = conv["type"] as InboxState["kind"];
      const nextSeq = conv["next_seq"] as number;
      const agg = pendingAgg.find((p) => p["cid"] === cid);
      const unread = (agg?.["n"] as number | undefined) ?? 0;
      const state: InboxState = {
        conversationId: cid,
        kind,
        topic: (conv["topic"] as string | null) ?? undefined,
        unread,
        recent: [],
        verbatim: verbatim.get(cid) ?? false,
        lastSeq: Math.max(
          nextSeq - 1,
          (agg?.["max_seq"] as number | undefined) ?? 0,
        ),
        lastAt: (agg?.["last_at"] as string | undefined) ?? this.lastAtOf(cid),
      };
      if (kind === "direct") {
        const peer = this.one(
          "SELECT account_id FROM mesh_memberships WHERE conversation_id = ? AND account_id <> ? LIMIT 1",
          [cid, accountId],
        );
        if (peer) state.peer = peer["account_id"] as string;
      }
      // 溢出折叠字段（§7.5）：对任何会话类型都可能发生
      const overflow = conv["overflow_count"] as number | null;
      if (overflow !== null && overflow > 0) {
        state.overflow = overflow;
        state.summary =
          (conv["overflow_summary"] as string | null) ?? undefined;
      }
      if (kind === "queue") {
        state.claimable = this.queueClaimableCount(cid);
        const claims = this.myClaims(cid, accountId, nowMs);
        if (claims.length > 0) state.myClaims = claims;
      }
      // recent：最新 3 条 pending，按 seq 升序展示（≤3 条，40 字，§10.4）
      const recentRows = this.rows(
        "SELECT m.* FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state IN " +
          PENDING_STATES +
          " ORDER BY m.seq DESC LIMIT 3",
        [accountId, cid],
      );
      recentRows.reverse();
      state.recent = recentRows.map((raw) => {
        // SAFETY: rows come from SELECT m.* on mesh_messages; MessageRow mirrors its columns 1:1
        return toPreview(
          rowToEnvelope(raw as unknown as MessageRow),
          accountId,
          (id) => this.nameOf(id),
        );
      });
      conversations.push(state);
    }
    conversations.sort((a, b) =>
      a.lastAt < b.lastAt
        ? 1
        : a.lastAt > b.lastAt
          ? -1
          : a.conversationId < b.conversationId
            ? -1
            : 1,
    );

    // 待应答（§14）：两边各一份
    const awaitingMyAck = (
      this.rows(
        "SELECT correlation_id, from_account, intent, deadline FROM mesh_pending_acks " +
          "WHERE to_account = ? AND state = 'open' ORDER BY deadline",
        [accountId],
      ) as Array<{
        correlation_id: string;
        from_account: string;
        intent: string | null;
        deadline: string;
      }>
    ).map((r) => ({
      correlationId: r.correlation_id,
      from: r.from_account,
      intent: r.intent ?? undefined,
      deadlineIn: deadlineIn(r.deadline, nowMs),
    }));
    const awaitingTheirAck = (
      this.rows(
        "SELECT correlation_id, to_account, intent, deadline FROM mesh_pending_acks " +
          "WHERE from_account = ? AND state = 'open' ORDER BY deadline",
        [accountId],
      ) as Array<{
        correlation_id: string;
        to_account: string;
        intent: string | null;
        deadline: string;
      }>
    ).map((r) => ({
      correlationId: r.correlation_id,
      to: r.to_account,
      intent: r.intent ?? undefined,
      deadlineIn: deadlineIn(r.deadline, nowMs),
    }));

    return { conversations, awaitingMyAck, awaitingTheirAck };
  }

  private lastAtOf(cid: ConversationId): string {
    const row = this.one(
      "SELECT MAX(routed_at) AS t FROM mesh_messages WHERE conversation_id = ?",
      [cid],
    );
    return (row?.["t"] as string | null) ?? "";
  }

  private queueClaimableCount(cid: ConversationId): number {
    const row = this.one(
      "SELECT COUNT(*) AS n FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
        "WHERE m.conversation_id = ? AND d.state IN ('routed','queued')",
      [cid],
    );
    return (row?.["n"] as number | undefined) ?? 0;
  }

  private myClaims(
    cid: ConversationId,
    accountId: string,
    nowMs: number,
  ): Array<{ messageId: MessageId; leaseIn: string }> {
    return (
      this.rows(
        "SELECT m.id AS mid, d.claim_until AS until FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE m.conversation_id = ? AND d.state = 'claimed' " +
          "AND json_extract(m.payload, '$.claim.by') = ?",
        [cid, accountId],
      ) as Array<{ mid: string; until: string }>
    ).map((r) => ({ messageId: r.mid, leaseIn: deadlineIn(r.until, nowMs) }));
  }

  // ── 会话与流 ──

  async conversationsOf(accountId: string): Promise<ConversationSummary[]> {
    const rows = this.rows(
      "SELECT c.id AS cid, c.type AS type, c.topic AS topic, c.archived_at AS archived, " +
        "c.next_seq AS next_seq, ms.caps AS caps " +
        "FROM mesh_memberships ms JOIN mesh_conversations c ON c.id = ms.conversation_id " +
        "WHERE ms.account_id = ? AND ms.left_at IS NULL",
      [accountId],
    );
    const subs = this.rows(
      "SELECT c.id AS cid, c.type AS type, c.topic AS topic, c.archived_at AS archived, " +
        "c.next_seq AS next_seq " +
        "FROM mesh_subscriptions s JOIN mesh_conversations c ON c.id = s.conversation_id " +
        "WHERE s.account_id = ? AND s.unsubscribed_at IS NULL",
      [accountId],
    );
    const seen = new Set<string>();
    const out: ConversationSummary[] = [];
    const push = (r: Record<string, unknown>, caps: Cap[]) => {
      const cid = r["cid"] as string;
      if (seen.has(cid)) return;
      seen.add(cid);
      const kind = r["type"] as ConversationSummary["kind"];
      const lastSeq = (r["next_seq"] as number) - 1;
      out.push({
        conversationId: cid,
        kind,
        title: this.titleOf(
          cid,
          kind,
          (r["topic"] as string | null) ?? undefined,
          accountId,
        ),
        state: r["archived"] === null ? "active" : "archived",
        memberCount:
          kind === "topic" ? undefined : this.registry.memberCount(cid),
        myCaps: caps,
        lastSeq,
        lastAt: this.lastAtOf(cid),
      });
    };
    for (const r of rows) push(r, jsonParse<Cap[]>(r["caps"] as string, []));
    for (const r of subs) push(r, []);
    out.sort((a, b) =>
      a.lastAt < b.lastAt
        ? 1
        : a.lastAt > b.lastAt
          ? -1
          : a.conversationId < b.conversationId
            ? -1
            : 1,
    );
    return out;
  }

  private titleOf(
    cid: string,
    kind: string,
    topic: string | undefined,
    me: string,
  ): string {
    if (topic !== undefined && topic !== "") return topic;
    if (kind === "direct") {
      const peer = this.one(
        "SELECT account_id FROM mesh_memberships WHERE conversation_id = ? AND account_id <> ? LIMIT 1",
        [cid, me],
      );
      const peerId = (peer?.["account_id"] as string | undefined) ?? "unknown";
      return this.nameOf(peerId);
    }
    return `${kind}(${cid.slice(0, 8)})`;
  }

  async streamEntries(
    piSessionId: string,
    opts?: { sinceSeq?: number },
  ): Promise<StreamEntry[]> {
    const since = opts?.sinceSeq ?? 0;
    const rows = this.rows(
      "SELECT entry_id, pi_session_id, parent_id, seq_in_stream, entry_type, raw_json, " +
        "mesh_message_id, created_at FROM mesh_stream_entries WHERE pi_session_id = ? AND seq_in_stream >= ? " +
        "ORDER BY seq_in_stream",
      [piSessionId, since],
    );
    return rows.map((raw) => ({
      entryId: raw["entry_id"] as string,
      piSessionId: raw["pi_session_id"] as string,
      parentId: (raw["parent_id"] as string | null) ?? null,
      seqInStream: raw["seq_in_stream"] as number,
      entryType: raw["entry_type"] as string,
      rawJson: raw["raw_json"] as string,
      meshMessageId: (raw["mesh_message_id"] as string | null) ?? null,
      createdAt: raw["created_at"] as string,
    }));
  }

  // ── 回放（§23.2：零 LLM 转写）──

  async replay(
    endpointId: string,
    opts?: { untilSeq?: number },
  ): Promise<ReplayResult> {
    const endpoint = this.registry.getEndpoint(endpointId);
    const accountId = endpoint?.accountId ?? "";
    let entries: StreamEntry[] = [];
    if (endpoint?.piSessionId) {
      entries = await this.streamEntries(endpoint.piSessionId);
      const untilSeq = opts?.untilSeq;
      if (untilSeq !== undefined) {
        entries = entries.filter((e) => e.seqInStream <= untilSeq);
      }
    }
    const inbox: InboxView = accountId
      ? await this.inboxOf(accountId)
      : { conversations: [], awaitingMyAck: [], awaitingTheirAck: [] };
    // 注入体：以 InboxView 为骨架的 P2 摘要（逐会话一段）
    const injected: string[] = [];
    for (const conv of inbox.conversations) {
      const lines: string[] = [];
      if (conv.summary) lines.push(`[summary] ${conv.summary}`);
      lines.push(`[digest] ${conv.unread} unread in ${conv.conversationId}`);
      injected.push(lines.join("\n"));
    }
    const prompt = entries
      .map((e) => {
        let text = e.rawJson;
        try {
          const j = JSON.parse(e.rawJson) as { text?: unknown; content?: unknown };
          if (typeof j.text === "string") text = j.text;
          else if (typeof j.content === "string") text = j.content;
        } catch {
          // rawJson 保持原文
        }
        return `[${e.entryType}] ${text}`;
      })
      .join("\n");
    return { prompt, entries, inbox, injected };
  }

  async forkAt(_endpointId: string, _entryId: string): Promise<never> {
    throw new MeshUnsupportedError("Observer.forkAt");
  }

  // ── 指标 ──

  async counters(
    names?: string[],
    since?: string,
  ): Promise<Record<string, number>> {
    const wanted =
      names !== undefined && names.length > 0
        ? [...new Set(names)]
        : [...REGISTERED_COUNTERS].sort();
    const out: Record<string, number> = {};
    let sql = "SELECT name, SUM(value) AS v FROM mesh_counters WHERE 1 = 1";
    const args: unknown[] = [];
    if (since !== undefined && since !== "") {
      sql += " AND bucket >= ?";
      args.push(hourBucket(since));
    }
    const placeholders = wanted.map(() => "?").join(",");
    sql += " AND name IN (" + placeholders + ") GROUP BY name";
    args.push(...wanted);
    for (const row of this.rows(sql, args)) {
      out[row["name"] as string] = (row["v"] as number | null) ?? 0;
    }
    for (const n of wanted) {
      if (!(n in out)) out[n] = 0;
    }
    if (names === undefined || names.length === 0) {
      // queueDepth：各状态 delivery 行数（快照，非计数器）
      for (const st of DELIVERY_STATES) {
        const row = this.one(
          "SELECT COUNT(*) AS n FROM mesh_deliveries WHERE state = ?",
          [st],
        );
        out["queueDepth:" + st] = (row?.["n"] as number | undefined) ?? 0;
      }
    }
    return out;
  }

  // ── 不变量断言（§23.4 C1–C16）──

  async checkInvariants(): Promise<InvariantReport> {
    const nowMs = Date.now();
    const hourAgo = isoFromMs(nowMs - 3_600_000);
    const parkCutoff = isoFromMs(nowMs - this.limits.parkTtlMs);
    const now = isoNow();

    const checks: Array<{
      id: string;
      assertion: string;
      run: () => Array<Record<string, unknown>>;
    }> = [
      {
        // C1（I3）同会话 seq 严格递增无洞无重（seq 从 1 起 ⇒ count = max）
        id: "C1",
        assertion: "per-conversation seq contiguous 1..n with no duplicates",
        run: () =>
          this.rows(
            "SELECT conversation_id, COUNT(*) AS n, MAX(seq) AS mx, COUNT(DISTINCT seq) AS d " +
              "FROM mesh_messages GROUP BY conversation_id HAVING n <> mx OR d <> n",
          ),
      },
      {
        // C2（I5）不重复投递：有 endpoint 按 (message, endpoint)，无 endpoint 按 (message, account)
        id: "C2",
        assertion:
          "no duplicate delivery per (message, endpoint) or (message, account)",
        run: () =>
          this.rows(
            "SELECT message_id, endpoint_id, COUNT(*) AS n FROM mesh_deliveries " +
              "WHERE endpoint_id IS NOT NULL GROUP BY message_id, endpoint_id HAVING n > 1 " +
              "UNION ALL " +
              "SELECT message_id, account_id, COUNT(*) AS n FROM mesh_deliveries " +
              "WHERE endpoint_id IS NULL GROUP BY message_id, account_id HAVING n > 1",
          ),
      },
      {
        // C3（I17 / §7.9）状态与时间戳组合合法
        id: "C3",
        assertion:
          "delivery state/timestamp combinations are legal; drops carry a reason",
        run: () =>
          this.rows(
            "SELECT id, state, drop_reason FROM mesh_deliveries WHERE " +
              "(consumed_at IS NOT NULL AND delivered_at IS NULL) OR " +
              "(delivered_at IS NOT NULL AND queued_at IS NULL) OR " +
              "(state = 'consumed' AND consumed_at IS NULL) OR " +
              "(state = 'delivered' AND delivered_at IS NULL) OR " +
              "(state = 'dropped' AND drop_reason IS NULL) OR " +
              "(partial = 1 AND state <> 'consumed') OR " +
              "(state IN ('claimed','acked') AND delivered_at IS NULL)",
          ),
      },
      {
        // C4（I12）无孤儿投递（消息与投递同事务）
        id: "C4",
        assertion: "every delivery references an existing message",
        run: () =>
          this.rows(
            "SELECT d.id FROM mesh_deliveries d LEFT JOIN mesh_messages m ON m.id = d.message_id WHERE m.id IS NULL",
          ),
      },
      {
        // C5 缓存一致：pending_count ≡ 四态投递行数（口径含 routed，见文件头）
        id: "C5",
        assertion:
          "mesh_inboxes.pending_count equals actual pending delivery rows",
        run: () =>
          this.rows(
            "SELECT i.account_id, i.conversation_id, i.pending_count, COALESCE(x.actual, 0) AS actual " +
              "FROM mesh_inboxes i LEFT JOIN (" +
              "SELECT d.account_id AS account_id, m.conversation_id AS conversation_id, COUNT(*) AS actual " +
              "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
              "WHERE d.state IN " +
              PENDING_STATES +
              " GROUP BY d.account_id, m.conversation_id) x " +
              "ON x.account_id = i.account_id AND x.conversation_id = i.conversation_id " +
              "WHERE i.pending_count <> COALESCE(x.actual, 0)",
          ),
      },
      {
        // C6（I8）无「当时还不是成员」的投递（direct/group/queue；topic 见 C14）
        id: "C6",
        assertion: "deliveries only to members (joined_seq <= seq)",
        run: () =>
          this.rows(
            "SELECT d.id, d.account_id, m.conversation_id FROM mesh_deliveries d " +
              "JOIN mesh_messages m ON m.id = d.message_id " +
              "JOIN mesh_conversations c ON c.id = m.conversation_id " +
              "LEFT JOIN mesh_memberships ms ON ms.conversation_id = m.conversation_id " +
              "AND ms.account_id = d.account_id AND ms.joined_seq <= m.seq " +
              "WHERE c.type IN ('direct','group','queue') AND ms.account_id IS NULL",
          ),
      },
      {
        // C7（I8）入群前的历史不投给该成员（除非 historyVisibility='full'）
        id: "C7",
        assertion:
          "no pre-join history delivered unless historyVisibility=full",
        run: () =>
          this.rows(
            "SELECT d.id, m.seq, ms.joined_seq FROM mesh_deliveries d " +
              "JOIN mesh_messages m ON m.id = d.message_id " +
              "JOIN mesh_conversations c ON c.id = m.conversation_id " +
              "JOIN mesh_memberships ms ON ms.conversation_id = m.conversation_id AND ms.account_id = d.account_id " +
              "WHERE m.seq < ms.joined_seq " +
              "AND COALESCE(json_extract(c.config, '$.historyVisibility'), 'none') <> 'full'",
          ),
      },
      {
        // C8（§14）待应答无泄漏：open 且 deadline < now-1h
        id: "C8",
        assertion: "no open pending_acks past deadline + 1h grace",
        run: () =>
          this.rows(
            "SELECT correlation_id, deadline FROM mesh_pending_acks WHERE state = 'open' AND deadline < ?",
            [hourAgo],
          ),
      },
      {
        // C9（I11）tombstone 链完整：指向的必须是真实 kind='tombstone' 消息
        id: "C9",
        assertion: "tombstoned_by points to a real tombstone message",
        run: () =>
          this.rows(
            "SELECT m.id, m.tombstoned_by FROM mesh_messages m " +
              "LEFT JOIN mesh_messages t ON t.id = m.tombstoned_by " +
              "WHERE m.tombstoned_by IS NOT NULL AND (t.id IS NULL OR t.kind <> 'tombstone')",
          ),
      },
      {
        // C10（I1）锁一致：warming/hot/evicting 必须有 lock_path；hot 的锁文件必须存在
        id: "C10",
        assertion:
          "hot endpoints hold lock_path whose lock file exists on disk",
        run: () => {
          const violations = this.rows(
            "SELECT id, state, lock_path FROM mesh_endpoints " +
              "WHERE state IN ('warming','hot','evicting') AND (lock_path IS NULL OR lock_path = '')",
          );
          const hot = this.rows(
            "SELECT id, lock_path FROM mesh_endpoints WHERE state = 'hot'",
          );
          for (const row of hot) {
            const p = row["lock_path"] as string | null;
            let exists = false;
            try {
              exists = p !== null && p !== "" && existsSync(p);
            } catch {
              exists = false;
            }
            if (!exists) {
              violations.push({
                id: row["id"],
                state: "hot",
                lock_path: p,
                issue: "lock file missing on disk",
              });
            }
          }
          return violations;
        },
      },
      {
        // C11（I17 / §7.10）parked 必带原因与时间
        id: "C11",
        assertion: "parked deliveries carry reason and timestamp",
        run: () =>
          this.rows(
            "SELECT id FROM mesh_deliveries WHERE state = 'parked' AND (parked_reason IS NULL OR parked_at IS NULL)",
          ),
      },
      {
        // C12（§7.9②）parked 不永久沉底：超 parkTtlMs 必须已被转走
        id: "C12",
        assertion: "no parked deliveries older than parkTtlMs",
        run: () =>
          this.rows(
            "SELECT id, parked_reason, parked_at FROM mesh_deliveries WHERE state = 'parked' AND parked_at < ?",
            [parkCutoff],
          ),
      },
      {
        // C13（§17）claimed 不过期（过期必须被 requeue）
        id: "C13",
        assertion: "no expired claimed deliveries",
        run: () =>
          this.rows(
            "SELECT d.id, d.claim_until FROM mesh_deliveries d " +
              "JOIN mesh_messages m ON m.id = d.message_id " +
              "JOIN mesh_conversations c ON c.id = m.conversation_id " +
              "WHERE c.type = 'queue' AND d.state = 'claimed' AND d.claim_until < ?",
            [now],
          ),
      },
      {
        // C14（I8 的 topic 版）投递与订阅区间一致
        id: "C14",
        assertion: "topic deliveries match subscription range",
        run: () =>
          this.rows(
            "SELECT d.id, d.account_id, m.seq FROM mesh_deliveries d " +
              "JOIN mesh_messages m ON m.id = d.message_id " +
              "JOIN mesh_conversations c ON c.id = m.conversation_id " +
              "LEFT JOIN mesh_subscriptions s ON s.conversation_id = m.conversation_id " +
              "AND s.account_id = d.account_id AND s.from_seq <= m.seq AND s.subscribed_at <= m.routed_at " +
              "WHERE c.type = 'topic' AND s.account_id IS NULL",
          ),
      },
      {
        // C15（I8）caps 值域 + 未归档 group 至少一个 dissolve 持有者（在任成员）
        id: "C15",
        assertion:
          "caps within value domain; every active group has a dissolve holder among current members",
        run: () =>
          this.rows(
            "SELECT ms.conversation_id, ms.account_id, j.value AS bad_cap FROM mesh_memberships ms, json_each(ms.caps) j " +
              "WHERE j.value NOT IN ('speak','read','invite','remove','setTopic','setCaps','dissolve') " +
              "UNION ALL " +
              "SELECT c.id, NULL, 'NO_ADMIN_LEFT' FROM mesh_conversations c WHERE c.type = 'group' AND c.archived_at IS NULL " +
              "AND NOT EXISTS (SELECT 1 FROM mesh_memberships ms2, json_each(ms2.caps) j2 " +
              "WHERE ms2.conversation_id = c.id AND ms2.left_at IS NULL AND j2.value = 'dissolve')",
          ),
      },
      {
        // C16（§11）@system 账号存在（system 消息外键的前提）
        id: "C16",
        assertion: "@system account exists",
        run: () =>
          this.rows(
            "SELECT '@system' AS missing WHERE NOT EXISTS (SELECT 1 FROM mesh_accounts WHERE id = '@system')",
          ),
      },
    ];

    const violations: InvariantReport["violations"] = [];
    for (const check of checks) {
      const rows = check.run();
      if (rows.length > 0) {
        violations.push({
          id: check.id,
          assertion: check.assertion,
          count: rows.length,
          sample: rows.slice(0, 5),
        });
      }
    }
    return {
      ok: violations.length === 0,
      checked: checks.length,
      at: now,
      violations,
    };
  }

  // ── 内部 ──

  private hasFts(): boolean {
    if (this.ftsAvailable === null) {
      const row = this.one(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'mesh_messages_fts'",
      );
      this.ftsAvailable = ((row?.["n"] as number | undefined) ?? 0) > 0;
    }
    return this.ftsAvailable;
  }
}
