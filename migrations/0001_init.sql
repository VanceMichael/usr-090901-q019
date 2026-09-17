-- 0001_init.sql — 化妆品疑似制假批次召回协同服务
-- Schema + reference data (recall batches, store directory, notification
-- templates with deadline rules) provided by the warehouse. All statements
-- are idempotent; the migration runner wraps the file in one transaction.

CREATE TABLE IF NOT EXISTS brands (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id              UUID PRIMARY KEY,
  brand_id        TEXT NOT NULL REFERENCES brands (id),
  batch_code      TEXT NOT NULL,
  product_name    TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  produced_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (brand_id, batch_code)
);

CREATE TABLE IF NOT EXISTS stores (
  id         UUID PRIMARY KEY,
  brand_id   TEXT NOT NULL REFERENCES brands (id),
  store_code TEXT NOT NULL,
  name       TEXT NOT NULL,
  region     TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (brand_id, store_code)
);

-- rules JSONB shape:
-- {
--   "ackDeadlineHours": number,          -- 期限规则: hours from publish to ack deadline
--   "allowedChannels": string[],         -- receipt channels accepted for this template
--   "exemptionReasonCodes": string[],    -- 豁免理由白名单
--   "minReasonTextLength": number        -- 豁免理由最小字数
-- }
CREATE TABLE IF NOT EXISTS notification_templates (
  id       UUID PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands (id),
  name     TEXT NOT NULL,
  channel  TEXT NOT NULL,
  body     TEXT NOT NULL,
  rules    JSONB NOT NULL,
  UNIQUE (brand_id, name)
);

CREATE TABLE IF NOT EXISTS recall_tasks (
  id              UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  brand_id        TEXT NOT NULL REFERENCES brands (id),
  batch_id        UUID NOT NULL REFERENCES batches (id),
  batch_code      TEXT NOT NULL,
  batch_version   INTEGER NOT NULL,
  template_id     UUID NOT NULL REFERENCES notification_templates (id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  published_at    TIMESTAMPTZ NOT NULL,
  deadline_at     TIMESTAMPTZ NOT NULL,
  closed_at       TIMESTAMPTZ,
  close_reason    TEXT
);
CREATE INDEX IF NOT EXISTS recall_tasks_brand_idx ON recall_tasks (brand_id, published_at DESC);

-- Per-store assignment. `status` is the durable state; `overdue` is derived
-- at read time from (status = 'pending' AND deadline_at < now).
CREATE TABLE IF NOT EXISTS recall_task_stores (
  task_id             UUID NOT NULL REFERENCES recall_tasks (id),
  store_id            UUID NOT NULL REFERENCES stores (id),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'acknowledged', 'exempted')),
  acknowledged_at     TIMESTAMPTZ,
  receipt_late        BOOLEAN NOT NULL DEFAULT FALSE,
  overdue_days_at_ack INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id, store_id)
);
CREATE INDEX IF NOT EXISTS recall_task_stores_store_idx ON recall_task_stores (store_id);

CREATE TABLE IF NOT EXISTS receipts (
  id           UUID PRIMARY KEY,
  task_id      UUID NOT NULL REFERENCES recall_tasks (id),
  store_id     UUID NOT NULL REFERENCES stores (id),
  receipt_time TIMESTAMPTZ NOT NULL,   -- store-reported acknowledgement time
  received_at  TIMESTAMPTZ NOT NULL,   -- server time the receipt was recorded
  channel      TEXT NOT NULL,
  note         TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('accepted', 'accepted_late', 'duplicate')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipts_store_idx ON receipts (store_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS receipts_task_idx ON receipts (task_id);

CREATE TABLE IF NOT EXISTS exemption_requests (
  id           UUID PRIMARY KEY,
  task_id      UUID NOT NULL REFERENCES recall_tasks (id),
  store_id     UUID NOT NULL REFERENCES stores (id),
  reason_code  TEXT NOT NULL,
  reason_text  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer     TEXT,
  review_note  TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  reviewed_at  TIMESTAMPTZ
);
-- At most one pending exemption per (task, store); drives idempotent re-requests.
CREATE UNIQUE INDEX IF NOT EXISTS exemption_pending_uniq
  ON exemption_requests (task_id, store_id) WHERE status = 'pending';

-- Persisted coverage snapshot per task; recomputed inside the same
-- transaction as every mutation so counts never drift, and survives restarts.
CREATE TABLE IF NOT EXISTS coverage_snapshots (
  task_id           UUID PRIMARY KEY REFERENCES recall_tasks (id),
  total_stores      INTEGER NOT NULL,
  acknowledged      INTEGER NOT NULL,
  late_acknowledged INTEGER NOT NULL,
  exempted          INTEGER NOT NULL,
  pending           INTEGER NOT NULL,
  overdue           INTEGER NOT NULL,
  coverage_rate     NUMERIC(6, 4) NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL,
  version           INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Reference data (deterministic ids so black-box tests can rely on them).
-- ---------------------------------------------------------------------------

INSERT INTO brands (id, name) VALUES
  ('lumina',  'Lumina 露肌'),
  ('velvette', 'Velvette 薇尔薇')
ON CONFLICT (id) DO NOTHING;

INSERT INTO batches (id, brand_id, batch_code, product_name, current_version, produced_at) VALUES
  ('ba7c4000-0000-4000-8000-000000000001', 'lumina',   'B-2026-0901', '净透洁面乳 150ml', 3, '2026-08-20T00:00:00Z'),
  ('ba7c4000-0000-4000-8000-000000000002', 'lumina',   'B-2026-0815', '修护精华露 30ml',  1, '2026-08-01T00:00:00Z'),
  ('ba7c4000-0000-4000-8000-000000000003', 'velvette', 'V-778',        '丝绒哑光口红',      2, '2026-07-15T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO stores (id, brand_id, store_code, name, region, active) VALUES
  ('57000000-0000-4000-8000-000000000001', 'lumina',   'S-001', '上海静安店', '华东', TRUE),
  ('57000000-0000-4000-8000-000000000002', 'lumina',   'S-002', '北京朝阳店', '华北', TRUE),
  ('57000000-0000-4000-8000-000000000003', 'lumina',   'S-003', '广州天河店', '华南', TRUE),
  ('57000000-0000-4000-8000-000000000004', 'lumina',   'S-004', '成都锦江店', '西南', TRUE),
  ('57000000-0000-4000-8000-000000000005', 'lumina',   'S-005', '武汉江汉店', '华中', TRUE),
  ('57000000-0000-4000-8000-000000000006', 'lumina',   'S-006', '沈阳和平店', '东北', FALSE),
  ('57000000-0000-4000-8000-000000000101', 'velvette', 'V-001', '上海淮海店', '华东', TRUE),
  ('57000000-0000-4000-8000-000000000102', 'velvette', 'V-002', '杭州西湖店', '华东', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO notification_templates (id, brand_id, name, channel, body, rules) VALUES
  ('7e000000-0000-4000-8000-000000000001', 'lumina', 'standard-recall-notice', 'app',
   '【召回通知】请立即停止销售并下架批次 {{batchCode}}（版本 {{batchVersion}}），并在 {{deadlineHours}} 小时内通过本应用确认。',
   '{"ackDeadlineHours": 72, "allowedChannels": ["app", "sms", "email"], "exemptionReasonCodes": ["NO_STOCK", "STORE_CLOSED", "NEVER_RECEIVED"], "minReasonTextLength": 8}'::jsonb),
  ('7e000000-0000-4000-8000-000000000002', 'lumina', 'urgent-recall-notice', 'sms',
   '【紧急召回】批次 {{batchCode}} 涉嫌制假，请 24 小时内确认下架并回复本短信。',
   '{"ackDeadlineHours": 24, "allowedChannels": ["sms", "app"], "exemptionReasonCodes": ["NO_STOCK", "NEVER_RECEIVED"], "minReasonTextLength": 8}'::jsonb),
  ('7e000000-0000-4000-8000-000000000003', 'velvette', 'standard-recall-notice', 'app',
   '【召回通知】请立即下架批次 {{batchCode}} 并在 {{deadlineHours}} 小时内确认。',
   '{"ackDeadlineHours": 48, "allowedChannels": ["app", "email"], "exemptionReasonCodes": ["NO_STOCK", "STORE_CLOSED"], "minReasonTextLength": 10}'::jsonb)
ON CONFLICT (id) DO NOTHING;
