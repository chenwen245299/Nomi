import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { PaperStatus } from "./constants";

// ── Papers data access ───────────────────────────────────────────────────────
// Real Tauri commands in the app, an in-memory fallback so `pnpm dev` renders
// and the whole flow (graph, edges, body editor) works in a plain browser.
// Mirrors the shape of the notes + travel modules.

/** A paper node: its metadata and position on the relationship graph. */
export interface Paper {
  id: string;
  title: string;
  status: PaperStatus;
  /** Target venue / journal (e.g. "NeurIPS 2026"). */
  venue: string;
  tags: string[];
  /** Importance, 1–5 stars; 0 = unrated. Used to rank 打算写 / 有潜力 within
   *  their group, where a status alone says nothing about which to start next. */
  rating: number;
  x: number;
  y: number;
  createdAt: number;
  updatedAt: number;
}

/** A directed relationship between two papers (from → to). */
export interface PaperEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface PapersGraph {
  schemaVersion: number;
  papers: Paper[];
  edges: PaperEdge[];
}

/** The editable fields of a paper, sent whole on create and on metadata save. */
export interface PaperInput {
  title: string;
  status: PaperStatus;
  venue: string;
  tags: string[];
  rating: number;
  x: number;
  y: number;
}

export interface SavedImage {
  relPath: string;
  dataUrl: string;
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Mirrors the backend's clamp, so the browser preview behaves the same. */
const clampRating = (rating: number) => Math.min(5, Math.max(0, Math.round(rating || 0)));
const nowSec = () => Math.floor(Date.now() / 1000);
const previewId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 10)}`;

// ── Browser-preview in-memory store ──────────────────────────────────────────
const preview: {
  papers: Paper[];
  edges: PaperEdge[];
  bodies: Map<string, string>;
  images: Map<string, string>; // `${id} ${relPath}` → data URL
} = {
  papers: [
    {
      id: "demo-diffusion",
      title: "扩散模型的可控生成综述",
      status: "writing",
      venue: "TPAMI (计划投稿)",
      tags: ["diffusion", "survey"],
      rating: 0,
      x: 40,
      y: -60,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
    {
      id: "demo-rlhf",
      title: "RLHF 中的奖励建模",
      status: "planned",
      venue: "NeurIPS 2026",
      tags: ["rlhf", "alignment"],
      rating: 4,
      x: 320,
      y: 40,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
    {
      id: "demo-agent",
      title: "长时程 Agent 的记忆机制",
      status: "idea",
      venue: "",
      tags: ["agent", "memory"],
      rating: 5,
      x: -220,
      y: 120,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
    {
      id: "demo-quant",
      title: "低比特量化的训练稳定性",
      status: "done",
      venue: "ICML 2025",
      tags: ["quantization"],
      rating: 0,
      x: 60,
      y: 220,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
  ],
  edges: [
    { id: "e1", from: "demo-agent", to: "demo-rlhf", label: "延伸" },
    { id: "e2", from: "demo-rlhf", to: "demo-diffusion", label: "对比" },
    { id: "e3", from: "demo-quant", to: "demo-diffusion", label: "复用方法" },
  ],
  bodies: new Map([
    [
      "demo-diffusion",
      "# 扩散模型的可控生成综述\n\n## 大纲\n\n1. 背景与动机\n2. 条件生成的分类\n3. 无训练 vs 训练式控制\n4. 评测与开放问题\n",
    ],
  ]),
  images: new Map(),
};

// ── Graph ─────────────────────────────────────────────────────────────────────

export async function loadGraph(): Promise<PapersGraph> {
  if (isTauri()) return invoke<PapersGraph>("papers_load_graph");
  return {
    schemaVersion: 1,
    papers: preview.papers.map((p) => ({ ...p })),
    edges: preview.edges.map((e) => ({ ...e })),
  };
}

export async function createPaper(input: PaperInput): Promise<Paper> {
  if (isTauri()) return invoke<Paper>("papers_create_paper", { input });
  const paper: Paper = {
    ...input,
    id: previewId("paper-"),
    title: input.title.trim() || "未命名论文",
    rating: clampRating(input.rating),
    createdAt: nowSec(),
    updatedAt: nowSec(),
  };
  preview.papers.push(paper);
  preview.bodies.set(paper.id, "");
  return { ...paper };
}

export async function updatePaper(id: string, input: PaperInput): Promise<Paper> {
  if (isTauri()) return invoke<Paper>("papers_update_paper", { id, input });
  const paper = preview.papers.find((p) => p.id === id);
  if (!paper) throw new Error("论文不存在。");
  Object.assign(paper, {
    title: input.title.trim() || "未命名论文",
    status: input.status,
    venue: input.venue.trim(),
    tags: input.tags,
    rating: clampRating(input.rating),
    updatedAt: nowSec(),
  });
  return { ...paper };
}

export async function movePaper(id: string, x: number, y: number): Promise<void> {
  if (isTauri()) {
    await invoke("papers_move_paper", { id, x, y });
    return;
  }
  const paper = preview.papers.find((p) => p.id === id);
  if (paper) {
    paper.x = x;
    paper.y = y;
  }
}

export async function deletePaper(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("papers_delete_paper", { id });
    return;
  }
  preview.papers = preview.papers.filter((p) => p.id !== id);
  preview.edges = preview.edges.filter((e) => e.from !== id && e.to !== id);
  preview.bodies.delete(id);
}

export async function readBody(id: string): Promise<string> {
  if (isTauri()) return invoke<string>("papers_read_body", { id });
  return preview.bodies.get(id) ?? "";
}

export async function saveBody(id: string, content: string): Promise<void> {
  if (isTauri()) {
    await invoke("papers_save_body", { id, content });
    return;
  }
  preview.bodies.set(id, content);
  const paper = preview.papers.find((p) => p.id === id);
  if (paper) paper.updatedAt = nowSec();
}

// ── Edges ─────────────────────────────────────────────────────────────────────

export async function addEdge(from: string, to: string, label = ""): Promise<PaperEdge> {
  if (isTauri()) return invoke<PaperEdge>("papers_add_edge", { from, to, label });
  if (from === to) throw new Error("不能连接到论文自身。");
  const existing = preview.edges.find(
    (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
  );
  if (existing) return { ...existing };
  const edge: PaperEdge = { id: previewId("edge-"), from, to, label };
  preview.edges.push(edge);
  return { ...edge };
}

export async function updateEdge(id: string, label: string): Promise<void> {
  if (isTauri()) {
    await invoke("papers_update_edge", { id, label });
    return;
  }
  const edge = preview.edges.find((e) => e.id === id);
  if (edge) edge.label = label;
}

export async function deleteEdge(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("papers_delete_edge", { id });
    return;
  }
  preview.edges = preview.edges.filter((e) => e.id !== id);
}

// ── Inline images (per-paper assets, mirrors notes/travel) ────────────────────

export async function saveNoteImage(
  id: string,
  name: string,
  dataBase64: string,
): Promise<SavedImage> {
  if (isTauri()) return invoke<SavedImage>("papers_save_image", { id, name, dataBase64 });
  const safe = (name || "image.png").replace(/[^\w.\-一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
  const relPath = `assets/${safe || "image.png"}`;
  const dataUrl = `data:image/png;base64,${dataBase64}`;
  preview.images.set(`${id} ${relPath}`, dataUrl);
  return { relPath, dataUrl };
}

export async function readNoteAssets(id: string, relPaths: string[]): Promise<string[]> {
  if (isTauri()) return invoke<string[]>("papers_read_assets", { id, relPaths });
  return relPaths.map((rel) => preview.images.get(`${id} ${rel}`) ?? "");
}

export async function revealPaper(id?: string | null): Promise<void> {
  if (!isTauri()) return;
  const abs = await invoke<string>("papers_reveal", { id: id ?? null });
  await revealItemInDir(abs);
}
