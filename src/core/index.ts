// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — mesh-core 子入口（§29.2：零 pi 依赖的可嵌入面）
// 本文件及其传递闭包不得 import 任何 pi 包（CI 门禁 G1）。
// 全量装配入口（createMesh + mesh-pi）在包根 "./"。
// ═══════════════════════════════════════════════════════════════════════════

// 公共类型面（§12.6）：信封/实体/策略槽/Limits/事件/StreamPort/Transport/Observer/MeshHost
export * from "./types.js";

// 内部组件契约（宿主自定义 Transport/StreamPort 时需要这些形状）
export type {
  EventBus,
  Mailbox,
  MeshComponents,
  Registry,
  RouteInput,
  Store,
  ToolContext,
  ConversationAdminOp,
  MemberRow,
  ContactRow,
} from "./contracts.js";

// 默认实现（§12.3 八槽可换；这些是实现也是装配零件）
export {
  AllowAllAccessControl,
  createDefaultPolicies,
  DefaultActivationPolicy,
  DefaultDeliveryPolicy,
  DefaultRetentionPolicy,
  FreeForAllFloorPolicy,
  TopologyEndpointSelector,
  WakeRateLimiter,
  WallClockLogicalClock,
  withPolicyGuard,
} from "./policies.js";
export { DefaultRenderer, escapeDelims, verifyWrapped } from "./renderer.js";
export { InProcessTransport } from "./transport.js";
export { SqliteStore, REGISTERED_COUNTERS } from "./store.js";
export { MeshRegistry, capsSubsetOf, hasCap, validCaps } from "./registry.js";
export { MeshEventBus } from "./events.js";
export { MeshRouter } from "./router.js";
export { MeshMailbox } from "./mailbox.js";
export { MeshObserver, rowToEnvelope } from "./observer.js";
export { buildToolSet, checkToolCopy, MESH_TOOL_NAMES } from "./tools.js";
export {
  directConversationId,
  hourBucket,
  idempotencyKey,
  isoFromMs,
  isoNow,
  msFromIso,
  sha256Hex,
  sleep,
  truncate,
  ulid,
} from "./util.js";
