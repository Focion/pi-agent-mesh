// ═══════════════════════════════════════════════════════════════════════════
// Registry（§3.2 §11.1 §11.2）：账号/端点/会话/成员/联系人的增删查。
// - I7：账号三轴（endpointClass / capabilities / initiate）互不推导
// - I8：caps 是纯位集合，无角色序；子集规则由本文件导出的纯函数承担
// - direct 会话 id 派生式（§9.1）：对称、幂等、可离线计算
// - joinedSeq 取当前 next_seq（§9.4 历史可见性基准）
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import type { ContactRow, MemberRow, Registry } from "./contracts.js";
import type {
  Account,
  Cap,
  AccountId,
  Conversation,
  ConversationConfig,
  ConversationId,
  ConversationKind,
  CreateConversationInput,
  Endpoint,
  EndpointId,
  EndpointState,
  MeshLease,
  PresenceState,
  RegisterAccountInput,
  RegisterEndpointInput,
  StreamTopology,
} from "./types.js";
import { DEFAULT_LIMITS, type Limits } from "./types.js";
import {
  directConversationId,
  isoNow,
  jsonParse,
  jsonText,
  ulid,
} from "./util.js";

// ─── caps 纯函数（§4.4 §9.3：库只认位，不排序）────────────────────────────

export const ALL_CAPS: readonly Cap[] = [
  "speak",
  "read",
  "invite",
  "remove",
  "setTopic",
  "setCaps",
  "dissolve",
];

export function hasCap(caps: Cap[] | undefined, cap: Cap): boolean {
  return Array.isArray(caps) && caps.includes(cap);
}

/** I8 子集规则：granted ⊆ holder。权限只能从已持有的位里派生。 */
export function capsSubsetOf(granted: Cap[], holder: Cap[]): boolean {
  return granted.every((c) => holder.includes(c));
}

/** caps 值域校验（C15 的写入侧防线） */
export function validCaps(caps: unknown): caps is Cap[] {
  return (
    Array.isArray(caps) &&
    caps.every((c) => (ALL_CAPS as readonly string[]).includes(c as string))
  );
}

// ─── 行映射 ────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  display_name: string;
  endpoint_class: string;
  capabilities: string;
  initiate: string;
  default_grade: string | null;
  profile_ref: string | null;
  presence: string;
  presence_until: string | null;
  presence_reason: string | null;
  created_at: string;
  archived_at: string | null;
  ext: string | null;
}

interface EndpointRow {
  id: string;
  account_id: string;
  topology: string;
  scope: string | null;
  scope_key: string | null;
  pool_slot: number | null;
  pi_session_id: string | null;
  lease_mode: string;
  lease_until: string | null;
  lock_path: string | null;
  state: string;
  last_active_at: string | null;
}

interface ConversationRow {
  id: string;
  type: string;
  topic: string | null;
  announcement: string | null;
  config: string | null;
  next_seq: number;
  member_count: number;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
  ext: string | null;
}

interface MembershipRow {
  conversation_id: string;
  account_id: string;
  caps: string;
  joined_seq: number;
  last_spoke_seq: number;
  last_mentioned_seq: number;
  verbatim_pinned: number | null;
  joined_at: string;
  left_at: string | null;
  muted_until: string | null;
}

function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id,
    displayName: r.display_name,
    endpointClass: r.endpoint_class as Account["endpointClass"],
    capabilities: jsonParse<string[]>(r.capabilities, []),
    initiate: jsonParse<Account["initiate"]>(r.initiate, []),
    defaultGrade: (r.default_grade as Account["defaultGrade"]) ?? undefined,
    profileRef: r.profile_ref ?? undefined,
    ext: r.ext === null ? undefined : jsonParse<unknown>(r.ext, undefined),
  };
}

function rowToEndpoint(r: EndpointRow): Endpoint {
  const topology: StreamTopology =
    r.topology === "perConversation"
      ? {
          kind: "perConversation",
          scope: (r.scope ?? "conversation") as "conversation" | "purpose",
          key: r.scope_key ?? "",
        }
      : r.topology === "pooled"
        ? { kind: "pooled", size: 1, affinity: "none" }
        : { kind: "unified" };
  return {
    id: r.id,
    accountId: r.account_id,
    topology,
    state: r.state as EndpointState,
    piSessionId: r.pi_session_id,
    lease: r.lease_mode as MeshLease,
    leaseUntil: r.lease_until,
    lastActiveAt: r.last_active_at,
  };
}

function rowToConversation(r: ConversationRow, limits: Limits): Conversation {
  const config = jsonParse<Partial<ConversationConfig>>(r.config, {});
  return {
    id: r.id,
    kind: r.type as ConversationKind,
    state: r.archived_at ? "archived" : "active",
    topic: r.topic ?? undefined,
    announcement: r.announcement ?? undefined,
    config: normalizeConfig(r.type as ConversationKind, config, limits),
    createdBy: r.created_by ?? "",
    createdAt: r.created_at,
    lastSeq: r.next_seq - 1,
    ext: r.ext === null ? undefined : jsonParse<unknown>(r.ext, undefined),
  };
}

/** §9.4：单会话配置只允许收紧；未给的项取全局 Limits；groupSizeHardCap 夹到全局值 */
function normalizeConfig(
  type: string,
  c: Partial<ConversationConfig>,
  limits: Limits,
): ConversationConfig {
  const hardCap =
    type === "group"
      ? Math.min(
          c.groupSizeHardCap ?? limits.groupSizeHardCap,
          limits.groupSizeHardCap,
        )
      : undefined;
  return {
    historyVisibility: c.historyVisibility ?? "since_join",
    maxHistoryOnJoin: c.maxHistoryOnJoin ?? 0,
    openJoin: c.openJoin ?? false,
    groupSizeHardCap: hardCap,
    claimTtlMs: c.claimTtlMs ?? limits.claimTtlMs,
    mentionAllPerHour: c.mentionAllPerHour ?? 3,
    maxPending: Math.min(c.maxPending ?? limits.maxPending, limits.maxPending),
    maxPendingBytes: Math.min(
      c.maxPendingBytes ?? limits.maxPendingBytes,
      limits.maxPendingBytes,
    ),
  };
}

// ─── Registry 实现 ─────────────────────────────────────────────────────────

export class MeshRegistry implements Registry {
  private readonly db: Database.Database;
  private readonly limits: Limits;

  constructor(db: Database.Database, limits: Limits = DEFAULT_LIMITS) {
    this.db = db;
    this.limits = limits;
  }

  // ── 账号 ──

  registerAccount(a: RegisterAccountInput): Promise<Account> {
    const id = a.id ?? ulid();
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO mesh_accounts (id, display_name, endpoint_class, capabilities, initiate, " +
          "default_grade, profile_ref, presence, created_at, ext) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        a.displayName,
        a.endpointClass,
        jsonText(a.capabilities ?? []) ?? "[]",
        jsonText(a.initiate ?? []) ?? "[]",
        a.defaultGrade ?? null,
        a.profileRef ?? null,
        "offline",
        now,
        a.ext === undefined ? null : JSON.stringify(a.ext),
      );
    return Promise.resolve(this.getAccount(id)!);
  }

  getAccount(id: AccountId): Account | undefined {
    const row = this.db
      .prepare<[string], AccountRow>("SELECT * FROM mesh_accounts WHERE id = ?")
      .get(id) as AccountRow | undefined;
    return row ? rowToAccount(row) : undefined;
  }

  lookupAccounts(q: {
    query?: string;
    capabilities?: string[];
    limit?: number;
  }): Account[] {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const rows = this.db
      .prepare<[number], AccountRow>(
        "SELECT * FROM mesh_accounts WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as AccountRow[];
    let accounts = rows.map(rowToAccount);
    if (q.query) {
      const needle = q.query.toLowerCase();
      accounts = accounts.filter(
        (a) =>
          a.id.toLowerCase().includes(needle) ||
          a.displayName.toLowerCase().includes(needle),
      );
    }
    if (q.capabilities && q.capabilities.length > 0) {
      accounts = accounts.filter((a) =>
        q.capabilities!.every((c) => (a.capabilities ?? []).includes(c)),
      );
    }
    return accounts;
  }

  /** 有效 presence（presence_until 过期按 offline 解释，§11.1；库不起定时器改写） */
  effectivePresence(id: AccountId): PresenceState {
    const row = this.db
      .prepare<[string], { presence: string; presence_until: string | null }>(
        "SELECT presence, presence_until FROM mesh_accounts WHERE id = ?",
      )
      .get(id);
    if (!row) return "offline";
    if (row.presence_until && Date.parse(row.presence_until) < Date.now())
      return "offline";
    return row.presence as PresenceState;
  }

  setPresence(
    id: AccountId,
    state: PresenceState,
    opts?: { until?: string; reason?: string },
  ): void {
    const before = this.effectivePresence(id);
    this.db
      .prepare(
        "UPDATE mesh_accounts SET presence = ?, presence_until = ?, presence_reason = ? WHERE id = ?",
      )
      .run(state, opts?.until ?? null, opts?.reason ?? null, id);
    return void { before };
  }

  upsertContact(
    ownerId: AccountId,
    peerId: AccountId,
    opts?: { alias?: string; tags?: unknown },
  ): void {
    const tags = opts?.tags;
    this.db
      .prepare(
        "INSERT INTO mesh_contacts (owner_id, peer_id, alias, tags, created_at) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(owner_id, peer_id) DO UPDATE SET alias = excluded.alias, tags = excluded.tags",
      )
      .run(
        ownerId,
        peerId,
        opts?.alias ?? null,
        tags === undefined ? null : JSON.stringify(tags),
        isoNow(),
      );
  }

  listContacts(ownerId: AccountId, query?: string): ContactRow[] {
    const rows = this.db
      .prepare<
        [string],
        {
          owner_id: string;
          peer_id: string;
          alias: string | null;
          tags: string | null;
        }
      >(
        "SELECT owner_id, peer_id, alias, tags FROM mesh_contacts WHERE owner_id = ?",
      )
      .all(ownerId);
    let out: ContactRow[] = rows.map((r) => ({
      accountId: r.peer_id,
      displayName: this.getAccount(r.peer_id)?.displayName ?? r.peer_id,
      alias: r.alias ?? undefined,
      tags: r.tags === null ? undefined : jsonParse<unknown>(r.tags, undefined),
    }));
    if (query) {
      const needle = query.toLowerCase();
      out = out.filter(
        (c) =>
          c.accountId.toLowerCase().includes(needle) ||
          c.displayName.toLowerCase().includes(needle) ||
          (c.alias ?? "").toLowerCase().includes(needle),
      );
    }
    return out;
  }

  // ── 端点 ──

  registerEndpoint(e: RegisterEndpointInput): Promise<Endpoint> {
    const id = ulid();
    const t = e.topology;
    this.db
      .prepare(
        "INSERT INTO mesh_endpoints (id, account_id, topology, scope, scope_key, pool_slot, " +
          "pi_session_id, state, last_active_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        e.accountId,
        t.kind,
        t.kind === "perConversation" ? (t as { scope: string }).scope : null,
        t.kind === "perConversation" ? (t as { key: string }).key : null,
        null,
        e.piSessionId ?? null,
        "cold",
        null,
      );
    return Promise.resolve(this.getEndpoint(id)!);
  }

  getEndpoint(id: EndpointId): Endpoint | undefined {
    const row = this.db
      .prepare<[string], EndpointRow>(
        "SELECT * FROM mesh_endpoints WHERE id = ?",
      )
      .get(id) as EndpointRow | undefined;
    return row ? rowToEndpoint(row) : undefined;
  }

  endpointsOf(accountId: AccountId): Endpoint[] {
    const rows = this.db
      .prepare<[string], EndpointRow>(
        "SELECT * FROM mesh_endpoints WHERE account_id = ? ORDER BY id",
      )
      .all(accountId) as EndpointRow[];
    return rows.map(rowToEndpoint);
  }

  updateEndpointState(id: EndpointId, state: EndpointState): void {
    this.db
      .prepare(
        "UPDATE mesh_endpoints SET state = ?, last_active_at = ? WHERE id = ?",
      )
      .run(state, state === "cold" ? null : isoNow(), id);
  }

  setEndpointSession(id: EndpointId, piSessionId: string): void {
    this.db
      .prepare("UPDATE mesh_endpoints SET pi_session_id = ? WHERE id = ?")
      .run(piSessionId, id);
  }

  setEndpointLease(
    id: EndpointId,
    lease: MeshLease,
    until: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE mesh_endpoints SET lease_mode = ?, lease_until = ? WHERE id = ?",
      )
      .run(lease, until, id);
  }

  /** §8.3/§19.4：warm 抢到锁后落库归属（lock_path），evict 清空。C10 锁一致的持久真相。 */
  setEndpointLock(id: EndpointId, lockPath: string | null): void {
    this.db
      .prepare("UPDATE mesh_endpoints SET lock_path = ? WHERE id = ?")
      .run(lockPath, id);
  }

  /** pooled 拓扑注册 size 条端点 */
  registerPooledEndpoints(
    accountId: AccountId,
    size: number,
    piSessionIds?: string[],
  ): Promise<Endpoint[]> {
    const out: Endpoint[] = [];
    for (let i = 0; i < size; i++) {
      const id = ulid();
      this.db
        .prepare(
          "INSERT INTO mesh_endpoints (id, account_id, topology, pool_slot, pi_session_id, state) VALUES (?,?,?,?,?,?)",
        )
        .run(id, accountId, "pooled", i, piSessionIds?.[i] ?? null, "cold");
      out.push(this.getEndpoint(id)!);
    }
    return Promise.resolve(out);
  }

  // ── 会话 ──

  ensureDirect(a: AccountId, b: AccountId): Promise<Conversation> {
    const id = directConversationId(a, b);
    const existing = this.getConversation(id);
    if (existing) return Promise.resolve(existing);
    const now = isoNow();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO mesh_conversations (id, type, config, next_seq, member_count, created_by, created_at) " +
          "VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "direct",
        JSON.stringify({ historyVisibility: "full" }),
        1,
        2,
        a,
        now,
      );
    const joinedSeq = 0; // direct 双方从 0 起可见（历史全可见，§9.4 config.full）
    const caps = jsonText(["speak", "read"])!;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
      )
      .run(id, a, caps, joinedSeq, now);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
      )
      .run(id, b, caps, joinedSeq, now);
    // 直接触发 ensureDirect 的场景是普通发送：两行 inbox 预建，避免 fanout 时补建
    this.ensureInboxRow(a, id);
    this.ensureInboxRow(b, id);
    return Promise.resolve(this.getConversation(id)!);
  }

  createConversation(c: CreateConversationInput): Promise<Conversation> {
    const id = ulid();
    const now = isoNow();
    const members =
      c.type === "topic"
        ? []
        : Array.from(new Set([c.creator, ...(c.members ?? [])]));
    this.db
      .prepare(
        "INSERT INTO mesh_conversations (id, type, topic, announcement, config, next_seq, member_count, created_by, created_at, ext) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        c.type,
        c.topic ?? null,
        null,
        jsonText(c.config ?? {}) ?? "{}",
        1,
        members.length,
        c.creator,
        now,
        c.ext === undefined ? null : JSON.stringify(c.ext),
      );
    if (c.type !== "topic") {
      const joinedSeq = 0;
      const stmt = this.db.prepare(
        "INSERT INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
      );
      const creatorCaps = jsonText([...ALL_CAPS])!;
      const memberCaps = jsonText(["speak", "read"])!;
      const tx = this.db.transaction(() => {
        for (const m of members) {
          stmt.run(
            id,
            m,
            m === c.creator ? creatorCaps : memberCaps,
            joinedSeq,
            now,
          );
          this.ensureInboxRow(m, id);
        }
      });
      tx();
    }
    return Promise.resolve(this.getConversation(id)!);
  }

  getConversation(id: ConversationId): Conversation | undefined {
    const row = this.db
      .prepare<[string], ConversationRow>(
        "SELECT * FROM mesh_conversations WHERE id = ?",
      )
      .get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row, this.limits) : undefined;
  }

  setTopic(conv: ConversationId, topic?: string, announcement?: string): void {
    this.db
      .prepare(
        "UPDATE mesh_conversations SET topic = COALESCE(?, topic), announcement = COALESCE(?, announcement) WHERE id = ?",
      )
      .run(topic ?? null, announcement ?? null, conv);
  }

  archiveConversation(conv: ConversationId): void {
    this.db
      .prepare("UPDATE mesh_conversations SET archived_at = ? WHERE id = ?")
      .run(isoNow(), conv);
  }

  // ── 成员 ──

  addMember(conv: ConversationId, account: AccountId, caps: Cap[]): void {
    const joinedSeq = this.currentSeq(conv);
    const existing = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_memberships WHERE conversation_id = ? AND account_id = ?",
      )
      .get(conv, account);
    if (existing && existing.n > 0) {
      // 退群后重新加入：更新 joined_seq（§9.4——第二次加入看不到中间那段）
      this.db
        .prepare(
          "UPDATE mesh_memberships SET left_at = NULL, joined_seq = ?, joined_at = ?, caps = ? WHERE conversation_id = ? AND account_id = ?",
        )
        .run(joinedSeq, isoNow(), jsonText(caps)!, conv, account);
    } else {
      this.db
        .prepare(
          "INSERT INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
        )
        .run(conv, account, jsonText(caps)!, joinedSeq, isoNow());
    }
    this.ensureInboxRow(account, conv);
    this.refreshMemberCount(conv);
  }

  removeMember(conv: ConversationId, account: AccountId): void {
    this.db
      .prepare(
        "UPDATE mesh_memberships SET left_at = ? WHERE conversation_id = ? AND account_id = ?",
      )
      .run(isoNow(), conv, account);
    this.refreshMemberCount(conv);
  }

  getMembership(
    conv: ConversationId,
    account: AccountId,
  ):
    | {
        caps: Cap[];
        joinedSeq: number;
        mutedUntil?: string;
        verbatimPinned?: boolean;
      }
    | undefined {
    const row = this.db
      .prepare<[string, string], MembershipRow>(
        "SELECT * FROM mesh_memberships WHERE conversation_id = ? AND account_id = ? AND left_at IS NULL",
      )
      .get(conv, account) as MembershipRow | undefined;
    if (!row) return undefined;
    return {
      caps: jsonParse<Cap[]>(row.caps, []),
      joinedSeq: row.joined_seq,
      mutedUntil: row.muted_until ?? undefined,
      verbatimPinned:
        row.verbatim_pinned === null || row.verbatim_pinned === undefined
          ? undefined
          : row.verbatim_pinned === 1,
    };
  }

  listMembers(conv: ConversationId): MemberRow[] {
    const rows = this.db
      .prepare<
        [string],
        MembershipRow & { display_name: string; presence: string }
      >(
        "SELECT ms.*, a.display_name, a.presence, a.presence_until FROM mesh_memberships ms " +
          "JOIN mesh_accounts a ON a.id = ms.account_id WHERE ms.conversation_id = ? AND ms.left_at IS NULL ORDER BY ms.joined_at",
      )
      .all(conv) as Array<
      MembershipRow & {
        display_name: string;
        presence: string;
        presence_until: string | null;
      }
    >;
    const now = Date.now();
    return rows.map((r) => ({
      accountId: r.account_id,
      displayName: r.display_name,
      caps: jsonParse<Cap[]>(r.caps, []),
      presence:
        r.presence_until && Date.parse(r.presence_until) < now
          ? ("offline" as const)
          : (r.presence as MemberRow["presence"]),
    }));
  }

  memberCount(conv: ConversationId): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_memberships WHERE conversation_id = ? AND left_at IS NULL",
      )
      .get(conv);
    return row?.n ?? 0;
  }

  setCaps(conv: ConversationId, account: AccountId, caps: Cap[]): void {
    this.db
      .prepare(
        "UPDATE mesh_memberships SET caps = ? WHERE conversation_id = ? AND account_id = ?",
      )
      .run(jsonText(caps)!, conv, account);
  }

  mute(conv: ConversationId, account: AccountId, until: string): void {
    this.db
      .prepare(
        "UPDATE mesh_memberships SET muted_until = ? WHERE conversation_id = ? AND account_id = ?",
      )
      .run(until, conv, account);
  }

  recordSpoke(conv: ConversationId, account: AccountId, seq: number): void {
    // 只增不减（§11.2）
    this.db
      .prepare(
        "UPDATE mesh_memberships SET last_spoke_seq = MAX(last_spoke_seq, ?) WHERE conversation_id = ? AND account_id = ?",
      )
      .run(seq, conv, account);
  }

  recordMentioned(
    conv: ConversationId,
    accounts: AccountId[],
    seq: number,
  ): void {
    if (accounts.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE mesh_memberships SET last_mentioned_seq = MAX(last_mentioned_seq, ?) WHERE conversation_id = ? AND account_id = ?",
    );
    for (const a of accounts) stmt.run(seq, conv, a);
  }

  /** 原文预算推导输入（§7.4） */
  spokeOrMentioned(conv: ConversationId, account: AccountId): boolean {
    const row = this.db
      .prepare<[string, string], { s: number; m: number }>(
        "SELECT last_spoke_seq AS s, last_mentioned_seq AS m FROM mesh_memberships WHERE conversation_id = ? AND account_id = ?",
      )
      .get(conv, account);
    if (!row) return false;
    return row.s > 0 || row.m > 0;
  }

  gapOf(conv: ConversationId, account: AccountId): number {
    const convRow = this.db
      .prepare<[string], { next_seq: number }>(
        "SELECT next_seq FROM mesh_conversations WHERE id = ?",
      )
      .get(conv);
    const memRow = this.db
      .prepare<[string, string], { s: number; m: number }>(
        "SELECT last_spoke_seq AS s, last_mentioned_seq AS m FROM mesh_memberships WHERE conversation_id = ? AND account_id = ?",
      )
      .get(conv, account);
    const nextSeq = convRow?.next_seq ?? 1;
    const last = Math.max(memRow?.s ?? 0, memRow?.m ?? 0);
    return nextSeq - 1 - last;
  }

  // ── 订阅（topic）──

  subscribe(conv: ConversationId, account: AccountId, fromSeq: number): void {
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO mesh_subscriptions (conversation_id, account_id, from_seq, subscribed_at) VALUES (?,?,?,?) " +
          "ON CONFLICT(conversation_id, account_id) DO UPDATE SET from_seq = excluded.from_seq, subscribed_at = excluded.subscribed_at, unsubscribed_at = NULL",
      )
      .run(conv, account, fromSeq, now);
    this.ensureInboxRow(account, conv);
  }

  unsubscribe(conv: ConversationId, account: AccountId): void {
    this.db
      .prepare(
        "UPDATE mesh_subscriptions SET unsubscribed_at = ? WHERE conversation_id = ? AND account_id = ?",
      )
      .run(isoNow(), conv, account);
  }

  listSubscribers(
    conv: ConversationId,
  ): Array<{ accountId: AccountId; fromSeq: number }> {
    const rows = this.db
      .prepare<[string], { account_id: string; from_seq: number }>(
        "SELECT account_id, from_seq FROM mesh_subscriptions WHERE conversation_id = ? AND unsubscribed_at IS NULL",
      )
      .all(conv);
    return rows.map((r) => ({ accountId: r.account_id, fromSeq: r.from_seq }));
  }

  // ── seq 分配（§11.8：必须在 Store.tx 内调用）──

  allocateSeq(conv: ConversationId): number {
    this.db
      .prepare(
        "UPDATE mesh_conversations SET next_seq = next_seq + 1 WHERE id = ?",
      )
      .run(conv);
    const row = this.db
      .prepare<[string], { next_seq: number }>(
        "SELECT next_seq FROM mesh_conversations WHERE id = ?",
      )
      .get(conv);
    return (row?.next_seq ?? 2) - 1;
  }

  currentSeq(conv: ConversationId): number {
    const row = this.db
      .prepare<[string], { next_seq: number }>(
        "SELECT next_seq FROM mesh_conversations WHERE id = ?",
      )
      .get(conv);
    return (row?.next_seq ?? 1) - 1;
  }

  // ── 内部 ──

  ensureInboxRow(account: AccountId, conv: ConversationId): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO mesh_inboxes (account_id, conversation_id) VALUES (?,?)",
      )
      .run(account, conv);
  }

  private refreshMemberCount(conv: ConversationId): void {
    this.db
      .prepare("UPDATE mesh_conversations SET member_count = ? WHERE id = ?")
      .run(this.memberCount(conv), conv);
  }
}
