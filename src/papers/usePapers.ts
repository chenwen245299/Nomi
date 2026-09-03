import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge as apiAddEdge,
  createPaper as apiCreatePaper,
  deleteEdge as apiDeleteEdge,
  deletePaper as apiDeletePaper,
  loadGraph,
  movePaper as apiMovePaper,
  saveBody as apiSaveBody,
  updateEdge as apiUpdateEdge,
  updatePaper as apiUpdatePaper,
  type Paper,
  type PaperEdge,
  type PaperEdgeSide,
  type PaperInput,
} from "./api";

/**
 * Shared, tab-agnostic store for the papers section: the whole relationship graph
 * (paper nodes + directed edges) plus the mutations that keep it in sync. The
 * selected paper lives in the tab state up in App. Node positions are updated
 * optimistically on drag and persisted on drop.
 */
export interface PapersData {
  loading: boolean;
  error: string | null;
  papers: Paper[];
  edges: PaperEdge[];
  reload: () => Promise<void>;
  findPaper: (id: string | null) => Paper | undefined;
  createPaper: (input: PaperInput) => Promise<Paper | null>;
  updatePaper: (id: string, input: PaperInput) => Promise<Paper | null>;
  /** Optimistically move a node (no persistence — call on every drag frame). */
  moveLocal: (id: string, x: number, y: number) => void;
  /** Persist a node's final dragged position (call on drop). */
  commitMove: (id: string, x: number, y: number) => Promise<void>;
  deletePaper: (id: string) => Promise<void>;
  saveBody: (id: string, content: string) => Promise<void>;
  addEdge: (
    from: string,
    to: string,
    label?: string,
    fromSide?: PaperEdgeSide,
    toSide?: PaperEdgeSide,
  ) => Promise<PaperEdge | null>;
  updateEdge: (id: string, label: string) => Promise<void>;
  deleteEdge: (id: string) => Promise<void>;
  dismissError: () => void;
}

export function usePapers(enabled: boolean): PapersData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [edges, setEdges] = useState<PaperEdge[]>([]);
  const loadedRef = useRef(false);

  const fail = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [],
  );

  const reload = useCallback(async () => {
    try {
      const graph = await loadGraph();
      setPapers(graph.papers);
      setEdges(graph.edges);
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    void reload();
  }, [enabled, reload]);

  const findPaper = useCallback(
    (id: string | null) => (id ? papers.find((paper) => paper.id === id) : undefined),
    [papers],
  );

  const createPaper = useCallback(
    async (input: PaperInput) => {
      try {
        const paper = await apiCreatePaper(input);
        setPapers((prev) => [...prev, paper]);
        return paper;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const updatePaper = useCallback(
    async (id: string, input: PaperInput) => {
      try {
        const paper = await apiUpdatePaper(id, input);
        setPapers((prev) => prev.map((item) => (item.id === id ? paper : item)));
        return paper;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const moveLocal = useCallback((id: string, x: number, y: number) => {
    setPapers((prev) => prev.map((item) => (item.id === id ? { ...item, x, y } : item)));
  }, []);

  const commitMove = useCallback(
    async (id: string, x: number, y: number) => {
      setPapers((prev) => prev.map((item) => (item.id === id ? { ...item, x, y } : item)));
      try {
        await apiMovePaper(id, x, y);
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const deletePaper = useCallback(
    async (id: string) => {
      try {
        await apiDeletePaper(id);
        setPapers((prev) => prev.filter((item) => item.id !== id));
        setEdges((prev) => prev.filter((edge) => edge.from !== id && edge.to !== id));
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const saveBody = useCallback(async (id: string, content: string) => {
    await apiSaveBody(id, content);
    setPapers((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, updatedAt: Math.floor(Date.now() / 1000) } : item,
      ),
    );
  }, []);

  const addEdge = useCallback(
    async (
      from: string,
      to: string,
      label = "",
      fromSide?: PaperEdgeSide,
      toSide?: PaperEdgeSide,
    ) => {
      try {
        const edge = await apiAddEdge(from, to, label, fromSide, toSide);
        setEdges((prev) => (prev.some((e) => e.id === edge.id) ? prev : [...prev, edge]));
        return edge;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const updateEdge = useCallback(
    async (id: string, label: string) => {
      setEdges((prev) => prev.map((edge) => (edge.id === id ? { ...edge, label } : edge)));
      try {
        await apiUpdateEdge(id, label);
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const deleteEdge = useCallback(
    async (id: string) => {
      try {
        await apiDeleteEdge(id);
        setEdges((prev) => prev.filter((edge) => edge.id !== id));
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const dismissError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      loading,
      error,
      papers,
      edges,
      reload,
      findPaper,
      createPaper,
      updatePaper,
      moveLocal,
      commitMove,
      deletePaper,
      saveBody,
      addEdge,
      updateEdge,
      deleteEdge,
      dismissError,
    }),
    [
      loading,
      error,
      papers,
      edges,
      reload,
      findPaper,
      createPaper,
      updatePaper,
      moveLocal,
      commitMove,
      deletePaper,
      saveBody,
      addEdge,
      updateEdge,
      deleteEdge,
      dismissError,
    ],
  );
}
