import type { Quadrant } from "./api";

// ── Todo colour system ───────────────────────────────────────────────────────
// The section accent (violet, see `accentFor("todo")` in src/theme.ts) themes the
// chrome — rail selection, collection wash, header underline. Inside the feature
// the four Eisenhower quadrants each own a colour so a task's priority is legible
// at a glance in every view: the dot on a list row, the checkbox ring, and the
// board panel it sits in are all the same hue.
//
// `color` is a fill (dots, checkboxes, panel accents); `text` is the deepened
// variant that stays AA-legible as small text on the light surfaces; `tint` /
// `soft` are the low-alpha washes for panel headers and bodies.

export interface QuadrantStyle {
  id: Quadrant;
  /** Full name, e.g. 重要且紧急. */
  label: string;
  /** The action the quadrant prescribes, shown under the board panel title. */
  hint: string;
  color: string;
  text: string;
  tint: string;
  soft: string;
  border: string;
}

export const QUADRANTS: QuadrantStyle[] = [
  {
    id: 1,
    label: "重要且紧急",
    hint: "马上就做",
    color: "#D2504F",
    text: "#A63B3A",
    tint: "rgba(210,80,79,0.11)",
    soft: "rgba(210,80,79,0.045)",
    border: "rgba(210,80,79,0.24)",
  },
  {
    id: 2,
    label: "重要不紧急",
    hint: "安排时间做",
    color: "#6C5CE0",
    text: "#4C3EAE",
    tint: "rgba(108,92,224,0.11)",
    soft: "rgba(108,92,224,0.045)",
    border: "rgba(108,92,224,0.24)",
  },
  {
    id: 3,
    label: "紧急不重要",
    hint: "快速处理或交给别人",
    color: "#D08A22",
    text: "#93601A",
    tint: "rgba(208,138,34,0.13)",
    soft: "rgba(208,138,34,0.055)",
    border: "rgba(208,138,34,0.26)",
  },
  {
    id: 4,
    label: "不重要不紧急",
    hint: "有空再说",
    color: "#77808F",
    text: "#59616E",
    tint: "rgba(119,128,143,0.11)",
    soft: "rgba(119,128,143,0.045)",
    border: "rgba(119,128,143,0.24)",
  },
];

export function quadrantStyle(quadrant: Quadrant): QuadrantStyle {
  return QUADRANTS[quadrant - 1] ?? QUADRANTS[3];
}

/** Colour for a due-date chip: red once the date has passed, neutral otherwise. */
export const OVERDUE_COLOR = "#B24D4D";
export const OVERDUE_FILL = "rgba(178,77,77,0.12)";
