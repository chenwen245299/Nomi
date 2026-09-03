// Orthogonal edge routing for the paper relationship graph.
//
// Edges used to be bezier curves drawn centre-to-centre, which meant a link
// between two distant papers would run straight underneath any card that
// happened to sit between them. This router instead produces axis-aligned
// polylines ("折线") that keep a fixed clearance around every card:
//
//   1. pick a side (and a slot on that side) for each endpoint,
//   2. lay a lattice of candidate lines along the inflated card borders,
//   3. A* across that lattice, paying for length and for every corner.
//
// Everything here is world space (the same coordinates papers are stored in),
// so a route only changes when cards move or resize — not when panning/zooming.

export interface Point {
  x: number;
  y: number;
}

export interface RouteNode {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface RouteLink {
  id: string;
  from: string;
  to: string;
}

export interface RoutedEdge {
  id: string;
  /** ≥2 points; every consecutive pair is horizontal or vertical. */
  points: Point[];
}

/** Clearance a route keeps from a card border when it has the room. */
export const ROUTE_PAD = 20;
/** The card itself, barely inflated — this part is genuinely impassable. */
const HARD_PAD = 3;
/** Cost multiplier for squeezing through a card's clearance ring. */
const SQUEEZE = 3.5;
/** Spacing between two edges docking on the same side of a card. */
const SLOT = 22;
/** A* cost (in world px) charged for each corner, to prefer straight runs. */
const BEND_COST = 40;
/** Extra corridors offered beside each card border, so parallel edges can spread. */
const LANE_STEP = 13;
/**
 * Lanes are what keep parallel edges off each other, but each one widens the
 * lattice on both axes and the search cost grows with their product. Big boards
 * trade some of that spread back for a routing pass that still fits in a drag
 * frame — at that size the cards are far enough apart that it barely shows.
 */
function laneCount(nodeCount: number): number {
  if (nodeCount <= 24) return 2;
  if (nodeCount <= 48) return 1;
  return 0;
}
/** Cost per world px of corridor already taken by an earlier edge. */
const REUSE_COST = 0.9;
const REUSE_CAP = 3;
/** Ports this close to lining up are pulled flush, killing 2px staircase kinks. */
const SNAP = 12;
/** Safety valve so a pathological graph can't lock up a drag frame. */
const MAX_POPS = 60000;

const EPS = 0.5;
const MERGE = 0.75;

type Side = "l" | "r" | "t" | "b";

/**
 * A card as the router sees it: an impassable core, and a clearance ring that
 * routes may cross but pay dearly for. Making the ring soft rather than solid
 * matters — two cards parked closer together than 2×ROUTE_PAD have overlapping
 * rings, and a solid ring would wall an endpoint in with no route out at all.
 */
interface Obstacle {
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
  sx0: number;
  sy0: number;
  sx1: number;
  sy1: number;
}

interface Endpoint {
  port: Point;
  stub: Point;
  /** 0 = the stub leaves horizontally, 1 = vertically. */
  axis: 0 | 1;
}

function sidesFor(dx: number, dy: number): [Side, Side] {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["r", "l"] : ["l", "r"];
  return dy >= 0 ? ["b", "t"] : ["t", "b"];
}

function endpointFor(node: RouteNode, side: Side, off: number): Endpoint {
  const hw = node.w / 2;
  const hh = node.h / 2;
  switch (side) {
    case "r":
      return {
        port: { x: node.cx + hw, y: node.cy + off },
        stub: { x: node.cx + hw + ROUTE_PAD, y: node.cy + off },
        axis: 0,
      };
    case "l":
      return {
        port: { x: node.cx - hw, y: node.cy + off },
        stub: { x: node.cx - hw - ROUTE_PAD, y: node.cy + off },
        axis: 0,
      };
    case "b":
      return {
        port: { x: node.cx + off, y: node.cy + hh },
        stub: { x: node.cx + off, y: node.cy + hh + ROUTE_PAD },
        axis: 1,
      };
    default:
      return {
        port: { x: node.cx + off, y: node.cy - hh },
        stub: { x: node.cx + off, y: node.cy - hh - ROUTE_PAD },
        axis: 1,
      };
  }
}

/** Sorted, near-duplicate-free coordinate axis. */
function buildAxis(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > MERGE) out.push(v);
  }
  return out;
}

/** Index of the lattice line closest to `v`. */
function nearest(axis: number[], v: number): number {
  let lo = 0;
  let hi = axis.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(axis[lo - 1] - v) <= Math.abs(axis[lo] - v)) return lo - 1;
  return lo;
}

/** Drop points that sit on the straight line between their neighbours. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  const res: Point[] = [];
  for (let i = 0; i < out.length; i += 1) {
    const prev = res[res.length - 1];
    const next = out[i + 1];
    if (prev && next) {
      const collinearX = Math.abs(prev.x - out[i].x) < 0.01 && Math.abs(out[i].x - next.x) < 0.01;
      const collinearY = Math.abs(prev.y - out[i].y) < 0.01 && Math.abs(out[i].y - next.y) < 0.01;
      if (collinearX || collinearY) continue;
    }
    res.push(out[i]);
  }
  return res;
}

/** Last-resort orthogonal path used when A* can't get through (overlapping cards). */
function fallbackPath(a: Endpoint, b: Endpoint): Point[] {
  const pts: Point[] = [a.port, a.stub];
  if (a.axis === 0 && b.axis === 0) {
    const mx = (a.stub.x + b.stub.x) / 2;
    pts.push({ x: mx, y: a.stub.y }, { x: mx, y: b.stub.y });
  } else if (a.axis === 1 && b.axis === 1) {
    const my = (a.stub.y + b.stub.y) / 2;
    pts.push({ x: a.stub.x, y: my }, { x: b.stub.x, y: my });
  } else if (a.axis === 0) {
    pts.push({ x: b.stub.x, y: a.stub.y });
  } else {
    pts.push({ x: a.stub.x, y: b.stub.y });
  }
  pts.push(b.stub, b.port);
  return simplify(pts);
}

/** Minimal binary heap over (state, f) pairs. */
class Heap {
  private states: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.states.length;
  }

  push(state: number, key: number) {
    this.states.push(state);
    this.keys.push(key);
    let i = this.states.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const top = this.states[0];
    const lastState = this.states.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.states.length > 0) {
      this.states[0] = lastState;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < this.keys.length && this.keys[l] < this.keys[small]) small = l;
        if (r < this.keys.length && this.keys[r] < this.keys[small]) small = r;
        if (small === i) break;
        this.swap(small, i);
        i = small;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    const s = this.states[a];
    this.states[a] = this.states[b];
    this.states[b] = s;
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
  }
}

export function routeEdges(nodes: RouteNode[], links: RouteLink[]): Map<string, RoutedEdge> {
  const result = new Map<string, RoutedEdge>();
  if (links.length === 0 || nodes.length === 0) return result;

  const byId = new Map<string, RouteNode>();
  for (const n of nodes) byId.set(n.id, n);

  // ── 1. Assign a side + slot to every endpoint. Edges docking on the same side
  //       of the same card fan out so they never overlap on the way in.
  interface Pending {
    link: RouteLink;
    a: RouteNode;
    b: RouteNode;
    sideA: Side;
    sideB: Side;
    offA: number;
    offB: number;
  }
  const pending: Pending[] = [];
  const slots = new Map<string, { pend: Pending; end: "a" | "b"; key: number }[]>();

  for (const link of links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b || a.id === b.id) continue;
    const [sideA, sideB] = sidesFor(b.cx - a.cx, b.cy - a.cy);
    const p: Pending = { link, a, b, sideA, sideB, offA: 0, offB: 0 };
    pending.push(p);
    const push = (nodeId: string, side: Side, end: "a" | "b", key: number) => {
      const k = `${nodeId}:${side}`;
      const list = slots.get(k);
      if (list) list.push({ pend: p, end, key });
      else slots.set(k, [{ pend: p, end, key }]);
    };
    // Order slots by where the other card sits, so the fan doesn't cross itself.
    push(a.id, sideA, "a", sideA === "l" || sideA === "r" ? b.cy : b.cx);
    push(b.id, sideB, "b", sideB === "l" || sideB === "r" ? a.cy : a.cx);
  }

  for (const [key, list] of slots) {
    const nodeId = key.slice(0, key.lastIndexOf(":"));
    const side = key.slice(key.lastIndexOf(":") + 1) as Side;
    const node = byId.get(nodeId);
    if (!node) continue;
    const sideLen = side === "l" || side === "r" ? node.h : node.w;
    list.sort((p, q) => p.key - q.key);
    const n = list.length;
    const spacing = n > 1 ? Math.min(SLOT, (sideLen * 0.66) / (n - 1)) : 0;
    list.forEach((entry, i) => {
      const off = (i - (n - 1) / 2) * spacing;
      if (entry.end === "a") entry.pend.offA = off;
      else entry.pend.offB = off;
    });
  }

  // A fan spreads one end of an edge but not always the other, which can leave
  // the two ports a few px apart — a staircase kink right against a card. Pull
  // the uncrowded end flush whenever the gap is small enough to close.
  for (const p of pending) {
    const horiz = p.sideA === "l" || p.sideA === "r";
    const delta =
      (horiz ? p.b.cy + p.offB : p.b.cx + p.offB) - (horiz ? p.a.cy + p.offA : p.a.cx + p.offA);
    if (Math.abs(delta) < 0.01 || Math.abs(delta) > SNAP) continue;
    const lone = (node: RouteNode, side: Side) =>
      (slots.get(`${node.id}:${side}`)?.length ?? 2) === 1;
    const room = (node: RouteNode, side: Side) =>
      (side === "l" || side === "r" ? node.h : node.w) / 2 - 10;
    if (lone(p.b, p.sideB) && Math.abs(p.offB - delta) <= room(p.b, p.sideB)) p.offB -= delta;
    else if (lone(p.a, p.sideA) && Math.abs(p.offA + delta) <= room(p.a, p.sideA)) p.offA += delta;
  }

  // ── 2. Obstacles + the lattice of candidate lines.
  const obstacles: Obstacle[] = nodes.map((n) => ({
    hx0: n.cx - n.w / 2 - HARD_PAD,
    hy0: n.cy - n.h / 2 - HARD_PAD,
    hx1: n.cx + n.w / 2 + HARD_PAD,
    hy1: n.cy + n.h / 2 + HARD_PAD,
    sx0: n.cx - n.w / 2 - ROUTE_PAD,
    sy0: n.cy - n.h / 2 - ROUTE_PAD,
    sx1: n.cx + n.w / 2 + ROUTE_PAD,
    sy1: n.cy + n.h / 2 + ROUTE_PAD,
  }));

  const lanes = laneCount(nodes.length);
  const rawX: number[] = [];
  const rawY: number[] = [];
  for (const r of obstacles) {
    rawX.push(r.sx0, r.sx1);
    rawY.push(r.sy0, r.sy1);
    // Spare corridors just outside each border: without them, every edge that
    // has to skirt a card converges on the exact same line and they overlap.
    for (let l = 1; l <= lanes; l += 1) {
      rawX.push(r.sx0 - l * LANE_STEP, r.sx1 + l * LANE_STEP);
      rawY.push(r.sy0 - l * LANE_STEP, r.sy1 + l * LANE_STEP);
    }
  }
  const ends = pending.map((p) => ({
    a: endpointFor(p.a, p.sideA, p.offA),
    b: endpointFor(p.b, p.sideB, p.offB),
  }));
  for (const e of ends) {
    rawX.push(e.a.stub.x, e.b.stub.x);
    rawY.push(e.a.stub.y, e.b.stub.y);
  }
  // An outer ring so a route can always escape around the whole graph.
  const ringX = Math.min(...rawX) - ROUTE_PAD * 2;
  const ringX2 = Math.max(...rawX) + ROUTE_PAD * 2;
  const ringY = Math.min(...rawY) - ROUTE_PAD * 2;
  const ringY2 = Math.max(...rawY) + ROUTE_PAD * 2;
  rawX.push(ringX, ringX2);
  rawY.push(ringY, ringY2);

  const xs = buildAxis(rawX);
  const ys = buildAxis(rawY);
  const m = xs.length;
  const n = ys.length;

  // ── 3. Rate every lattice move: BLOCKED through a card, SQUEEZED through a
  //       card's clearance ring, FREE otherwise. Shared by all edges.
  const BLOCKED = 0;
  const FREE = 1;
  const SQUEEZED = 2;
  const hPass = new Uint8Array(Math.max(0, m - 1) * n);
  const vPass = new Uint8Array(m * Math.max(0, n - 1));
  const hardBand: Obstacle[] = [];
  const softBand: Obstacle[] = [];
  for (let j = 0; j < n; j += 1) {
    const y = ys[j];
    hardBand.length = 0;
    softBand.length = 0;
    for (const r of obstacles) {
      if (y > r.hy0 + EPS && y < r.hy1 - EPS) hardBand.push(r);
      else if (y > r.sy0 + EPS && y < r.sy1 - EPS) softBand.push(r);
    }
    for (let i = 0; i < m - 1; i += 1) {
      const mid = (xs[i] + xs[i + 1]) / 2;
      let pass = FREE;
      for (const r of hardBand) {
        if (mid > r.hx0 + EPS && mid < r.hx1 - EPS) {
          pass = BLOCKED;
          break;
        }
        if (pass === FREE && mid > r.sx0 + EPS && mid < r.sx1 - EPS) pass = SQUEEZED;
      }
      if (pass === FREE) {
        for (const r of softBand) {
          if (mid > r.sx0 + EPS && mid < r.sx1 - EPS) {
            pass = SQUEEZED;
            break;
          }
        }
      }
      hPass[j * (m - 1) + i] = pass;
    }
  }
  for (let i = 0; i < m; i += 1) {
    const x = xs[i];
    hardBand.length = 0;
    softBand.length = 0;
    for (const r of obstacles) {
      if (x > r.hx0 + EPS && x < r.hx1 - EPS) hardBand.push(r);
      else if (x > r.sx0 + EPS && x < r.sx1 - EPS) softBand.push(r);
    }
    for (let j = 0; j < n - 1; j += 1) {
      const mid = (ys[j] + ys[j + 1]) / 2;
      let pass = FREE;
      for (const r of hardBand) {
        if (mid > r.hy0 + EPS && mid < r.hy1 - EPS) {
          pass = BLOCKED;
          break;
        }
        if (pass === FREE && mid > r.sy0 + EPS && mid < r.sy1 - EPS) pass = SQUEEZED;
      }
      if (pass === FREE) {
        for (const r of softBand) {
          if (mid > r.sy0 + EPS && mid < r.sy1 - EPS) {
            pass = SQUEEZED;
            break;
          }
        }
      }
      vPass[i * (n - 1) + j] = pass;
    }
  }

  // ── 4. A* per edge. A state is (lattice cell, axis we arrived along).
  //       Edges are routed in turn and each one marks the corridors it used, so
  //       later edges pay to share them and slide into a neighbouring lane.
  const cells = m * n;
  const g = new Float64Array(cells * 2);
  const parent = new Int32Array(cells * 2);
  const seen = new Int32Array(cells * 2);
  const hUse = new Uint8Array(hPass.length);
  const vUse = new Uint8Array(vPass.length);
  let stamp = 0;

  pending.forEach((p, idx) => {
    const ep = ends[idx];
    // Snap both stubs onto the lattice, then pull the port across with them so
    // every segment stays perfectly axis-aligned.
    const si = nearest(xs, ep.a.stub.x);
    const sj = nearest(ys, ep.a.stub.y);
    const ti = nearest(xs, ep.b.stub.x);
    const tj = nearest(ys, ep.b.stub.y);
    const a: Endpoint = {
      axis: ep.a.axis,
      stub: { x: xs[si], y: ys[sj] },
      port: ep.a.axis === 0 ? { x: ep.a.port.x, y: ys[sj] } : { x: xs[si], y: ep.a.port.y },
    };
    const b: Endpoint = {
      axis: ep.b.axis,
      stub: { x: xs[ti], y: ys[tj] },
      port: ep.b.axis === 0 ? { x: ep.b.port.x, y: ys[tj] } : { x: xs[ti], y: ep.b.port.y },
    };

    const start = sj * m + si;
    const goal = tj * m + ti;
    let points: Point[] | null = null;

    if (start !== goal) {
      stamp += 1;
      const heap = new Heap();
      const h = (cell: number) => {
        const ci = cell % m;
        const cj = (cell / m) | 0;
        return Math.abs(xs[ci] - xs[ti]) + Math.abs(ys[cj] - ys[tj]);
      };
      const s0 = start * 2 + a.axis;
      g[s0] = 0;
      parent[s0] = -1;
      seen[s0] = stamp;
      heap.push(s0, h(start));

      let found = -1;
      let pops = 0;
      while (heap.size > 0 && pops < MAX_POPS) {
        const state = heap.pop();
        pops += 1;
        const cell = state >> 1;
        const dir = state & 1;
        if (cell === goal) {
          found = state;
          break;
        }
        const ci = cell % m;
        const cj = (cell / m) | 0;
        const relax = (nc: number, nd: 0 | 1, step: number, pass: number, used: number) => {
          let cost = g[state] + step * (pass === SQUEEZED ? SQUEEZE : 1) + step * REUSE_COST * used;
          if (nd !== dir) cost += BEND_COST;
          // Arriving at the target along the wrong axis means a corner right at
          // the card — price it the same as any other bend.
          if (nc === goal && nd !== b.axis) cost += BEND_COST;
          const ns = nc * 2 + nd;
          if (seen[ns] === stamp && g[ns] <= cost) return;
          seen[ns] = stamp;
          g[ns] = cost;
          parent[ns] = state;
          heap.push(ns, cost + h(nc));
        };
        if (ci > 0) {
          const at = cj * (m - 1) + (ci - 1);
          if (hPass[at]) relax(cell - 1, 0, xs[ci] - xs[ci - 1], hPass[at], hUse[at]);
        }
        if (ci < m - 1) {
          const at = cj * (m - 1) + ci;
          if (hPass[at]) relax(cell + 1, 0, xs[ci + 1] - xs[ci], hPass[at], hUse[at]);
        }
        if (cj > 0) {
          const at = ci * (n - 1) + (cj - 1);
          if (vPass[at]) relax(cell - m, 1, ys[cj] - ys[cj - 1], vPass[at], vUse[at]);
        }
        if (cj < n - 1) {
          const at = ci * (n - 1) + cj;
          if (vPass[at]) relax(cell + m, 1, ys[cj + 1] - ys[cj], vPass[at], vUse[at]);
        }
      }

      if (found >= 0) {
        const trail: number[] = [];
        for (let st = found; st >= 0; st = parent[st]) {
          trail.push(st >> 1);
          if (parent[st] < 0) break;
        }
        trail.reverse();
        // Book the corridors this route just took.
        for (let i = 1; i < trail.length; i += 1) {
          const from = trail[i - 1];
          const to = trail[i];
          const fi = from % m;
          const fj = (from / m) | 0;
          if (to === from + 1 || to === from - 1) {
            const idx = fj * (m - 1) + Math.min(fi, to % m);
            if (hUse[idx] < REUSE_CAP) hUse[idx] += 1;
          } else {
            const idx = fi * (n - 1) + Math.min(fj, (to / m) | 0);
            if (vUse[idx] < REUSE_CAP) vUse[idx] += 1;
          }
        }
        const chain = trail.map((cell) => ({ x: xs[cell % m], y: ys[(cell / m) | 0] }));
        points = simplify([a.port, ...chain, b.port]);
      }
    } else {
      points = simplify([a.port, a.stub, b.port]);
    }

    result.set(p.link.id, { id: p.link.id, points: points ?? fallbackPath(a, b) });
  });

  return result;
}

/** SVG path for an orthogonal polyline with rounded corners. */
export function orthoPath(points: Point[], radius: number): string {
  if (points.length < 2) return "";
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      parts.push(`L ${cur.x} ${cur.y}`);
      continue;
    }
    const ax = cur.x + ((prev.x - cur.x) / inLen) * r;
    const ay = cur.y + ((prev.y - cur.y) / inLen) * r;
    const bx = cur.x + ((next.x - cur.x) / outLen) * r;
    const by = cur.y + ((next.y - cur.y) / outLen) * r;
    parts.push(`L ${ax} ${ay}`, `Q ${cur.x} ${cur.y} ${bx} ${by}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

/** Point half-way along a polyline, by arc length. */
export function pathMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (walked + seg >= total / 2) {
      const t = seg === 0 ? 0 : (total / 2 - walked) / seg;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    walked += seg;
  }
  return points[points.length - 1];
}
