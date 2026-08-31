import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  moveNode,
  notesTree,
  renameFolder,
  renameNote,
  type NoteNode,
} from "./api";

/** Walk the tree depth-first, yielding every node. */
function* walk(nodes: NoteNode[]): Generator<NoteNode> {
  for (const node of nodes) {
    yield node;
    if (node.children) {
      yield* walk(node.children);
    }
  }
}

/**
 * Shared, tab-agnostic store for the notes section: the folder/note tree plus the
 * mutations that keep it in sync. Selection lives in the tab state up in App.
 * Every mutation refreshes from disk so all open tabs see current data.
 */
export interface NotesData {
  tree: NoteNode[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  findNode: (path: string | null) => NoteNode | null;
  createNote: (parent: string) => Promise<NoteNode | null>;
  createFolder: (parent: string) => Promise<NoteNode | null>;
  renameNode: (node: NoteNode, name: string) => Promise<NoteNode | null>;
  deleteNode: (node: NoteNode) => Promise<void>;
  moveNode: (path: string, newParent: string) => Promise<NoteNode | null>;
}

export function useNotes(active: boolean): NotesData {
  const [tree, setTree] = useState<NoteNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTree(await notesTree());
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

  const findNode = useCallback(
    (path: string | null) => {
      if (!path) {
        return null;
      }
      for (const node of walk(tree)) {
        if (node.path === path) {
          return node;
        }
      }
      return null;
    },
    [tree],
  );

  const doCreateNote = useCallback(
    async (parent: string) => {
      try {
        const created = await createNote(parent, "未命名笔记");
        await refresh();
        return created;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [refresh],
  );

  const doCreateFolder = useCallback(
    async (parent: string) => {
      try {
        const created = await createFolder(parent, "新建文件夹");
        await refresh();
        return created;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [refresh],
  );

  const renameNode = useCallback(
    async (node: NoteNode, name: string) => {
      try {
        const updated =
          node.kind === "note"
            ? await renameNote(node.path, name)
            : await renameFolder(node.path, name);
        await refresh();
        return updated;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [refresh],
  );

  const deleteNode = useCallback(
    async (node: NoteNode) => {
      try {
        if (node.kind === "note") {
          await deleteNote(node.path);
        } else {
          await deleteFolder(node.path);
        }
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const doMoveNode = useCallback(
    async (path: string, newParent: string) => {
      try {
        const moved = await moveNode(path, newParent);
        await refresh();
        return moved;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [refresh],
  );

  return useMemo(
    () => ({
      tree,
      loading,
      error,
      refresh,
      findNode,
      createNote: doCreateNote,
      createFolder: doCreateFolder,
      renameNode,
      deleteNode,
      moveNode: doMoveNode,
    }),
    [
      tree,
      loading,
      error,
      refresh,
      findNode,
      doCreateNote,
      doCreateFolder,
      renameNode,
      deleteNode,
      doMoveNode,
    ],
  );
}
