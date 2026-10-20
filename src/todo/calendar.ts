import type { Todo } from "./api";
import { dateKey, shiftKey, spanCovers } from "./dates.ts";

export type CalendarMode = "month" | "week" | "day";
export const HOUR_HEIGHT = 72;
export const MIN_EVENT_MINUTES = 40;

export function weekDays(day: string): string[] {
  const date = new Date(`${day}T12:00:00`);
  const first = shiftKey(day, -((date.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftKey(first, index));
}

/** A stable six-row grid, starting on Monday, including adjacent months. */
export function monthDays(day: string): string[] {
  const first = weekDays(`${day.slice(0, 7)}-01`)[0];
  return Array.from({ length: 42 }, (_, index) => shiftKey(first, index));
}

/** Preserve the selected day where possible, including leap years and December. */
export function shiftMonth(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const target = new Date(year, month - 1 + delta, 1, 12);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date, last));
  return dateKey(target);
}

export function todosOnDay(todos: Todo[], day: string): Todo[] {
  return todos.filter((todo) => todo.dueDate && spanCovers(todo.dueDate, todo.endDate, day));
}

function minutes(clock: string | null): number | null {
  if (!clock || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) return null;
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

export interface CalendarTime {
  start: number;
  end: number;
  label: string;
  invalid: boolean;
}

/** Times apply on EACH day of a date span, matching the existing 当天 editor.
 * A lone start/end is a point, not an invented one-hour appointment. */
export function calendarTime(todo: Todo): CalendarTime | null {
  const start = minutes(todo.startTime);
  const end = minutes(todo.endTime);
  if (start === null && end === null) return null;
  if (start !== null && end !== null) {
    return {
      start,
      end: Math.max(start, end),
      label: `${todo.startTime}–${todo.endTime}`,
      invalid: end < start,
    };
  }
  return {
    start: (start ?? end)!,
    end: (start ?? end)!,
    label: start !== null ? `${todo.startTime} 开始` : `截至 ${todo.endTime}`,
    invalid: false,
  };
}

export interface CalendarEvent {
  todo: Todo;
  time: CalendarTime;
  column: number;
  columns: number;
}

/** Give overlapping events separate columns, including transitive collisions.
 * The minimum visual height participates in packing so short tasks stay clickable. */
export function layoutDay(todos: Todo[], day: string): CalendarEvent[] {
  const events: CalendarEvent[] = todosOnDay(todos, day)
    .flatMap((todo) => {
      const time = calendarTime(todo);
      return time ? [{ todo, time, column: 0, columns: 1 }] : [];
    })
    .sort(
      (a, b) =>
        a.time.start - b.time.start ||
        b.time.end - a.time.end ||
        a.todo.order - b.todo.order ||
        a.todo.id.localeCompare(b.todo.id),
    );
  let cluster: CalendarEvent[] = [];
  let clusterEnd = -1;
  let columnEnds: number[] = [];
  const finishCluster = () => {
    for (const event of cluster) event.columns = columnEnds.length;
  };
  for (const event of events) {
    if (event.time.start >= clusterEnd) {
      finishCluster();
      cluster = [];
      columnEnds = [];
    }
    const end = Math.max(event.time.end, event.time.start + MIN_EVENT_MINUTES);
    let column = columnEnds.findIndex((until) => until <= event.time.start);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = end;
    event.column = column;
    cluster.push(event);
    clusterEnd = Math.max(...columnEnds);
  }
  finishCluster();
  return events;
}

/** Union of unfinished, fully specified time ranges; overlapping minutes count once. */
export function busyMinutes(todos: Todo[], day: string): number {
  const ranges = todosOnDay(todos, day)
    .filter((todo) => !todo.done)
    .flatMap((todo) => {
      const time = calendarTime(todo);
      return time && time.end > time.start ? [time] : [];
    })
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let until = 0;
  for (const range of ranges) {
    total += Math.max(0, range.end - Math.max(until, range.start));
    until = Math.max(until, range.end);
  }
  return total;
}

export function clockAt(minute: number): string {
  return `${Math.floor(minute / 60)}`.padStart(2, "0") + ":" + `${minute % 60}`.padStart(2, "0");
}
