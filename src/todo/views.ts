import type { Quadrant, Todo } from "./api";
import { dateKey, dayHeading, fullDateLabel, shiftKey } from "./dates";
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

function completedOn(todo: Todo, day: string): boolean {
  return (
    todo.done && todo.completedAt !== null && dateKey(new Date(todo.completedAt * 1000)) === day
  );
}

/**
 * Whether a todo belongs to `scope`. The dated scopes reach backwards without a
 * bound — an overdue task keeps showing up in 今天 until it is dealt with, which
 * is the whole point of a due date — and also keep whatever was finished today,
 * so the day's list still shows the work that got done.
 */
export function inScope(todo: Todo, scope: TodoScope, today: string): boolean {
  switch (scope) {
    case "today":
      return (todo.dueDate !== null && todo.dueDate <= today) || completedOn(todo, today);
    case "week":
      return (
        (todo.dueDate !== null && todo.dueDate <= shiftKey(today, 6)) || completedOn(todo, today)
      );
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

/** Board order inside one quadrant: unfinished first, then the manual order. */
export function sortForBoard(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.order - b.order || a.createdAt - b.createdAt,
  );
}

/**
 * List order: unfinished first, then by due date (undated last), then by
 * quadrant so the most important work floats to the top of an equal day.
 */
export function sortForList(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") ||
      a.quadrant - b.quadrant ||
      a.order - b.order,
  );
}

export interface TodoGroup {
  key: string;
  /** Section heading; empty for scopes that render one unlabelled section. */
  title: string;
  todos: Todo[];
}

function group(key: string, title: string, todos: Todo[]): TodoGroup[] {
  return todos.length > 0 ? [{ key, title, todos: sortForList(todos) }] : [];
}

/**
 * Split a scope's todos into the sections the list layout renders. Sections are
 * ordered by urgency (overdue first) and each is internally sorted by
 * `sortForList`, so finished items sink to the bottom of their own section.
 */
export function groupForList(todos: Todo[], scope: TodoScope, today: string): TodoGroup[] {
  const overdue = todos.filter(
    (todo) => !todo.done && todo.dueDate !== null && todo.dueDate < today,
  );
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
    return [...group("overdue", "已逾期", overdue), ...group("today", "今天", rest)];
  }

  if (scope === "week") {
    const byDay = new Map<string, Todo[]>();
    const undated: Todo[] = [];
    for (const todo of rest) {
      // A task finished today with no due date still belongs to today's list.
      const day = todo.dueDate ?? (completedOn(todo, today) ? today : null);
      if (day === null) {
        undated.push(todo);
        continue;
      }
      byDay.set(day, [...(byDay.get(day) ?? []), todo]);
    }
    return [
      ...group("overdue", "已逾期", overdue),
      ...[...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, items]) => ({
          key: day,
          title: dayHeading(day, today),
          todos: sortForList(items),
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
        rest.filter((todo) => todo.dueDate === today),
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

  // A single quadrant keeps the manual board order — that ordering is the user's
  // own ranking of the quadrant, and re-sorting it here would throw it away.
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
