import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage, effectiveStatus, overdueDays } from "../../src/coverage.js";
import { decodeTodoCursor, encodeTodoCursor, decodeHistoryCursor, encodeHistoryCursor } from "../../src/cursor.js";
import { ApiError } from "../../src/errors.js";

test("覆盖率 = (已确认 + 已豁免) / 总数，保留 4 位小数", () => {
  const c = computeCoverage({ total: 7, acknowledged: 3, exempted: 1, overdue: 2 });
  assert.equal(c.coverage_rate, 0.5714);
  assert.equal(c.pending, 3);
  assert.equal(c.overdue, 2);
});

test("总数为 0 时覆盖率为 0", () => {
  const c = computeCoverage({ total: 0, acknowledged: 0, exempted: 0, overdue: 0 });
  assert.equal(c.coverage_rate, 0);
  assert.equal(c.pending, 0);
});

test("全部确认时覆盖率为 1", () => {
  const c = computeCoverage({ total: 5, acknowledged: 4, exempted: 1, overdue: 0 });
  assert.equal(c.coverage_rate, 1);
  assert.equal(c.pending, 0);
});

test("逾期天数：超过期限即计 1 天，按天向上取整", () => {
  const deadline = new Date("2026-09-10T00:00:00Z");
  assert.equal(overdueDays(deadline, new Date("2026-09-09T23:59:59Z")), 0);
  assert.equal(overdueDays(deadline, new Date("2026-09-10T00:00:00Z")), 0);
  assert.equal(overdueDays(deadline, new Date("2026-09-10T00:00:01Z")), 1);
  assert.equal(overdueDays(deadline, new Date("2026-09-11T00:00:01Z")), 2);
  assert.equal(overdueDays(deadline, new Date("2026-09-12T12:00:00Z")), 3);
});

test("门店状态推导：pending 且过期 => overdue", () => {
  const deadline = new Date("2026-09-10T00:00:00Z");
  const before = new Date("2026-09-09T00:00:00Z");
  const after = new Date("2026-09-11T00:00:00Z");
  assert.equal(effectiveStatus("pending", deadline, before), "pending");
  assert.equal(effectiveStatus("pending", deadline, after), "overdue");
  assert.equal(effectiveStatus("acknowledged", deadline, after), "acknowledged");
  assert.equal(effectiveStatus("exempted", deadline, after), "exempted");
});

test("待办游标编解码往返一致", () => {
  const c = { d: "2026-09-10T00:00:00.000Z", n: 12345 };
  assert.deepEqual(decodeTodoCursor(encodeTodoCursor(c)), c);
});

test("历史游标编解码往返一致", () => {
  const c = { r: "2026-09-10T00:00:00.000Z", i: 999 };
  assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(c)), c);
});

test("非法游标抛出 400 invalid_cursor", () => {
  assert.throws(() => decodeTodoCursor("!!!not-base64!!!"), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, "invalid_cursor");
    return true;
  });
  // base64 合法但内容结构不对
  const bad = Buffer.from(JSON.stringify({ x: 1 }), "utf8").toString("base64url");
  assert.throws(() => decodeTodoCursor(bad), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "invalid_cursor");
    return true;
  });
});
