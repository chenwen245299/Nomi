// A tiny registry that lets tree actions (rename / move) persist an open note's
// editor to disk BEFORE they move its file. Without this, debounced edits would be
// flushed to the OLD path after the rename and rejected by the backend's
// anti-resurrection guard — silently losing the user's latest keystrokes.

const registry = new Map<string, () => Promise<void>>();

/** Register `flush` for `path`; returns an unregister function. */
export function registerNoteFlush(path: string, flush: () => Promise<void>): () => void {
  registry.set(path, flush);
  return () => {
    if (registry.get(path) === flush) {
      registry.delete(path);
    }
  };
}

/**
 * Flush the open editor for `path` and any open notes nested under it (so folder
 * renames/moves are covered too). Resolves once every affected save has settled.
 */
export async function flushNotesUnder(path: string): Promise<void> {
  const prefix = `${path}/`;
  const pending: Array<Promise<void>> = [];
  for (const [notePath, flush] of registry) {
    if (notePath === path || notePath.startsWith(prefix)) {
      pending.push(flush());
    }
  }
  await Promise.all(pending);
}
