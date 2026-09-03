import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearDoneTodos,
  createTodo,
  deleteTodo,
  listTodos,
  reorderTodos,
  updateTodo,
  type Quadrant,
  type Todo,
  type TodoPatch,
} from "./api";

/** The canonical order the backend also uses: unfinished first, then manual order. */
function canonical(todos: Todo[]): Todo[] {
  return [...todos].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.order - b.order || a.createdAt - b.createdAt,
  );
}

/**
 * Shared, tab-agnostic store for the todo section: the flat todo list plus the
 * mutations that keep it in sync. Which view a tab is showing lives in the tab
 * state up in App — every view here is a pure grouping of this one list.
 *
 * Mutations apply optimistically so a checkbox never lags the click, then adopt
 * the record the backend wrote (which owns `order`, `updatedAt` and `completedAt`).
 * A failed write reloads from disk rather than leaving the UI ahead of the file.
 */
export interface TodosData {
  todos: Todo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addTodo: (
    title: string,
    quadrant: Quadrant,
    dueDate: string | null,
    endDate?: string | null,
  ) => Promise<Todo | null>;
  patchTodo: (id: string, patch: TodoPatch) => Promise<Todo | null>;
  removeTodo: (id: string) => Promise<void>;
  reorder: (quadrant: Quadrant, ids: string[]) => Promise<void>;
  clearDone: () => Promise<void>;
  dismissError: () => void;
}

export function useTodos(active: boolean): TodosData {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTodos(canonical(await listTodos()));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void refresh();
  }, [active, refresh]);

  const addTodo = useCallback(
    async (
      title: string,
      quadrant: Quadrant,
      dueDate: string | null,
      endDate: string | null = null,
    ) => {
      try {
        const created = await createTodo(title, quadrant, dueDate, endDate);
        setTodos((prev) => canonical([...prev, created]));
        setError(null);
        return created;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [],
  );

  const patchTodo = useCallback(
    async (id: string, patch: TodoPatch) => {
      setTodos((prev) =>
        canonical(prev.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo))),
      );
      try {
        const updated = await updateTodo(id, patch);
        setTodos((prev) => canonical(prev.map((todo) => (todo.id === id ? updated : todo))));
        setError(null);
        return updated;
      } catch (err) {
        setError(String(err));
        await refresh();
        return null;
      }
    },
    [refresh],
  );

  const removeTodo = useCallback(
    async (id: string) => {
      const previous = todos;
      setTodos((prev) => prev.filter((todo) => todo.id !== id));
      try {
        await deleteTodo(id);
        setError(null);
      } catch (err) {
        setError(String(err));
        setTodos(previous);
      }
    },
    [todos],
  );

  const reorder = useCallback(
    async (quadrant: Quadrant, ids: string[]) => {
      // Give the dragged card its new slot right away; the backend renumbers the
      // whole quadrant and hands back the authoritative list.
      setTodos((prev) => {
        const position = new Map(ids.map((id, index) => [id, index]));
        return canonical(
          prev.map((todo) =>
            todo.quadrant === quadrant && position.has(todo.id)
              ? { ...todo, order: position.get(todo.id)! }
              : todo,
          ),
        );
      });
      try {
        setTodos(canonical(await reorderTodos(quadrant, ids)));
        setError(null);
      } catch (err) {
        setError(String(err));
        await refresh();
      }
    },
    [refresh],
  );

  const clearDone = useCallback(async () => {
    try {
      await clearDoneTodos();
      setTodos((prev) => prev.filter((todo) => !todo.done));
      setError(null);
    } catch (err) {
      setError(String(err));
      await refresh();
    }
  }, [refresh]);

  const dismissError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      todos,
      loading,
      error,
      refresh,
      addTodo,
      patchTodo,
      removeTodo,
      reorder,
      clearDone,
      dismissError,
    }),
    [
      todos,
      loading,
      error,
      refresh,
      addTodo,
      patchTodo,
      removeTodo,
      reorder,
      clearDone,
      dismissError,
    ],
  );
}
