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

/** Left→right tiers used by the graph's auto-arrange (idea → … → published pipeline). */
export const PIPELINE_ORDER: PaperStatus[] = ["idea", "planned", "writing", "done", "published"];

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[(status as PaperStatus) in STATUS_META ? (status as PaperStatus) : "idea"];
}

export function isPaperStatus(value: string): value is PaperStatus {
  return value in STATUS_META;
}
