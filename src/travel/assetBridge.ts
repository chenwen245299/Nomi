import type { UploadedImage } from "../editor";
import { readNoteAssets, saveNoteImage } from "./api";

// ── Local image round-trip (mirrors src/notes/assetBridge) ────────────────────
//
// Travel notes persist portable Markdown: images are referenced by a path
// relative to the note (`assets/pic.png`) and stored in the note's folder. The
// webview can't load those relative paths, so while a note is open we swap them
// for `data:` URLs (display) and swap them back on save (storage). Each open note
// keeps a map tracking that correspondence for its session.

export interface NoteImageMap {
  byDataUrl: Map<string, string>;
}

export function createImageMap(): NoteImageMap {
  return { byDataUrl: new Map() };
}

const IMAGE_RE = /(!\[[^\]]*\]\()([^)]*)(\))/g;

function mapImageUrls(markdown: string, fn: (url: string) => string): string {
  return markdown.replace(IMAGE_RE, (_match, open: string, inner: string, close: string) => {
    const trimmed = inner.trim();
    let url: string;
    let title: string;
    if (trimmed.startsWith("<")) {
      const end = trimmed.indexOf(">");
      if (end === -1) return `${open}${inner}${close}`;
      url = trimmed.slice(1, end);
      title = trimmed.slice(end + 1).trim();
    } else {
      const space = trimmed.search(/\s/);
      url = space === -1 ? trimmed : trimmed.slice(0, space);
      title = space === -1 ? "" : trimmed.slice(space).trim();
    }
    const mapped = fn(url);
    const encoded = /\s/.test(mapped) ? `<${mapped}>` : mapped;
    return `${open}${encoded}${title ? ` ${title}` : ""}${close}`;
  });
}

const isLocalRef = (url: string) => !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("/");
const isDataUrl = (url: string) => url.startsWith("data:");

export async function hydrateForDisplay(
  noteId: string,
  markdown: string,
  map: NoteImageMap,
): Promise<string> {
  const rels = new Set<string>();
  mapImageUrls(markdown, (url) => {
    if (isLocalRef(url)) rels.add(url);
    return url;
  });
  if (rels.size === 0) return markdown;
  const relList = [...rels];
  const dataUrls = await readNoteAssets(noteId, relList);
  const relToData = new Map<string, string>();
  relList.forEach((rel, index) => {
    const dataUrl = dataUrls[index];
    if (dataUrl) {
      relToData.set(rel, dataUrl);
      map.byDataUrl.set(dataUrl, rel);
    }
  });
  return mapImageUrls(markdown, (url) => relToData.get(url) ?? url);
}

const extFromMime = (mime: string): string => {
  const table: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
  };
  return table[mime.toLowerCase()] ?? "png";
};

async function persistDataUrl(noteId: string, dataUrl: string): Promise<string | null> {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, mime, base64] = match;
  const saved = await saveNoteImage(noteId, `image.${extFromMime(mime || "image/png")}`, base64);
  return saved.relPath;
}

export async function prepareForStorage(
  noteId: string,
  markdown: string,
  map: NoteImageMap,
): Promise<string> {
  const unknown = new Set<string>();
  mapImageUrls(markdown, (url) => {
    if (isDataUrl(url) && !map.byDataUrl.has(url)) unknown.add(url);
    return url;
  });
  for (const dataUrl of unknown) {
    const rel = await persistDataUrl(noteId, dataUrl);
    if (rel) map.byDataUrl.set(dataUrl, rel);
  }
  return mapImageUrls(markdown, (url) => map.byDataUrl.get(url) ?? url);
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });

const stem = (name: string) =>
  (name.replace(/\.[^.]+$/, "") || "图片").replace(/[[\]\r\n]/g, " ").trim() || "图片";

/** MarkdownEditor `onImageUpload` for travel notes: copy each pasted/dropped/
 *  picked image into the note's `assets/` folder, hand back a `data:` URL. */
export async function uploadNoteImages(
  noteId: string,
  files: File[],
  map: NoteImageMap,
): Promise<UploadedImage[]> {
  const out: UploadedImage[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const dataUrl = await readAsDataUrl(file);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const name = file.name || `image.${extFromMime(file.type)}`;
    const saved = await saveNoteImage(noteId, name, base64);
    map.byDataUrl.set(saved.dataUrl, saved.relPath);
    out.push({ url: saved.dataUrl, alt: stem(file.name || "图片") });
  }
  return out;
}
