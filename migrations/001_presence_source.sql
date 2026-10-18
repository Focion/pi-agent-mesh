-- I24（§15）：显式 presence 与派生 presence 的区分列。
-- presence_explicit = 1 ⇒ presence/presence_until 由宿主 setPresence 显式设定，
-- 在 until 未过期前优先于端点派生；= 0 ⇒ 一律按 §15.2 由端点状态派生。
-- 历史库默认 0（此前 presence 都是默认 offline，语义等同未显式设置）。
ALTER TABLE mesh_accounts ADD COLUMN presence_explicit INTEGER NOT NULL DEFAULT 0;