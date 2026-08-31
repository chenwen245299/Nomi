// ── Local-calendar date helpers ──────────────────────────────────────────────
// Due dates are stored as bare `YYYY-MM-DD` strings, deliberately without a time
// or zone: "today" means the user's today, wherever they are. Everything here
// works on that string form, so no Date arithmetic can shift a day across a DST
// boundary or a UTC offset.

/** `YYYY-MM-DD` for a local Date (never the UTC-shifted `toISOString`). */
export function dateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `YYYY-MM-DD` for today, in local time. */
export function todayKey(): string {
  return dateKey(new Date());
}

/** `key` shifted by `days` (may be negative), still local. */
export function shiftKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  return dateKey(date);
}

/** Days from `from` to `to` (negative when `to` is in the past). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = new Date(fy, fm - 1, fd).getTime();
  const b = new Date(ty, tm - 1, td).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** The coming Saturday (or today, if today is already Saturday). */
export function weekendKey(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(year, month - 1, day).getDay(); // 0 = 周日
  return shiftKey(today, (6 - weekday + 7) % 7);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function weekdayLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return WEEKDAYS[new Date(year, month - 1, day).getDay()];
}

/** "8月30日", or "2027年1月2日" once the year differs from today's. */
export function calendarLabel(key: string, today: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return sameYear ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

/** Short chip text: 昨天 / 今天 / 明天 / 周四 (within a week) / 8月30日. */
export function dueLabel(key: string, today: string): string {
  const delta = daysBetween(today, key);
  if (delta === 0) return "今天";
  if (delta === 1) return "明天";
  if (delta === -1) return "昨天";
  if (delta > 1 && delta < 7) return weekdayLabel(key);
  if (delta < -1 && delta > -7) return `逾期 ${-delta} 天`;
  return calendarLabel(key, today);
}

/** Section heading for a day: "今天 · 8月28日 周五". */
export function dayHeading(key: string, today: string): string {
  const delta = daysBetween(today, key);
  const prefix = delta === 0 ? "今天" : delta === 1 ? "明天" : weekdayLabel(key);
  return `${prefix} · ${calendarLabel(key, today)}`;
}

/** Long form used by the main header: "2026年8月28日 周五". */
export function fullDateLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return `${year}年${month}月${day}日 ${weekdayLabel(key)}`;
}
