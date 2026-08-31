import { useEffect, useRef } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import "./editor.css";
import { VDITOR_CDN, type EditorLang } from "./vditorAssets";

export interface MarkdownPreviewProps {
  /** Markdown to render, read-only. */
  value: string;
  accentRgb?: string;
  lang?: EditorLang;
  className?: string;
}

/**
 * Read-only Markdown renderer, sharing the exact same offline pipeline as
 * {@link MarkdownEditor} (KaTeX, mermaid, code highlighting, …). Handy for any
 * feature that needs to *show* Markdown without editing it — no network access.
 */
export function MarkdownPreview({
  value,
  accentRgb,
  lang = "zh_CN",
  className,
}: MarkdownPreviewProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    void Vditor.preview(element, value ?? "", {
      mode: "light",
      cdn: VDITOR_CDN,
      lang,
      hljs: { lineNumber: true },
      math: { engine: "KaTeX" },
    });
  }, [value, lang]);

  useEffect(() => {
    if (accentRgb) {
      ref.current?.style.setProperty("--nomi-editor-accent", accentRgb);
    }
  }, [accentRgb]);

  const classes = ["nomi-md-preview", "vditor-reset", className ?? ""].filter(Boolean).join(" ");
  return <div className={classes} ref={ref} />;
}
