-- 0001_init.sql — 化妆品疑似制假批次召回协同服务 schema
-- 所有表使用确定性主键/唯一约束以支撑幂等发布与回执。
-- 注意：迁移执行器已将每个文件包裹在单事务中，请勿在此使用 BEGIN/COMMIT。

-- 品牌与门店目录（仓库提供的门店归属数据）
CREATE TABLE brands (
  brand_id text PRIMARY KEY,
  name     text NOT NULL
);

CREATE TABLE stores (
  store_id   bigserial PRIMARY KEY,
  store_code text NOT NULL UNIQUE,
  brand_id   text NOT NULL REFERENCES brands (brand_id),
  name       text NOT NULL,
  region     text NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true
);
CREATE INDEX stores_brand_idx ON stores (brand_id);

-- 通知模板（按召回原因编码区分，版本化）
CREATE TABLE notice_templates (
  template_id   bigserial PRIMARY KEY,
  template_code text NOT NULL,
  version       integer NOT NULL,
  reason_code   text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  UNIQUE (template_code, version)
);

-- 期限规则：每个原因编码对应的默认确认时限（小时）
CREATE TABLE deadline_rules (
  reason_code    text PRIMARY KEY,
  ack_due_hours  integer NOT NULL CHECK (ack_due_hours > 0)
);

-- 规则集快照（来自 fixtures/rules.json，启动时确定性载入）
CREATE TABLE rule_sets (
  rule_set_id bigserial PRIMARY KEY,
  source      text NOT NULL,
  version     text NOT NULL,
  payload     jsonb NOT NULL,
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, version)
);

-- 召回任务
CREATE TABLE recall_tasks (
  task_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id    text NOT NULL UNIQUE,            -- 发布幂等键
  brand_id           text NOT NULL REFERENCES brands (brand_id),
  lot_code           text NOT NULL,                   -- 召回批次号
  lot_version        integer NOT NULL CHECK (lot_version >= 1),  -- 批次版本（aggregate_revision）
  reason_code        text NOT NULL,
  template_code      text NOT NULL,
  template_version   integer NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  actor_role         text NOT NULL,
  published_at       timestamptz NOT NULL,            -- 事件时间（occurred_at）
  deadline_at        timestamptz NOT NULL,            -- 确认期限
  total_notices      integer NOT NULL DEFAULT 0,      -- 以下计数与 recall_notices 同事务维护
  acknowledged_count integer NOT NULL DEFAULT 0,
  exempted_count     integer NOT NULL DEFAULT 0,
  closed_at          timestamptz,
  close_note         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, lot_code, lot_version)            -- 同一批次版本只存在一个任务
);
CREATE INDEX recall_tasks_brand_idx ON recall_tasks (brand_id, status);

-- 门店通知（每个任务 × 门店一行）
CREATE TABLE recall_notices (
  notice_id       bigserial PRIMARY KEY,
  task_id         uuid NOT NULL REFERENCES recall_tasks (task_id),
  store_id        bigint NOT NULL REFERENCES stores (store_id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'exempted')),
  notified_at     timestamptz NOT NULL,
  acknowledged_at timestamptz,
  late            boolean NOT NULL DEFAULT false,     -- 回执时间晚于期限
  UNIQUE (task_id, store_id)
);
CREATE INDEX recall_notices_task_idx ON recall_notices (task_id, status);
CREATE INDEX recall_notices_store_idx ON recall_notices (store_id);

-- 确认回执（门店确认历史，含迟到标记）
CREATE TABLE receipts (
  receipt_id      bigserial PRIMARY KEY,
  source_event_id text NOT NULL UNIQUE,               -- 回执幂等键
  notice_id       bigint NOT NULL REFERENCES recall_notices (notice_id),
  task_id         uuid NOT NULL REFERENCES recall_tasks (task_id),
  store_id        bigint NOT NULL REFERENCES stores (store_id),
  received_at     timestamptz NOT NULL,               -- 门店回执时间
  recorded_at     timestamptz NOT NULL DEFAULT now(), -- 服务端落库时间
  channel         text NOT NULL DEFAULT 'unspecified',
  note            text,
  result          text NOT NULL CHECK (result IN ('accepted', 'late'))
);
CREATE INDEX receipts_store_idx ON receipts (store_id, recorded_at DESC, receipt_id DESC);
CREATE INDEX receipts_task_idx ON receipts (task_id);

-- 豁免申请与审核
CREATE TABLE exemptions (
  exemption_id    bigserial PRIMARY KEY,
  source_event_id text NOT NULL UNIQUE,               -- 申请幂等键
  task_id         uuid NOT NULL REFERENCES recall_tasks (task_id),
  store_id        bigint NOT NULL REFERENCES stores (store_id),
  reason_code     text NOT NULL,
  reason_text     text NOT NULL,
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  applied_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,
  UNIQUE (task_id, store_id)                          -- 每门店每任务仅一条豁免申请
);
CREATE INDEX exemptions_task_idx ON exemptions (task_id, status);

-- 覆盖率快照（发布/回执/豁免/关闭时同事务写入，重启后仍有效）
CREATE TABLE coverage_snapshots (
  snapshot_id    bigserial PRIMARY KEY,
  task_id        uuid NOT NULL REFERENCES recall_tasks (task_id),
  trigger        text NOT NULL CHECK (trigger IN ('publish', 'receipt', 'exemption', 'close')),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  total          integer NOT NULL,
  acknowledged   integer NOT NULL,
  exempted       integer NOT NULL,
  pending        integer NOT NULL,
  overdue        integer NOT NULL,
  coverage_rate  numeric(6, 4) NOT NULL
);
CREATE INDEX coverage_snapshots_task_idx ON coverage_snapshots (task_id, snapshot_id);
