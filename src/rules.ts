import { readFileSync } from "node:fs";
import type { Database } from "./db.js";

export interface RulesFixture {
  version: string;
  theme?: string;
  reason_codes: string[];
  notes?: string;
}

/** 读取并校验 fixtures/rules.json（确定性规则来源，禁止联网获取） */
export function loadRulesFixture(rulesFile: string): RulesFixture {
  const raw = JSON.parse(readFileSync(rulesFile, "utf8")) as RulesFixture;
  if (!raw.version || !Array.isArray(raw.reason_codes) || raw.reason_codes.length === 0) {
    throw new Error(`rules fixture at ${rulesFile} is invalid`);
  }
  return raw;
}

/** 将规则集确定性载入 rule_sets（幂等：source+version 唯一） */
export async function syncRuleSet(db: Database, fixture: RulesFixture): Promise<void> {
  await db.query(
    `INSERT INTO rule_sets (source, version, payload)
     VALUES ('fixtures/rules.json', $1, $2::jsonb)
     ON CONFLICT (source, version) DO NOTHING`,
    [fixture.version, JSON.stringify(fixture)],
  );
}
