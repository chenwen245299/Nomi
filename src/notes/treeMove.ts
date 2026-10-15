import type { NoteNode } from "./api";

export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** A drop into the current parent is a no-op; folders cannot contain themselves. */
export function canMoveNode(node: NoteNode, parent: string): boolean {
  return (
    parentOf(node.path) !== parent &&
    (node.kind !== "folder" || (parent !== node.path && !parent.startsWith(`${node.path}/`)))
  );
}

/** Keep expanded descendants attached to a folder after it is renamed or moved. */
export function remapExpanded(paths: Set<string>, from: string, to: string): Set<string> {
  return new Set(
    [...paths].map((path) =>
      path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path,
    ),
  );
}
