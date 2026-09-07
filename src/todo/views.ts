import type { Quadrant, Todo } from "./api";
import { dateKey, dayHeading, fullDateLabel, shiftKey, spanCovers, spanDays } from "./dates";
import { quadrantStyle } from "./palette";

// ── Views ────────────────────────────────────────────────────────────────────
// Two orthogonal choices, both held in the tab state so every tab remembers what
// it was showing:
//
//   scope  — which todos (今天 / 本周 / 全部 / 已完成 / one quadrant), picked in
//            the collection column;
//   layout — how to draw them (四象限看板 / 清单), picked in the main header.
//
// Everything below is a pure function of the one flat todo list, so switching a
// view never touches disk.

export type TodoScope = "today" | "week" | "all" | "done" | "q1" | "q2" | "q3" | "q4";
export type TodoLayout = "board" | "list";

/** The quadrant a `q…` scope pins to, or null for the multi-quadrant scopes. */
export function scopeQuadrant(scope: TodoScope): Quadrant | null {
  switch (scope) {
    case "q1":
      return 1;
    case "q2":
      return 2;
    case "q3":
      return 3;
    case "q4":
      return 4;
    default:
      return null;
  }
}

/** The board only makes sense where more than one quadrant is in play. */
export function scopeSupportsBoard(scope: TodoScope): boolean {
  return scope === "today" || scope === "week" || scope === "all";
}

/** The last day a todo occupies: its end date, or its due date for a single-day
 *  task. Null only when it has no date at all. */
export function lastDay(todo: Todo): string | null {
  return todo.endDate ?? todo.dueDate;
}

/** A dated todo is overdue once the whole span is behind us — a task running
 *  until Friday is not late on Wednesday just because it started Monday. */
export function isOverdue(todo: Todo, today: string): boolean {
  const last = lastDay(todo);
  return !todo.done && last !== null && last < today;
}

/** Whether the todo occupies `day` — true for every day of a multi-day span. */
export function occupiesDay(todo: Todo, day: string): boolean {
  return todo.dueDate !== null && spanCovers(todo.dueDate, todo.endDate, day);
}

function completedOn(todo: Todo, day: string): boolean {
  return (
    todo.done && todo.completedAt !== null && dateKey(new Date(todo.completedAt * 1000)) === day
  );
}

/**
 * Whether a todo belongs to `scope`. Open overdue work remains visible until it
 * is dealt with. A completed task only remains in 今天 / 未来七天 when it was
 * actually completed today; older completed work belongs in 已完成 instead.
 */
export function inScope(todo: Todo, scope: TodoScope, today: string): boolean {
  switch (scope) {
    case "today":
      return todo.done ? completedOn(todo, today) : todo.dueDate !== null && todo.dueDate <= today;
    case "week":
      return todo.done
        ? completedOn(todo, today)
        : todo.dueDate !== null && todo.dueDate <= shiftKey(today, 6);
    case "all":
      return true;
    case "done":
      return todo.done;
    default:
      return todo.quadrant === scopeQuadrant(scope);
  }
}

export function todosInScope(todos: Todo[], scope: TodoScope, today: string): Todo[] {
  return todos.filter((todo) => inScope(todo, scope, today));
}

function clockKey(todo: Todo): string {
  return todo.startTime ?? todo.endTime ?? "99:99";
}

/** Board order inside one quadrant: date first, then the day's 24-hour timeline.
 * Tasks without a time sit after timed tasks on the same date. */
export function sortForBoard(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) =>
      (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") ||
      clockKey(a).localeCompare(clockKey(b)) ||
      Number(a.done) - Number(b.done) ||
      a.order - b.order ||
      a.createdAt - b.createdAt,
  );
}

/**
 * List order: due date and 24-hour timeline first, then completion state and
 * quadrant. Untimed work sits after timed work on the same date.
 */
export function sortForList(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) =>
      (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") ||
      clockKey(a).localeCompare(clockKey(b)) ||
      Number(a.done) - Number(b.done) ||
      a.quadrant - b.quadrant ||
      a.order - b.order,
  );
}

/** Order rows that already share one displayed day by their clock time. */
export function sortForDay(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) =>
      clockKey(a).localeCompare(clockKey(b)) ||
      Number(a.done) - Number(b.done) ||
      a.quadrant - b.quadrant ||
      a.order - b.order ||
      a.createdAt - b.createdAt,
  );
}

export interface TodoGroup {
  key: string;
  /** Section heading; empty for scopes that render one unlabelled section. */
  title: string;
  todos: Todo[];
}

function group(
  key: string,
  title: string,
  todos: Todo[],
  sort: (items: Todo[]) => Todo[] = sortForList,
): TodoGroup[] {
  return todos.length > 0 ? [{ key, title, todos: sort(todos) }] : [];
}

/**
 * Split a scope's todos into the sections the list layout renders. Sections are
 * ordered by urgency (overdue first). Dated day sections follow the 24-hour
 * timeline; broader sections follow date, time, completion state and quadrant.
 */
export function groupForList(todos: Todo[], scope: TodoScope, today: string): TodoGroup[] {
  const overdue = todos.filter((todo) => isOverdue(todo, today));
  const overdueIds = new Set(overdue.map((todo) => todo.id));
  const rest = todos.filter((todo) => !overdueIds.has(todo.id));

  if (scope === "done") {
    const byDay = new Map<string, Todo[]>();
    for (const todo of todos) {
      const day = todo.completedAt ? dateKey(new Date(todo.completedAt * 1000)) : "未记录";
      byDay.set(day, [...(byDay.get(day) ?? []), todo]);
    }
    return [...byDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, items]) => ({
        key: day,
        title: day === "未记录" ? "未记录完成时间" : dayHeading(day, today),
        todos: [...items].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
      }));
  }

  if (scope === "today") {
    return [...group("overdue", "已逾期", overdue), ...group("today", "今天", rest, sortForDay)];
  }

  if (scope === "week") {
    const byDay = new Map<string, Todo[]>();
    const undated: Todo[] = [];
    const last = shiftKey(today, 6);
    for (const todo of rest) {
      // A task finished today with no due date still belongs to today's list.
      const start = todo.dueDate ?? (completedOn(todo, today) ? today : null);
      if (start === null) {
        undated.push(todo);
        continue;
      }
      // A multi-day task is listed under every day it runs, so a week view shows
      // what is actually on your plate each day rather than only the day it
      // started. Days outside the window are clipped, and a span that began in
      // the past shows from today onwards.
      for (const day of spanDays(start, todo.endDate)) {
        if (day < today || day > last) {
          continue;
        }
        byDay.set(day, [...(byDay.get(day) ?? []), todo]);
      }
    }
    return [
      ...group("overdue", "已逾期", overdue),
      ...[...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, items]) => ({
          key: day,
          title: dayHeading(day, today),
          todos: sortForDay(items),
        })),
      ...group("undated", "未安排日期", undated),
    ];
  }

  if (scope === "all") {
    return [
      ...group("overdue", "已逾期", overdue),
      ...group(
        "today",
        "今天",
        rest.filter((todo) => occupiesDay(todo, today)),
        sortForDay,
      ),
      ...group(
        "upcoming",
        "即将到来",
        rest.filter((todo) => todo.dueDate !== null && todo.dueDate > today),
      ),
      ...group(
        "undated",
        "未安排日期",
        rest.filter((todo) => todo.dueDate === null),
      ),
    ];
  }

  // A single quadrant still follows date and clock time; manual order resolves
  // ties between tasks scheduled for the same moment.
  return [{ key: scope, title: "", todos: sortForBoard(todos) }];
}

/** Unfinished counts per scope for the collection column's badges. */
export function scopeCounts(todos: Todo[], today: string): Record<TodoScope, number> {
  const open = todos.filter((todo) => !todo.done);
  return {
    today: open.filter((todo) => todo.dueDate !== null && todo.dueDate <= today).length,
    week: open.filter((todo) => todo.dueDate !== null && todo.dueDate <= shiftKey(today, 6)).length,
    all: open.length,
    done: todos.filter((todo) => todo.done).length,
    q1: open.filter((todo) => todo.quadrant === 1).length,
    q2: open.filter((todo) => todo.quadrant === 2).length,
    q3: open.filter((todo) => todo.quadrant === 3).length,
    q4: open.filter((todo) => todo.quadrant === 4).length,
  };
}

/** Today's progress for the collection footer: finished today / due-or-done today. */
export function todayProgress(todos: Todo[], today: string): { done: number; total: number } {
  const scoped = todos.filter((todo) => inScope(todo, "today", today));
  return { done: scoped.filter((todo) => todo.done).length, total: scoped.length };
}

/** Display name for a scope — the quadrant scopes borrow the quadrant's own name. */
export function scopeLabel(scope: TodoScope): string {
  const quadrant = scopeQuadrant(scope);
  if (quadrant) {
    return quadrantStyle(quadrant).label;
  }
  switch (scope) {
    case "today":
      return "今天";
    case "week":
      return "未来七天";
    case "done":
      return "已完成";
    default:
      return "全部";
  }
}

/** One line under the title explaining what the scope holds. */
export function scopeSubtitle(scope: TodoScope, today: string): string {
  const quadrant = scopeQuadrant(scope);
  if (quadrant) {
    return quadrantStyle(quadrant).hint;
  }
  switch (scope) {
    case "today":
      return fullDateLabel(today);
    case "week":
      return "今天起七天内到期的待办";
    case "done":
      return "已经完成的待办";
    default:
      return "所有待办，包括没有安排日期的";
  }
}
