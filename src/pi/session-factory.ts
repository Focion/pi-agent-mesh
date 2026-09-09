// ═══════════════════════════════════════════════════════════════════════════
// createPiSessionFactory：SessionFactory（§12.3 ⑨，唯一必填槽）的参考实现。
//
// 约定（宿主可用自己的工厂完全替换，本文件不是架构假设）：
//  - 每端点一个 cwd：<stateDir>/endpoints/<endpointId>，session 目录其下 sessions/
//  - piSessionId 存的是 session 文件路径（对 mesh-core 是不透明字符串，
//    open 时直接喂给 SessionManager.open）
//  - 模型/工具白名单归宿主（M1）：经 options 注入；mesh 工具由 ctx.tools 带入
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, SessionFactory } from "../core/types.js";
import { loadPiSdk } from "./pi-sdk.js";

export interface PiSessionFactoryOptions {
  /** 锁文件/端点工作目录的根（与 PiStreamPort 的 stateDir 一致） */
  stateDir: string;
  /** pi 全局配置目录（默认 ~/.pi/agent；测试给临时目录） */
  agentDir?: string;
  /** 宿主选定的模型（pi-ai 的 Model<any>）；缺省由 pi 按 settings 解析 */
  model?: unknown;
  thinkingLevel?: string;
  /** 内建工具白名单（pi 语义）；给了就只开这些 */
  tools?: string[];
  /** 端点 cwd 的自定义解析（默认 <stateDir>/endpoints/<id>） */
  cwdFor?(endpoint: Endpoint): string;
}

export function createPiSessionFactory(opts: PiSessionFactoryOptions): SessionFactory {
  const cwdFor = (e: Endpoint) => opts.cwdFor?.(e) ?? join(opts.stateDir, "endpoints", e.id);

  async function spawn(
    endpoint: Endpoint,
    sessionManager: unknown,
    customTools: unknown[],
  ): Promise<{ session: unknown; piSessionId: string }> {
    const pi = await loadPiSdk();
    const cwd = cwdFor(endpoint);
    await mkdir(cwd, { recursive: true });
    const { session } = await pi.createAgentSession({
      cwd,
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.model ? { model: opts.model as never } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel as never } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      customTools: customTools as never,
      sessionManager: sessionManager as never,
    });
    const sm = session.sessionManager;
    return { session, piSessionId: sm.getSessionFile() ?? sm.getSessionId() };
  }

  return {
    async create(ctx) {
      const pi = await loadPiSdk();
      const cwd = cwdFor(ctx.endpoint);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      const sm = pi.SessionManager.create(cwd, sessionDir);
      return spawn(ctx.endpoint, sm, ctx.tools as unknown[]);
    },

    async open(ctx) {
      const pi = await loadPiSdk();
      const cwd = cwdFor(ctx.endpoint);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      // piSessionId 即 session 文件路径（本实现的约定，见头注）
      const sm = pi.SessionManager.open(ctx.piSessionId, sessionDir, cwd);
      return { session: (await spawn(ctx.endpoint, sm, ctx.tools as unknown[])).session };
    },
  };
}
