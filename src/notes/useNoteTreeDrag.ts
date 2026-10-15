import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { NoteNode } from "./api";
import { canMoveNode, parentOf } from "./treeMove";

type DragPreview = { node: NoteNode; parent: string | null; x: number; y: number };
type DragSession = DragPreview & {
  moved: boolean;
  pointerId: number;
  startX: number;
  startY: number;
};

/** Pointer events work in the desktop shell, which intentionally blocks native drags. */
export function useNoteTreeDrag({
  containerRef,
  disabled,
  expand,
  onMove,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  expand: (path: string) => void;
  onMove: (node: NoteNode, parent: string) => Promise<void>;
}) {
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const session = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);
  const expandFolder = useEffectEvent(expand);
  const moveNode = useEffectEvent(onMove);

  useEffect(() => {
    let frame = 0;
    let hoverTimer: number | undefined;
    let hoverPath: string | null = null;
    let restoreBody: (() => void) | null = null;

    const targetAt = (current: DragSession): string | null => {
      const container = containerRef.current;
      const hit = document.elementFromPoint(current.x, current.y);
      if (!container || !hit || !container.contains(hit)) return null;
      let parent: string;
      if (hit.closest("[data-note-drop-root]")) {
        parent = "";
      } else {
        if (!hit.closest("[data-note-tree-scroll]")) return null;
        const row = hit.closest<HTMLElement>("[data-note-tree-row]");
        const path = row?.dataset.noteTreeRow;
        // Dropping on another note means placing it in that note's folder.
        parent = path ? (row?.dataset.noteKind === "folder" ? path : parentOf(path)) : "";
        if (path === current.node.path) return null;
      }
      return canMoveNode(current.node, parent) ? parent : null;
    };

    const updateTarget = (current: DragSession) => {
      current.parent = targetAt(current);
      const { node, parent, x, y } = current;
      setDrag((previous) =>
        previous?.node === node &&
        previous.parent === parent &&
        previous.x === x &&
        previous.y === y
          ? previous
          : { node, parent, x, y },
      );
      document.body.style.cursor = parent === null ? "not-allowed" : "grabbing";
      const folder = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>('[data-note-kind="folder"]');
      const nextHover =
        parent && folder?.dataset.noteTreeRow === parent && folder.dataset.noteExpanded !== "true"
          ? parent
          : null;
      if (nextHover !== hoverPath) {
        window.clearTimeout(hoverTimer);
        hoverPath = nextHover;
        if (nextHover) hoverTimer = window.setTimeout(() => expandFolder(nextHover), 600);
      }
    };

    const tick = () => {
      const current = session.current;
      if (!current?.moved) return;
      const scroll = containerRef.current?.querySelector<HTMLElement>("[data-note-tree-scroll]");
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        if (
          current.x >= bounds.left &&
          current.x <= bounds.right &&
          current.y >= bounds.top &&
          current.y <= bounds.bottom
        ) {
          const edge = 36;
          const speed =
            current.y < bounds.top + edge
              ? -Math.ceil(((bounds.top + edge - current.y) / edge) * 10)
              : current.y > bounds.bottom - edge
                ? Math.ceil(((current.y - bounds.bottom + edge) / edge) * 10)
                : 0;
          if (speed) scroll.scrollTop += speed;
        }
      }
      updateTarget(current);
      frame = window.requestAnimationFrame(tick);
    };

    const finish = () => {
      const current = session.current;
      session.current = null;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(hoverTimer);
      hoverPath = null;
      restoreBody?.();
      restoreBody = null;
      const container = containerRef.current;
      if (current && container?.hasPointerCapture(current.pointerId)) {
        container.releasePointerCapture(current.pointerId);
      }
      setDrag(null);
    };

    const pointerMove = (event: globalThis.PointerEvent) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.moved) {
        if (Math.hypot(current.x - current.startX, current.y - current.startY) < 5) return;
        current.moved = true;
        suppressClick.current = true;
        const cursor = document.body.style.cursor;
        const userSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        restoreBody = () => {
          document.body.style.cursor = cursor;
          document.body.style.userSelect = userSelect;
        };
        try {
          containerRef.current?.setPointerCapture(event.pointerId);
        } catch {
          // Window listeners also work in webviews without pointer capture.
        }
        frame = window.requestAnimationFrame(tick);
      }
      event.preventDefault();
      event.stopPropagation();
      updateTarget(current);
    };

    const pointerUp = (event: globalThis.PointerEvent) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.moved) {
        event.preventDefault();
        event.stopPropagation();
        current.x = event.clientX;
        current.y = event.clientY;
        const parent = targetAt(current);
        finish();
        if (parent !== null) void moveNode(current.node, parent);
      } else {
        finish();
      }
    };

    const pointerCancel = (event: globalThis.PointerEvent) => {
      if (session.current?.pointerId === event.pointerId) finish();
    };
    const cancel = () => {
      if (session.current) finish();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    window.addEventListener("pointermove", pointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("lostpointercapture", pointerCancel, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("lostpointercapture", pointerCancel, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("blur", cancel);
      finish();
    };
  }, [containerRef]);

  return {
    drag,
    onPointerDown: (node: NoteNode, event: PointerEvent<HTMLDivElement>) => {
      suppressClick.current = false;
      if (disabled || !event.isPrimary || event.button !== 0 || event.pointerType === "touch")
        return;
      if (event.target instanceof Element && event.target.closest("input, textarea")) return;
      session.current = {
        node,
        parent: null,
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
      };
    },
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
