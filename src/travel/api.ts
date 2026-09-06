import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  fileToDataUrl,
  mimeFromPath,
  readImageBlob,
  writeImageBytes,
} from "../editor/binaryAssets";

// ── Travel data access ───────────────────────────────────────────────────────
// Real Tauri commands in the app, an in-memory fallback so `pnpm dev` renders
// and the whole flow (notes, plans, offline-map list) works in a plain browser.
// Mirrors the shape of the notes + finance modules.

/** A geotagged trip note. Coordinates are WGS-84; `rating` is 0–5 (0 = unrated). */
export interface TravelNote {
  id: string;
  title: string;
  category: string;
  lat: number | null;
  lng: number | null;
  address: string;
  rating: number;
  /** `YYYY-MM-DD` — the trip date, used to order the trajectory. */
  date: string;
  createdAt: number;
  updatedAt: number;
}

/** The editable fields of a note, sent whole on create and on metadata save. */
export interface NoteInput {
  title: string;
  category: string;
  lat: number | null;
  lng: number | null;
  address: string;
  rating: number;
  date: string;
}

export interface SavedImage {
  relPath: string;
  dataUrl: string;
}

export interface PlanStop {
  id: string;
  title: string;
  address: string;
  lat: number | null;
  lng: number | null;
  /** 1-based day within the trip (0 = unscheduled). */
  day: number;
  /** Local 24-hour times (`HH:mm`); empty means unscheduled within the day. */
  startTime: string;
  endTime: string;
  note: string;
  done: boolean;
}

export interface TravelPlan {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  notes: string;
  stops: PlanStop[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanInput {
  title: string;
  startDate: string;
  endDate: string;
  notes: string;
  stops: PlanStop[];
}

export interface TravelSettings {
  schemaVersion: number;
  /** "online" (Protomaps hosted) or the name of a downloaded offline map. */
  basemap: string;
  categories: string[];
}

export interface OfflineMap {
  name: string;
  sourceUrl: string | null;
  bytes: number;
  updatedAt: number;
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const nowSec = () => Math.floor(Date.now() / 1000);
const previewId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 10)}`;

// ── Browser-preview in-memory store ──────────────────────────────────────────
const DEFAULT_CATEGORIES = ["美食", "文化", "购物", "其他"];

const preview: {
  notes: TravelNote[];
  bodies: Map<string, string>;
  images: Map<string, string>; // `${id} ${relPath}` → data URL
  plans: TravelPlan[];
  settings: TravelSettings;
} = {
  notes: [
    {
      id: "demo-xian",
      title: "西安 · 城墙与回民街",
      category: "美食",
      lat: 34.2658,
      lng: 108.9541,
      address: "陕西省西安市",
      rating: 5,
      date: "2026-04-12",
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
    {
      id: "demo-gz",
      title: "广州 · 早茶三日",
      category: "美食",
      lat: 23.1291,
      lng: 113.2644,
      address: "广东省广州市",
      rating: 4,
      date: "2026-03-02",
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
  ],
  bodies: new Map([
    ["demo-xian", "# 西安\n\n城墙骑行一圈，回民街的**肉夹馍**和柿子饼。\n"],
    ["demo-gz", "# 广州\n\n陶陶居、点都德，早茶从早喝到晌午。\n"],
  ]),
  images: new Map(),
  plans: [],
  settings: { schemaVersion: 2, basemap: "online", categories: DEFAULT_CATEGORIES },
};

// ── Notes ─────────────────────────────────────────────────────────────────────

export async function listNotes(): Promise<TravelNote[]> {
  if (isTauri()) return invoke<TravelNote[]>("travel_list_notes");
  return [...preview.notes].sort(
    (a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt,
  );
}

export async function createNote(input: NoteInput): Promise<TravelNote> {
  if (isTauri()) return invoke<TravelNote>("travel_create_note", { input });
  const note: TravelNote = {
    ...input,
    id: previewId("note-"),
    title: input.title.trim() || "未命名旅行",
    rating: Math.min(5, input.rating),
    createdAt: nowSec(),
    updatedAt: nowSec(),
  };
  preview.notes.push(note);
  preview.bodies.set(note.id, "");
  return note;
}

export async function readNote(id: string): Promise<string> {
  if (isTauri()) return invoke<string>("travel_read_note", { id });
  return preview.bodies.get(id) ?? "";
}

export async function saveNote(id: string, content: string): Promise<void> {
  if (isTauri()) {
    await invoke("travel_save_note", { id, content });
    return;
  }
  preview.bodies.set(id, content);
  const note = preview.notes.find((item) => item.id === id);
  if (note) note.updatedAt = nowSec();
}

export async function updateNote(id: string, input: NoteInput): Promise<TravelNote> {
  if (isTauri()) return invoke<TravelNote>("travel_update_note", { id, input });
  const note = preview.notes.find((item) => item.id === id);
  if (!note) throw new Error("旅行笔记不存在。");
  Object.assign(note, input, {
    title: input.title.trim() || "未命名旅行",
    rating: Math.min(5, input.rating),
    updatedAt: nowSec(),
  });
  return { ...note };
}

export async function deleteNote(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("travel_delete_note", { id });
    return;
  }
  preview.notes = preview.notes.filter((item) => item.id !== id);
  preview.bodies.delete(id);
}

// ── Inline images (per-note assets, mirrors notes module) ─────────────────────

export async function saveNoteImage(
  id: string,
  name: string,
  dataBase64: string,
): Promise<SavedImage> {
  if (isTauri()) return invoke<SavedImage>("travel_save_note_image", { id, name, dataBase64 });
  const safe = (name || "image.png").replace(/[^\w.\-一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
  const relPath = `assets/${safe || "image.png"}`;
  const dataUrl = `data:image/png;base64,${dataBase64}`;
  preview.images.set(`${id} ${relPath}`, dataUrl);
  return { relPath, dataUrl };
}

export async function readNoteAssets(id: string, relPaths: string[]): Promise<string[]> {
  if (isTauri()) return invoke<string[]>("travel_read_note_assets", { id, relPaths });
  return relPaths.map((rel) => preview.images.get(`${id} ${rel}`) ?? "");
}

export async function saveNoteImageFile(id: string, name: string, file: File): Promise<string> {
  if (isTauri()) {
    return writeImageBytes("travel_save_note_image_bytes", id, name, file);
  }
  const dataUrl = await fileToDataUrl(file);
  const saved = await saveNoteImage(id, name, dataUrl.slice(dataUrl.indexOf(",") + 1));
  return saved.relPath;
}

export async function readNoteAssetBlob(id: string, relPath: string): Promise<Blob | null> {
  if (isTauri()) {
    try {
      return await readImageBlob(
        "travel_read_note_asset_bytes",
        { id, relPath },
        mimeFromPath(relPath),
      );
    } catch {
      return null;
    }
  }
  const dataUrl = preview.images.get(`${id} ${relPath}`);
  return dataUrl ? fetch(dataUrl).then((response) => response.blob()) : null;
}

export async function revealTravel(id?: string | null): Promise<void> {
  if (!isTauri()) return;
  const abs = await invoke<string>("travel_reveal", { id: id ?? null });
  await revealItemInDir(abs);
}

// ── Plans ─────────────────────────────────────────────────────────────────────

export async function listPlans(): Promise<TravelPlan[]> {
  if (isTauri()) return invoke<TravelPlan[]>("travel_list_plans");
  return [...preview.plans].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createPlan(input: PlanInput): Promise<TravelPlan> {
  if (isTauri()) return invoke<TravelPlan>("travel_create_plan", { input });
  const plan: TravelPlan = {
    ...input,
    id: previewId("plan-"),
    title: input.title.trim() || "未命名行程",
    createdAt: nowSec(),
    updatedAt: nowSec(),
  };
  preview.plans.push(plan);
  return plan;
}

export async function savePlan(plan: TravelPlan): Promise<TravelPlan> {
  if (isTauri()) return invoke<TravelPlan>("travel_save_plan", { plan });
  const index = preview.plans.findIndex((item) => item.id === plan.id);
  if (index < 0) throw new Error("旅行规划不存在。");
  const next = { ...plan, updatedAt: nowSec() };
  preview.plans[index] = next;
  return next;
}

export async function deletePlan(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("travel_delete_plan", { id });
    return;
  }
  preview.plans = preview.plans.filter((item) => item.id !== id);
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<TravelSettings> {
  if (isTauri()) return invoke<TravelSettings>("travel_get_settings");
  return preview.settings;
}

export async function setSettings(settings: TravelSettings): Promise<TravelSettings> {
  if (isTauri()) return invoke<TravelSettings>("travel_set_settings", { settings });
  preview.settings = { ...settings, schemaVersion: 2 };
  return preview.settings;
}

// ── Offline maps ──────────────────────────────────────────────────────────────

export async function listMaps(): Promise<OfflineMap[]> {
  if (isTauri()) return invoke<OfflineMap[]>("travel_list_maps");
  return [];
}

export async function importMap(name: string, sourcePath: string): Promise<OfflineMap> {
  if (isTauri()) return invoke<OfflineMap>("travel_import_map", { name, sourcePath });
  throw new Error("浏览器预览不支持导入离线地图。");
}

export async function downloadMap(name: string, url: string): Promise<OfflineMap> {
  if (isTauri()) return invoke<OfflineMap>("travel_download_map", { name, url });
  throw new Error("浏览器预览不支持下载离线地图。");
}

export async function updateMap(name: string): Promise<OfflineMap> {
  if (isTauri()) return invoke<OfflineMap>("travel_update_map", { name });
  throw new Error("浏览器预览不支持更新离线地图。");
}

export async function deleteMap(name: string): Promise<void> {
  if (isTauri()) {
    await invoke("travel_delete_map", { name });
    return;
  }
}

/** Read a byte range from an offline `.pmtiles`, as base64 — backs the PMTiles
 *  source that lets a selected offline map render with no network. */
export async function mapReadRange(name: string, offset: number, length: number): Promise<string> {
  return invoke<string>("travel_map_read_range", { name, offset, length });
}

export async function revealMaps(): Promise<void> {
  if (!isTauri()) return;
  await revealItemInDir(await invoke<string>("travel_reveal_maps"));
}
