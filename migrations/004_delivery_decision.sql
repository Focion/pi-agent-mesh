-- I28（§12.4）：redeliver_reason 承载「重投触发原因」，把两条正交的决策留痕轴分开——
-- note 解释「定档/不唤醒/降档」（deliverOne 定档时写），redeliver_reason 解释「为何又重投」
-- （requeue 站点写：entry_vanished / handoff_timeout / claim_timeout / 原 parked_reason）。
-- 历史库默认 NULL ⇒ 语义「从未重投」，不做回填（重投历史不可由现有列可靠重建）。
ALTER TABLE mesh_deliveries ADD COLUMN redeliver_reason TEXT;