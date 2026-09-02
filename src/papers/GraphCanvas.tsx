import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiFocus3Line,
  RiPriceTag3Line,
  RiZoomInLine,
  RiZoomOutLine,
} from "@remixicon/react";
import { useTheme, type Accent } from "../theme";
import type { Paper, PaperEdge } from "./api";
import { STATUS_META, STATUS_ORDER, statusMeta, type PaperStatus } from "./constants";

// A free-form relationship graph for papers. Nodes are draggable cards coloured by
// status; edges are directed links drawn between them. Pan by dragging the canvas,
// zoom with the wheel, and connect two papers by dragging from a node's ▸ handle
// onto another node. Everything is hand-drawn (DOM nodes + one SVG edge overlay)
// so it themes exactly like the rest of the app.

const NODE_W = 190;
const NODE_H = 78; // nominal, for edge border-intersection math
const MIN_K = 0.3;
const MAX_K = 2.4;

interface Transform {
  x: number;
  y: number;
  k: number;
}

type DragMode = "none" | "pan" | "node" | "link";

interface DragSession {
  mode: DragMode;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  nodeId?: string;
  nodeStartX?: number;
  nodeStartY?: number;
  panStart?: Transform;
  fromId?: string;
}

type MenuState =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "edge"; id: string; x: number; y: number }
  | { kind: "canvas"; worldX: number; worldY: number; x: number; y: number };

export interface GraphCanvasProps {
  accent: Accent;
  papers: Paper[];
  edges: PaperEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
  onCreateAt: (x: number, y: number) => void;
  onMoveLocal: (id: string, x: number, y: number) => void;
  onCommitMove: (id: string, x: number, y: number) => void;
  onAddEdge: (from: string, to: string) => void;
  onRenameEdge: (id: string) => void;
  onDeleteEdge: (id: string) => void;
  onDeletePaper: (id: string) => void;
  onSetStatus: (id: string, status: PaperStatus) => void;
  onReveal: (id: string) => void;
}

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Point where the segment from a rect's centre toward `(tx,ty)` crosses the border. */
function borderPoint(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return { x: cx + dx * s, y: cy + dy * s };
}

/**
 * Quadratic-bezier control point for the edge between two card centres, offset
 * perpendicular to the line by a length-proportional amount. A consistent side
 * means edges leaving the same node in similar directions fan apart, and an
 * A→B edge bows opposite to its B→A twin.
 */
function controlPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  k: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(64 * k, len * 0.15);
  return { x: (ax + bx) / 2 + (-dy / len) * bow, y: (ay + by) / 2 + (dx / len) * bow };
}

function fitTransform(papers: Paper[], w: number, h: number): Transform {
  if (w === 0 || h === 0) return { x: 0, y: 0, k: 1 };
  if (papers.length === 0) return { x: w / 2, y: h / 2, k: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of papers) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const padX = NODE_W + 80;
  const padY = NODE_H + 80;
  const bw = maxX - minX + padX;
  const bh = maxY - minY + padY;
  const k = clampK(Math.min(w / bw, h / bh, 1.15));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: w / 2 - k * cx, y: h / 2 - k * cy, k };
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { accent, papers, edges, selectedId } = props;
  const theme = useTheme();
  const { t } = theme;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [linkCursor, setLinkCursor] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const dragRef = useRef<DragSession | null>(null);
  const initializedRef = useRef(false);
  // Manual double-click detection: pointer capture on the viewport retargets the
  // native dblclick to the viewport (not the node), so we time clicks ourselves.
  const lastClickRef = useRef<{ id: string; t: number } | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  // Real (unscaled) node sizes — card height varies, so edges use the measured
  // size to land the arrowhead just outside each card instead of under it.
  const [nodeSizes, setNodeSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  const measureNode = useCallback((id: string, el: HTMLDivElement | null) => {
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setNodeSizes((prev) => {
      const cur = prev.get(id);
      if (cur && cur.w === w && cur.h === h) return prev;
      const next = new Map(prev);
      next.set(id, { w, h });
      return next;
    });
  }, []);
  // Latest render values that stable callbacks (wheel listener, pointer handlers)
  // need to read without re-subscribing / going stale. Updated after every commit
  // in a dep-less effect (never during render).
  const latest = useRef({ papers, edges, transform, size, props });
  useEffect(() => {
    latest.current = { papers, edges, transform, size, props };
  });

  const paperById = useMemo(() => {
    const map = new Map<string, Paper>();
    for (const p of papers) map.set(p.id, p);
    return map;
  }, [papers]);

  const toWorld = useCallback((sx: number, sy: number, tf: Transform) => {
    return { x: (sx - tf.x) / tf.k, y: (sy - tf.y) / tf.k };
  }, []);

  // ── Measure + initial framing (ResizeObserver fires an initial callback, so the
  //    first setState happens off the effect body — no synchronous effect setState).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const next = { w: rect.width, h: rect.height };
      setSize(next);
      if (!initializedRef.current && next.w > 0) {
        initializedRef.current = true;
        setTransform(fitTransform(latest.current.papers, next.w, next.h));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── Wheel zoom (non-passive so we can preventDefault the page scroll).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      setTransform((tf) => {
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const k = clampK(tf.k * factor);
        if (k === tf.k) return tf;
        const wx = (sx - tf.x) / tf.k;
        const wy = (sy - tf.y) / tf.k;
        return { k, x: sx - k * wx, y: sy - k * wy };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const screenPos = useCallback(
    (wx: number, wy: number) => ({
      x: transform.x + transform.k * wx,
      y: transform.y + transform.k * wy,
    }),
    [transform],
  );

  // ── Pointer interaction (delegated at the viewport; capture keeps events flowing).
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const target = event.target as HTMLElement;
    // Floating controls (＋ / zoom / fit / legend) handle their own clicks — don't
    // capture the pointer for them, or the capture steals their click event.
    if (target.closest("button, [data-graph-ui]")) return;
    const handleEl = target.closest("[data-connect-handle]");
    const nodeEl = target.closest("[data-paper-id]") as HTMLElement | null;
    const nodeId = nodeEl?.getAttribute("data-paper-id") ?? undefined;

    setMenu(null);
    el.setPointerCapture(event.pointerId);

    if (handleEl && nodeId) {
      dragRef.current = {
        mode: "link",
        pointerId: event.pointerId,
        startX: sx,
        startY: sy,
        lastX: sx,
        lastY: sy,
        moved: false,
        fromId: nodeId,
      };
      setLinkFrom(nodeId);
      setLinkCursor({ x: sx, y: sy });
      return;
    }

    if (nodeId) {
      const paper = latest.current.papers.find((p) => p.id === nodeId);
      dragRef.current = {
        mode: "node",
        pointerId: event.pointerId,
        startX: sx,
        startY: sy,
        lastX: sx,
        lastY: sy,
        moved: false,
        nodeId,
        nodeStartX: paper?.x ?? 0,
        nodeStartY: paper?.y ?? 0,
      };
      return;
    }

    dragRef.current = {
      mode: "pan",
      pointerId: event.pointerId,
      startX: sx,
      startY: sy,
      lastX: sx,
      lastY: sy,
      moved: false,
      panStart: latest.current.transform,
    };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    if (Math.abs(sx - drag.startX) + Math.abs(sy - drag.startY) > 3) drag.moved = true;
    drag.lastX = sx;
    drag.lastY = sy;

    if (drag.mode === "pan" && drag.panStart) {
      const dx = sx - drag.startX;
      const dy = sy - drag.startY;
      setTransform({ ...drag.panStart, x: drag.panStart.x + dx, y: drag.panStart.y + dy });
    } else if (drag.mode === "node" && drag.nodeId) {
      const tf = latest.current.transform;
      const wx = (drag.nodeStartX ?? 0) + (sx - drag.startX) / tf.k;
      const wy = (drag.nodeStartY ?? 0) + (sy - drag.startY) / tf.k;
      latest.current.props.onMoveLocal(drag.nodeId, wx, wy);
    } else if (drag.mode === "link") {
      setLinkCursor({ x: sx, y: sy });
    }
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    viewportRef.current?.releasePointerCapture(event.pointerId);
    const p = latest.current.props;

    if (drag.mode === "node" && drag.nodeId) {
      if (!drag.moved) {
        // Second click on the same node within 350ms → open the detail view.
        const nowT = Date.now();
        const last = lastClickRef.current;
        if (last && last.id === drag.nodeId && nowT - last.t < 350) {
          lastClickRef.current = null;
          p.onOpen(drag.nodeId);
        } else {
          lastClickRef.current = { id: drag.nodeId, t: nowT };
          p.onSelect(drag.nodeId);
        }
      } else {
        const tf = latest.current.transform;
        const wx = (drag.nodeStartX ?? 0) + (drag.lastX - drag.startX) / tf.k;
        const wy = (drag.nodeStartY ?? 0) + (drag.lastY - drag.startY) / tf.k;
        p.onCommitMove(drag.nodeId, wx, wy);
      }
    } else if (drag.mode === "link" && drag.fromId) {
      const hit = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-paper-id]");
      const toId = hit?.getAttribute("data-paper-id") ?? null;
      if (toId && toId !== drag.fromId) p.onAddEdge(drag.fromId, toId);
      setLinkFrom(null);
      setLinkCursor(null);
    } else if (drag.mode === "pan" && !drag.moved) {
      p.onSelect(null);
    }
  }, []);

  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const { papers: ps, edges: es, transform: tf } = latest.current;

      const nodeEl = (event.target as HTMLElement).closest("[data-paper-id]");
      const nodeId = nodeEl?.getAttribute("data-paper-id");
      if (nodeId) {
        setMenu({ kind: "node", id: nodeId, x: event.clientX, y: event.clientY });
        return;
      }
      // Edge hit-test in screen space.
      const map = new Map(ps.map((p) => [p.id, p]));
      let best: { id: string; d: number } | null = null;
      for (const edge of es) {
        const a = map.get(edge.from);
        const b = map.get(edge.to);
        if (!a || !b) continue;
        const ax = tf.x + tf.k * a.x;
        const ay = tf.y + tf.k * a.y;
        const bx = tf.x + tf.k * b.x;
        const by = tf.y + tf.k * b.y;
        // Match the drawn curve: approximate it by its two control sub-segments.
        const ctrl = controlPoint(ax, ay, bx, by, tf.k);
        const d = Math.min(
          distToSegment(sx, sy, ax, ay, ctrl.x, ctrl.y),
          distToSegment(sx, sy, ctrl.x, ctrl.y, bx, by),
        );
        if (d < 16 && (!best || d < best.d)) best = { id: edge.id, d };
      }
      if (best) {
        setMenu({ kind: "edge", id: best.id, x: event.clientX, y: event.clientY });
        return;
      }
      const world = toWorld(sx, sy, tf);
      setMenu({
        kind: "canvas",
        worldX: world.x,
        worldY: world.y,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [toWorld],
  );

  // ── Toolbar actions.
  const zoomBy = useCallback((factor: number) => {
    const { w, h } = latest.current.size;
    setTransform((tf) => {
      const k = clampK(tf.k * factor);
      if (k === tf.k) return tf;
      const cx = w / 2;
      const cy = h / 2;
      const wx = (cx - tf.x) / tf.k;
      const wy = (cy - tf.y) / tf.k;
      return { k, x: cx - k * wx, y: cy - k * wy };
    });
  }, []);

  const fitView = useCallback(() => {
    const { papers: ps, size: sz } = latest.current;
    setTransform(fitTransform(ps, sz.w, sz.h));
  }, []);

  const createCentered = useCallback(() => {
    const { size: sz, transform: tf } = latest.current;
    const world = toWorld(sz.w / 2, sz.h / 2, tf);
    latest.current.props.onCreateAt(world.x, world.y);
  }, [toWorld]);

  // ── Edge geometry (screen space) for the SVG overlay.
  const rendered = useMemo(() => {
    const k = transform.k;
    const gap = 3 * k; // land the arrowhead just outside the card, never under it
    const half = (id: string) => {
      const s = nodeSizes.get(id) ?? { w: NODE_W, h: NODE_H };
      return { hw: (s.w / 2) * k + gap, hh: (s.h / 2) * k + gap };
    };
    return edges
      .map((edge) => {
        const a = paperById.get(edge.from);
        const b = paperById.get(edge.to);
        if (!a || !b) return null;
        const acx = transform.x + k * a.x;
        const acy = transform.y + k * a.y;
        const bcx = transform.x + k * b.x;
        const bcy = transform.y + k * b.y;
        // Bow the edge sideways so edges sharing a node fan apart instead of
        // stacking on the same straight line; reversed edges bow the other way.
        const ctrl = controlPoint(acx, acy, bcx, bcy, k);
        const aHalf = half(edge.from);
        const bHalf = half(edge.to);
        // Trim to each card's border along the curve's tangent (toward the
        // control point), so the arrowhead meets the card at the right angle.
        const start = borderPoint(acx, acy, aHalf.hw, aHalf.hh, ctrl.x, ctrl.y);
        const end = borderPoint(bcx, bcy, bHalf.hw, bHalf.hh, ctrl.x, ctrl.y);
        const active = selectedId === edge.from || selectedId === edge.to;
        return { edge, start, end, ctrl, active };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }, [edges, paperById, transform, selectedId, nodeSizes]);

  const linkSource = useMemo(() => {
    if (!linkCursor || !linkFrom) return null;
    const from = paperById.get(linkFrom);
    if (!from) return null;
    return {
      x: transform.x + transform.k * from.x,
      y: transform.y + transform.k * from.y,
    };
  }, [linkCursor, linkFrom, paperById, transform]);

  const arrowSize = Math.max(10, 13 * transform.k);
  const isEmpty = papers.length === 0;

  return (
    <div
      ref={viewportRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        background:
          "radial-gradient(circle at 1px 1px, rgba(60,70,85,0.10) 1px, transparent 0) 0 0 / 26px 26px",
      }}
    >
      <style>{`
        .nomi-paper-node .nomi-connect-handle { opacity: 0; transition: opacity 120ms ease, transform 120ms ease; }
        .nomi-paper-node:hover .nomi-connect-handle { opacity: 1; }
        .nomi-paper-node:hover { z-index: 5; }
      `}</style>

      {/* Edges + temp link line (screen space, non-interactive). */}
      <svg
        width={size.w}
        height={size.h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        {rendered.map(({ edge, start, end, ctrl, active }) => {
          const color = active ? accent.accent : t.separatorStrong;
          // Curve midpoint (bezier at t=0.5) for the label chip.
          const mx = 0.25 * start.x + 0.5 * ctrl.x + 0.25 * end.x;
          const my = 0.25 * start.y + 0.5 * ctrl.y + 0.25 * end.y;
          // Arrowhead follows the tangent at the end (from the control point).
          const angle = Math.atan2(end.y - ctrl.y, end.x - ctrl.x);
          const ax1 = end.x - arrowSize * Math.cos(angle - Math.PI / 7);
          const ay1 = end.y - arrowSize * Math.sin(angle - Math.PI / 7);
          const ax2 = end.x - arrowSize * Math.cos(angle + Math.PI / 7);
          const ay2 = end.y - arrowSize * Math.sin(angle + Math.PI / 7);
          return (
            <g key={edge.id}>
              <path
                d={`M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`}
                fill="none"
                stroke={color}
                strokeWidth={active ? 3.5 : 2.5}
                strokeLinecap="round"
              />
              <polygon points={`${end.x},${end.y} ${ax1},${ay1} ${ax2},${ay2}`} fill={color} />
              {edge.label ? (
                <g>
                  <rect
                    x={mx - edge.label.length * 6 - 6}
                    y={my - 10}
                    width={edge.label.length * 12 + 12}
                    height={20}
                    rx={7}
                    fill={t.cardSurface}
                    stroke={t.separator}
                    strokeWidth={1}
                  />
                  <text
                    x={mx}
                    y={my + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill={t.textSecondary}
                    style={{ fontWeight: 500 }}
                  >
                    {edge.label}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
        {linkSource && linkCursor ? (
          <line
            x1={linkSource.x}
            y1={linkSource.y}
            x2={linkCursor.x}
            y2={linkCursor.y}
            stroke={accent.accent}
            strokeWidth={3}
            strokeDasharray="5 4"
            strokeLinecap="round"
          />
        ) : null}
      </svg>

      {/* Node layer (container ignores pointers; each card opts back in). */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {papers.map((paper) => {
          const pos = screenPos(paper.x, paper.y);
          const meta = statusMeta(paper.status);
          const selected = paper.id === selectedId;
          return (
            <div
              key={paper.id}
              ref={(el) => measureNode(paper.id, el)}
              data-paper-id={paper.id}
              className="nomi-paper-node"
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: NODE_W,
                transform: `translate(-50%, -50%) scale(${transform.k})`,
                transformOrigin: "center",
                pointerEvents: "auto",
                cursor: "grab",
              }}
            >
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  padding: "11px 13px",
                  borderRadius: 13,
                  background: t.cardSurface,
                  border: `1px solid ${selected ? accent.accent : t.separator}`,
                  boxShadow: selected
                    ? `0 8px 22px rgba(${accent.rgb},0.22), 0 0 0 3px rgba(${accent.rgb},0.16)`
                    : "0 4px 12px rgba(16,24,36,0.08), 0 1px 2px rgba(16,24,36,0.06)",
                  fontFamily: "inherit",
                }}
              >
                <div
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    color: t.textPrimary,
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.35,
                    wordBreak: "break-word",
                  }}
                >
                  {paper.title}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      height: 18,
                      padding: "0 7px",
                      borderRadius: 6,
                      background: meta.soft,
                      color: meta.text,
                      fontSize: 10.5,
                      fontWeight: 600,
                    }}
                  >
                    <span
                      style={{ width: 6, height: 6, borderRadius: 3, background: meta.color }}
                    />
                    {meta.label}
                  </span>
                  {paper.venue ? (
                    <span
                      style={{
                        maxWidth: "100%",
                        display: "inline-flex",
                        alignItems: "center",
                        height: 18,
                        padding: "0 7px",
                        borderRadius: 6,
                        background: `rgba(${accent.rgb},0.10)`,
                        color: accent.accentText,
                        fontSize: 10.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {paper.venue}
                    </span>
                  ) : null}
                </div>
                {paper.tags.length > 0 ? (
                  <div
                    style={{
                      color: t.textTertiary,
                      fontSize: 10.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    #{paper.tags.slice(0, 2).join(" #")}
                  </div>
                ) : null}

                {/* Drag-to-connect handle. */}
                <div
                  data-connect-handle
                  className="nomi-connect-handle"
                  title="拖拽到另一篇论文以建立关系"
                  style={{
                    position: "absolute",
                    right: -11,
                    top: "50%",
                    marginTop: -11,
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    background: accent.accent,
                    border: `2px solid ${t.cardSurface}`,
                    boxShadow: "0 2px 6px rgba(16,24,36,0.22)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "crosshair",
                  }}
                >
                  <RiAddLine color="#fff" size={14} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty state. */}
      {isEmpty ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            pointerEvents: "none",
            textAlign: "center",
            padding: 24,
          }}
        >
          <EmptyGraphGlyph color={t.textTertiary} accent={accent.accent} />
          <div style={{ color: t.textPrimary, fontSize: 16, fontWeight: 700 }}>
            规划你的论文关系图
          </div>
          <div style={{ color: t.textSecondary, fontSize: 13, lineHeight: 1.6, maxWidth: 340 }}>
            新建一篇论文，标记它是「有潜力 / 打算写 / 正在写 / 已完成」，
            再从卡片右侧的圆点拖拽，把有关联的论文连起来。
          </div>
          <button
            type="button"
            onClick={createCentered}
            style={{
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginTop: 4,
              padding: "8px 16px",
              borderRadius: 10,
              border: "none",
              background: accent.accent,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              boxShadow: `0 6px 16px rgba(${accent.rgb},0.28)`,
            }}
          >
            <RiAddLine color="#fff" size={16} />
            新建论文
          </button>
        </div>
      ) : null}

      {/* Legend (bottom-left). */}
      <div
        data-graph-ui
        style={{
          position: "absolute",
          left: 14,
          bottom: 14,
          display: "flex",
          gap: 12,
          padding: "8px 12px",
          borderRadius: 11,
          background: t.overlaySolid,
          border: `1px solid ${t.separator}`,
          boxShadow: "0 4px 14px rgba(16,24,36,0.10)",
        }}
      >
        {STATUS_ORDER.map((status) => (
          <div key={status} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 3,
                background: STATUS_META[status].color,
              }}
            />
            <span style={{ color: t.textSecondary, fontSize: 11.5, fontWeight: 500 }}>
              {STATUS_META[status].label}
            </span>
          </div>
        ))}
      </div>

      {/* Zoom / fit / new toolbar (bottom-right). */}
      <div
        data-graph-ui
        style={{
          position: "absolute",
          right: 14,
          bottom: 14,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <ToolButton label="新建论文" accentBg={accent.accent} onClick={createCentered}>
          <RiAddLine color="#fff" size={18} />
        </ToolButton>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRadius: 11,
            overflow: "hidden",
            background: t.overlaySolid,
            border: `1px solid ${t.separator}`,
            boxShadow: "0 4px 14px rgba(16,24,36,0.10)",
          }}
        >
          <IconButton title="放大" onClick={() => zoomBy(1.2)} theme={t}>
            <RiZoomInLine color={t.textSecondary} size={17} />
          </IconButton>
          <div style={{ height: 1, background: t.separator }} />
          <IconButton title="缩小" onClick={() => zoomBy(1 / 1.2)} theme={t}>
            <RiZoomOutLine color={t.textSecondary} size={17} />
          </IconButton>
          <div style={{ height: 1, background: t.separator }} />
          <IconButton title="适应视图" onClick={fitView} theme={t}>
            <RiFocus3Line color={t.textSecondary} size={17} />
          </IconButton>
        </div>
      </div>

      {menu ? (
        <GraphContextMenu
          menu={menu}
          accent={accent}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            const p = latest.current.props;
            setMenu(null);
            if (menu.kind === "node") {
              if (action === "open") p.onOpen(menu.id);
              else if (action === "reveal") p.onReveal(menu.id);
              else if (action === "delete") p.onDeletePaper(menu.id);
              else if (action.startsWith("status:"))
                p.onSetStatus(menu.id, action.slice("status:".length) as PaperStatus);
            } else if (menu.kind === "edge") {
              if (action === "rename") p.onRenameEdge(menu.id);
              else if (action === "delete") p.onDeleteEdge(menu.id);
            } else if (menu.kind === "canvas" && action === "create") {
              p.onCreateAt(menu.worldX, menu.worldY);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ToolButton({
  children,
  label,
  accentBg,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  accentBg: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 40,
        height: 40,
        borderRadius: 12,
        border: "none",
        background: accentBg,
        cursor: "pointer",
        boxShadow: `0 6px 16px rgba(16,24,36,0.18)`,
      }}
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  title,
  onClick,
  theme,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  theme: ReturnType<typeof useTheme>["t"];
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = theme.controlHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 38,
        height: 34,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        transition: "background-color 120ms ease",
      }}
    >
      {children}
    </button>
  );
}

type MenuAction = string;

function GraphContextMenu({
  menu,
  accent,
  onAction,
  onClose,
}: {
  menu: MenuState;
  accent: Accent;
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = theme;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - 8 - rect.width))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - 8 - rect.height))}px`;
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  type Row =
    | { action: string; label: string; icon?: React.ReactNode; danger?: boolean; dot?: string }
    | { divider: true };
  const rows: Row[] =
    menu.kind === "node"
      ? [
          {
            action: "open",
            label: "打开论文",
            icon: <RiExternalLinkLine color={t.textSecondary} size={15} />,
          },
          { divider: true },
          ...STATUS_ORDER.map((status) => ({
            action: `status:${status}`,
            label: `标为「${STATUS_META[status].label}」`,
            dot: STATUS_META[status].color,
          })),
          { divider: true },
          {
            action: "reveal",
            label: "在文件夹中显示",
            icon: <RiExternalLinkLine color={t.textSecondary} size={15} />,
          },
          {
            action: "delete",
            label: "删除论文",
            danger: true,
            icon: <RiDeleteBinLine color={t.errorText} size={15} />,
          },
        ]
      : menu.kind === "edge"
        ? [
            {
              action: "rename",
              label: "重命名关系",
              icon: <RiPriceTag3Line color={t.textSecondary} size={15} />,
            },
            {
              action: "delete",
              label: "删除关系",
              danger: true,
              icon: <RiDeleteBinLine color={t.errorText} size={15} />,
            },
          ]
        : [
            {
              action: "create",
              label: "在此新建论文",
              icon: <RiAddLine color={t.textSecondary} size={15} />,
            },
          ];

  return createPortal(
    <div
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 2000 }}
    >
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: menu.x,
          top: menu.y,
          minWidth: 184,
          padding: 6,
          background: t.cardSurface,
          border: `1px solid ${t.separator}`,
          borderRadius: 12,
          boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
          fontFamily: "inherit",
        }}
      >
        {rows.map((row, index) =>
          "divider" in row ? (
            <div
              key={`d${index}`}
              style={{ height: 1, background: t.separator, margin: "5px 8px" }}
            />
          ) : (
            <button
              key={row.action}
              type="button"
              onClick={() => onAction(row.action)}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = row.danger
                  ? "rgba(178,77,77,0.10)"
                  : `rgba(${accent.rgb},0.12)`;
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                border: "none",
                background: "transparent",
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1.2,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                color: row.danger ? t.errorText : t.textPrimary,
                transition: "background-color 120ms ease",
              }}
            >
              <span style={{ display: "inline-flex", width: 18, justifyContent: "center" }}>
                {row.dot ? (
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: row.dot }} />
                ) : (
                  row.icon
                )}
              </span>
              {row.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}

function EmptyGraphGlyph({ color, accent }: { color: string; accent: string }) {
  return (
    <svg width={96} height={72} viewBox="0 0 96 72" fill="none" aria-hidden>
      <line x1="24" y1="20" x2="66" y2="16" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="24" y1="20" x2="30" y2="54" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="66" y1="16" x2="72" y2="52" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <rect x="8" y="10" width="34" height="20" rx="5" fill={accent} opacity="0.9" />
      <rect x="54" y="6" width="34" height="20" rx="5" fill={color} opacity="0.4" />
      <rect x="16" y="44" width="34" height="20" rx="5" fill={color} opacity="0.4" />
      <rect x="58" y="42" width="34" height="20" rx="5" fill={color} opacity="0.25" />
    </svg>
  );
}
