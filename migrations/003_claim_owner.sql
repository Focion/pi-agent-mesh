-- I12（§17）：claim 归属从 payload 下移到 delivery 行，payload 不可变（A1）。
-- 此前 claim() 用 json_set(payload,'$.claim',…) 把归属写进消息正文，违反消息不可变
-- 约束、使 seal（对 payload 摘要）失效，observer/mailbox 四处 json_extract 回读。
-- 现新增三列承载 claim 归属、时间与末次错误；交付侧从 delivery 列读取，正文不再含 claim。
-- 历史库三列默认 NULL ⇒ 语义「未认领」，与 legacy 行为等价。
ALTER TABLE mesh_deliveries ADD COLUMN claimed_by TEXT;
ALTER TABLE mesh_deliveries ADD COLUMN claimed_at TEXT;
ALTER TABLE mesh_deliveries ADD COLUMN claim_error TEXT;
-- §17.2：回收扫描覆盖两个窗口（待领 delivered、持有 claimed），旧索引 WHERE state='claimed'
-- 只含持有窗口，delivered 未领窗口无人回收。重建为覆盖两态的偏索引。
DROP INDEX IF EXISTS ix_delivery_claim;
CREATE INDEX IF NOT EXISTS ix_delivery_claim ON mesh_deliveries(state, claim_until)
  WHERE state IN ('delivered','claimed');