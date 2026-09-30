// ═══════════════════════════════════════════════════════════════════════════
// Router（§5.4 §5.5 §6 §7.8 §9.1 §11.8 §14 §16.6 §17）：一条消息的准入与分发。
//
// 六步（§5.4）：①成员+speak（@system 豁免；topic 改判 canPublish）
// ②kind ∈ from.initiate（合法 correlationId 的应答豁免，§14.1）
// ③mentions 非成员剔除（spec §5.4③：剔除并记 warning，不是拒绝）
// ④topic/queue 的 to/expect 收窄 ⑤Floor（group/queue）⑥单 IMMEDIATE 事务。
//
// 事务内四件事（§11.8）：分配 seq、插消息（含 FTS 行）、插全部 delivery 行
// （state='routed'）、bump inbox 计数与计数器。事件在提交后派发。
//
// 分发规则（§16.6 §17 §14）：
// - topic：对每个 from_seq ≤ seq 的订阅者各插一行 silent/P3 delivery（§16.3）
// - queue：EndpointSelector 选单消费者，插一行 routed delivery + pending_acks(sync=0)
// - request（blocking）：pending_acks.sync=1（§14.5 阻塞轴）
// - REQUEST_CYCLE 检测照 §14.5 算法：只遍历 sync=1 开集边 + 自环
// ═══════════════════════════════════════════════════════════════════════════

import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import type { RouteInput, Router } from "./contracts.js";
import type { MeshEventBus } from "./events.js";
import { withPolicyGuard, withPolicyTimeout } from "./policies.js";
import type { MeshRegistry } from "./registry.js";
import type { SqliteStore } from "./store.js";
import type {
  Account,
  Cap,
  Conversation,
  Envelope,
  EnvelopePayload,
  Limits,
  Membership,
  MessageId,
  MessageKind,
  Policies,
  PolicySlot,
  DegradeTarget,
} from "./types.js";
import { MeshRejectError } from "./types.js";
import {
  directConversationId,
  idempotencyKey,
  isoFromMs,
  isoNow,
  jsonParse,
  msFromIso,
  sha256Hex,
  ulid,
} from "./util.js";

const SYSTEM_ACCOUNT = "@system";
const MENTION_ALL = "@all";
const LIKE_ALL = '%"@all"%';

export interface RouterDeps {
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  policies: Policies;
  limits: Limits;
  devMode: boolean;
  /** 投递回调：装配层接 Mailbox.fanout；Router 在 tx 提交并发出事件后 await 它 */
  onRouted: (envelope: Envelope) => Promise<void>;
  /** pending_acks 开集查询（delivery 矩阵行 1 用；Router 保留此槽位给装配层） */
  isAwaiting: (accountId: string, correlationId: string) => boolean;
  /** §22.4：宿主提供的 HMAC 密钥；缺省 seal 关闭（默认形态） */
  sealKey?: string;
  /** §6.1/F.2：放行 @all 的能力位；缺省 "speak"（装配层从 MeshOptions 透传） */
  mentionAllCap?: Cap;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  from_account: string;
  kind: string;
  expect: string;
  priority: string | null;
  to_accounts: string | null;
  mentions: string | null;
  reply_to: string | null;
  correlation_id: string | null;
  logical_ts: string | null;
  routed_at: string;
  payload: string;
  ext: string | null;
}

export class MeshRouter implements Router {
  private readonly deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  async route(
    input: RouteInput,
  ): Promise<{ messageId: MessageId; seq: number; correlationId?: string }> {
    const d = this.deps;
    const from = input.from;
    const convId = input.conversationId;
    const kind = (input.kind ?? "chat") as MessageKind;
    let expect = input.expect ?? "none";

    // ── 规范化 ──
    const payload = buildPayload(input);
    const payloadJson = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    const toNorm = Array.from(new Set(input.to ?? []));
    const mentionsRaw = Array.from(new Set(input.mentions ?? []));
    const clientToken =
      input.clientToken ??
      // §5.5：宿主缺省 clientToken 退化为 5 秒去重窗
      sha256Hex(
        from +
          " " +
          convId +
          " " +
          sha256Hex(payloadJson) +
          " " +
          Math.floor(Date.now() / 5000),
      );
    const key = idempotencyKey(convId, from, clientToken);

    // ── 第 0 步：幂等（§5.5）──
    // 这是事务外的快路径预检；并发同键的真闸是 UNIQUE(idempotency_key)，
    // 冲突在事务外捕获后同样按幂等命中返回（见 ⑥ 的 catch）。
    const dup = findIdempotentDup(d.store.db, key);
    if (dup) {
      d.store.bumpCounter("dedup_hit");
      return {
        messageId: dup.id,
        seq: dup.seq,
        correlationId: dup.correlation_id ?? undefined,
      };
    }

    // ── 会话解析（§9.1/§9.2：首条消息隐式 ensureDirect）──
    let conv = d.registry.getConversation(convId);
    if (!conv) {
      if (toNorm.length === 1 && d.registry.getAccount(toNorm[0] ?? "")) {
        const derived = directConversationId(from, toNorm[0] ?? "");
        if (derived === convId) {
          conv = await d.registry.ensureDirect(from, toNorm[0] ?? "");
        }
      }
      if (!conv) {
        throw new MeshRejectError(
          "NOT_A_MEMBER",
          "no such conversation: " + convId,
        );
      }
    }
    if (conv.state !== "active") {
      throw new MeshRejectError(
        "NOT_A_MEMBER",
        "conversation is archived: " + convId,
      );
    }

    const sender = d.registry.getAccount(from);
    if (!sender)
      throw new MeshRejectError("NOT_A_MEMBER", "unknown sender: " + from);
    const isSystem = from === SYSTEM_ACCOUNT;

    // ── ① 成员 + speak（topic 无成员表，跳到 canPublish）──
    let membership: Membership | undefined;
    if (conv.kind !== "topic" && !isSystem) {
      const m = d.registry.getMembership(convId, from);
      if (!m)
        throw new MeshRejectError(
          "NOT_A_MEMBER",
          from + " is not a member of " + convId,
        );
      if (!m.caps.includes("speak")) {
        throw new MeshRejectError(
          "NO_SPEAK_CAP",
          from + " lacks speak cap in " + convId,
        );
      }
      membership = {
        conversationId: convId,
        accountId: from,
        caps: m.caps,
        joinedSeq: m.joinedSeq,
      };
    }

    // ── 应答合法性（§14.1：带合法 correlationId 的应答豁免 initiate）──
    let replyOf: {
      correlation_id: string;
      expect: string;
      message_id: string;
    } | null = null;
    if (input.correlationId) {
      const pa = d.store.db
        .prepare<
          [string, string],
          { correlation_id: string; expect: string; message_id: string }
        >(
          "SELECT correlation_id, expect, message_id FROM mesh_pending_acks " +
            "WHERE correlation_id = ? AND to_account = ? AND state = 'open'",
        )
        .get(input.correlationId, from);
      if (pa) replyOf = pa;
    }

    // ── ② initiate（轴三；§4.2）──
    if (!isSystem && !replyOf && !(sender.initiate ?? []).includes(kind)) {
      throw new MeshRejectError(
        "CANNOT_INITIATE",
        kind + " not in initiate set of " + from,
      );
    }
    if (replyOf) {
      // §14.1：应答消息的 expect 强制 none，否则无限往返；强制降级须记 warning
      if (input.expect !== undefined && input.expect !== "none") {
        console.warn(
          `[pi-agent-mesh] reply on correlationId ${replyOf.correlation_id}: ` +
            `expect "${input.expect}" forced to "none" (§14.1)`,
        );
      }
      expect = "none";
    }

    // ── ④ topic / queue 的语义收窄（§16.6 §17.1）──
    if (conv.kind === "topic") {
      if (toNorm.length > 0) {
        throw new MeshRejectError(
          "TARGETING_NOT_SUPPORTED",
          "to is not supported on topic",
        );
      }
      if (expect !== "none") {
        throw new MeshRejectError(
          "TARGETING_NOT_SUPPORTED",
          "expect must be none on topic",
        );
      }
    }
    if (conv.kind === "queue") {
      // §17.6：显式 reply 拒绝；其余值覆写为 ack，不报错
      if (expect === "reply") {
        throw new MeshRejectError(
          "TARGETING_NOT_SUPPORTED",
          "expect:reply is not supported on queue",
        );
      }
      expect = "ack"; // §17.1：Router 强制
    }

    // ── 成员/订阅者集合 ──
    const memberRows = d.registry.listMembers(convId);
    const memberCaps = new Map<string, Cap[]>();
    for (const m of memberRows) memberCaps.set(m.accountId, m.caps);
    const subscribers =
      conv.kind === "topic" ? d.registry.listSubscribers(convId) : [];
    const subscriberIds = new Set(subscribers.map((s) => s.accountId));

    // ── ③ mentions 过滤（§5.4③：非成员剔除并记 warning；topic 非订阅者忽略）──
    const mentionPool =
      conv.kind === "topic" ? subscriberIds : new Set(memberCaps.keys());
    const mentionsAll =
      mentionsRaw.includes(MENTION_ALL) && conv.kind !== "topic";
    const mentions = mentionsRaw.filter(
      (m) => m === MENTION_ALL || (m !== from && mentionPool.has(m)),
    );
    const strippedMentions = mentionsRaw.filter((m) => !mentions.includes(m));
    if (strippedMentions.length > 0) {
      // §5.4③：非成员（topic：非订阅者）剔除并记 warning，不是拒绝
      console.warn(
        `[pi-agent-mesh] mentions stripped (not ` +
          `${conv.kind === "topic" ? "subscribers" : "members"} of ${convId}): ` +
          strippedMentions.join(", ") + " (§5.4③)",
      );
    }

    // ── @all 两道闸（§6.1/§9.5）──
    // 闸一·权限 = mentionAllCap 能力位（此处）+ AccessControl.canMentionAll
    //（draft 建成后与 canSend 同段执行）；闸二·频率 = 每小时 N 次 + 冷却，先命中者拒绝。
    // 两道闸都是同步拒绝、不落 delivery。
    if (mentionsAll) {
      const capNeeded = d.mentionAllCap ?? "speak";
      // @system 豁免：非成员、无 caps（与 Floor/speak 豁免同理）
      if (!isSystem && !(membership?.caps ?? []).includes(capNeeded)) {
        throw new MeshRejectError(
          "NO_SPEAK_CAP",
          `@all requires "${capNeeded}" cap in ` + convId,
        );
      }
      const perHour = conv.config.mentionAllPerHour ?? 3;
      const hourAgoIso = isoFromMs(Date.now() - 3_600_000);
      const recent = d.store.db
        .prepare<[string, string, string], { n: number }>(
          "SELECT COUNT(*) AS n FROM mesh_messages WHERE conversation_id = ? AND mentions LIKE ? AND routed_at > ?",
        )
        .get(convId, LIKE_ALL, hourAgoIso);
      if ((recent?.n ?? 0) >= perHour) {
        throw new MeshRejectError(
          "MENTION_ALL_THROTTLED",
          "mention-all hourly limit reached",
        );
      }
      if (d.limits.mentionAllCooldownMs > 0) {
        const last = d.store.db
          .prepare<[string, string], { routed_at: string }>(
            "SELECT routed_at FROM mesh_messages WHERE conversation_id = ? AND mentions LIKE ? ORDER BY routed_at DESC LIMIT 1",
          )
          .get(convId, LIKE_ALL);
        if (
          last &&
          Date.now() - msFromIso(last.routed_at) < d.limits.mentionAllCooldownMs
        ) {
          throw new MeshRejectError(
            "MENTION_ALL_THROTTLED",
            "mention-all cooldown active",
          );
        }
      }
    }

    // ── expect ≠ none ⇒ 恰好一个目标（§14.1 pending_acks 单对端）──
    // queue 例外：单消费者由 selector 选出（非调用方定向），故跳过单对端校验；
    // pending_acks 仍会写入（sync=0，to_account=消费者，§17.6）。
    let expectTarget: string | null = null;
    if (expect !== "none" && conv.kind !== "queue") {
      if (toNorm.length === 1) {
        expectTarget = toNorm[0] ?? null;
      } else if (conv.kind === "direct" && toNorm.length === 0) {
        const peer = memberRows.find((m) => m.accountId !== from);
        expectTarget = peer?.accountId ?? null;
      }
      if (!expectTarget) {
        throw new MeshRejectError(
          "TARGETING_NOT_SUPPORTED",
          "expect:" + expect + " requires exactly one target",
        );
      }
      if (!memberCaps.has(expectTarget)) {
        throw new MeshRejectError(
          "NOT_A_MEMBER",
          "expect target is not a member",
        );
      }
    }

    // ── 扇出前防护（§7.8：groupSizeHardCap 只对 group）──
    let warnSize = false;
    if (conv.kind === "group") {
      const mc = memberRows.length;
      const hardCap = conv.config.groupSizeHardCap ?? d.limits.groupSizeHardCap;
      if (mc > hardCap) {
        throw new MeshRejectError(
          "FANOUT_TOO_LARGE",
          "group size " + mc + " > hard cap " + hardCap,
        );
      }
      if (mc > d.limits.groupSizeWarn) warnSize = true;
    }

    // ── 草稿信封（策略 ctx 用；seq 在事务内才分配）──
    const envelopeId = ulid();
    const routedAt = isoNow();
    const effCorrelationId =
      expect === "none"
        ? (input.correlationId ?? undefined)
        : (input.correlationId ?? ulid());
    const draft: Envelope = {
      id: envelopeId,
      seq: 0,
      from,
      fromEndpoint: input.fromEndpoint ?? null,
      routedAt,
      idempotencyKey: key,
      conversationId: convId,
      to: toNorm.length > 0 ? toNorm : undefined,
      kind,
      expect,
      priority: input.priority,
      mentions: mentions.length > 0 ? mentions : undefined,
      replyTo: input.replyTo,
      correlationId: effCorrelationId,
      requestType: input.requestType,
      logicalTs: input.logicalTs,
      payload,
    };

    // ── ⑤ Floor（group/queue；§13）──
    // @system 豁免：其 endpointClass 为 sink，§7.4/§13 规定 sink 端点跳过 Floor；
    // 且它不是成员、不在 candidates 里，不豁免会让 §14 的超时通知永远发不出去。
    if ((conv.kind === "group" || conv.kind === "queue") && !isSystem) {
      const candidates = [...memberCaps.keys()];
      const lastSpeakers = lastSpeakersOf(d, convId);
      const granted = withPolicyGuard(
        this.guardDeps("floor", "free_for_all"),
        () =>
          d.policies.floor.grantFloor({
            conversationId: convId,
            candidates,
            lastSpeakers,
            envelope: draft,
          }),
        candidates, // 降级 = free_for_all（§13.4：宁可吵，不要全场哑掉）
      );
      if (!granted.includes(from)) {
        throw new MeshRejectError(
          "NO_FLOOR",
          from + " has no floor in " + convId,
        );
      }
    }

    // ── AccessControl（fail-closed：超时/抛错 → 拒绝，§9.1 闸②/§12.3⑥）──
    if (conv.kind === "topic") {
      const ok = await withPolicyTimeout(
        this.guardDeps("accessControl", "deny"),
        () =>
          d.policies.accessControl.canPublish?.({
            envelope: draft,
            from: sender,
            conversation: conv,
          }) ?? true,
        false,
      );
      if (!ok) throw new MeshRejectError("NOT_A_MEMBER", "canPublish denied");
    }
    const okSend = await withPolicyTimeout(
      this.guardDeps("accessControl", "deny"),
      () =>
        d.policies.accessControl.canSend?.({
          envelope: draft,
          from: sender,
          conversation: conv,
          membership,
        }) ?? true,
      false,
    );
    if (!okSend) throw new MeshRejectError("NOT_A_MEMBER", "canSend denied");

    // ── @all 闸一·AccessControl 半边（§9.5:1726；fail-closed：超时/抛错 → 否决）──
    if (mentionsAll) {
      const okMentionAll = await withPolicyTimeout(
        this.guardDeps("accessControl", "deny"),
        () =>
          d.policies.accessControl.canMentionAll?.({
            envelope: draft,
            from: sender,
            conversation: conv,
            membership,
          }) ?? true,
        false,
      );
      if (!okMentionAll)
        throw new MeshRejectError(
          "NO_SPEAK_CAP",
          "mention_all denied by AccessControl",
        );
    }

    // ── tombstone 前置校验（§5.6：唯一更正路径）──
    if (kind === "tombstone") {
      if (!input.replyTo) {
        throw new MeshRejectError("NOT_A_MEMBER", "tombstone requires replyTo");
      }
      const orig = d.store.db
        .prepare<[string], { id: string; conversation_id: string }>(
          "SELECT id, conversation_id FROM mesh_messages WHERE id = ?",
        )
        .get(input.replyTo);
      if (!orig || orig.conversation_id !== convId) {
        throw new MeshRejectError(
          "NOT_A_MEMBER",
          "tombstone target not found in this conversation",
        );
      }
    }

    // ── ⑥ 单事务（§11.8）──
    let out: {
      envelope: Envelope;
      deliveryCount: number;
      tombDropped: Array<{ account_id: string }>;
      tombOriginal: Envelope | null;
    };
    try {
      out = d.store.tx(() => {
      const seq = d.registry.allocateSeq(convId);
      const seal = d.sealKey
        ? computeSeal(d.sealKey, draft, seq, payloadJson)
        : undefined;
      const envelope: Envelope = { ...draft, seq, ...(seal ? { seal } : {}) };

      d.store.db
        .prepare(
          "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, from_endpoint, kind, " +
            "expect, priority, to_accounts, mentions, reply_to, correlation_id, ack_of, intent, late, " +
            "logical_ts, routed_at, payload, client_token, idempotency_key, seal, ext) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          envelope.id,
          convId,
          seq,
          from,
          input.fromEndpoint ?? null,
          kind,
          expect,
          input.priority ?? null,
          JSON.stringify(toNorm),
          JSON.stringify(mentions),
          input.replyTo ?? null,
          effCorrelationId ?? null,
          replyOf && replyOf.expect === "ack" ? replyOf.message_id : null,
          input.requestType ?? null,
          0,
          input.logicalTs ?? null,
          routedAt,
          payloadJson,
          clientToken,
          key,
          seal ?? null,
          input.ext === undefined ? null : JSON.stringify(input.ext),
        );

      // FTS（contentless：手工插 rowid + text）
      const rowid = (
        d.store.db.prepare("SELECT last_insert_rowid() AS r").get() as {
          r: number;
        }
      ).r;
      const ftsText = payload.text ?? JSON.stringify(payload);
      d.store.db
        .prepare("INSERT INTO mesh_messages_fts (rowid, text) VALUES (?, ?)")
        .run(rowid, ftsText);

      // ── delivery 集（group/direct：to ∪ mentions(@all 展开) − sender；无 read cap 无行）──
      // topic：每个 from_seq ≤ seq 的订阅者一行（silent/P3，不唤醒）；queue：单消费者一行。
      let queueConsumer: string | null = null;
      let deliveryCount = 0;
      const insDelivery = d.store.db.prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, path, state, state_changed_at) " +
          "VALUES (?,?,?,NULL,?,?,?)",
      );
      if (conv.kind === "topic") {
        // §16.3：仅投递给订阅起始 seq ≤ 本条 seq 的订阅者（退订断档不补容）
        for (const s of [...subscribers].sort((a, b) =>
          a.accountId < b.accountId ? -1 : 1,
        )) {
          if (s.fromSeq > seq) continue;
          insDelivery.run(
            ulid(),
            envelope.id,
            s.accountId,
            "P3",
            "routed",
            routedAt,
          );
          deliveryCount++;
          d.registry.ensureInboxRow(s.accountId, convId);
          d.store.db
            .prepare(
              "UPDATE mesh_inboxes SET pending_count = pending_count + 1, pending_bytes = pending_bytes + ? " +
                "WHERE account_id = ? AND conversation_id = ?",
            )
            .run(payloadBytes, s.accountId, convId);
        }
      } else if (conv.kind === "queue") {
        // §17.1：每条消息 = 一条 delivery，终态 acked；由 least-in-flight 选出单消费者。
        const queueCandidates = [...memberCaps.keys()].filter((m) => m !== from);
        queueConsumer = selectQueueConsumer(d, convId, queueCandidates);
        if (!queueConsumer) {
          throw new MeshRejectError(
            "FANOUT_TOO_LARGE",
            "queue has no worker to consume message",
          );
        }
        insDelivery.run(
          ulid(),
          envelope.id,
          queueConsumer,
          "P1",
          "routed",
          routedAt,
        );
        deliveryCount++;
        d.registry.ensureInboxRow(queueConsumer, convId);
        d.store.db
          .prepare(
            "UPDATE mesh_inboxes SET pending_count = pending_count + 1, pending_bytes = pending_bytes + ? " +
              "WHERE account_id = ? AND conversation_id = ?",
          )
          .run(payloadBytes, queueConsumer, convId);
      } else {
        const recipientSet = new Set<string>();
        if (toNorm.length > 0) {
          for (const t of toNorm) recipientSet.add(t);
        } else {
          for (const m of memberCaps.keys()) recipientSet.add(m);
        }
        if (mentionsAll) for (const m of memberCaps.keys()) recipientSet.add(m);
        for (const m of mentions) if (m !== MENTION_ALL) recipientSet.add(m);
        recipientSet.delete(from);

        for (const accountId of [...recipientSet].sort((a, b) =>
          a < b ? -1 : 1,
        )) {
          const caps = memberCaps.get(accountId);
          if (!caps || !caps.includes("read")) continue; // 无 read ⇒ 无行
          const path = caps.includes("speak") ? "P1" : "P3";
          insDelivery.run(
            ulid(),
            envelope.id,
            accountId,
            path,
            "routed",
            routedAt,
          );
          deliveryCount++;
          d.registry.ensureInboxRow(accountId, convId);
          d.store.db
            .prepare(
              "UPDATE mesh_inboxes SET pending_count = pending_count + 1, pending_bytes = pending_bytes + ? " +
                "WHERE account_id = ? AND conversation_id = ?",
            )
            .run(payloadBytes, accountId, convId);
        }
      }

      // 发送方自己的行：不算未读（§6.1），但计入原文预算（§7.4）
      if (conv.kind !== "topic") {
        d.registry.ensureInboxRow(from, convId);
        d.store.db
          .prepare(
            "UPDATE mesh_inboxes SET verbatim_bytes = verbatim_bytes + ? WHERE account_id = ? AND conversation_id = ?",
          )
          .run(payloadBytes, from, convId);
      }

      d.registry.recordSpoke(convId, from, seq);
      const mentionedAccounts = new Set<string>(
        mentions.filter((m) => m !== MENTION_ALL),
      );
      if (mentionsAll)
        for (const m of memberCaps.keys())
          if (m !== from) mentionedAccounts.add(m);
      d.registry.recordMentioned(convId, [...mentionedAccounts], seq);

      // ── pending_acks（§14.2：ack 30s / reply 5min；queue 恒 sync=0，to_account=消费者）──
      const ackTarget = conv.kind === "queue" ? queueConsumer : expectTarget;
      if (expect !== "none" && ackTarget) {
        // §14.5：sync=1（阻塞式）才参与环检测；queue 与普通 request 均为 sync=0
        const sync = conv.kind === "queue" ? 0 : input.blocking ? 1 : 0;
        if (sync === 1) {
          const cycle = detectRequestCycle(
            d.store,
            from,
            ackTarget,
            d.limits.requestChainMaxDepth,
          );
          if (cycle.result !== "ok") {
            throw new MeshRejectError(
              "REQUEST_CYCLE",
              cycle.result + (cycle.path ? ": " + cycle.path.join(" -> ") : ""),
            );
          }
        }
        const timeoutMs =
          expect === "ack" ? d.limits.ackTimeoutMs : d.limits.replyTimeoutMs;
        d.store.db
          .prepare(
            "INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, " +
              "conversation_id, intent, sync, deadline, state) VALUES (?,?,?,?,?,?,?,?,?,'open')",
          )
          .run(
            effCorrelationId,
            envelope.id,
            expect,
            from,
            ackTarget,
            convId,
            input.requestType ?? null,
            sync,
            isoFromMs(Date.now() + timeoutMs),
          );
      }

      // ── 应答回来：闭合开集（§14.1 ⑥）──
      if (replyOf) {
        d.store.db
          .prepare(
            "UPDATE mesh_pending_acks SET state = 'answered', answered_by_message = ? " +
              "WHERE correlation_id = ? AND to_account = ? AND state = 'open'",
          )
          .run(envelope.id, replyOf.correlation_id, from);
      }

      // ── tombstone：原文未投出的投递行终止（§5.6）──
      let tombDropped: Array<{ account_id: string }> = [];
      let tombOriginal: Envelope | null = null;
      if (kind === "tombstone" && input.replyTo) {
        d.store.db
          .prepare("UPDATE mesh_messages SET tombstoned_by = ? WHERE id = ?")
          .run(envelope.id, input.replyTo);
        tombDropped = d.store.db
          .prepare<[string], { account_id: string }>(
            "SELECT account_id FROM mesh_deliveries WHERE message_id = ? AND state IN ('routed','queued','parked')",
          )
          .all(input.replyTo) as Array<{ account_id: string }>;
        d.store.db
          .prepare(
            "UPDATE mesh_deliveries SET state = 'dropped', drop_reason = 'TOMBSTONED', state_changed_at = ? " +
              "WHERE message_id = ? AND state IN ('routed','queued','parked')",
          )
          .run(routedAt, input.replyTo);
        const origRow = d.store.db
          .prepare<[string], MessageRow>(
            "SELECT * FROM mesh_messages WHERE id = ?",
          )
          .get(input.replyTo) as MessageRow | undefined;
        if (origRow) tombOriginal = rowToEnvelope(origRow);
      }

      // ── 计数器（附录 E；与状态跃迁同事务）──
      d.store.bumpCounter("messages_total");
      if (deliveryCount > 0)
        d.store.bumpCounter("deliveries_total", deliveryCount);
      if (warnSize) d.store.bumpCounter("fanout_warn");

      return { envelope, deliveryCount, tombDropped, tombOriginal };
      });
    } catch (err) {
      // §5.5：第 0 步预检在事务外，UNIQUE(idempotency_key) 才是真闸。并发同键
      // 重试会双双通过预检 ⇒ 后者在事务内撞约束。这不是错误而是幂等命中：
      // 事务已整体回滚（seq 无空洞），重查原结果返回，并记 dedup_hit。
      if (isIdempotencyConflict(err)) {
        const orig = findIdempotentDup(d.store.db, key);
        if (orig) {
          d.store.bumpCounter("dedup_hit");
          return {
            messageId: orig.id,
            seq: orig.seq,
            correlationId: orig.correlation_id ?? undefined,
          };
        }
      }
      throw err;
    }

    // ── 提交后：事件（§12.5 硬规定三）→ fanout ──
    d.events.emit("message_routed", { envelope: out.envelope });
    if (out.tombOriginal) {
      for (const t of out.tombDropped) {
        d.events.emit("message_dropped", {
          envelope: out.tombOriginal,
          reason: "TOMBSTONED",
        });
      }
    }
    await d.onRouted(out.envelope);
    return {
      messageId: out.envelope.id,
      seq: out.envelope.seq,
      correlationId: out.envelope.correlationId,
    };
  }

  private guardDeps(slot: PolicySlot, degradedTo: DegradeTarget) {
    const d = this.deps;
    return {
      slot,
      timeoutMs: d.limits.policyTimeoutMs,
      degradedTo,
      onDegraded: (
        reason: "timeout" | "threw",
        s: PolicySlot,
        target: DegradeTarget,
      ) => {
        d.events.emit("policy_degraded", {
          slot: s,
          reason,
          degradedTo: target,
        });
        d.store.bumpCounter("policy_degraded");
      },
    };
  }
}

// ─── 纯函数 ────────────────────────────────────────────────────────────────

/** §5.5：按幂等键取原结果（第 0 步预检与 UNIQUE 冲突回退共用） */
function findIdempotentDup(
  db: Database.Database,
  key: string,
): { id: string; seq: number; correlation_id: string | null } | undefined {
  return db
    .prepare<
      [string],
      { id: string; seq: number; correlation_id: string | null }
    >(
      "SELECT id, seq, correlation_id FROM mesh_messages WHERE idempotency_key = ?",
    )
    .get(key);
}

/** better-sqlite3 的 UNIQUE 冲突判定，仅限 mesh_messages.idempotency_key */
function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    typeof e?.code === "string" &&
    e.code.startsWith("SQLITE_CONSTRAINT") &&
    typeof e?.message === "string" &&
    e.message.includes("mesh_messages.idempotency_key")
  );
}

function buildPayload(input: RouteInput): EnvelopePayload {
  const base = input.payload ? { ...input.payload } : {};
  if (input.text !== undefined) base.text = input.text;
  return base;
}

/** §22.4：seal 只覆盖消息本身（系统层 + 意图层 + payload/ext 摘要），HMAC-sha256 */
function computeSeal(
  key: string,
  draft: Envelope,
  seq: number,
  payloadJson: string,
): string {
  const canonical = JSON.stringify({
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
  });
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

function lastSpeakersOf(d: RouterDeps, convId: string): string[] {
  const rows = d.store.db
    .prepare<[string], { from_account: string }>(
      "SELECT from_account FROM mesh_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 5",
    )
    .all(convId);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.from_account)) {
      seen.add(r.from_account);
      out.push(r.from_account);
    }
  }
  return out;
}

/** §17.1：从 queue 成员挑出当前 in-flight 最少的消费者（相等取字典序最小，保证确定性） */
function selectQueueConsumer(
  d: RouterDeps,
  convId: string,
  candidates: string[],
): string | null {
  const sorted = [...candidates].sort();
  if (sorted.length === 0) return null;
  const rows = d.store.db
    .prepare<[string], { account_id: string; n: number }>(
      "SELECT d.account_id, COUNT(*) AS n FROM mesh_deliveries d " +
        "JOIN mesh_messages m ON m.id = d.message_id " +
        "WHERE m.conversation_id = ? AND d.state IN ('queued','delivered','routed','parked') " +
        "GROUP BY d.account_id",
    )
    .all(convId);
  const inflight = new Map(rows.map((r) => [r.account_id, r.n]));
  let best = sorted[0]!;
  let bestN = inflight.get(best) ?? 0;
  for (const m of sorted.slice(1)) {
    const n = inflight.get(m) ?? 0;
    if (n < bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

/**
 * §14.5 环检测：只遍历 sync=1（阻塞式）开集边；account 为节点。
 * 自环（请求自己）直接 cycle；深度超 requestChainMaxDepth 与真死锁同码拒绝。
 */
export function detectRequestCycle(
  store: SqliteStore,
  from: string,
  to: string,
  maxDepth: number,
): { result: "ok" | "cycle" | "depth"; path?: string[] } {
  if (from === to) return { result: "cycle", path: [from, to] };
  const edges = store.db
    .prepare<[], { from_account: string; to_account: string }>(
      "SELECT from_account, to_account FROM mesh_pending_acks WHERE state = 'open' AND sync = 1",
    )
    .all() as Array<{ from_account: string; to_account: string }>;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from_account) ?? [];
    list.push(e.to_account);
    adj.set(e.from_account, list);
  }
  const seen = new Set<string>([to]);
  const parent = new Map<string, string>();
  const stack: Array<{ node: string; depth: number }> = [
    { node: to, depth: 1 },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    if (cur.node === from) {
      const path: string[] = [from];
      let n: string | undefined = cur.node;
      while (n !== undefined && n !== to) {
        n = parent.get(n);
        if (n !== undefined) path.push(n);
      }
      path.push(to);
      return { result: "cycle", path };
    }
    if (cur.depth >= maxDepth) return { result: "depth" };
    for (const next of adj.get(cur.node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        parent.set(next, cur.node);
        stack.push({ node: next, depth: cur.depth + 1 });
      }
    }
  }
  return { result: "ok" };
}

function rowToEnvelope(r: MessageRow): Envelope {
  return {
    id: r.id,
    seq: r.seq,
    from: r.from_account,
    fromEndpoint: null,
    routedAt: r.routed_at,
    idempotencyKey: "",
    conversationId: r.conversation_id,
    to: jsonParse<string[]>(r.to_accounts, []),
    kind: r.kind as MessageKind,
    expect: r.expect as Envelope["expect"],
    priority: (r.priority ?? undefined) as Envelope["priority"],
    mentions: jsonParse<string[]>(r.mentions, []),
    replyTo: r.reply_to ?? undefined,
    correlationId: r.correlation_id ?? undefined,
    logicalTs: r.logical_ts ?? undefined,
    payload: jsonParse<EnvelopePayload>(r.payload, {}),
    ext: r.ext === null ? undefined : jsonParse<unknown>(r.ext, undefined),
  };
}

export type { Account, Conversation };
