// ═══════════════════════════════════════════════════════════════════════════
// SharedSpace（§18）：共享空间的持久化与 ACL。
//
// - 每个对象一行 mesh_shared_objects + 每版一行 mesh_shared_versions，
//   put 的 CAS / 版本记录 / 旧版本裁剪同属一个 db.transaction（§18.4）。
// - ACL 用规范 §18 三向 Acl = { read, write, admin }，语义「任一规则命中即放行」。
//   内建判等：public / conversation{id} / accounts{ids} / capabilities{...} /
//   custom{tag → AccessControl.resolveCustomTag}，无人判定即 deny（§18.6 fail-closed）。
//   策略槽 canRead/canWrite/canAdmin（fail-closed）在内建规则之前裁决。put/append 走
//   write 面；get/list 走 read 面；改 ACL 与 del（打墓碑）走 admin 面（§4.2/§18.6）。
// - 默认 ACL：`conv:` → read/write = 该会话成员或订阅者、admin = owner；其余 → 三向均 owner。
// - 写路径对已归档会话禁写（仍可读，§18.4）；conv 变更通知按读权限全体过滤，
//   有收件人读不到对象时抑制通知、只留宿主事件（§4.2）。
// - `shared.get` 对「从未存在」与「已 del（tombstoned）」统一返回 null；
//   list 经 tombstoned=0 排除。错误统一 reject（MeshRejectError 携 SPACE_FORBIDDEN
//   / VERSION_MISMATCH / OBJECT_TOO_LARGE）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import type { SharedSpace as SharedSpaceContract } from "./contracts.js";
import type { MeshEventBus } from "./events.js";
import { withPolicyTimeout, type PolicyTimeoutDeps } from "./policies.js";
import type { MeshRegistry } from "./registry.js";
import type { SqliteStore } from "./store.js";
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
  /** 供 guardDeps 撞击 policy_degraded 计数器（§23.3，与 router/mailbox 一致） */
  store?: SqliteStore;
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

/** Acl 规范化指纹（§4.2 授权依据复验）：规则/名单顺序无关，用于「ACL 是否变过」判等。 */
function aclFingerprint(acl: Acl): string {
  const rule = (r: AclRule): unknown => {
    switch (r.kind) {
      case "public":
        return ["public"];
      case "conversation":
        return ["conversation", r.conversationId ?? ""];
      case "accounts":
        return ["accounts", [...(r.accounts ?? [])].sort()];
      case "capabilities":
        return ["capabilities", [...(r.capabilities ?? [])].sort()];
      case "custom":
        return ["custom", r.tag ?? ""];
      default:
        return ["?", r];
    }
  };
  const face = (rules: AclRule[] | undefined): unknown[] =>
    (rules ?? [])
      .map(rule)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([face(acl.read), face(acl.write), face(acl.admin)]);
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
    let updatedBy: string | undefined;
    if (version !== undefined) {
      const vrow = this.d.db
        .prepare<[string, string, number], { data: string; updated_at: string; updated_by: string }>(
          "SELECT data, updated_at, updated_by FROM mesh_shared_versions WHERE space_id = ? AND key = ? AND version = ?",
        )
        .get(spaceId, key, version) as
        | { data: string; updated_at: string; updated_by: string }
        | undefined;
      if (!vrow) return null;
      data = jsonParse<unknown>(vrow.data, null);
      ver = version;
      updatedAt = vrow.updated_at;
      updatedBy = vrow.updated_by;
    } else {
      data = jsonParse<unknown>(obj.data, null);
      ver = obj.version;
      updatedAt = obj.updated_at;
    }

    const meta = this.metaFrom(obj, { data, version: ver, updatedAt, updatedBy });
    await this.assertAllowed(obj, account, "read", spaceId, meta);
    return meta;
  }

  async list(
    spaceId: SpaceId,
    opts: { as: AccountId; keyPrefix?: string; sinceVersion?: number; limit?: number },
  ): Promise<SharedObjectMeta[]> {
    const account = this.requireAccount(opts.as);
    const prefix = opts.keyPrefix ?? "";
    const args: unknown[] = [spaceId, prefix + "%"];
    let sql =
      "SELECT * FROM mesh_shared_objects WHERE space_id = ? AND tombstoned = 0 AND key LIKE ?";
    if (opts.sinceVersion !== undefined) {
      sql += " AND version > ?";
      args.push(opts.sinceVersion);
    }
    sql += " ORDER BY key";
    const rows = this.d.db.prepare(sql).all(...args) as ObjectRow[];
    const limit = opts.limit;
    const out: SharedObjectMeta[] = [];
    for (const obj of rows) {
      // limit 在读 ACL 过滤之后封顶（不因被过滤的私有键折减可读结果数）
      if (limit !== undefined && out.length >= limit) break;
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

    this.rejectArchivedWrite(spaceId);

    const existing = this.readObject(spaceId, key);
    // CAS（§18.3）：缺省盲写；0 断言不存在；不等 → VERSION_MISMATCH。事务内还会复验（§4.2）。
    const expected = opts.expectedVersion;
    // I27：缺省盲写计数（附录 E）——无版本断言即盲写，是 §4.2 复验的代价与风险面。
    if (expected === undefined) this.d.store?.bumpCounter("blind_write");
    if (expected !== undefined) {
      const curV = existing && existing.tombstoned === 0 ? existing.version : 0;
      if (expected !== curV) {
        throw new MeshRejectError(
          "VERSION_MISMATCH",
          `current version is ${curV} (expected ${expected})`,
        );
      }
    }

    // 授权依据（§4.2）：写按旧 ACL 裁决；换 ACL 还需旧 ACL 的 admin。
    const oldAcl = existing
      ? jsonParse<Acl>(existing.acl, { read: [], write: [], admin: [] })
      : this.defaultAcl(spaceId, opts.as);
    const newAcl = opts.acl ?? oldAcl;
    const guardMeta: SharedObjectMeta = existing
      ? this.metaFrom(existing)
      : { key, version: 0, ownerId: opts.as, updatedBy: opts.as, acl: oldAcl, size: 0, updatedAt: isoNow() };

    await this.assertAllowedAcl(oldAcl, account, "write", spaceId, guardMeta);
    if (opts.acl !== undefined && aclFingerprint(opts.acl) !== aclFingerprint(oldAcl)) {
      await this.assertAllowedAcl(oldAcl, account, "admin", spaceId, guardMeta);
    }

    const oldAclFp = aclFingerprint(oldAcl);
    const now = isoNow();

    const write = this.d.db.transaction((): { version: number } => {
      const cur = this.readObject(spaceId, key);
      // 事务内复验（§4.2）：版本与授权依据都没变才写——异步授权后的竞态由此闭合（I20）。
      if (expected !== undefined) {
        const curV = cur && cur.tombstoned === 0 ? cur.version : 0;
        if (expected !== curV) {
          throw new MeshRejectError(
            "VERSION_MISMATCH",
            `current version is ${curV} (expected ${expected})`,
          );
        }
      } else {
        const curAcl = cur
          ? jsonParse<Acl>(cur.acl, { read: [], write: [], admin: [] })
          : this.defaultAcl(spaceId, opts.as);
        if (aclFingerprint(curAcl) !== oldAclFp) {
          throw new MeshRejectError(
            "VERSION_MISMATCH",
            "authorization basis changed during write",
          );
        }
      }

      const nextVersion = (cur?.version ?? 0) + 1;
      this.upsertObject(
        spaceId,
        key,
        nextVersion,
        dataJson,
        opts.contentType ?? cur?.content_type ?? null,
        newAcl,
        cur?.created_by ?? opts.as,
        cur?.created_at ?? now,
        opts.as,
        now,
        opts.ext === undefined ? null : JSON.stringify(opts.ext),
      );
      this.recordVersion(spaceId, key, nextVersion, dataJson, opts.as, now);
      this.pruneVersions(spaceId, key, nextVersion);
      return { version: nextVersion };
    });
    const result = write();

    this.d.events.emit("shared_object_changed", {
      spaceId,
      key,
      version: result.version,
      by: opts.as,
    });
    await this.notifyIfPermitted(spaceId, key, result.version, opts.as, "write");
    return result;
  }

  async append(
    spaceId: SpaceId,
    key: string,
    item: unknown,
    opts: { as: AccountId; maxLen?: number },
  ): Promise<{ version: number }> {
    const account = this.requireAccount(opts.as);
    this.rejectArchivedWrite(spaceId);

    const existing = this.readObject(spaceId, key);
    const oldAcl = existing
      ? jsonParse<Acl>(existing.acl, { read: [], write: [], admin: [] })
      : this.defaultAcl(spaceId, opts.as);
    const guardMeta: SharedObjectMeta = existing
      ? this.metaFrom(existing)
      : { key, version: 0, ownerId: opts.as, updatedBy: opts.as, acl: oldAcl, size: 0, updatedAt: isoNow() };
    // append 不换 ACL，写面裁决即可（§18.3 追加天然可交换，无 admin 需求）。
    await this.assertAllowedAcl(oldAcl, account, "write", spaceId, guardMeta);

    const oldAclFp = aclFingerprint(oldAcl);
    const maxLen = opts.maxLen;
    const now = isoNow();

    const write = this.d.db.transaction((): { version: number } => {
      const cur = this.readObject(spaceId, key);
      // 事务内复验授权依据（acl 变了即拒绝）；读-改-写同事务源于并发追加不丢（§18.3）。
      const curAcl = cur
        ? jsonParse<Acl>(cur.acl, { read: [], write: [], admin: [] })
        : this.defaultAcl(spaceId, opts.as);
      if (aclFingerprint(curAcl) !== oldAclFp) {
        throw new MeshRejectError(
          "VERSION_MISMATCH",
          "authorization basis changed during append",
        );
      }

      const current =
        cur && cur.tombstoned === 0 ? (jsonParse<unknown>(cur.data, []) as unknown) : [];
      const arr = Array.isArray(current) ? [...current] : [];
      arr.push(item);
      while (maxLen !== undefined && arr.length > maxLen) arr.shift();

      const dataJson = JSON.stringify(arr);
      const size = Buffer.byteLength(dataJson, "utf8");
      if (size > this.d.limits.sharedObjectMaxBytes) {
        throw new MeshRejectError(
          "OBJECT_TOO_LARGE",
          `object is ${size} bytes (max ${this.d.limits.sharedObjectMaxBytes})`,
        );
      }

      const nextVersion = (cur?.version ?? 0) + 1;
      this.upsertObject(
        spaceId,
        key,
        nextVersion,
        dataJson,
        cur?.content_type ?? null,
        curAcl,
        cur?.created_by ?? opts.as,
        cur?.created_at ?? now,
        opts.as,
        now,
        cur?.ext ?? null,
      );
      this.recordVersion(spaceId, key, nextVersion, dataJson, opts.as, now);
      this.pruneVersions(spaceId, key, nextVersion);
      return { version: nextVersion };
    });
    const result = write();

    this.d.events.emit("shared_object_changed", {
      spaceId,
      key,
      version: result.version,
      by: opts.as,
    });
    await this.notifyIfPermitted(spaceId, key, result.version, opts.as, "append");
    return result;
  }

  async del(spaceId: SpaceId, key: string, opts: { as: AccountId }): Promise<void> {
    const account = this.requireAccount(opts.as);
    this.rejectArchivedWrite(spaceId);
    const existing = this.readObject(spaceId, key);
    if (!existing || existing.tombstoned === 1) {
      throw new MeshRejectError("NO_SUCH_KEY", `no object ${spaceId}/${key}`);
    }
    const meta = this.metaFrom(existing);
    // del = 打墓碑，走 admin 面（§4.2/§18.6），不是 write。
    await this.assertAllowed(existing, account, "delete", spaceId, meta);

    const nextVersion = existing.version + 1;
    const now = isoNow();
    const write = this.d.db.transaction(() => {
      // 事务内复验：对象未被并发改写（版本未变）才打墓碑（§4.2）。
      const cur = this.readObject(spaceId, key);
      if (!cur || cur.tombstoned === 1 || cur.version !== existing.version) {
        throw new MeshRejectError("VERSION_MISMATCH", "object changed during delete");
      }
      // §18.1：版本推进，保证 objects.version == versions 表该 key 的最大版本。
      this.d.db
        .prepare(
          "UPDATE mesh_shared_objects SET tombstoned = 1, version = ?, updated_by = ?, updated_at = ? " +
            "WHERE space_id = ? AND key = ?",
        )
        .run(nextVersion, opts.as, now, spaceId, key);
      this.recordVersion(spaceId, key, nextVersion, null, opts.as, now);
    });
    write();

    this.d.events.emit("shared_object_changed", {
      spaceId,
      key,
      version: nextVersion,
      by: opts.as,
    });
    await this.notifyIfPermitted(spaceId, key, nextVersion, opts.as, "delete");
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
    // put/append 走 write 面；"delete"（打墓碑）与 "admin" 走 admin 面（§4.2/§18.6）。
    const isRead = op === "read";
    const isAdmin = op === "admin" || op === "delete";
    const policyFn = isRead
      ? this.d.accessControl.canRead
      : isAdmin
        ? this.d.accessControl.canAdmin
        : this.d.accessControl.canWrite;
    const ctx = await this.buildCtx(spaceId, account, op, meta);
    // fail-closed（§22.5）：钩子缺失 → 放行（缺省 allow）；返回 undefined → 非法 → deny。
    const slotOk = await withPolicyTimeout(
      this.guardDeps("accessControl"),
      () => {
        if (!policyFn) return true;
        return policyFn(ctx);
      },
      false,
      (v) => typeof v === "boolean",
    );
    if (!slotOk) return false;

    const rules = isRead ? acl.read : isAdmin ? acl.admin : acl.write;
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
      case "custom": {
        // 钩子缺失 → 拒绝（§18.6：custom 无人判定即 deny，fail-closed）；抛错/超时/返回值非法 → deny
        const hook = this.d.accessControl.resolveCustomTag;
        if (!hook) return false;
        return await withPolicyTimeout(
          this.guardDeps("accessControl"),
          () => hook(rule.tag ?? "", ctx),
          false,
          (v) => typeof v === "boolean",
        );
      }
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

  // ── 通知与归档 ──────────────────────────────────────────────────────────

  /** 会话级对象的归档禁写（§18.4）：会话已归档 → 拒绝写入（读仍放行）。 */
  private rejectArchivedWrite(spaceId: SpaceId): void {
    const convId = conversationOfSpace(spaceId);
    if (convId === undefined) return;
    const conv = this.d.registry.getConversation(convId);
    if (conv && conv.state === "archived") {
      throw new MeshRejectError(
        "SPACE_FORBIDDEN",
        `conversation ${convId} is archived; writes are rejected (reads remain allowed)`,
      );
    }
  }

  /**
   * conv 变更通知的读权限门（§4.2）：只有全部历史可读收件人都有对象 read 时
   * 才发公共会话通知，否则抑制（宿主事件 shared_object_changed 仍然照发，不泄露 key）。
   */
  private async notifyIfPermitted(
    spaceId: SpaceId,
    key: string,
    version: number,
    by: AccountId,
    op: "write" | "append" | "delete",
  ): Promise<void> {
    if (!this.d.notify) return;
    if (!(await this.notificationAllowed(spaceId, key))) return;
    await this.d.notify(spaceId, key, version, by, op);
  }

  private async notificationAllowed(spaceId: SpaceId, key: string): Promise<boolean> {
    const convId = conversationOfSpace(spaceId);
    if (convId === undefined) return true; // 非会话空间：装配层 notify 本身即 no-op
    const obj = this.readObject(spaceId, key);
    if (!obj) return false;
    const acl = jsonParse<Acl>(obj.acl, { read: [], write: [], admin: [] });
    const meta = this.metaFrom(obj);
    const conv = this.d.registry.getConversation(convId);
    if (!conv) return false;
    const recipients =
      conv.kind === "topic"
        ? this.d.registry.listSubscribers(convId).map((s) => s.accountId)
        : this.d.registry.listMembers(convId).map((m) => m.accountId);
    for (const id of recipients) {
      const acct = this.d.registry.getAccount(id);
      if (!acct) return false; // 无法核对的收件人 → 保守抑制，不泄露 key
      if (!(await this.allowedAcl(acl, acct, "read", spaceId, meta))) return false;
    }
    return true;
  }

  // ── 内部：行读取与版本 ──────────────────────────────────────────────────

  private upsertObject(
    spaceId: SpaceId,
    key: string,
    version: number,
    dataJson: string,
    contentType: string | null,
    acl: Acl,
    createdBy: AccountId,
    createdAt: string,
    by: AccountId,
    now: string,
    ext: string | null,
  ): void {
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
        version,
        dataJson,
        contentType,
        JSON.stringify(acl),
        createdBy,
        createdAt,
        by,
        now,
        ext,
      );
  }

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
    over?: { data?: unknown; version?: number; updatedAt?: string; updatedBy?: string },
  ): SharedObjectMeta {
    const data = over?.data !== undefined ? JSON.stringify(over.data) : obj.data;
    return {
      key: obj.key,
      version: over?.version ?? obj.version,
      ownerId: obj.created_by,
      updatedBy: over?.updatedBy ?? obj.updated_by,
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
        this.d.store?.bumpCounter("policy_degraded");
      },
    };
  }
}