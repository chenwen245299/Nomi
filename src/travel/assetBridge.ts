import type { UploadedImage } from "../editor";
import { readNoteAssetBlob, saveNoteImage, saveNoteImageFile } from "./api";

// ── Local image round-trip (mirrors src/notes/assetBridge) ────────────────────
//
// Travel notes persist portable Markdown: images are referenced by a path
// relative to the note (`assets/pic.png`) and stored in the note's folder. The
// webview can't load those relative paths, so while a note is open we swap them
// for short Blob URLs (display) and swap them back on save (storage). Each open note
// keeps a map tracking that correspondence for its session.

export interface NoteImageMap {
  byDataUrl: Map<string, string>;
  pendingByUrl: Map<string, Promise<string>>;
  objectUrls: Set<string>;
}

export function createImageMap(): NoteImageMap {
  return { byDataUrl: new Map(), pendingByUrl: new Map(), objectUrls: new Set() };
}

export function disposeImageMap(map: NoteImageMap): void {
  for (const url of map.objectUrls) URL.revokeObjectURL(url);
  map.objectUrls.clear();
  map.byDataUrl.clear();
  map.pendingByUrl.clear();
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
  const loaded = await Promise.all(
    relList.map(async (rel) => {
      const blob = await readNoteAssetBlob(noteId, rel);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      map.objectUrls.add(url);
      map.byDataUrl.set(url, rel);
      return [rel, url] as const;
    }),
  );
  const relToDisplay = new Map(loaded.filter((item) => item !== null));
  return mapImageUrls(markdown, (url) => relToDisplay.get(url) ?? url);
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
  const pending = new Set<Promise<string>>();
  const unknown = new Set<string>();
  mapImageUrls(markdown, (url) => {
    const write = map.pendingByUrl.get(url);
    if (write) pending.add(write);
    if (isDataUrl(url) && !map.byDataUrl.has(url)) unknown.add(url);
    return url;
  });
  await Promise.all(pending);
  for (const dataUrl of unknown) {
    const rel = await persistDataUrl(noteId, dataUrl);
    if (rel) map.byDataUrl.set(dataUrl, rel);
  }
  return mapImageUrls(markdown, (url) => map.byDataUrl.get(url) ?? url);
}

const stem = (name: string) =>
  (name.replace(/\.[^.]+$/, "") || "图片").replace(/[[\]\r\n]/g, " ").trim() || "图片";

/** Show a short Blob URL immediately while the original bytes persist in the
 * background. This keeps large screenshots out of Vditor's Markdown parser. */
export async function uploadNoteImages(
  noteId: string,
  files: File[],
  map: NoteImageMap,
): Promise<UploadedImage[]> {
  return files.flatMap((file) => {
    if (!file.type.startsWith("image/")) return [];
    const displayUrl = URL.createObjectURL(file);
    map.objectUrls.add(displayUrl);
    const name = file.name || `image.${extFromMime(file.type)}`;
    const write = saveNoteImageFile(noteId, name, file);
    map.pendingByUrl.set(displayUrl, write);
    void write.then(
      (relPath) => {
        map.byDataUrl.set(displayUrl, relPath);
        map.pendingByUrl.delete(displayUrl);
      },
      () => {},
    );
    return [{ url: displayUrl, alt: stem(file.name || "图片") }];
  });
}
