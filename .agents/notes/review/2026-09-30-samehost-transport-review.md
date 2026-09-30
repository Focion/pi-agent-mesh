---
title: sameHost 多进程 Transport 与锁语义 CR——3 处真实缺陷
date: 2026-09-30
status: done
owner: unassigned
tags: [review, samehost, transport, lock, m3, correctness]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/review/2026-09-29-deferred-capabilities-audit.md
---

# sameHost 多进程 Transport 与锁语义 CR

## 结论

sameHost（§19.3）的实现（`SameHostTransport` + `EndpointLock` shared 共存 + `isEndpointLocal` 网关）在 happy path 上跑通（225 测试全绿、e2e 两进程用 FakeStreamPort 通过），但**跨进程投递的 ack 链路断了一环**、**锁的 shared 共存语义踩了 M3 的红线**。共 3 处需要修，其中 2 处为高（正确性）、1 处为中（sameHost 启动被堵）。

要点：**`transport.ack` 在生产路径从未被调用**——每条跨进程消息实际会被重投 `maxAttempts` 次（写多条重复 entry）后落 `failed`；**`EndpointLock.acquire` 的 shared-shared 共存分支让两个进程能同时 hold 同一 endpoint 的锁**——这正是 M3 定义要防的「双写者损坏 session 树」。

## 问题清单

| # | 位置 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | `src/core/mailbox.ts:855` / `src/core/transport.ts:120` | major | `transport.ack` 生产路径零调用：outbox 行永不到 done，每消息重投 maxAttempts 次后 failed（见 §一） | ✅ 已修：`handleOutboxDelivery` 成功后补 `transport.ack(deliveryId,"delivered")`；e2e 加 outbox=done 断言 |
| 2 | `src/pi/lock.ts:69-81` | major | shared-shared 共存违反 M3「全局单写者」，双 wam 写坏 session 树（见 §二） | ✅ 已修：`acquire` 拆 `mode:"single"|"multi"`，仅实例锁 multi 共存；endpoint 锁 any 租约严格单写者；`release` single 恒删 |
| 3 | `src/index.ts:326-337` | minor | 启动端点探测 unconditional exclusive acquire，堵死 sameHost 第二进程（见 §三） | ✅ 已修：`useSameHost` 下跳过端点探测；实例锁按 mode 取 multi/single |
| L1–L4 | 见 §四 | nit | 锁残留/幂等 warm/并发重入等 | 不修（记档） |

---

## 一、`transport.ack` 从未被调用：outbox 行永远到不了 done（HIGH）

**位置**：`src/core/mailbox.ts:855-876`（`handleOutboxDelivery`）、`src/core/transport.ts:120-135`（`ack`）、`src/core/types.ts:756-759`（`Transport` 契约）。

**事实**：

- `Transport` 接口（`types.ts:759`）把 `ack(deliveryId, state)` 定义为交付终态的推进入口；`SameHostTransport.ack`（`transport.ts:120`）实现正确（`delivered` → `done`）。
- `mailbox.handleOutboxDelivery` 收到 outbox 条目后只做 `port.deliver` + `UPDATE mesh_deliveries SET handoff_at/entry_id`（`mailbox.ts:863-875`），**从不调用 `this.d.transport.ack(d.deliveryId, "delivered")`**。
- 全仓 grep `transport.ack` / `.ack(deliveryId` 无任何生产调用点——`SameHostTransport.ack` 是**死代码**，仅被单测 `transport.test.ts` 手工调用。

**后果**（claimTtlMs 默认 5min、maxAttempts 默认 3）：

1. 跨进程消息 poller 认领后投递成功，但 outbox 行停在 `claimed`；
2. 5min 后 `runPollCycle` ①回收 claimed→ready，③重新认领 → 重新走 `handleOutboxDelivery` → `port.deliver` 对同一 envelope **再写一条 entry**（`port.deliver` 无 envelope 幂等去重，见 `stream-port.ts:334-387`）；
3. 如此反复 `maxAttempts` 次（3 次投递、3 条重复 entry），最后 ②死信判 `attempts>=3` → 行 `failed`。

即：**同机多进程每条消息稳态是「投 3 次 + 重复 entry + 终态 failed」**，而不是「投 1 次 + done」。单测 `ack moves outbox to done` 之所以绿，是因为测试 handler 直接手调 `t.ack`，绕过了真实的 mailbox 集成路径。

**修复**：`handleOutboxDelivery` 的 `port.deliver` 成功后补 `await this.d.transport.ack(d.deliveryId, "delivered")`；投递抛错时不 ack（保留 claimed 供回收重试）。注意 `handleOutboxDelivery` 里缺 account 的 throw 分支当前也被 `runPollCycle` 的 catch 吞掉，契合「不 ack 留待回收」，但成功路径必须 ack。

---

## 二、`EndpointLock.acquire` 的 shared-shared 共存分支违反 M3 单写者（HIGH）

**位置**：`src/pi/lock.ts:69-72`、`src/pi/stream-port.ts:512-517`。

**规范依据**：

- M3（spec `## 结论` 表、`:1363`）：「同一 `endpointId` 在全局最多有一个持锁写者」。
- `:4696`：「"顺手接管"在任何情况下都不合法」——锁只有两条合法释放路径：持锁进程自己释放，或运维人工清理。
- `:6501`：多进程同机时「每个 Endpoint 归属唯一进程（靠 stream `.lock`）」。

**事实**：`acquire` 在 `O_EXCL` 撞 `EEXIST` 后，若 `lease==="shared" && existing.lease==="shared"` 就**返回一把新锁**（`:71-72`），不抛 `LockHeldError`。`stream-port.ts` 的投递驱动自动 warm 恰恰用 `shared` 租约（`ensureHot` → `warm(ep,"shared")`，`:514`）。

**后果**：

1. **双写者**：两个进程对同一 endpoint 都 `warm(...,"shared")` 都会成功，各自建一条活 pi session、各自 `deliver` → 两条路径写同一棵 append-only session 树，leaf 指针错乱、历史不可恢复——正是 M3 存在要防的故障（spec `:175`）。
2. **phantom lock**：第二条进程拿到的新锁 `writerId` 是自己的，但锁文件里仍是第一个进程的 `writerId`（共存分支不重写文件）。于是 `isEndpointLocal`（`index.ts:472`）读文件比对 `writerId` 时，对第二个进程返回 **false**——它明明把 endpoint warm 在了本进程，却被判成「他进程」，出向投递被错误地 publish 到 outbox、再被自己的 poller 捡回来兜一圈。
3. **测试把 bug 固化了**：`stream-port.test.ts:318-335`「双抢同一路径 shared ⇒ 共存」直接断言了 M3 禁止的行为，需要反转。

**根因**：一个 `acquire` 路径同时服务两种截然不同的锁——① `.instance.lock`（`:321`，需允许 N 进程附着，`sameHost` 的核心）② endpoint `.lock`（必须严格单写者）。shared-shared 共存是为①而加的，却无差别作用到了②。

**修复方向**：把「多进程附着」与「单写者」拆开。instance 锁单独走一个允许多持有的机制（或给 `acquire` 加显式 `mode: "multi"|"single"`）；endpoint 锁**任何租约**下都保持 `O_EXCL` 撞 `EEXIST` 即 `LockHeldError`（`shared`/`exclusive` 只区分「应答窗口是否独占」的租约语义，不改变「全局一个写者」）。相应地 `release` 的「shared 不 unlink」分支（`:143-146`）也要回到「所有租赁都 unlink」或由 instance/endpoint 类型决定。

---

## 三、createMesh 启动端点探测堵死 sameHost 第二进程（MEDIUM）

**位置**：`src/index.ts:316-337`（instance 锁 + endpoint 探测）、`src/index.ts:326-332`。

**事实**：启动时对 `mesh_endpoints` 里**所有**已注册端点逐个 `EndpointLock.acquire(..., { writerId })`（默认 lease=`exclusive`，`:330`）。exclusive 撞 `EEXIST` 必抛 `LockHeldError`（共存分支只放行 shared-shared）。

**后果**：多进程稳态下，进程 A 已 warm 若干 endpoint（真实 `PiStreamPort` 会写 `.lock` 文件），进程 B 启动时探测这些端点锁即抛 → **B 的 `createMesh` reject**。spec `:6357` 明确「由别的进程托管的 Agent 在本进程注册为 external」，B 本不该为其抢锁；探测却无差别覆盖所有端点。当前 e2e 用 `FakeStreamPort`（不写锁文件）侥幸绕开，真实 `PiStreamPort` 下必触发。

**修复方向**：探测范围收窄到「本进程负责的 endpoint」（非 external/foreign），并对命中锁做 writerId + 存活判断——只拒绝「另一**活**进程持有」，而非「存在锁文件」。这与 spec `:2681`/`:6572` 的「抢不到即拒绝启动」并不冲突：拒的是**本进程要接管的端点被占**，不是**别人的端点被别人占**。

---

## 四、低优先 / 记录在案（不属缺陷，防误读）

| # | 项 | 说明 | 处置 |
| --- | --- | --- | --- |
| L1 | `isEndpointLocal` 无锁文件即「本进程」（`index.ts:471`） | 对 external 端点若 owner 进程崩溃（锁残留但按 M3 不自动清），会误判 local 并就地 auto-warm。§19 设计里这属于「运维未确认前不接管」的纪律缺口 | ✅ 已修（2026-10-01）：`isEndpointLocal` 改读 `mesh_endpoints.lock_path` + `endpointClass`——`external` 恒 outbox、绝不本地 auto-warm；`stream` 按 lock.writerId 判本/他进程。见 `notes/plan/2026-10-01-deferred-fixes-plan.md` A2-3 |
| L2 | stale 端点锁不自动回收 | `crashed` 进程留的 endpoint `.lock` 会让该端点永远收不到 outbox 投递 | ✅ 已修（2026-10-01）补上显式接管面：`MeshHost.reclaimEndpoint(endpointId)`（`ownerIsLive` 判活，`dead` 才 `forceRelease`）+ `createMesh({recoverDeadEndpoints})` 启动判活开关——M3「绝不猜」边界保留（判活不上来 ⇒ `unknown` ⇒ 保持 unavailable + 告警）。见 plan A2-4 |
| L3 | `warm` 重复调用覆盖 `transportSubs` | `index.ts:1137` 二次 warm 会 `subscribe` 覆盖旧句柄（`transport.subscribe` 内部 `set` 已替换 handler，无泄漏），旧 unsub 被孤儿化 | 幂等 warm 下无实际泄漏，可忽略 |
| L4 | `runPollCycle` 的 `await handler(pd)` 与 `setInterval` 可并发重入 | 同进程第二圈轮询会看到行已 `claimed` 而跳过，CAS 兜底 | 安全，无需改 |

## 验证期望

修复①③后，e2e 应增补**真实 `PiStreamPort`（或带锁文件的 Fake）**的 sameHost 用例：断言「投递成功后 outbox 行 = `done`」、「接收进程只收到一条 entry」、「第二进程在 owner 进程 warm 事后仍能启动但拿不到 owner 的端点锁」。

## 值得留存的经验

- **「终态推进」接口不能只靠单测覆盖**：`SameHostTransport.ack` 由单测直接调用通过，但真实集成路径（`meshbx.handleOutboxDelivery`）漏接。契约方法（`Transport.ack`）要有「谁负责调」的走查，而不只是「方法本身对」。
- **锁的语义要分清「多进程附着」与「单写者」两个正交维度**。给 `acquire` 加一个全局「shared 可共存」开关，会把 instance 锁的需求错误地施加到 endpoint 锁上，破坏 M3；共享租约的「shared/exclusive」本意是「应答窗口是否独占」，与「能否多写者共存」无关。
- **用 Fake/Stub 端口测锁相关路径会漏真问题**：FakeStreamPort 不写 `.lock` 文件，使 endpoint 探测、isEndpointLocal、崩溃恢复的锁分支全被架空。锁相关 e2e 必须用带锁文件语义的 port 实现。