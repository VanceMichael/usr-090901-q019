# 化妆品疑似制假批次召回协同服务

监管人员查封疑似化妆品制假场所后，品牌方通过本服务跟踪**每个召回批次的通知覆盖率与门店确认进度**。纯后台 HTTP 服务：接收召回任务发布、门店确认回执、豁免申请与任务关闭请求，按门店生成 `pending / acknowledged / exempted / overdue` 状态，并汇总批次覆盖率、未确认清单与逾期天数。不调用任何外部电商或检测系统。

技术栈：Node.js 22 · TypeScript · PostgreSQL 17 · Docker Compose

## 快速开始

```sh
# 一键容器验收（构建 → 健康检查 → 黑盒测试 → 真实重启 → 重启恢复校验）
bash scripts/acceptance.sh

# 本地开发：启动依赖后跑服务
docker compose up -d postgres
DATABASE_URL=postgres://app:local-dev-only@localhost:5432/app npm run build && npm start

# 本地测试（无 DATABASE_URL 时自动引导 embedded-postgres）
npm test

# 校验 scaffold 基线输入
docker compose run --rm --no-deps scaffold-check
```

服务启动时自动执行 `migrations/` 中的迁移（含门店目录、通知模板、期限规则等确定性种子数据），并将 `fixtures/rules.json` 规则集幂等载入 `rule_sets` 表。

## API 一览（前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/recall-tasks` | 发布召回任务（幂等：重复发布返回原任务） |
| POST | `/recall-tasks/:taskId/receipts:batch` | 批量门店回执（错误按输入索引隔离） |
| POST | `/recall-tasks/:taskId/exemptions` | 门店豁免申请 |
| POST | `/exemptions/:exemptionId/review` | 豁免审核（approve / reject） |
| POST | `/recall-tasks/:taskId/close` | 关闭召回任务（幂等） |
| GET | `/brands/:brandId/recall-progress` | 按品牌查看召回进度（覆盖率 + 未确认清单） |
| GET | `/recall-tasks/:taskId` | 任务详情（每门店状态、快照、计数交叉校验） |
| GET | `/stores/:storeCode/receipts` | 单门店回执/豁免历史（游标分页） |
| GET | `/todos` | 按期限分页的待办（`brand_id` / `status` / `due_before` / `cursor` / `limit`） |
| GET | `/notice-templates` | 模板与规则查询（`?reason_code=` 过滤） |
| GET | `/healthz` `/readyz` | 存活 / 就绪探针 |

### 发布召回任务

```json
POST /api/v1/recall-tasks
{
  "source_event_id": "recall-2026-0908-01",   // 幂等键
  "brand_id": "brand-aurora",
  "lot_code": "lot-C9",
  "lot_version": 1,                            // 批次版本（aggregate_revision）
  "reason_code": "COSMETIC_RECALL",            // 须在 fixtures/rules.json 规则集中
  "actor_role": "regulator",
  "occurred_at": "2026-09-08T02:17:00Z",
  "deadline_at": "2026-09-11T02:17:00Z",       // 可选；缺省按期限规则推导（COSMETIC_RECALL=72h）
  "store_codes": ["store-a01", "store-a02"]    // 可选；缺省为品牌全部在营门店
}
```

- 重复发布（同一 `source_event_id`，或同一 `(brand_id, lot_code, lot_version)`）→ `200` 且 `deduplicated: true`，返回原任务；
- 低于现有版本的旧批次 → `409 stale_lot_version`；更高版本 → 创建新任务；
- 门店归属校验：跨品牌/不存在/已停用门店 → `422 invalid_store_list`（逐项列出错误）；
- 任务 + 通知 + 计数 + 覆盖率快照在**同一 PostgreSQL 事务**提交。

### 批量门店回执

```json
POST /api/v1/recall-tasks/:taskId/receipts:batch
{
  "actor_role": "warehouse",
  "receipts": [
    {"source_event_id": "rcpt-1", "store_code": "store-a01", "received_at": "2026-09-09T01:00:00Z"},
    {"source_event_id": "rcpt-2", "store_code": "store-ghost", "received_at": "2026-09-09T01:00:00Z"}
  ]
}
```

每条回执独立事务处理，错误按输入索引隔离，互不影响：

```json
{
  "summary": {"total": 2, "accepted": 1, "duplicates": 0, "errors": 1},
  "results": [
    {"index": 0, "status": "accepted", "receipt_id": 101, "late": false},
    {"index": 1, "status": "error", "code": "unknown_store", "message": "门店 store-ghost 不存在"}
  ]
}
```

校验规则：门店存在且归属该品牌、在任务通知范围内、任务未关闭、`received_at` 不早于发布时刻且不晚于当前时间（允许 5 分钟时钟偏移）。`received_at` 晚于期限 → 仍接收但 `late: true`。同一 `source_event_id` 重发 → `duplicate` 返回原回执；同门店换事件重复回执 → `already_acknowledged`。

### 豁免申请与审核

- 申请：`reason_code` 须在豁免理由编码表内（`NO_STOCK_OF_LOT` / `ALREADY_RETURNED` / `STORE_CLOSED` / `IN_TRANSIT_ONLY`），`reason_text` ≥ 10 字；已确认门店不可申请（`409 already_acknowledged`）。
- 审核：`{"decision": "approve"|"reject", "reviewer": "...", "actor_role": "brand_safety"}`；批准后门店状态置为 `exempted` 并计入覆盖率，重复审核返回 `409 exemption_already_reviewed`。

### 状态与覆盖率

- 门店状态：`pending`（待确认）、`acknowledged`（已确认，可带 `late`）、`exempted`（已豁免）、`overdue`（待确认且已过期限，由期限实时推导）。
- 覆盖率 = `(acknowledged + exempted) / total`，保留 4 位小数；未确认清单 = 仍处于 pending 的门店；逾期天数按期限向上取整（逾期即 ≥1 天）。
- 每次发布/回执/豁免/关闭都在事务内写入 `coverage_snapshots`；任务详情同时返回计数器值与明细实算值（`live_counts`）供一致性核对。

## 可靠性设计

- **幂等**：发布/回执/豁免/关闭均以 `source_event_id` 或业务唯一键去重，重复请求返回原记录；并发重复发布由唯一约束兜底。
- **事务一致**：任务行上的计数器与通知明细在同一事务更新；快照在同事务生成，重启后仍有效。
- **重启恢复**：全部状态存于 PostgreSQL；分页游标为无状态键集（base64url 编码的 `(deadline_at, notice_id)`），重启后继续有效。`scripts/acceptance.sh` 会真实重启 app 容器做两阶段校验。
- **优雅停机**：SIGTERM/SIGINT 触发连接排空（10s 上限）。

## 目录结构

```
contracts/            请求契约（scaffold 输入，不修改）
fixtures/             规则集与样例（scaffold 输入，不修改）
migrations/           SQL 迁移（schema + 确定性种子数据）
src/                  服务源码（路由/校验/事务逻辑/查询）
test/                 单元 + 集成 + 重启恢复测试
scripts/acceptance.sh 一键容器验收
```

## 测试与验收

- `npm test`：单元（覆盖率/游标/状态推导）+ 集成（重复发布、迟到回执、豁免审核、覆盖率计算、混合批错误隔离、计数一致性、分页、历史、模板查询、进程内重启恢复）。无 `DATABASE_URL` 时自动引导 embedded-postgres；设置 `APP_BASE_URL` 则切换为纯黑盒模式。
- `bash scripts/acceptance.sh`：容器化一键验收——构建镜像、Compose 健康检查、黑盒跑全部用例、**真实重启 app 容器**后校验快照与游标恢复。
