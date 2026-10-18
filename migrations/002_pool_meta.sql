-- I15/C05（§8.1）：pooled 拓扑的 size/affinity 持久化列。
-- 在此之前 pooled 端点只落 pool_slot，size/affinity 由 rowToEndpoint 凭空回退
-- （size=1/affinity="none"），重启后选择器分片基数与亲和策略丢失。
-- 历史库默认 NULL ⇒ rowToEndpoint 回退 size=1/affinity="none"，语义等价于
-- 「单槽位、无亲和」，legacy 行为不变。
ALTER TABLE mesh_endpoints ADD COLUMN pool_size INTEGER;
ALTER TABLE mesh_endpoints ADD COLUMN pool_affinity TEXT;