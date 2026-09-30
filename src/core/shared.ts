// ═══════════════════════════════════════════════════════════════════════════
// SharedSpace（§18）：共享空间的持久化与 ACL。
//
// - 每个对象一行 mesh_shared_objects + 每版一行 mesh_shared_versions，
//   put 的 CAS / 版本记录 / 旧版本裁剪同属一个 db.transaction（§18.4）。
// - ACL 用规范 §18 三向 Acl = { read, write, admin }，语义「任一规则命中即放行」。
//   内建判等：public / conversation{id} / accounts{ids} / capabilities{...} /
//   custom{tag → AccessControl.resolveCustomTag}。策略槽 canRead/canWrite/canAdmin
//   （fail-closed）在内建规则之前裁决。put/del/append 走 write 面；get/list 走 read 面；
//   admin 面仅保留在类型上（本构建未暴露 setAcl，故 admin 暂无裁决入口）。
// - 默认 ACL：`conv:` → read/write = 该会话成员或订阅者、admin = owner；其余 → 三向均 owner。
// - `shared.get` 对「从未存在」与「已 del（tombstoned）」统一返回 null；
//   list 经 tombstoned=0 排除。错误统一 reject（MeshRejectError 携 SPACE_FORBIDDEN
//   / VERSION_MISMATCH / OBJECT_TOO_LARGE）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import type { SharedSpace as SharedSpaceContract } from "./contracts.js";
import type { MeshEventBus } from "./events.js";
import { withPolicyTimeout, type PolicyTimeoutDeps } from "./policies.js";
import type { MeshRegistry } from "./registry.js";
import type {
  AccessControl,
  Account,
  AccountId,
  Acl,
  AclCtx,
  AclRule,
  Conversation,
  DegradeTarget,
  Limits,
  Membership,
  PolicySlot,
  SharedObjectMeta,
  SpaceId,
} from "./types.js";
import { MeshRejectError } from "./types.js";
import { isoNow, jsonParse } from "./util.js";

const CONV_PREFIX = "conv:";

export interface SharedSpaceDeps {
  db: Database.Database;
  registry: MeshRegistry;
  events: MeshEventBus;
  accessControl: AccessControl;
  limits: Limits;
  /** 提交后通知：装配层根据 spaceId 决定是否 route 一条 conv: silent 事件消息 */
  notify?: (
    spaceId: SpaceId,
    key: string,
    version: number,
    by: AccountId,
    op: "write" | "append" | "delete",
  ) => void | Promise<void>;
}

interface ObjectRow {
  space_id: string;
  key: string;
  version: number;
  data: string;
  content_type: string | null;
  acl: string;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  tombstoned: number;
  ext: string | null;
}

/** spaceId 是会话空间时解析出 conversationId；否则 undefined */
export function conversationOfSpace(spaceId: SpaceId): string | undefined {
  return spaceId.startsWith(CONV_PREFIX)
    ? spaceId.slice(CONV_PREFIX.length)
    : undefined;
}

export class SharedSpace implements SharedSpaceContract {
  private readonly d: SharedSpaceDeps;

  constructor(deps: SharedSpaceDeps) {
    this.d = deps;
  }

  // ── 读 ─────────────────────────────────────────────────────────────────

  async get(
    spaceId: SpaceId,
    key: string,
    as: AccountId,
    version?: number,
  ): Promise<SharedObjectMeta | null> {
    const account = this.requireAccount(as);
    const obj = this.readObject(spaceId, key);
    if (!obj) return null;
    if (version === undefined && obj.tombstoned === 1) return null;

    let data: unknown;
    let ver: number;
    let updatedAt: string;
    if (version !== undefined) {
      const vrow = this.d.db
        .prepare<[string, string, number], { data: string; updated_at: string }>(
          "SELECT data, updated_at FROM mesh_shared_versions WHERE space_id = ? AND key = ? AND version = ?",
        )
        .get(spaceId, key, version) as
        | { data: string; updated_at: string }
        | undefined;
      if (!vrow) return null;
      data = jsonParse<unknown>(vrow.data, null);
      ver = version;
      updatedAt = vrow.updated_at;
    } else {
      data = jsonParse<unknown>(obj.data, null);
      ver = obj.version;
      updatedAt = obj.updated_at;
    }

    const meta = this.metaFrom(obj, { data, version: ver, updatedAt });
    await this.assertAllowed(obj, account, "read", spaceId, meta);
    return meta;
  }

  async list(
    spaceId: SpaceId,
    opts: { as: AccountId; keyPrefix?: string },
  ): Promise<SharedObjectMeta[]> {
    const account = this.requireAccount(opts.as);
    const prefix = opts.keyPrefix ?? "";
    const rows = this.d.db
      .prepare<[string, string], ObjectRow>(
        "SELECT * FROM mesh_shared_objects WHERE space_id = ? AND tombstoned = 0 AND key LIKE ? ORDER BY key",
      )
      .all(spaceId, prefix + "%") as ObjectRow[];
    const out: SharedObjectMeta[] = [];
    for (const obj of rows) {
      const meta = this.metaFrom(obj, {
        data: undefined,
        version: obj.version,
        updatedAt: obj.updated_at,
      });
      // 只回调用方可读的对象（不泄露键名）
      if (await this.allowed(obj, account, "read", spaceId, meta)) {
        out.push(meta);
      }
    }
    return out;
  }

  // ── 写 ─────────────────────────────────────────────────────────────────

  async put(
    spaceId: SpaceId,
    key: string,
    data: unknown,
    opts: {
      as: AccountId;
      expectedVersion?: number;
      contentType?: string;
      acl?: Acl;
      ext?: unknown;
    },
  ): Promise<{ version: number }> {
    const account = this.requireAccount(opts.as);
    const dataJson = JSON.stringify(data);
    const size = Buffer.byteLength(dataJson, "utf8");
    if (size > this.d.limits.sharedObjectMaxBytes) {
      throw new MeshRejectError(
        "OBJECT_TOO_LARGE",
        `object is ${size} bytes (max ${this.d.limits.sharedObjectMaxBytes})`,
      );
    }

    const existing = this.readObject(spaceId, key);
    // CAS（§18.4）：缺省盲写；0 断言不存在；不匹配 → VERSION_MISMATCH
    const expected = opts.expectedVersion;
    if (expected === 0 && existing && existing.tombstoned === 0) {
      throw new MeshRejectError(
        "VERSION_MISMATCH",
        `key already exists at version ${existing.version} (expected create)`,
      );
    }
    if (expected !== undefined && expected > 0) {
      if (!existing || existing.tombstoned === 1 || existing.version !== expected) {
        throw new MeshRejectError(
          "VERSION_MISMATCH",
          `current version is ${existing && existing.tombstoned === 0 ? existing.version : 0} (expected ${expected})`,
        );
      }
    }

    // ACL：写用旧对象的 ACL（不存在则用默认）；创建时可显式换 acl
    const acl = opts.acl ?? (existing ? jsonParse<Acl>(existing.acl, { read: [], write: [], admin: [] }) : this.defaultAcl(spaceId, opts.as));
    const guardMeta: SharedObjectMeta = existing
      ? this.metaFrom(existing)
      : {
          key,
          version: 0,
          ownerId: opts.as,
          acl,
          size: 0,
          updatedAt: isoNow(),
        };
    await this.assertAllowedAcl(acl, account, "write", spaceId, guardMeta);

    const now = isoNow();
    const nextVersion = (existing?.version ?? 0) + 1;

    const write = this.d.db.transaction(() => {
      this.d.db
        .prepare(
          "INSERT INTO mesh_shared_objects (space_id, key, version, data, content_type, acl, " +
            "created_by, created_at, updated_by, updated_at, tombstoned, ext) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,0,?) " +
            "ON CONFLICT(space_id, key) DO UPDATE SET version = excluded.version, data = excluded.data, " +
            "content_type = excluded.content_type, acl = excluded.acl, updated_by = excluded.updated_by, " +
            "updated_at = excluded.updated_at, tombstoned = 0, ext = excluded.ext",
        )
        .run(
          spaceId,
          key,
          nextVersion,
          dataJson,
          opts.contentType ?? existing?.content_type ?? null,
          JSON.stringify(acl),
          existing?.created_by ?? opts.as,
          existing?.created_at ?? now,
          opts.as,
          now,
          opts.ext === undefined ? null : JSON.stringify(opts.ext),
        );
      this.recordVersion(spaceId, key, nextVersion, dataJson, opts.as, now);
      this.pruneVersions(spaceId, key, nextVersion);
    });
    write();

    this.d.events.emit("shared_object_changed", {
      spaceId,
      key,
      version: nextVersion,
      by: opts.as,
    });
    await this.d.notify?.(spaceId, key, nextVersion, opts.as, "write");
    return { version: nextVersion };
  }

  async append(
    spaceId: SpaceId,
    key: string,
    item: unknown,
    opts: { as: AccountId; maxLen?: number },
  ): Promise<{ version: number }> {
    const existing = this.readObject(spaceId, key);
    const current = existing && existing.tombstoned === 0
      ? (jsonParse<unknown>(existing.data, []) as unknown)
      : [];
    const arr = Array.isArray(current) ? current : [];
    arr.push(item);
    const maxLen = opts.maxLen;
    while (maxLen !== undefined && arr.length > maxLen) arr.shift();
    return this.put(spaceId, key, arr, {
      as: opts.as,
      ...(existing ? { acl: jsonParse<Acl>(existing.acl, { read: [], write: [], admin: [] }) } : {}),
    });
  }

  async del(spaceId: SpaceId, key: string, opts: { as: AccountId }): Promise<void> {
    const account = this.requireAccount(opts.as);
    const existing = this.readObject(spaceId, key);
    if (!existing || existing.tombstoned === 1) {
      throw new MeshRejectError("NO_SUCH_KEY", `no object ${spaceId}/${key}`);
    }
    const meta = this.metaFrom(existing);
    await this.assertAllowed(existing, account, "delete", spaceId, meta);

    const now = isoNow();
    const write = this.d.db.transaction(() => {
      this.d.db
        .prepare(
          "UPDATE mesh_shared_objects SET tombstoned = 1, updated_by = ?, updated_at = ? WHERE space_id = ? AND key = ?",
        )
        .run(opts.as, now, spaceId, key);
      this.recordVersion(spaceId, key, existing.version + 1, null, opts.as, now);
    });
    write();

    this.d.events.emit("shared_object_changed", {
      spaceId,
      key,
      version: existing.version + 1,
      by: opts.as,
    });
    await this.d.notify?.(spaceId, key, existing.version + 1, opts.as, "delete");
  }

  // ── ACL ────────────────────────────────────────────────────────────────

  private async assertAllowed(
    obj: ObjectRow,
    account: ReturnType<SharedSpace["requireAccount"]>,
    op: AclCtx["op"],
    spaceId: SpaceId,
    meta: SharedObjectMeta,
  ): Promise<void> {
    const acl = jsonParse<Acl>(obj.acl, { read: [], write: [], admin: [] });
    await this.assertAllowedAcl(acl, account, op, spaceId, meta);
  }

  private async assertAllowedAcl(
    acl: Acl,
    account: ReturnType<SharedSpace["requireAccount"]>,
    op: AclCtx["op"],
    spaceId: SpaceId,
    meta: SharedObjectMeta,
  ): Promise<void> {
    if (!(await this.allowedAcl(acl, account, op, spaceId, meta))) {
      throw new MeshRejectError(
        "SPACE_FORBIDDEN",
        `account ${account.id} lacks ${op} on ${spaceId}/${meta.key}`,
      );
    }
  }

  private async allowed(
    obj: ObjectRow,
    account: ReturnType<SharedSpace["requireAccount"]>,
    op: AclCtx["op"],
    spaceId: SpaceId,
    meta: SharedObjectMeta,
  ): Promise<boolean> {
    return this.allowedAcl(jsonParse<Acl>(obj.acl, { read: [], write: [], admin: [] }), account, op, spaceId, meta);
  }

  private async allowedAcl(
    acl: Acl,
    account: ReturnType<SharedSpace["requireAccount"]>,
    op: AclCtx["op"],
    spaceId: SpaceId,
    meta: SharedObjectMeta,
  ): Promise<boolean> {
    // "delete" 与 put/append 同属 write 面（§18）；仅 "admin" 走 admin 面
    const isRead = op === "read";
    const isWrite = op === "write" || op === "delete";
    const policyFn = isRead
      ? this.d.accessControl.canRead
      : isWrite
        ? this.d.accessControl.canWrite
        : this.d.accessControl.canAdmin;
    const ctx = await this.buildCtx(spaceId, account, op, meta);
    const slotOk = await withPolicyTimeout(
      this.guardDeps("accessControl"),
      () => policyFn?.(ctx) ?? true,
      false,
    );
    if (!slotOk) return false;

    const rules = isRead ? acl.read : isWrite ? acl.write : acl.admin;
    for (const rule of rules ?? []) {
      if (await this.ruleMatches(rule, ctx)) return true;
    }
    return false;
  }

  private async ruleMatches(rule: AclRule, ctx: AclCtx): Promise<boolean> {
    switch (rule.kind) {
      case "public":
        return true;
      case "conversation":
        return this.accountInConversation(rule.conversationId ?? "", ctx.account.id);
      case "accounts":
        return (rule.accounts ?? []).includes(ctx.account.id);
      case "capabilities":
        return (rule.capabilities ?? []).some((c) =>
          (ctx.account.capabilities ?? []).includes(c),
        );
      case "custom":
        return (await this.d.accessControl.resolveCustomTag?.(rule.tag ?? "", ctx)) ?? true;
      default:
        return false;
    }
  }

  private accountInConversation(convId: string, accountId: AccountId): boolean {
    if (this.d.registry.getMembership(convId, accountId) !== undefined) return true;
    return this.d.registry
      .listSubscribers(convId)
      .some((s) => s.accountId === accountId);
  }

  private async buildCtx(
    spaceId: SpaceId,
    account: Account,
    op: AclCtx["op"],
    object?: SharedObjectMeta,
  ): Promise<AclCtx> {
    const ctx: AclCtx = { account, op, ...(object ? { object } : {}) };
    const convId = conversationOfSpace(spaceId);
    if (convId !== undefined) {
      const conv = this.d.registry.getConversation(convId);
      if (conv) {
        ctx.conversation = conv;
        const m = this.d.registry.getMembership(convId, account.id);
        if (m) {
          const membership: Membership = {
            conversationId: convId,
            accountId: account.id,
            caps: m.caps,
            joinedSeq: m.joinedSeq,
            ...(m.mutedUntil !== undefined ? { mutedUntil: m.mutedUntil } : {}),
            ...(m.verbatimPinned !== undefined ? { verbatimPinned: m.verbatimPinned } : {}),
          };
          ctx.membership = membership;
        }
      }
    }
    return ctx;
  }

  // ── 内部：行读取与版本 ──────────────────────────────────────────────────

  private requireAccount(as: AccountId): Account {
    const account = this.d.registry.getAccount(as);
    if (!account) throw new MeshRejectError("SPACE_FORBIDDEN", "unknown account: " + as);
    return account;
  }

  private readObject(spaceId: SpaceId, key: string): ObjectRow | undefined {
    return this.d.db
      .prepare<[string, string], ObjectRow>(
        "SELECT * FROM mesh_shared_objects WHERE space_id = ? AND key = ?",
      )
      .get(spaceId, key) as ObjectRow | undefined;
  }

  private metaFrom(
    obj: ObjectRow,
    over?: { data?: unknown; version?: number; updatedAt?: string },
  ): SharedObjectMeta {
    const data = over?.data !== undefined ? JSON.stringify(over.data) : obj.data;
    return {
      key: obj.key,
      version: over?.version ?? obj.version,
      ownerId: obj.created_by,
      acl: jsonParse<Acl>(obj.acl, { read: [], write: [], admin: [] }),
      size: Buffer.byteLength(data, "utf8"),
      contentType: obj.content_type ?? undefined,
      updatedAt: over?.updatedAt ?? obj.updated_at,
      ...(over?.data !== undefined ? { data: over.data } : {}),
    };
  }

  private recordVersion(
    spaceId: SpaceId,
    key: string,
    version: number,
    data: string | null,
    by: AccountId,
    now: string,
  ): void {
    this.d.db
      .prepare(
        "INSERT INTO mesh_shared_versions (space_id, key, version, data, updated_by, updated_at) " +
          "VALUES (?,?,?,?,?,?)",
      )
      .run(spaceId, key, version, data, by, now);
  }

  private pruneVersions(spaceId: SpaceId, key: string, current: number): void {
    const keep = this.d.limits.sharedVersionsKept;
    if (keep <= 0) {
      this.d.db
        .prepare("DELETE FROM mesh_shared_versions WHERE space_id = ? AND key = ?")
        .run(spaceId, key);
      return;
    }
    const cutoff = current - keep + 1;
    if (cutoff > 1) {
      this.d.db
        .prepare(
          "DELETE FROM mesh_shared_versions WHERE space_id = ? AND key = ? AND version < ?",
        )
        .run(spaceId, key, cutoff);
    }
  }

  private defaultAcl(spaceId: SpaceId, owner: AccountId): Acl {
    const convId = conversationOfSpace(spaceId);
    if (convId !== undefined) {
      const conv: AclRule = { kind: "conversation", conversationId: convId };
      return {
        read: [conv],
        write: [conv],
        admin: [{ kind: "accounts", accounts: [owner] }],
      };
    }
    const ownerOnly: AclRule[] = [{ kind: "accounts", accounts: [owner] }];
    return { read: ownerOnly, write: ownerOnly, admin: ownerOnly };
  }

  private guardDeps(slot: PolicySlot, degradedTo: DegradeTarget = "deny"): PolicyTimeoutDeps {
    return {
      slot,
      timeoutMs: this.d.limits.policyTimeoutMs,
      degradedTo,
      onDegraded: (reason, s, target) => {
        this.d.events.emit("policy_degraded", { slot: s, reason, degradedTo: target });
      },
    };
  }
}