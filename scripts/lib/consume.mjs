// ═══════════════════════════════════════════════════════════════════════════
// 类型面消费（C08 / G01 / 后续 G08）：用仓库 tsc 编译 .mts/.cts 消费用例，确认
// 包根与 core 入口的声明（含 .d.cts）在 ESM 与 CJS 两个模块系统下都能解析。
//
// pack.mjs（先解包 tarball 到临时 node_modules）与 verify-local.mjs（软链本地
// ROOT 为包）共用本步骤——唯一区别是「@pi/agent-mesh 在 nm 里被谁装进去」，由调用方
// 负责保证（tarball 解包，或 symlink 本地 ROOT）。消费文件内容两边完全一致。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// scripts/lib/ → ROOT 上溯两级。
const ROOT = join(import.meta.dirname, "..", "..");

export const CONSUMER_MTS = `
import { createMesh, createPiSessionFactory, DEFAULT_LIMITS, PiStreamPort, EndpointLock } from "@pi/agent-mesh";
import type {
  CreateMeshOptions, MeshHost, SessionFactory, ToolDefinition, MeshToolResult,
  ToolContext, AccountId, EndpointId, ConversationId, MessageId, DeliveryId,
  Envelope, Limits, SendInput, RegisterAccountInput, Unsubscribe, PortStatus,
} from "@pi/agent-mesh";
import {
  MeshRejectError, InvariantViolationError, InProcessTransport, SqliteStore,
  MeshRouter, createDefaultPolicies, buildToolSet,
} from "@pi/agent-mesh/core";
import type {
  Store, Registry, Mailbox, EventBus, MeshComponents, RouteInput,
  ConversationSummary, ContactRow, MemberRow, DeliveryState,
} from "@pi/agent-mesh/core";
export {};
`;

export const CONSUMER_CTS = `
import { createMesh, DEFAULT_LIMITS } from "@pi/agent-mesh";
import type { MeshHost, ToolDefinition, ToolContext } from "@pi/agent-mesh";
import { MeshRejectError, SqliteStore } from "@pi/agent-mesh/core";
import type { Store, Mailbox } from "@pi/agent-mesh/core";
export {};
`;

export const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    types: ["node"],
  },
  include: ["consumer.mts", "consumer.cts"],
};

/**
 * 校验 .mts/.cts 类型消费。
 * @param {object} ctx
 * @param {string} ctx.tmp  消费工程目录（需已存在 node_modules/<pkg>）。
 * @param {string} ctx.nm   node_modules 目录（已装入 @pi/agent-mesh）。
 * @param {(cmd:string, argv:string[], opts?:object)=>any} ctx.run  spawnSync 封装（pack.mjs 的 run）。
 * @param {(msg:string)=>void} ctx.ok
 * @param {(msg:string)=>void} ctx.fail     打印并退出（由调用方保证不再返回）。
 */
export function validateTypesConsumers({ tmp, nm, run, ok, fail }) {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) return fail("仓库 node_modules/typescript/bin/tsc 缺失——先 npm install。");
  if (!existsSync(join(ROOT, "node_modules", "@earendil-works"))) {
    return fail("仓库 node_modules/@earendil-works 缺失——先 npm install（pi 类型解析需要）。");
  }
  if (!existsSync(join(ROOT, "node_modules", "@types", "node"))) {
    return fail("仓库 node_modules/@types/node 缺失——先 npm install。");
  }

  // 包可能已解包到独立目录（tarball），其 node_modules 为空；软链 pi/@types 供其类型解析。
  symlinkSync(join(ROOT, "node_modules", "@earendil-works"), join(nm, "@earendil-works"), "dir");
  symlinkSync(join(ROOT, "node_modules", "@types"), join(nm, "@types"), "dir");

  writeFileSync(join(tmp, "consumer.mts"), CONSUMER_MTS);
  writeFileSync(join(tmp, "consumer.cts"), CONSUMER_CTS);
  writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2) + "\n");

  const r = run(process.execPath, [tsc, "-p", join(tmp, "tsconfig.json")]);
  if (r.status !== 0) return fail(`类型面消费失败：\n${r.stdout || ""}${r.stderr || ""}`);
  ok("根 + core 类型在 .mts/.cts 下均可解析（.d.ts/.d.cts 双条件）");
}