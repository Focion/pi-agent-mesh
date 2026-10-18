// ═══════════════════════════════════════════════════════════════════════════
// G02（本地验收·存储与迁移）：合成 0.1.0 基线库的重开幂等、数据完整与迁移续跑。
//
// 基线库由 tests/helpers/baseline-db.ts 的 buildBaselineDb() 确定性重建（执行 5 个迁移
// 脚本 + 打 meta 印章 + 固定 id 种子数据，不提交二进制）。三条测试分别证明：
//   ① 重开幂等——createMesh 打开已全链迁移的库时零新增迁移、零 .premigrate.bak、schema 仍 v1；
//   ② 数据完整——16 条不变量全绿，且 shared 版本链 / claim 归属 / inbox 游标逐项抽查；
//   ③ 迁移续跑——基线库上再注入一个迁移脚本即触发升级备份（.premigrate.bak + backup_path），
//      既有数据不受损。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/core/store.js";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { BASELINE_COUNTS, buildBaselineDb } from "../helpers/baseline-db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "g02-baseline" }),
  open: async () => ({ session: {} }),
};

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function tableCount(db: Database.Database, name: string): number {
  return count(
    db,
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='" + name + "'",
  );
}

async function openHost(dbPath: string): Promise<MeshHost> {
  return createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: new FakeStreamPort(),
    devMode: true,
  });
}

describe("G02: 基线库迁移/重开（§28.3 / C07 / I05）", () => {
  it("① 重开幂等：零新增迁移、零备份、schema v1、五类数据行数一致", async () => {
    const dbPath = buildBaselineDb();
    const host = await openHost(dbPath);
    const db = new Database(dbPath);
    try {
      // 无 pending ⇒ 无升级备份
      expect(existsSync(dbPath + ".premigrate.bak")).toBe(false);
      const sv = db.prepare("SELECT v FROM mesh_meta WHERE k = 'schema_version'").get() as
        | { v: string }
        | undefined;
      expect(sv?.v).toBe("1");

      // 恰好 5 个迁移键（000..004），重开未新增
      const migrationKeys = db
        .prepare("SELECT k FROM mesh_meta WHERE k LIKE 'migration:%'")
        .all() as Array<{ k: string }>;
      expect(migrationKeys.map((r) => r.k).sort()).toEqual(
        ["000_init.sql", "001_presence_source.sql", "002_pool_meta.sql", "003_claim_owner.sql", "004_delivery_decision.sql"].map(
          (f) => "migration:" + f,
        ),
      );

      // 五类数据（accounts/endpoints/conversations/messages/deliveries）行数与种子一致
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_accounts")).toBe(BASELINE_COUNTS.accounts);
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_endpoints")).toBe(BASELINE_COUNTS.endpoints);
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_conversations")).toBe(
        BASELINE_COUNTS.conversations,
      );
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_memberships")).toBe(
        BASELINE_COUNTS.memberships,
      );
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_subscriptions")).toBe(
        BASELINE_COUNTS.subscriptions,
      );
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_messages")).toBe(BASELINE_COUNTS.messages);
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_deliveries")).toBe(BASELINE_COUNTS.deliveries);
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_pending_acks")).toBe(
        BASELINE_COUNTS.pending_acks,
      );
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_shared_objects")).toBe(
        BASELINE_COUNTS.shared_objects,
      );
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_shared_versions")).toBe(
        BASELINE_COUNTS.shared_versions,
      );
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_streams")).toBe(BASELINE_COUNTS.streams);
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_inboxes")).toBe(BASELINE_COUNTS.inboxes);
    } finally {
      db.close();
      await host.close();
    }
  });

  it("② 重开数据完整：16 条不变量全绿 + shared 版本链 / claim / inbox 游标抽查", async () => {
    const dbPath = buildBaselineDb();
    const host = await openHost(dbPath);
    const db = new Database(dbPath);
    try {
      await assertInvariants(host);

      // shared 版本链：space-1/cfg 存有 version 1、2 且顺序正确
      const versions = db
        .prepare(
          "SELECT version, data FROM mesh_shared_versions WHERE space_id = ? AND key = ? ORDER BY version",
        )
        .all("space-1", "cfg") as Array<{ version: number; data: string }>;
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(JSON.parse(versions[0]!.data)).toEqual({ v: 1 });
      expect(JSON.parse(versions[1]!.data)).toEqual({ v: 2 });

      // claim 归属：d8 的 claim_until 未过期且 claimed_by 正确保留
      const d8 = db
        .prepare(
          "SELECT state, claimed_by, claim_until, delivered_at FROM mesh_deliveries WHERE id = 'd8'",
        )
        .get() as { state: string; claimed_by: string | null; claim_until: string | null; delivered_at: string | null };
      expect(d8.state).toBe("acked");
      expect(d8.claimed_by).toBe("bob");
      expect(d8.claim_until).toBe("2099-01-01T00:00:00.000Z");
      expect(d8.delivered_at).toBeTypeOf("string");

      // inbox 游标：alice 在 dc 已消费到 seq2 ⇒ cursor_seq = 2（recomputeInboxCaches 不触碰游标）
      const inbox = db
        .prepare(
          "SELECT cursor_seq FROM mesh_inboxes WHERE account_id = 'alice' AND conversation_id = 'dc'",
        )
        .get() as { cursor_seq: number };
      expect(inbox.cursor_seq).toBe(2);
    } finally {
      db.close();
      await host.close();
    }
  });

  it("③ 迁移续跑：已全链迁移的库再注入脚本 → 升级备份 + backup_path + 数据无损", () => {
    const dbPath = buildBaselineDb();

    const dir = mkdtempSync(join(tmpdir(), "mesh-g02-mig-"));
    const custom = join(dir, "migrations");
    cpSync(new URL("../../migrations/", import.meta.url), custom, { recursive: true });
    writeFileSync(join(custom, "005_marker.sql"), "CREATE TABLE marker_g02 (id INTEGER);");

    const store = SqliteStore.open(dbPath, { migrationsDir: custom });
    const db = new Database(dbPath);
    try {
      expect(existsSync(dbPath + ".premigrate.bak")).toBe(true);
      expect(readFileSync(dbPath + ".premigrate.bak").length).toBeGreaterThan(0);
      expect(store.getMeta("backup_path")).toBe(dbPath + ".premigrate.bak");
      expect(tableCount(db, "marker_g02")).toBe(1);
      expect(store.getMeta("migration:005_marker.sql")).toBeDefined();
      // 既有数据不受迁移影响
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_messages")).toBe(BASELINE_COUNTS.messages);
      expect(count(db, "SELECT COUNT(*) AS n FROM mesh_deliveries")).toBe(BASELINE_COUNTS.deliveries);
    } finally {
      db.close();
      store.close();
    }
  });
});