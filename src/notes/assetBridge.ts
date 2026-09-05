import type { UploadedImage } from "../editor";
import { readNoteAssetBlob, saveNoteImage, saveNoteImageFile } from "./api";

// ── Local image round-trip ───────────────────────────────────────────────────
//
// Notes persist portable, human-readable Markdown: images are referenced by a
// path relative to the note (`assets/pic.png`) and stored in the note's folder.
// The webview can't load those relative paths directly, so while a note is open
// we swap them for short Blob URLs (display), and swap them back on save (storage).
// Each note keeps a NoteImageMap tracking that correspondence for its session.

export interface NoteImageMap {
  /** Short display URL → note-relative path (what gets written to disk). */
  byDataUrl: Map<string, string>;
  /** A freshly pasted Blob URL can display before its background write finishes. */
  pendingByUrl: Map<string, Promise<string>>;
  /** Blob URLs owned by this open editor, revoked when the editor closes. */
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

// Markdown image: `![alt](url)` or `![alt](url "title")` or `![alt](<url>)`.
const IMAGE_RE = /(!\[[^\]]*\]\()([^)]*)(\))/g;

/**
 * Replace every image URL via `fn`, preserving alt text and any `"title"`.
 * Parses the CommonMark `<...>` form (URL may contain spaces) before falling back
 * to whitespace-splitting, and re-emits the `<...>` form when the mapped URL
 * contains whitespace — so a path like `assets/my photo.png` round-trips intact.
 */
function mapImageUrls(markdown: string, fn: (url: string) => string): string {
  return markdown.replace(IMAGE_RE, (_match, open: string, inner: string, close: string) => {
    const trimmed = inner.trim();
    let url: string;
    let title: string;
    if (trimmed.startsWith("<")) {
      const end = trimmed.indexOf(">");
      if (end === -1) {
        return `${open}${inner}${close}`; // malformed — leave untouched
      }
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

/** Turn stored Markdown into short Blob URLs. Large image bytes never become
 * part of the Markdown string that Vditor parses and diffs. */
export async function hydrateForDisplay(
  notePath: string,
  markdown: string,
  map: NoteImageMap,
): Promise<string> {
  const rels = new Set<string>();
  mapImageUrls(markdown, (url) => {
    if (isLocalRef(url)) {
      rels.add(url);
    }
    return url;
  });
  if (rels.size === 0) {
    return markdown;
  }
  const relList = [...rels];
  const loaded = await Promise.all(
    relList.map(async (rel) => {
      const blob = await readNoteAssetBlob(notePath, rel);
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
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
  };
  return map[mime.toLowerCase()] ?? "png";
};

/** Persist a stray inline `data:` image (e.g. one vditor pasted itself) into the
 *  note's assets folder. Returns the relative path, or null if it isn't decodable. */
async function persistDataUrl(notePath: string, dataUrl: string): Promise<string | null> {
  // Editors emit base64 data URLs for images; that's all we need to handle.
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const [, mime, base64] = match;
  const saved = await saveNoteImage(notePath, `image.${extFromMime(mime || "image/png")}`, base64);
  return saved.relPath;
}

/** Turn display Markdown back into stored Markdown with relative `assets/…`
 * paths. Any legacy inline data image not already on disk is written first. */
export async function prepareForStorage(
  notePath: string,
  markdown: string,
  map: NoteImageMap,
): Promise<string> {
  const pending = new Set<Promise<string>>();
  const unknown = new Set<string>();
  mapImageUrls(markdown, (url) => {
    const write = map.pendingByUrl.get(url);
    if (write) pending.add(write);
    if (isDataUrl(url) && !map.byDataUrl.has(url)) {
      unknown.add(url);
    }
    return url;
  });
  await Promise.all(pending);
  for (const dataUrl of unknown) {
    const rel = await persistDataUrl(notePath, dataUrl);
    if (rel) {
      map.byDataUrl.set(dataUrl, rel);
    }
  }
  return mapImageUrls(markdown, (url) => map.byDataUrl.get(url) ?? url);
}

// Alt text sits inside `![…]`, so strip brackets/newlines that would break it.
const stem = (name: string) =>
  (name.replace(/\.[^.]+$/, "") || "图片").replace(/[[\]\r\n]/g, " ").trim() || "图片";

/**
 * MarkdownEditor `onImageUpload` for notes: copy each pasted/dropped/picked image
 * into the note's `assets/` folder. A Blob URL is returned immediately for
 * display; autosave waits for the binary background write before persisting.
 */
export async function uploadNoteImages(
  notePath: string,
  files: File[],
  map: NoteImageMap,
): Promise<UploadedImage[]> {
  return files.flatMap((file) => {
    if (!file.type.startsWith("image/")) return [];
    const displayUrl = URL.createObjectURL(file);
    map.objectUrls.add(displayUrl);
    const name = file.name || `image.${extFromMime(file.type)}`;
    const write = saveNoteImageFile(notePath, name, file);
    map.pendingByUrl.set(displayUrl, write);
    void write.then(
      (relPath) => {
        map.byDataUrl.set(displayUrl, relPath);
        map.pendingByUrl.delete(displayUrl);
      },
      () => {
        // Keep the rejected promise in the map so autosave reports an error
        // instead of ever writing a temporary blob: URL into the Markdown file.
      },
    );
    return [{ url: displayUrl, alt: stem(file.name || "图片") }];
  });
}
