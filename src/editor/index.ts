// Reusable, fully-offline Markdown editor built on vditor.
//
// Import from any feature that needs Markdown editing or rendering:
//   import { MarkdownEditor, MarkdownPreview } from "../editor";
//
// Everything runs locally — runtime assets are vendored to `/vditor` (see
// scripts/sync-vditor-assets.mjs) and no server upload/link endpoints are set.

export { MarkdownEditor } from "./MarkdownEditor";
export type { MarkdownEditorHandle, MarkdownEditorProps, UploadedImage } from "./MarkdownEditor";
export { MarkdownPreview } from "./MarkdownPreview";
export type { MarkdownPreviewProps } from "./MarkdownPreview";
export {
  EDITOR_MODE_LABELS,
  resolveToolbar,
  TOOLBAR_PRESETS,
  VDITOR_CDN,
  type EditorLang,
  type EditorMode,
  type ToolbarItem,
  type ToolbarPreset,
  type VditorOptions,
} from "./vditorAssets";
