/**
 * 覆盖率与逾期天数的纯函数，便于单元测试。
 * 覆盖率 = (已确认 + 已豁免) / 通知总数，保留 4 位小数。
 */
export interface CoverageInput {
  total: number;
  acknowledged: number;
  exempted: number;
  /** 当前仍处于 pending 且已逾期的数量 */
  overdue: number;
}

export interface Coverage {
  total: number;
  acknowledged: number;
  exempted: number;
  pending: number;
  overdue: number;
  coverage_rate: number;
}

export function computeCoverage(input: CoverageInput): Coverage {
  const pending = input.total - input.acknowledged - input.exempted;
  const rate =
    input.total === 0
      ? 0
      : Math.round(((input.acknowledged + input.exempted) / input.total) * 10000) / 10000;
  return {
    total: input.total,
    acknowledged: input.acknowledged,
    exempted: input.exempted,
    pending,
    overdue: input.overdue,
    coverage_rate: rate,
  };
}

const DAY_MS = 86_400_000;

/** 逾期天数：超过期限即计 1 天（向上取整），未逾期为 0 */
export function overdueDays(deadline: Date, now: Date): number {
  const diff = now.getTime() - deadline.getTime();
  return diff <= 0 ? 0 : Math.ceil(diff / DAY_MS);
}

/** 门店维度状态：pending 且已过期限 => overdue */
export type NoticeStatus = "pending" | "acknowledged" | "exempted" | "overdue";

export function effectiveStatus(
  stored: "pending" | "acknowledged" | "exempted",
  deadline: Date,
  now: Date,
): NoticeStatus {
  if (stored === "pending" && now.getTime() > deadline.getTime()) return "overdue";
  return stored;
}
