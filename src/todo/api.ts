import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

// ── Todo data access ─────────────────────────────────────────────────────────
// Mirrors the notes module's shape: real Tauri commands when running in the app,
// an in-memory fallback so `pnpm dev` renders and works in a plain browser.
// Everything persists to a single `todo/todos.json` under the data folder.

/** Eisenhower cell: 1 重要且紧急 · 2 重要不紧急 · 3 紧急不重要 · 4 不重要不紧急. */
export type Quadrant = 1 | 2 | 3 | 4;

export interface Todo {
  id: string;
  title: string;
  notes: string;
  quadrant: Quadrant;
  /** `YYYY-MM-DD` in the user's local calendar, or null for "someday". */
  dueDate: string | null;
  /** `HH:MM` (24-hour) start / end time on the due date, or null when unset. */
  startTime: string | null;
  endTime: string | null;
  done: boolean;
  /** Epoch seconds, or null while unfinished. */
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Manual sort key inside a quadrant, ascending. */
  order: number;
}

/**
 * Partial update. An absent key leaves the field alone; `dueDate: null` clears
 * the date (the backend tells the two apart, so never send `undefined` values —
 * build the object with only the keys you mean to change).
 */
export interface TodoPatch {
  title?: string;
  notes?: string;
  quadrant?: Quadrant;
  dueDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  done?: boolean;
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const nowSec = () => Math.floor(Date.now() / 1000);

// ── Browser-preview in-memory store ──────────────────────────────────────────
const preview: { todos: Todo[]; seq: number } = { todos: [], seq: 1 };

function previewNextOrder(quadrant: Quadrant): number {
  const orders = preview.todos.filter((t) => t.quadrant === quadrant).map((t) => t.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

/** Canonical order: unfinished first, then the manual order, then creation time. */
function canonical(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.order - b.order || a.createdAt - b.createdAt,
  );
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function listTodos(): Promise<Todo[]> {
  if (isTauri()) {
    return invoke<Todo[]>("todos_list");
  }
  return canonical(preview.todos);
}

export async function createTodo(
  title: string,
  quadrant: Quadrant,
  dueDate: string | null,
): Promise<Todo> {
  if (isTauri()) {
    return invoke<Todo>("create_todo", { title, quadrant, dueDate });
  }
  const trimmed = title.trim().slice(0, 200);
  if (!trimmed) {
    throw new Error("待办内容不能为空。");
  }
  const timestamp = nowSec();
  const todo: Todo = {
    id: `todo-preview-${preview.seq++}`,
    title: trimmed,
    notes: "",
    quadrant,
    dueDate: dueDate || null,
    startTime: null,
    endTime: null,
    done: false,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    order: previewNextOrder(quadrant),
  };
  preview.todos.push(todo);
  return todo;
}

export async function updateTodo(id: string, patch: TodoPatch): Promise<Todo> {
  if (isTauri()) {
    return invoke<Todo>("update_todo", { id, patch });
  }
  const todo = preview.todos.find((item) => item.id === id);
  if (!todo) {
    throw new Error("待办不存在。");
  }
  if (patch.title !== undefined) {
    const trimmed = patch.title.trim().slice(0, 200);
    if (!trimmed) {
      throw new Error("待办内容不能为空。");
    }
    todo.title = trimmed;
  }
  if (patch.notes !== undefined) {
    todo.notes = patch.notes.slice(0, 4000);
  }
  if (patch.quadrant !== undefined && patch.quadrant !== todo.quadrant) {
    todo.order = previewNextOrder(patch.quadrant);
    todo.quadrant = patch.quadrant;
  }
  if (patch.dueDate !== undefined) {
    todo.dueDate = patch.dueDate || null;
  }
  if (patch.startTime !== undefined) {
    todo.startTime = patch.startTime || null;
  }
  if (patch.endTime !== undefined) {
    todo.endTime = patch.endTime || null;
  }
  if (patch.done !== undefined) {
    todo.done = patch.done;
    todo.completedAt = patch.done ? nowSec() : null;
  }
  todo.updatedAt = nowSec();
  return { ...todo };
}

export async function deleteTodo(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_todo", { id });
    return;
  }
  preview.todos = preview.todos.filter((todo) => todo.id !== id);
}

/** Rewrite one quadrant's manual order from the id list the board dragged into shape. */
export async function reorderTodos(quadrant: Quadrant, ids: string[]): Promise<Todo[]> {
  if (isTauri()) {
    return invoke<Todo[]>("reorder_todos", { quadrant, ids });
  }
  let next = 0;
  for (const id of ids) {
    const todo = preview.todos.find((item) => item.id === id && item.quadrant === quadrant);
    if (todo) {
      todo.order = next++;
    }
  }
  for (const todo of preview.todos) {
    if (todo.quadrant === quadrant && !ids.includes(todo.id)) {
      todo.order = next++;
    }
  }
  return canonical(preview.todos);
}

/** Delete every finished todo; resolves to how many were removed. */
export async function clearDoneTodos(): Promise<number> {
  if (isTauri()) {
    return invoke<number>("clear_done_todos");
  }
  const before = preview.todos.length;
  preview.todos = preview.todos.filter((todo) => !todo.done);
  return before - preview.todos.length;
}

/** Reveal `todo/todos.json` in the OS file manager (Finder / Explorer). */
export async function revealTodoData(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const abs = await invoke<string>("todo_reveal_path");
  await revealItemInDir(abs);
}
