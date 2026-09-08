// Shared status vocabulary for the papers board. One place defines the four
// stages a paper moves through, their colours (node fills, chips, the graph
// legend) and their ordering in the collection list and the auto-arrange tiers.

export type PaperStatus = "idea" | "planned" | "writing" | "done" | "published";

export interface StatusMeta {
  /** Full label, e.g. "正在写". */
  label: string;
  /** Base colour: node accent bar, legend dot, chip text/border source. */
  color: string;
  /** Soft translucent fill behind the node body / chip. */
  soft: string;
  /** Readable text colour on a neutral/white surface (deepened for AA). */
  text: string;
  /** One-line hint shown in the status picker. */
  hint: string;
}

export const STATUS_META: Record<PaperStatus, StatusMeta> = {
  writing: {
    label: "正在写",
    color: "#3E86E0",
    soft: "rgba(62,134,224,0.13)",
    text: "#2A67BE",
    hint: "正在动笔、持续推进的论文",
  },
  planned: {
    label: "打算写",
    color: "#9B7EDE",
    soft: "rgba(155,126,222,0.15)",
    text: "#6F53BE",
    hint: "已经决定要写、排进计划的选题",
  },
  idea: {
    label: "有潜力",
    color: "#E0A030",
    soft: "rgba(224,160,48,0.16)",
    text: "#B0791C",
    hint: "还只是想法、但有潜力的方向",
  },
  done: {
    label: "已完成",
    color: "#3E9E6E",
    soft: "rgba(62,158,110,0.15)",
    text: "#2C7B53",
    hint: "初稿写完、投稿或在审的论文",
  },
  published: {
    label: "已发表",
    color: "#C85BA0",
    soft: "rgba(200,91,160,0.15)",
    text: "#A23F79",
    hint: "已经正式发表或被接收的论文",
  },
};

/** Collection list + legend order (active work first, finished last). */
export const STATUS_ORDER: PaperStatus[] = ["writing", "planned", "idea", "done", "published"];

/** Statuses where the paper is still a candidate rather than committed work.
 *  These are the two the importance rating applies to: 打算写 and 有潜力 can each
 *  hold a dozen entries that the status alone says nothing about, so the stars
 *  are what rank them. The other three are either already underway or finished,
 *  where a priority score has nothing left to decide. */
export const RATED_STATUSES = new Set<PaperStatus>(["planned", "idea"]);

/** Left→right tiers used by the graph's auto-arrange (idea → … → published pipeline). */
export const PIPELINE_ORDER: PaperStatus[] = ["idea", "planned", "writing", "done", "published"];

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[(status as PaperStatus) in STATUS_META ? (status as PaperStatus) : "idea"];
}

export function isPaperStatus(value: string): value is PaperStatus {
  return value in STATUS_META;
}

/** A venue badge's colours. Same shape as {@link StatusMeta}'s colour trio: a
 *  soft translucent fill, a deepened text colour that stays readable on it, and
 *  a faint border that gives the pill an edge. */
export interface VenueStyle {
  soft: string;
  text: string;
  border: string;
}

/** Curated swatches for venue badges. Each journal / conference name is hashed
 *  onto one of these so the same venue always reads in the same colour without
 *  anyone assigning them by hand — the list becomes colour-coded at a glance.
 *  The hues echo the muted, translucent palette the status chips already use. */
const VENUE_PALETTE: VenueStyle[] = [
  { soft: "rgba(62,134,224,0.13)", text: "#2A67BE", border: "rgba(62,134,224,0.30)" }, // blue
  { soft: "rgba(62,158,110,0.14)", text: "#2C7B53", border: "rgba(62,158,110,0.30)" }, // green
  { soft: "rgba(224,160,48,0.16)", text: "#A9741A", border: "rgba(224,160,48,0.32)" }, // amber
  { soft: "rgba(200,91,160,0.14)", text: "#A23F79", border: "rgba(200,91,160,0.30)" }, // pink
  { soft: "rgba(155,126,222,0.15)", text: "#6F53BE", border: "rgba(155,126,222,0.30)" }, // violet
  { soft: "rgba(56,168,178,0.15)", text: "#1F7C86", border: "rgba(56,168,178,0.32)" }, // teal
  { soft: "rgba(224,112,64,0.15)", text: "#BC5A28", border: "rgba(224,112,64,0.32)" }, // orange
  { soft: "rgba(90,120,200,0.14)", text: "#3F5AAE", border: "rgba(90,120,200,0.30)" }, // indigo
  { soft: "rgba(120,168,72,0.15)", text: "#5C7C24", border: "rgba(120,168,72,0.32)" }, // olive
  { soft: "rgba(210,90,90,0.14)", text: "#B0413F", border: "rgba(210,90,90,0.30)" }, // red
];

/** Stable per-venue swatch. A trimmed, case-folded venue string is hashed so
 *  "NeurIPS" and "neurips " land on the same colour; empty stays neutral (the
 *  badge isn't rendered for empty venues anyway). */
export function venueStyle(venue: string): VenueStyle {
  const key = venue.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return VENUE_PALETTE[Math.abs(hash) % VENUE_PALETTE.length];
}
