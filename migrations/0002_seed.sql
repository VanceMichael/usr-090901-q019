-- 0002_seed.sql — 确定性种子数据：品牌、门店目录、通知模板、期限规则、豁免理由编码
-- 该数据代表"仓库提供的门店目录 / 通知模板 / 期限规则"，不依赖任何外部系统。
-- 注意：迁移执行器已将每个文件包裹在单事务中，请勿在此使用 BEGIN/COMMIT。

INSERT INTO brands (brand_id, name) VALUES
  ('brand-aurora', 'Aurora 化妆品'),
  ('brand-vela',   'Vela 个护');

INSERT INTO stores (store_code, brand_id, name, region, active) VALUES
  ('store-a01', 'brand-aurora', '极光·上海静安店', 'east',  true),
  ('store-a02', 'brand-aurora', '极光·上海浦东店', 'east',  true),
  ('store-a03', 'brand-aurora', '极光·北京朝阳店', 'north', true),
  ('store-a04', 'brand-aurora', '极光·广州天河店', 'south', true),
  ('store-a05', 'brand-aurora', '极光·深圳南山店', 'south', true),
  ('store-a06', 'brand-aurora', '极光·成都锦江店', 'west',  true),
  ('store-a07', 'brand-aurora', '极光·杭州西湖店', 'east',  true),
  ('store-a08', 'brand-aurora', '极光·武汉江汉店', 'central', false),
  ('store-v01', 'brand-vela',   '薇拉·上海徐汇店', 'east',  true),
  ('store-v02', 'brand-vela',   '薇拉·北京海淀店', 'north', true),
  ('store-v03', 'brand-vela',   '薇拉·广州越秀店', 'south', true),
  ('store-v04', 'brand-vela',   '薇拉·重庆渝中店', 'west',  true);

-- 通知模板：与 fixtures/rules.json 的 reason_codes 对齐
INSERT INTO notice_templates (template_code, version, reason_code, title, body) VALUES
  ('tmpl-cosmetic-recall', 1, 'COSMETIC_RECALL',
   '疑似制假化妆品批次召回通知',
   '监管人员已查封疑似制假场所。请门店立即下架并封存批次 {{lot_code}}（版本 {{lot_version}}）全部在售与库存商品，于 {{deadline_at}} 前完成确认回执。'),
  ('tmpl-distribution-graph', 1, 'DISTRIBUTION_GRAPH',
   '批次流向核查通知',
   '批次 {{lot_code}} 涉及流向核查。请门店核对进销存记录并于 {{deadline_at}} 前确认。'),
  ('tmpl-revisioned-report', 1, 'REVISIONED_REPORT',
   '批次报告修订通知',
   '批次 {{lot_code}} 的检验报告已修订（版本 {{lot_version}}）。请门店重新确认处置状态并于 {{deadline_at}} 前回执。');

-- 期限规则：默认确认时限（小时），发布未显式指定 deadline_at 时使用
INSERT INTO deadline_rules (reason_code, ack_due_hours) VALUES
  ('COSMETIC_RECALL', 72),
  ('DISTRIBUTION_GRAPH', 120),
  ('REVISIONED_REPORT', 48);

-- 豁免理由编码（申请时校验，区别于召回原因编码）
CREATE TABLE exemption_reason_codes (
  code        text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO exemption_reason_codes (code, description) VALUES
  ('NO_STOCK_OF_LOT',  '门店从未购进该批次商品'),
  ('ALREADY_RETURNED', '该批次商品已在发布前退回仓库'),
  ('STORE_CLOSED',     '门店已停业，无在售库存'),
  ('IN_TRANSIT_ONLY',  '商品仅在途未入库，由仓库直接处置');
