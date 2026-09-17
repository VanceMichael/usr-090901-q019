/** Single source of "now" so time-dependent rules stay consistent. */
export const now = (): Date => new Date();

/** Clock-skew tolerance when validating store-reported receipt times. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const DAY_MS = 86_400_000;

/** Whole days `at` is past `deadline` (0 when not overdue). */
export function overdueDays(deadline: Date, at: Date): number {
  return Math.max(0, Math.floor((at.getTime() - deadline.getTime()) / DAY_MS));
}
