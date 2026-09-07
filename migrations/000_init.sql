-- ═══ Pi Agent Mesh — schema v1（规范：docs/Pi-Agent-Mesh.md 附录 G）═══
-- 17 张表 + 1 张 fts5 虚拟表，单一 SQLite 文件。
-- 约定：表名 mesh_ 前缀；索引 ix_/ux_ 前缀；时间列 TEXT ISO-8601 UTC；
--       ext 一律 TEXT 存 JSON，库不建索引不解释（M1/I18）。

-- 连接级设置（journal_mode 持久化；foreign_keys / busy_timeout 每连接由应用设置）
PRAGMA journal_mode = WAL;

-- ═══ 1. 元信息 ═══
CREATE TABLE IF NOT EXISTS mesh_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT OR IGNORE INTO mesh_meta (k, v) VALUES ('schema_version', '1');

-- ═══ 2. 账号与寻址 ═══
CREATE TABLE IF NOT EXISTS mesh_accounts (
  id             TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  endpoint_class TEXT NOT NULL CHECK (endpoint_class IN ('stream','sink','external')),
  capabilities   TEXT NOT NULL DEFAULT '[]',
  initiate       TEXT NOT NULL DEFAULT '[]',
  default_grade  TEXT,
  profile_ref    TEXT,
  presence       TEXT NOT NULL DEFAULT 'offline',
  presence_until TEXT,
  presence_reason TEXT,
  created_at     TEXT NOT NULL,
  archived_at    TEXT,
  ext            TEXT
);
-- '@system' 必须存在：它是 mesh_messages.from_account 外键的前提（C16）
INSERT OR IGNORE INTO mesh_accounts (id, display_name, endpoint_class, initiate, created_at)
  VALUES ('@system', 'system', 'sink', '["system"]', '1970-01-01T00:00:00Z');

CREATE TABLE IF NOT EXISTS mesh_endpoints (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES mesh_accounts(id),
  topology      TEXT NOT NULL CHECK (topology IN ('unified','perConversation','pooled')),
  scope         TEXT,
  scope_key     TEXT,
  pool_slot     INTEGER,
  pi_session_id TEXT,
  lease_mode    TEXT NOT NULL DEFAULT 'shared' CHECK (lease_mode IN ('shared','exclusive')),
  lease_until   TEXT,
  lock_path     TEXT,
  state         TEXT NOT NULL DEFAULT 'cold'
                  CHECK (state IN ('cold','warming','hot','evicting','unavailable')),
  last_active_at TEXT,
  ext           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_endpoint_percv ON mesh_endpoints(account_id, scope, scope_key)
  WHERE topology = 'perConversation';
CREATE UNIQUE INDEX IF NOT EXISTS ux_endpoint_pool ON mesh_endpoints(account_id, pool_slot)
  WHERE topology = 'pooled';

CREATE TABLE IF NOT EXISTS mesh_streams (
  pi_session_id   TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL REFERENCES mesh_endpoints(id),
  account_id      TEXT NOT NULL REFERENCES mesh_accounts(id),
  purpose         TEXT,
  cwd             TEXT,
  created_at      TEXT NOT NULL,
  last_entry_at   TEXT,
  entry_count     INTEGER NOT NULL DEFAULT 0,
  leaf_entry_id   TEXT,
  model_config_hash TEXT,
  ext             TEXT
);

CREATE TABLE IF NOT EXISTS mesh_contacts (
  owner_id   TEXT NOT NULL REFERENCES mesh_accounts(id),
  peer_id    TEXT NOT NULL REFERENCES mesh_accounts(id),
  alias      TEXT,
  tags       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, peer_id)
);

-- ═══ 3. 会话与成员 ═══
CREATE TABLE IF NOT EXISTS mesh_conversations (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('direct','group','topic','queue')),
  topic        TEXT,
  announcement TEXT,
  config       TEXT,
  next_seq     INTEGER NOT NULL DEFAULT 1,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES mesh_accounts(id),
  created_at   TEXT NOT NULL,
  archived_at  TEXT,
  ext          TEXT
);

CREATE TABLE IF NOT EXISTS mesh_memberships (
  conversation_id    TEXT NOT NULL REFERENCES mesh_conversations(id),
  account_id         TEXT NOT NULL REFERENCES mesh_accounts(id),
  caps               TEXT NOT NULL DEFAULT '["speak","read"]',
  joined_seq         INTEGER NOT NULL,
  last_spoke_seq     INTEGER NOT NULL DEFAULT 0,
  last_mentioned_seq INTEGER NOT NULL DEFAULT 0,
  verbatim_pinned    INTEGER,
  joined_at          TEXT NOT NULL,
  left_at            TEXT,
  muted_until        TEXT,
  ext                TEXT,
  PRIMARY KEY (conversation_id, account_id)
);
CREATE INDEX IF NOT EXISTS ix_membership_account ON mesh_memberships(account_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS mesh_subscriptions (
  conversation_id TEXT NOT NULL REFERENCES mesh_conversations(id),
  account_id      TEXT NOT NULL REFERENCES mesh_accounts(id),
  from_seq        INTEGER NOT NULL,
  subscribed_at   TEXT NOT NULL,
  unsubscribed_at TEXT,
  ext             TEXT,
  PRIMARY KEY (conversation_id, account_id)
);
CREATE INDEX IF NOT EXISTS ix_subscription_account ON mesh_subscriptions(account_id)
  WHERE unsubscribed_at IS NULL;

-- ═══ 4. 消息 ═══
CREATE TABLE IF NOT EXISTS mesh_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES mesh_conversations(id),
  seq             INTEGER NOT NULL,
  from_account    TEXT NOT NULL REFERENCES mesh_accounts(id),
  from_endpoint   TEXT REFERENCES mesh_endpoints(id),
  kind            TEXT NOT NULL
                    CHECK (kind IN ('chat','task','event','system','tombstone')),
  expect          TEXT NOT NULL DEFAULT 'none'
                    CHECK (expect IN ('ack','reply','none')),
  priority        TEXT,
  to_accounts     TEXT,
  mentions        TEXT,
  reply_to        TEXT REFERENCES mesh_messages(id),
  correlation_id  TEXT,
  ack_of          TEXT REFERENCES mesh_messages(id),
  intent          TEXT,
  late            INTEGER NOT NULL DEFAULT 0,
  logical_ts      TEXT,
  routed_at       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  client_token    TEXT,
  idempotency_key TEXT NOT NULL,
  seal            TEXT,
  tombstoned_by   TEXT REFERENCES mesh_messages(id),
  ext             TEXT,
  UNIQUE (conversation_id, seq),
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_msg_conv_seq    ON mesh_messages(conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS ix_msg_from        ON mesh_messages(from_account, routed_at DESC);
CREATE INDEX IF NOT EXISTS ix_msg_correlation ON mesh_messages(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS mesh_messages_fts USING fts5(
  text, content='', tokenize='trigram'
);

-- ═══ 5. 投递与收件箱 ═══
CREATE TABLE IF NOT EXISTS mesh_deliveries (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES mesh_messages(id),
  account_id    TEXT NOT NULL REFERENCES mesh_accounts(id),
  endpoint_id   TEXT REFERENCES mesh_endpoints(id),
  grade         TEXT CHECK (grade IN ('steer','followUp','silent')),
  path          TEXT CHECK (path IN ('P1','P2','P3')),
  woke          INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN
                  ('routed','queued','parked','delivered','consumed','dropped','claimed','acked')),
  partial       INTEGER NOT NULL DEFAULT 0,
  parked_reason TEXT,
  drop_reason   TEXT,
  entry_id      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claim_until   TEXT,
  parked_at     TEXT,
  queued_at     TEXT,
  delivered_at  TEXT,
  consumed_at   TEXT,
  handoff_at    TEXT,
  state_changed_at TEXT NOT NULL,
  note          TEXT,
  UNIQUE (message_id, endpoint_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_noep ON mesh_deliveries(message_id, account_id)
  WHERE endpoint_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_delivery_inflight ON mesh_deliveries(endpoint_id, state)
  WHERE state IN ('queued','delivered');
CREATE INDEX IF NOT EXISTS ix_delivery_parked   ON mesh_deliveries(state, parked_at) WHERE state = 'parked';
CREATE INDEX IF NOT EXISTS ix_delivery_claim    ON mesh_deliveries(state, claim_until) WHERE state = 'claimed';
CREATE INDEX IF NOT EXISTS ix_delivery_message  ON mesh_deliveries(message_id);

CREATE TABLE IF NOT EXISTS mesh_inboxes (
  account_id       TEXT NOT NULL REFERENCES mesh_accounts(id),
  conversation_id  TEXT NOT NULL REFERENCES mesh_conversations(id),
  cursor_seq       INTEGER NOT NULL DEFAULT 0,
  pending_count    INTEGER NOT NULL DEFAULT 0,
  pending_bytes    INTEGER NOT NULL DEFAULT 0,
  verbatim_bytes   INTEGER NOT NULL DEFAULT 0,
  overflow_count   INTEGER NOT NULL DEFAULT 0,
  overflow_summary TEXT,
  folded_to_seq    INTEGER NOT NULL DEFAULT 0,
  last_woke_at     TEXT,
  PRIMARY KEY (account_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS mesh_pending_acks (
  correlation_id  TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES mesh_messages(id),
  expect          TEXT NOT NULL CHECK (expect IN ('ack','reply')),
  from_account    TEXT NOT NULL REFERENCES mesh_accounts(id),
  to_account      TEXT NOT NULL REFERENCES mesh_accounts(id),
  endpoint_id     TEXT REFERENCES mesh_endpoints(id),
  conversation_id TEXT NOT NULL REFERENCES mesh_conversations(id),
  intent          TEXT,
  sync            INTEGER NOT NULL DEFAULT 0,
  deadline        TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open','answered','timeout','abandoned')),
  answered_by_message TEXT REFERENCES mesh_messages(id)
);
CREATE INDEX IF NOT EXISTS ix_pending_deadline ON mesh_pending_acks(deadline) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS ix_pending_cycle    ON mesh_pending_acks(from_account, to_account)
  WHERE state = 'open' AND sync = 1;

-- ═══ 6. 会话镜像 ═══
CREATE TABLE IF NOT EXISTS mesh_stream_entries (
  entry_id        TEXT PRIMARY KEY,
  pi_session_id   TEXT NOT NULL REFERENCES mesh_streams(pi_session_id),
  parent_id       TEXT,
  seq_in_stream   INTEGER NOT NULL,
  entry_type      TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  mesh_message_id TEXT REFERENCES mesh_messages(id),
  created_at      TEXT NOT NULL,
  model_config_hash TEXT
);
CREATE INDEX IF NOT EXISTS ix_entry_stream  ON mesh_stream_entries(pi_session_id, seq_in_stream);
CREATE INDEX IF NOT EXISTS ix_entry_message ON mesh_stream_entries(mesh_message_id)
  WHERE mesh_message_id IS NOT NULL;

-- ═══ 7. 共享空间 ═══
CREATE TABLE IF NOT EXISTS mesh_shared_objects (
  space_id     TEXT NOT NULL,
  key          TEXT NOT NULL,
  version      INTEGER NOT NULL,
  data         TEXT NOT NULL,
  content_type TEXT,
  acl          TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES mesh_accounts(id),
  created_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL REFERENCES mesh_accounts(id),
  updated_at   TEXT NOT NULL,
  tombstoned   INTEGER NOT NULL DEFAULT 0,
  ext          TEXT,
  PRIMARY KEY (space_id, key)
);
CREATE INDEX IF NOT EXISTS ix_shared_space ON mesh_shared_objects(space_id, key) WHERE tombstoned = 0;

CREATE TABLE IF NOT EXISTS mesh_shared_versions (
  space_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  data       TEXT,
  updated_by TEXT NOT NULL REFERENCES mesh_accounts(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, key, version)
);

-- ═══ 8. 运维 ═══
CREATE TABLE IF NOT EXISTS mesh_outbox (
  delivery_id     TEXT PRIMARY KEY,
  target_endpoint TEXT NOT NULL,
  payload         TEXT NOT NULL,
  claimed_by      TEXT,
  claimed_at      TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'ready'
                    CHECK (state IN ('ready','claimed','done','failed'))
);
CREATE INDEX IF NOT EXISTS ix_outbox_ready ON mesh_outbox(state, delivery_id) WHERE state = 'ready';

CREATE TABLE IF NOT EXISTS mesh_counters (
  name   TEXT NOT NULL,
  bucket TEXT NOT NULL,
  value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, bucket)
);
