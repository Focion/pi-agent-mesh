// ═══════════════════════════════════════════════════════════════════════════
// W01 探针 · 磁盘 session create/open 确认点（session-factory 的
// `getSessionFile() ?? getSessionId()` 约定，§8.3 / LD1）。
//
// 设计问题：磁盘落地（非 in-memory）下，getSessionFile() 在 create / open / 重开
// 三点是否确定、路径是否稳定？—— 这决定 mesh 存进 piSessionId 的到底是「文件
// 路径」还是「session id」，不成立则 W13（恢复）的 open 链会断。
//
// 实测机制（pi 1.1.0，读 dist/core/session-manager.js）：
//  - SessionManager.create(cwd, sessionDir) 立即在 newSession() 里（persist=true 时）
//    给 this.sessionFile = <sessionDir>/<timestamp>_<sessionId>.jsonl —— 即 create
//    点 getSessionFile() 就有非空路径，`?? getSessionId()` 永不回退到 id。
//  - 但文件本体要等第一条 user/assistant 消息落盘后才写出（_hasConversation 门）。
//  - open(path) 走 resolvePath + _setSessionFile：文件存在则按 header 恢复同一
//    sessionId；路径由 mesh 自报（存的就是路径），故重开点确定性是「按路径」稳定。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPiSdk } from "../../src/pi/pi-sdk.js";
import {
  createFaux,
  loadFauxCompat,
  registerFauxInto,
  waitFor,
} from "../helpers/pi-session.js";

const fmts: Array<{ sm: any; dispose(): void }> = [];
afterEach(() => {
  fmts.splice(0).forEach((f) => {
    try {
      f.dispose();
    } catch {
      // noop
    }
  });
});

interface DiskSession {
  session: any;
  faux: { setResponses(r: unknown[]): void };
  file: string | undefined;
  id: string;
  dir: string;
  sessionDir: string;
}

/** 磁盘 SessionManager + faux，返回 create 点即可观测的各标识符。 */
async function makeDiskSession(): Promise<DiskSession> {
  const pi = await loadPiSdk();
  const faux = await createFaux();
  const dir = mkdtempSync(join(tmpdir(), "pi-mesh-probe-disk-"));
  const sessionDir = join(dir, "sessions");
  const sm = pi.SessionManager.create(dir, sessionDir);
  const { session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel() as never,
    noTools: "all",
    sessionManager: sm,
  });
  registerFauxInto(session, faux);
  fmts.push({ sm: session, dispose: () => { try { session.dispose(); } catch {} rmSync(dir, { recursive: true, force: true }); } });
  return {
    session,
    faux,
    file: session.sessionManager.getSessionFile(),
    id: session.sessionManager.getSessionId(),
    dir,
    sessionDir,
  };
}

describe("probe 磁盘 session create/open 确认点", () => {
  it("create 点 getSessionFile() 已有确定路径（不落空、不回退 session id）", async () => {
    const d = await makeDiskSession();
    expect(typeof d.file).toBe("string");
    expect((d.file as string).length).toBeGreaterThan(0);
    // 路径在隔离的临时 sessionDir 内，且确与 session id 不同（路径 ≠ id）
    expect((d.file as string).startsWith(d.sessionDir)).toBe(true);
    expect(d.file).not.toBe(d.id);
    // 文件命名 <timestamp>_<sessionId>.jsonl：含本 session id
    expect((d.file as string)).toContain(d.id);
  });

  it("第一条 user/assistant 消息落盘后才写出文件；open 同路径恢复同一 session id", async () => {
    const compat = await loadFauxCompat();
    const d = await makeDiskSession();
    const before = existsSync(d.file as string);

    // 起一轮：user 入口 + faux assistant 回复（两者才是触发文件写出的 user/assistant 消息）
    d.faux.setResponses([compat.fauxAssistantMessage("hi")]);
    await d.session.sendCustomMessage(
      { customType: "mesh.msg", content: "first", display: true },
      { triggerTurn: true },
    );
    await waitFor(() => d.session.isIdle);

    // 落盘后文件存在
    expect(existsSync(d.file as string)).toBe(true);
    expect(readdirSync(d.sessionDir).length).toBeGreaterThan(0);
    expect({ before }).toEqual({ before: false }); // 起轮前确实未写出（setup 条目不落盘）

    // 重开点：open 同一路径 → 同一 session id（恢复不是新建）
    const pi = await loadPiSdk();
    const sm2 = pi.SessionManager.open(d.file as string, d.sessionDir, d.dir);
    expect(sm2.getSessionId()).toBe(d.id);
    expect(sm2.getSessionFile()).toBe(d.file);
  });
});