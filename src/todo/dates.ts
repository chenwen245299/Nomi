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

// ── Multi-day spans ──────────────────────────────────────────────────────────

/** Every day a span covers, inclusive. `end` null means the single start day. */
export function spanDays(start: string, end: string | null): string[] {
  if (end === null || end <= start) {
    return [start];
  }
  const days: string[] = [];
  // Bounded so a corrupt end date far in the future can't spin the UI forever.
  for (let day = start, i = 0; day <= end && i < 400; day = shiftKey(day, 1), i++) {
    days.push(day);
  }
  return days;
}

/** Whether `day` falls inside the span, inclusive at both ends. */
export function spanCovers(start: string, end: string | null, day: string): boolean {
  return day >= start && day <= (end ?? start);
}

/** Like `dueLabel`, but never says "逾期". A past day is only late when nothing
 *  follows it; as the START of a running span it is just when the task began. */
export function dayLabel(key: string, today: string): string {
  const delta = daysBetween(today, key);
  if (delta === 0) return "今天";
  if (delta === 1) return "明天";
  if (delta === -1) return "昨天";
  if (delta > 1 && delta < 7) return weekdayLabel(key);
  return calendarLabel(key, today);
}

/** Chip text for a span: "今天 → 周四", "8月30日 → 9月2日". Single days fall
 *  back to the plain `dueLabel`.
 *
 *  Only the END carries the overdue wording. A task running 8月31日 → 今天 is on
 *  schedule, and labelling its start "逾期 3 天" read as though it were late. */
export function spanLabel(start: string, end: string | null, today: string): string {
  if (end === null) {
    return dueLabel(start, today);
  }
  return `${dayLabel(start, today)} → ${dueLabel(end, today)}`;
}

/** "第 2/4 天" for a span in progress, else null. Tells you where you are in a
 *  task that runs over several days, which the date range alone does not. */
export function spanProgress(start: string, end: string | null, today: string): string | null {
  if (end === null || today < start || today > end) {
    return null;
  }
  return `第 ${daysBetween(start, today) + 1}/${daysBetween(start, end) + 1} 天`;
}
