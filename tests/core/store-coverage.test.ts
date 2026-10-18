// 分支覆盖补测（src/core/store.ts）：目标把这些原先未覆盖的分支补上——
//   openReadonly 退化（L161）、walSize stat 失败（L250）、WAL 超阈值（L230）、
//   WAL checkpoint 抛错的 catch（L235）、quick_check 非 ok 上报 integrity_failed（L259）、
//   schema_version 解析回退 0（L297）、tx() ROLLBACK 自身失败不掩盖原错误（L411）、
//   devMode 未登记计数器抛错（L433）、无 .name 句柄回退 ":memory:"（L130）。
// 全部走公共面或真实 better-sqlite3 行为，不改动 src/。
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/core/store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "mesh-storecov-")), "mesh.db");
}

describe("openReadonly 退化共享写句柄（I25）", () => {
  it("readonly 重开失败时回退到写句柄（匿名库；顺带覆盖 walSize stat 失败）", () => {
    // new Database("") 是匿名内存库：db.name === ""，openReadonly 里
    // new Database("", { readonly: true }) 因「in-memory 不能 readonly」抛错，
    // 走 catch 回退 this.db；checkWal 里 "-wal" 不存在 → walSize 走 stat 失败返回 0。
    const db = new Database("");
    const store = new SqliteStore(db, false, 5000, {});
    try {
      expect(store.readonlyDb).toBe(store.db);
      expect(store.getMeta("schema_version")).toBe("1");
    } finally {
      store.close();
    }
  });
});

describe("dbPath 回退（无 name 句柄）", () => {
  it("句柄未暴露 name 时按 :memory: 派生 dbPath", () => {
    // §construct 对 db.name 的 ?? ":memory:" 回退分支（L130）：只对 name 为 null 的
    // 退化身触发。用 Proxy 只拦截 name 读取、其余透传真实 better-sqlite3。
    const real = new Database(":memory:");
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "name") return null;
        return Reflect.get(target, prop, receiver);
      },
    });
    const store = new SqliteStore(db, false, 5000, {});
    try {
      // dbPath 派生为 ":memory:" ⇒ openReadonly 直接返回写句柄
      expect(store.readonlyDb).toBe(store.db);
    } finally {
      store.close();
    }
  });
});

describe("WAL 超阈值侦测（I34）", () => {
  it("WAL 超过 walMaxBytes 时报 wal_over_threshold", () => {
    const store = SqliteStore.open(tmpDbPath(), { walMaxBytes: 0 });
    try {
      const faults: string[] = [];
      store.health.setSink({ onFault: (code) => faults.push(code) });
      // 任意一次写入都会让 -wal 文件>0，超过阈值为 0 的边界
      store.setMeta("bulk", "x".repeat(100_000));
      store.checkHealth();
      expect(faults).toContain("wal_over_threshold");
    } finally {
      store.close();
    }
  });
});

describe("WAL checkpoint 失败留待复检（I34）", () => {
  it("checkpoint 自身抛错时不掩盖告警、直接返回", () => {
    // 覆盖 checkWal 里 wal_checkpoint(TRUNCATE) 的 catch 分支（L235）：
    // 真实读端阻塞时 pragma 通常返回 busy=1 而非抛错，这里注入抛错来走 catch。
    const db = new Database(tmpDbPath());
    const origPragma = db.pragma.bind(db) as (src: string, opts?: unknown) => unknown;
    Object.defineProperty(db, "pragma", {
      configurable: true,
      value: (src: string, opts?: unknown) => {
        if (src === "wal_checkpoint(TRUNCATE)") throw new Error("checkpoint busy");
        return origPragma(src, opts);
      },
    });
    // walMaxBytes 0 + 迁移写入 ⇒ 打开期初检即触发 WAL 超阈值 → checkpoint 抛错 → catch 返回，
    // 故障保持未恢复（下次复检再试）。
    const store = new SqliteStore(db, false, 5000, { walMaxBytes: 0 });
    try {
      expect(store.health.activeFaults()).toContain("wal_over_threshold");
    } finally {
      store.close();
    }
  });
});

describe("完整性故障侦测（I34）", () => {
  it("quick_check 非 ok 时上报 integrity_failed", () => {
    const db = new Database(":memory:");
    const origPragma = db.pragma.bind(db) as (source: string, opts?: unknown) => unknown;
    Object.defineProperty(db, "pragma", {
      configurable: true,
      value: (source: string, opts?: unknown) =>
        source === "quick_check" ? [{ quick_check: "corrupt" }] : origPragma(source, opts),
    });
    const store = new SqliteStore(db, false, 5000, {});
    try {
      expect(store.health.activeFaults()).toContain("integrity_failed");
    } finally {
      store.close();
    }
  });
});

describe("schema_version 解析回退（§28.3）", () => {
  it("缺少 schema_version 时按 0 对待并正常打开", () => {
    const path = tmpDbPath();
    const first = SqliteStore.open(path);
    first.db.prepare("DELETE FROM mesh_meta WHERE k = 'schema_version'").run();
    first.close();

    const store = SqliteStore.open(path);
    try {
      expect(store.getMeta("schema_version")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("tx() ROLLBACK 失败不掩盖原错误（I05）", () => {
  it("事务中句柄被关闭后 COMMIT/ROLLBACK 皆失败，仍抛出原错误", () => {
    const store = SqliteStore.open(":memory:");
    // 在 fn 内关闭句柄：COMMIT 抛「connection is not open」→ 进入 ROLLBACK，
    // ROLLBACK 同样失败 → 内层 catch 吞掉回滚错误并 rethrow 原 COMMIT 错误。
    expect(() =>
      store.tx(() => {
        store.db.close();
      }),
    ).toThrow(/not open/i);
    store.close();
  });
});

describe("bumpCounter devMode 闸门（§23.3）", () => {
  it("devMode 下未登记计数名抛错、登记名不抛错", () => {
    const store = SqliteStore.open(":memory:", { devMode: true });
    try {
      expect(() => store.bumpCounter("unregistered_metric")).toThrow(/unregistered counter/);
      expect(() => store.bumpCounter("messages_total")).not.toThrow();
    } finally {
      store.close();
    }
  });
});