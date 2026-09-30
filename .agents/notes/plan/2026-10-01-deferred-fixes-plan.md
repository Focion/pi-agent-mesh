---
title: 记档遗留项修复计划（sameHost 归属/死写者 + perConversation 选择器 + forkAt 决策）
date: 2026-10-01
status: done
owner: unassigned
tags: [plan, samehost, lock, m3, selector, fork, spec-drift]
related:
  - notes/review/2026-09-30-samehost-transport-review.md
  - notes/review/2026-09-29-deferred-capabilities-audit.md
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
---

# 记档遗留项修复计划

## 范围

把两篇 review 里「记录在案但未修」的项整理成一份可执行的修复计划。跨机部署（#11）保持 out-of-scope（已确认不做跨机）。

| 项 | 来源 | 级别 | 处置 |
| --- | --- | --- | --- |
| A. sameHost 端点归属持久化 + 死写者锁恢复 | 30 日 review L1/L2；audit #3/#10 余波 | 🔴 高（正确性） | 本计划主目标，分 A1–A4 |
| B. `mesh_endpoints.lock_path` 从未落库 ⇒ C10 恒触发 | 本次复核新发现（并入 A1） | 🔴 高（正确性） | 并入 A |
| C. perConversation 选择器不哈希（#9） | audit #9 | 🟢 低 | 规格歧义需一决策，见 C |
| D. forkAt（#1） | audit #1 | 🟢 低（取证） | 决策点，见 D，默认延后 |
| E. 声明类型简化（#4/#6/#7） | audit #4/#6/#7 | 🟢 低 | 保持简化，补文档/预算，见 E |
| F. demo runScenario 一键场景 | audit 复核结论 | 🟢 低（打磨） | 可顺手做，见 F |

---

## A. sameHost 端点归属持久化 + 死写者锁恢复（L1/L2 + C10）

### A1 现状与根因（实证）

1. **`lock_path` 列从未被任何代码写入**。`migrations/000_init.sql:46` 声明了 `lock_path TEXT`，`registry.ts` 只有类型字段（`:95`）和 `setEndpointLease`/`setEndpointSession`（写 `lease_mode`/`lease_until`/`pi_session_id`），全仓无一处写 `lock_path`（`grep lock_path src/` 仅命中 observer 断言、index 读锁路径、lock.ts）。
2. **C10 断言因此在生产必触发**。`observer.ts:852-882` 的 C10 第一子检查「`state IN ('warming','hot','evicting')` 必须 `lock_path` 非空」。真实 `PiStreamPort.warm` 经 `index.ts:374` → `registry.setEndpointState` 把 `mesh_endpoints.state` 写成 `hot`，但 `lock_path` 仍 NULL ⇒ 任何 `warm` 后 `checkInvariants()` 都报 C10 违规。当前测试全绿是因为 e2e 用 `FakeStreamPort`（不写 DB 的 state，也不走 registry 的 `setEndpointState`）绕开了这条路径——这正是 30 日 review 末「Fake/Stub 端口架空锁相关路径」教训的又一处体现。
3. **L1：`isEndpointLocal` 把「无锁文件」误判为「本进程」**。`index.ts:471-484`：`readInfo` 返回空或抛错都 `return true`（保守视为本进程）。当一个 `external` 端点（他进程托管）的 owner 尚未 warm、或无锁文件时，本进程 `deliverOne` 会就地 `auto-warm`（§8.3 投递驱动），造成「顺手接管」——M3 明确禁止（spec `:4696`「"顺手接管"在任何情况下都不合法」）。
4. **L2：owner 崩溃后端点永久无法被接管**。锁 `.lock` 里的 `writerId`/`pid` 是崩溃进程的，无自动恢复；`EndpointLock.forceRelease`（`lock.ts:112`）是无判活的裸删除，只被测试用。spec `:4733`/`:6572`/`:8234` 要求接管前必须「进程真的不存在」（`kill -0` 失败）+ 比对启动时刻（M-R10），且「判定不上来时保持 unavailable 并告警，绝不猜」。

### A2 修复步骤（建议顺序）

**A2-1. 补齐锁文件信息（`src/pi/lock.ts`）**

- `LockInfo` 增 `procStartedAt: string`（进程启动时刻，M-R10 的 pid 复用护栏）。`acquire` 写锁文件时一并落盘。启动时刻取法：`execFile("ps", ["-p", String(process.pid), "-o", "lstart="])`（macOS/Linux 通用），失败则置空字符串并记为「不可比」。
- 新增静态判活助手：
  - `EndpointLock.pidAlive(pid): Promise<boolean>`——`process.kill(pid, 0)`，`ESRCH` ⇒ false，`EPERM` ⇒ true。
  - `EndpointLock.ownerIsLive(lockPath): Promise<"alive" | "dead" | "unknown">`——读 `pid` + `procStartedAt`；`kill -0` 失败 ⇒ `dead`；存活但 `procStartedAt` 可读且不匹配 ⇒ pid 已复用 ⇒ `dead`（原 owner 消失）；无法读取启动时刻（macOS 无 `/proc`）⇒ `unknown`。
  - 三者语义：`dead` 才允许接管；`alive` = 另一活进程持有（正常 `LOCK_HELD`）；`unknown` = 保持 `unavailable` + 告警，**绝不猜**（`§27.4`/`M-R10`）。

**A2-2. `lock_path` 落库与清空（`src/core/registry.ts` + `src/index.ts` + `src/pi/stream-port.ts`）**

- `registry` 新增 `setEndpointLock(id, lockPath|null)`：`UPDATE mesh_endpoints SET lock_path = ?`。
- `stream-port.ts` 的 `warm` 抢到锁成功后调 `d.setEndpointLock(id, lockPath)`；`evict`/`release` 后清空。接口上给 `StreamPort` 依赖注入加一组 `setEndpointLock`（参照既有 `setEndpointLease` 的注入模式，`stream-port.ts:58`、`index.ts:435-448`）。
- 结果：C10 第一子检查恢复成真实可判定的不变量，且 `lock_path` 成为「谁是 owner」的持久真相（DB 层）。

**A2-3. `isEndpointLocal` 用归属而非锁文件存在与否（`src/index.ts:471-484`）**

- 在投递路径上把 `account.endpointClass` 纳入判断：
  - `endpointClass === "external"` ⇒ **恒 outbox**，绝不本地 auto-warm（消除 L1 的顺手接管）。
  - `endpointClass === "stream"` ⇒ 读 `mesh_endpoints.lock_path`：非空且 `lock.writerId === writerId` ⇒ 本地；非空但 writerId 异 ⇒ outbox；空（未 warm）⇒ 本地（本进程才该 warm 自己的 stream 端点）。
- 代价：`deliverOne` 目前只拿 `endpointId` 调 `isEndpointLocal`，需改为拿 `account`（或 endpoint 的 `accountId` 反查 `endpointClass`）。`mailbox` 上下文里已有 account，属小改。

**A2-4. 死写者恢复（opt-in，绝不自动）**

- `MeshHost` 暴露 `reclaimEndpoint(endpointId): Promise<{ outcome: "reclaimed" | "held" | "unknown" }>`：
  - `ownerIsLive` 判定；`dead` ⇒ `forceRelease` + 允许重新 `warm`；`alive` ⇒ 拒绝并返回持锁者 info；`unknown` ⇒ 拒绝 + `policy_degraded` 告警。
- `createMesh` 增加可选项 `recoverDeadEndpoints?: boolean`（默认 false）：启动端点探测（`index.ts:326-337`）时对「本进程负责的 stream 端点」做上述判活，`dead` 才允许接管；`exclusive` 撞 `EEXIST` 且 owner 死 ⇒ 回收，否则维持拒绝。这是 M-R10 规定的唯一合法自动回收窗口。
- 文档补 §27 运维边界：`owner 崩溃 ⇒ 显式 reclaimEndpoint 或 recoverDeadEndpoints`，`kill -9` 残留且判定不上来 ⇒ 人工 `forceRelease`。

### A3 决策点

- **`external` 端点的 auto-warm 是彻底禁止，还是只禁「有锁但异主」？** 建议前者（A2-3），因为 `external` 的语义就是「他进程托管」，本进程 warm 从来不该发生。若不改，`isEndpointLocal` 仍可能在无锁窗口误判 local。
- **启动时刻比对的精度**：macOS 无 `/proc`，`ps -o lstart=` 稳定但非瞬时。建议把「取不到启动时刻」显式归入 `unknown`（保守拒绝），与 spec 一致。

### A4 测试

- `stream-port.test.ts`：warm 后断言 `mesh_endpoints.lock_path` 非空、evict 后清空；`EndpointLock.ownerIsLive` 三态（现 pid 活、伪造死 pid、启动时刻不匹配）。
- `tests/e2e/samehost.test.ts`：补「external 端点无锁文件 ⇒ 本进程不 auto-warm、走 outbox」；补「owner 崩溃 ⇒ `reclaimEndpoint` 后 re-warm 成功；owner 活 ⇒ 拒绝」。
- 全程 `checkInvariants()` 全绿（C10 现在真正被验证）。

---

## C. perConversation 选择器不哈希（audit #9，🟢 低）

### 现状

`policies.ts:300-327`：`select` 的 ctx 只有 `{ accountId, envelope, topology: { kind, affinity? } }`（丢失 `StreamTopology` 的 `scope`/`key` 与 `conversationId`，spec 的签名 `§1355-1364` 里本有 `conversationId`）；`perConversation` 分支恒 `return eps[0]`。

### 规格歧义（务必先定，再写码）

spec `:1356` 说 `perConversation ⇒ hash(accountId, key)`，但 `StreamTopology`（`types.ts:201-203`）给每条端点带了 `{ scope: "conversation" | "purpose"; key: string }`，且 `ux_endpoint_percv` 唯一索引是 `(account_id, scope, scope_key)`（每 key 至多一条端点）。这产生两种读法：

1. **按 key 精确匹配**：端点声明自己服务哪个 `key`（会话/用途），`select` 找 `key === conversationId` 的那条。此读法下 `hash` 多余。
2. **按 hash 分片**：perConversation 端点是一批「槽位」，`hash(accountId, conversationId) % N` 选槽。此读法下端点 `key` 字段的解释存疑。

### 建议

优先按读法 2 落地（`hash` 才有意义，且与 `pooled` 亲和分支的 `sha256Hex(anchor) % N` 同一习语），实现最小：

1. 内建 `select` 的 ctx 扩展：`topology: StreamTopology` + `conversationId: string`（内部契约，与上次 plan 的 `RouteInput`/`Mailbox` 内契约改动同类）。
2. `perConversation`：`anchor = scope === "purpose" ? purposeKey(envelope) : conversationId`；`eps` 内匹配 `topology.kind === "perConversation"` 的端点，`idx = sha256Hex(accountId + ":" + anchor) % N`。
3. 无 perConversation 端点 ⇒ 回退 `eps[0]`（保持现状，不破坏单端点）。
4. 若后续澄清读法 1 为准，退化为「按 `key` 精确匹配 + hash 作同 key 稳定打散」，改动仍局限于 `select`。

本项不影响公共 API 面，仅补一条 P0/P1 就欠的确定性路由分支。

---

## D. forkAt（audit #1，🟢 低，取证）——决策，默认延后

`observer.ts:677` 是当前唯一 `MeshUnsupportedError` 运行时桩。要真正实现需同时解决三件前置（audit 遗留项已列）：

1. pi `forkFrom` 被门禁 G3 禁用（AGENTS.md / `check-imports.mjs`）——需放宽或换实现路径。
2. F4「分支语义」选型（分叉后旧分支要不要继续收消息、`from_seq` 如何切）。
3. §23.2 exclusive 租约（分叉端点的单答复窗口）。

**建议都列为「决策」而非「开单」**：forkAt 是取证工具，`replay` + 压缩对比已覆盖大部分「那决策为什么错」的调查价值。触发条件（audit 已写）：出现「replay 解释不了」的生产事故，或产品转向 agent 诊断。届时先解答 F4 的分支语义再动手。

本计划不做 forkAt，把 audit 的 `[ ] #1 forkAt` 维持为 `[ ]`。

---

## E. 声明类型简化（audit #4/#6/#7，🟢 低）——保持简化，补文档

这三项是「按声明类型做了语义子集」的**既定定界**，非缺陷；AGENTS.md 约定 5 只要求「偏离记入 review，不与规范静默漂移」。已登记。可选动作：

- **#4 topic 逐订阅者 RetentionPolicy 预算**：保持 fanout 语义，不改。风险点唯一是「订阅者极多时的写放大」，落一条备注到 spec 技术债清单即可。
- **#6 `PutResult`/`GetResult` 联合类型**：保持 reject/null。若要给调用方「当前版本 + hint」，可加一个可选 `shared.getRaw()`（返回 `{ version, data, tombstoned }`）而不动公共返回类型。**建议不做**，等真实需求。
- **#7 `purged` 保留窗口**：这个有长期存储风险（`mesh_shared_versions` 无限增长，spec `§27.3` 点名）。建议后续单独开「裁剪」小项：按保留窗口删 `mesh_shared_versions` 旧行 + `purged` 标记，一次小 PR，不并入本计划。

---

## F. demo runScenario 一键场景（audit 复核 100 行，🟢 低打磨）

`demo/src/runtime.ts` 的 `runScenario` 目前只支持 `"P0" | "P1"`，未接 Topic/请求-应答/Queue/共享空间/Replay 五页的确定性一键场景（零 LLM 可跑，纯 `send/subscribe/claim/ack/put` + 读 observer）。顺手项，不阻塞 A。

---

## 建议执行顺序

1. **A1–A4**（关联正确性 + 让 C10 复活）：先把 `lock_path` 落库 + `isEndpointLocal` 用 `endpointClass` 判定 + `ownerIsLive` 判活三件做掉；`recoverDeadEndpoints` 作为独立开关在最后，避免一次性引入「自动接管」的语义面。
2. **C**：规格歧义定夺后补 `select` 的确定性路由（半天量级）。
3. **E → F**：裁剪备注 + demo 打磨，随缘。
4. **D**：维持延后，等触发条件。

## 验证

```bash
npm run typecheck                    # 0 错
npm test                             # 全绿（含新增 A4 / C 用例，C10 现在真跑）
node scripts/check-imports.mjs       # G1–G4 0 违规（A 不动 layering；D 若做才碰 G3）
npm run build                        # tsup esm+cjs+dts
```

## 风险

- **A2-3 改动投递路径**：`isEndpointLocal` 接 `account` 会触到 `mailbox.deliverOne` 的调用签名，需回归 P0/P1 投递与 queue 用例（判断逻辑变化可能影响 `parked` 归属）。
- **A2-4 的 pid 复用护栏**在 macOS 上依赖 `ps -o lstart=`，跨平台一致性需在 CI 上亮一次（本机 darwin 即可验）。
- **C 的规格歧义**若选错，改动仅限 `select` 一处，回退成本低。