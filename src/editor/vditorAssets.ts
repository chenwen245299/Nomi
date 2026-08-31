import type Vditor from "vditor";

// ── Reusable Markdown editor: shared vditor configuration ────────────────────
//
// This module centralises everything about how Nomi drives vditor so that every
// feature (notes today, others later) gets the same offline-first, network-free
// editor by importing from `src/editor`.

/** Options accepted by the Vditor constructor. Derived from the class so we never
 *  depend on vditor's ambiently-declared global interface names. */
export type VditorOptions = NonNullable<ConstructorParameters<typeof Vditor>[1]>;
export type ToolbarItem = NonNullable<VditorOptions["toolbar"]>[number];
export type EditorLang = NonNullable<VditorOptions["lang"]>;

/** The three editing surfaces vditor offers, all fully client-side. */
export type EditorMode = "wysiwyg" | "ir" | "sv";

export const EDITOR_MODE_LABELS: Record<EditorMode, string> = {
  wysiwyg: "所见即所得",
  ir: "即时渲染",
  sv: "分屏预览",
};

/**
 * Base URL of the vendored vditor runtime assets (Lute — its parser, icons,
 * i18n, highlight.js, KaTeX, mermaid, ECharts …). vditor appends "/dist/…" to
 * this, so "/vditor" resolves to `public/vditor/dist/…` — served locally in dev
 * and bundled into the Tauri app by Vite. Setting this is exactly what makes the
 * editor fully OFFLINE: nothing is ever fetched from unpkg.com.
 *
 * The tree is produced by `scripts/sync-vditor-assets.mjs` (install / dev / build).
 */
export const VDITOR_CDN = "/vditor";

/** Named toolbar layouts. `full` exposes the complete local feature set (mode
 *  switcher, outline, preview, themes, export). Networked items (help/info links,
 *  server upload/record) are intentionally omitted — nothing here calls out. */
export const TOOLBAR_PRESETS = {
  minimal: [
    "headings",
    "bold",
    "italic",
    "strike",
    "|",
    "list",
    "ordered-list",
    "check",
    "|",
    "quote",
    "code",
    "inline-code",
    "link",
    "|",
    "undo",
    "redo",
  ],
  standard: [
    "emoji",
    "headings",
    "bold",
    "italic",
    "strike",
    "link",
    "|",
    "list",
    "ordered-list",
    "check",
    "outdent",
    "indent",
    "|",
    "quote",
    "line",
    "code",
    "inline-code",
    "insert-before",
    "insert-after",
    "|",
    "upload",
    "table",
    "|",
    "undo",
    "redo",
    "|",
    "edit-mode",
    "preview",
    "outline",
    "fullscreen",
  ],
  full: [
    "emoji",
    "headings",
    "bold",
    "italic",
    "strike",
    "link",
    "|",
    "list",
    "ordered-list",
    "check",
    "outdent",
    "indent",
    "|",
    "quote",
    "line",
    "code",
    "inline-code",
    "insert-before",
    "insert-after",
    "|",
    "upload",
    "table",
    "|",
    "undo",
    "redo",
    "|",
    "fullscreen",
    "edit-mode",
    "both",
    "preview",
    "outline",
    "code-theme",
    "content-theme",
    "export",
  ],
} satisfies Record<string, ToolbarItem[]>;

export type ToolbarPreset = keyof typeof TOOLBAR_PRESETS;

/** Resolve a preset name or an explicit item list to a concrete toolbar array. */
export function resolveToolbar(toolbar: ToolbarPreset | ToolbarItem[]): ToolbarItem[] {
  return Array.isArray(toolbar) ? toolbar : TOOLBAR_PRESETS[toolbar];
}
