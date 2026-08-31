// Off-screen Markdown → PDF/PNG renderer for the `create_markdown_document`
// tool. The backend can't render HTML with high fidelity, so it emits a
// `renderRequest` over the chat channel and this module renders the Markdown in
// the webview — the one place with a fully-offline, CJK + KaTeX + tables + code
// pipeline (vditor, assets vendored under public/vditor) — then hands the bytes
// back. It runs from `chatRuntime.handleStreamEvent` at module scope, so it
// works even when no conversation view is mounted.
//
// Security: the Markdown is authored by a remote model and the app's CSP is
// null, so an untrusted document must not be able to beacon out. Defenses:
//  1. Diagram code fences that run a third-party renderer (mermaid, plantuml,
//     echarts, …) are neutralised to inert code blocks BEFORE rendering. This is
//     the key control: vditor initialises mermaid at securityLevel:"loose" on the
//     global document, so a mermaid diagram could otherwise inject a remote
//     <image> that the browser fetches immediately, outside our reach.
//  2. vditor's XSS filter is on, and we strip every auto-loading remote
//     reference (remote <img>/<source>/<link>/<image>, media, inline url()) both
//     via the transform hook (pre-insertion) and after render.
//  3. Rasterisation uses html2canvas (walks the already-painted DOM), which
//     neither fetches @font-face/@import nor loads the SVG-<foreignObject> that
//     WKWebView (Tauri/macOS) hangs on — the latter is why html-to-image is not used.
// KaTeX and highlight.js are pure local HTML/CSS and are kept.

import Vditor from "vditor";
import "vditor/dist/index.css";
import { VDITOR_CDN } from "../editor/vditorAssets";

export interface RenderedFiles {
  pdfBase64?: string;
  pngBase64?: string;
  error?: string;
}

/** Content-box width (px) of a page at 96 DPI — matches jsPDF's `unit: "px"`. */
const PAGE_WIDTH_PX: Record<string, number> = { a4: 794, letter: 816 };
/** Cap the rasterised canvas area so a very long document can't exhaust memory. */
const MAX_CANVAS_PIXELS = 40_000_000;
/** Cap a single canvas dimension — WebKit/WKWebView silently blanks a canvas
 *  whose width or height exceeds ~16,384px. */
const MAX_CANVAS_SIDE = 16_000;
/** Code-fence languages vditor auto-renders with a third-party engine that can
 *  reach the network or execute complex untrusted input. Neutralised to `text`. */
const EXECUTABLE_FENCE_LANGS = new Set([
  "mermaid",
  "echarts",
  "mindmap",
  "plantuml",
  "abc",
  "graphviz",
  "flowchart",
  "flowchartjs",
]);

/** Convert executable-diagram code fences to inert `text` fences so no
 *  third-party renderer runs on untrusted model output. Errs toward
 *  over-neutralising (safety) rather than perfect fence parsing. */
function neutralizeDiagramFences(markdown: string): string {
  return markdown.replace(
    /^([ \t]*)(`{3,}|~{3,})[ \t]*([A-Za-z][\w-]*)([^\n]*)$/gm,
    (line, indent, fence, lang) =>
      EXECUTABLE_FENCE_LANGS.has(String(lang).toLowerCase()) ? `${indent}${fence}text` : line,
  );
}

function isRemoteUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return /^https?:/i.test(trimmed) || trimmed.startsWith("//");
}

/** Remove every reference the browser would auto-fetch (remote images, media,
 *  stylesheets, SVG images, non-data inline `url()`), so rendering makes no
 *  network call. */
function stripRemoteRefs(root: ParentNode): void {
  root.querySelectorAll("img").forEach((el) => {
    if (isRemoteUrl(el.getAttribute("src"))) el.removeAttribute("src");
    el.removeAttribute("srcset");
    el.removeAttribute("loading");
  });
  root
    .querySelectorAll("source, link, style, iframe, object, embed, video, audio")
    .forEach((el) => el.remove());
  root.querySelectorAll("image").forEach((el) => {
    const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
    if (isRemoteUrl(href)) el.remove();
  });
  root.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const style = el.getAttribute("style") ?? "";
    // Strip any url() that isn't a data: URL. Matching on the literal `url(`
    // token catches CSS hex-escaped remote URLs (e.g. `url(\68 ttps://…)`) that a
    // scheme regex would miss, since html-to-image reads de-escaped computed styles.
    if (/url\(/i.test(style)) {
      el.setAttribute("style", style.replace(/url\(\s*(['"]?)(?!\s*data:)[^)]*\)/gi, "none"));
    }
  });
}

/** vditor `transform` hook: sanitise the parsed HTML string before it is
 *  inserted into the DOM, so remote references never even start loading. */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  stripRemoteRefs(doc);
  return doc.body.innerHTML;
}

function nextFrame(): Promise<void> {
  // Resolve on the next paint, but fall back to a timer so a throttled/paused
  // rAF (e.g. an off-screen or backgrounded webview) can never stall the render.
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(done);
    setTimeout(done, 60);
  });
}

/** Reject with a labelled error if `promise` hasn't settled within `ms`, so no
 *  single stage can hang past the backend's render timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Await font loading, but never block on it — a perpetually-pending FontFaceSet
 *  must not hang the whole render. */
async function fontsReady(ms: number): Promise<void> {
  try {
    await withTimeout(Promise.resolve(document.fonts?.ready), ms, "字体加载");
  } catch {
    // Best-effort: proceed with whatever fonts are available.
  }
}

/** Wait until fonts are loaded and KaTeX math has rendered, so the capture isn't
 *  taken before the async work finishes — vditor's `preview` promise resolves
 *  before KaTeX (loaded via two chained async script fetches) paints, which on a
 *  cold start can exceed a fixed delay and capture raw `$...$` source. Bounded,
 *  never hangs. (Executable diagrams are neutralised upstream, so only math is
 *  gated here.) */
async function waitForRenderSettle(host: HTMLElement): Promise<void> {
  await fontsReady(3_000);
  const deadline = Date.now() + 5_000;
  // A math node is done once vditor marks it (data-math) or a .katex child exists;
  // an errored formula (.vditor-reset--error) is also "done" so it can't burn 5s.
  const mathPending = () =>
    Array.from(host.querySelectorAll(".language-math")).filter(
      (el) =>
        !el.hasAttribute("data-math") &&
        !el.querySelector(".katex") &&
        !el.classList.contains("vditor-reset--error"),
    ).length;
  while (Date.now() < deadline && mathPending() > 0) {
    await nextFrame();
  }
  // Web fonts KaTeX requested while rendering must be painted before capture.
  await fontsReady(2_000);
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取渲染结果失败"));
    reader.readAsDataURL(blob);
  });
}

/** Slice a tall canvas into page-height chunks and assemble a paginated PDF. */
async function canvasToPdfBase64(
  canvas: HTMLCanvasElement,
  pageSize: string,
  title: string,
): Promise<string> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    unit: "px",
    format: pageSize === "letter" ? "letter" : "a4",
    orientation: "portrait",
    compress: true,
  });
  if (title.trim()) doc.setProperties({ title: title.trim() });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  // Canvas pixels per PDF pixel (canvas width maps to the full page width).
  const scale = canvas.width / pageWidth;
  const pageSliceHeight = Math.max(1, Math.floor(pageHeight * scale));

  let rendered = 0;
  let firstPage = true;
  const slice = document.createElement("canvas");
  const ctx = slice.getContext("2d");
  if (!ctx) throw new Error("无法创建绘制上下文");

  while (rendered < canvas.height) {
    const sliceHeight = Math.min(pageSliceHeight, canvas.height - rendered);
    slice.width = canvas.width;
    slice.height = sliceHeight;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, rendered, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
    const dataUrl = slice.toDataURL("image/jpeg", 0.92);
    if (!firstPage) doc.addPage();
    firstPage = false;
    doc.addImage(dataUrl, "JPEG", 0, 0, pageWidth, sliceHeight / scale);
    rendered += sliceHeight;
  }
  return arrayBufferToBase64(doc.output("arraybuffer"));
}

/**
 * Render `markdown` to the requested formats in an off-screen host and return
 * the bytes (base64). Always cleans up the host; on failure returns `{ error }`
 * so the backend tool gets a definite answer.
 */
export async function renderMarkdownToFiles(
  markdown: string,
  formats: string[],
  pageSize: string,
  title: string,
  onStage?: (stage: string) => void,
): Promise<RenderedFiles> {
  const stage = (s: string) => {
    console.log(`[md-export] ${s}`);
    onStage?.(s);
  };
  const width = PAGE_WIDTH_PX[pageSize] ?? PAGE_WIDTH_PX.a4;
  const host = document.createElement("div");
  host.className = "vditor-reset";
  // Off-screen but fully painted (NOT display:none / opacity:0, which would give
  // an empty capture). box-sizing keeps the total width equal to the page width.
  host.style.cssText = [
    "position:fixed",
    "left:-99999px",
    "top:0",
    `width:${width}px`,
    "box-sizing:border-box",
    "padding:40px 48px",
    "margin:0",
    "background:#ffffff",
    "color:#1f2329",
    "font-size:15px",
    "line-height:1.7",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");
  document.body.appendChild(host);

  try {
    // vditor loads the Lute parser + i18n before resolving; time-box it so a
    // stalled asset load surfaces as a clear staged error, not a silent hang.
    stage("vditor 渲染");
    await withTimeout(
      Vditor.preview(host, neutralizeDiagramFences(markdown), {
        mode: "light",
        cdn: VDITOR_CDN,
        lang: "zh_CN",
        hljs: { lineNumber: true, style: "github" },
        math: { engine: "KaTeX" },
        markdown: { sanitize: true },
        transform: sanitizeHtml,
      }),
      15_000,
      "vditor 渲染",
    );
    stripRemoteRefs(host);
    stage("等待字体/公式");
    await waitForRenderSettle(host);
    stripRemoteRefs(host);

    // Rasterise with html2canvas (walks the DOM and paints to a canvas). We use it
    // instead of the SVG-<foreignObject> approach because WKWebView (Tauri on
    // macOS) frequently fails or hangs loading a foreignObject SVG into an image.
    stage("加载 html2canvas");
    const html2canvas = (await import("html2canvas")).default;
    const contentWidth = host.offsetWidth || width;
    const contentHeight = host.scrollHeight || host.offsetHeight || width;
    let pixelRatio = 2;
    // Bound total area (memory) …
    const projected = contentWidth * contentHeight * pixelRatio * pixelRatio;
    if (projected > MAX_CANVAS_PIXELS) {
      pixelRatio = Math.max(1, pixelRatio * Math.sqrt(MAX_CANVAS_PIXELS / projected));
    }
    // … and each single side (WKWebView blanks a canvas past ~16,384px). A very
    // tall document therefore downscales rather than silently rendering blank.
    const longestSide = Math.max(contentWidth, contentHeight) * pixelRatio;
    if (longestSide > MAX_CANVAS_SIDE) {
      pixelRatio = Math.max(0.5, pixelRatio * (MAX_CANVAS_SIDE / longestSide));
    }
    stage("html2canvas 截图");
    const canvas = await withTimeout(
      html2canvas(host, {
        scale: pixelRatio,
        backgroundColor: "#ffffff",
        logging: false,
        useCORS: false,
        // Capture the host's own box from its origin; the clone is repositioned to
        // 0,0 so the off-screen `left:-99999px` doesn't shift the capture region.
        width: contentWidth,
        height: contentHeight,
        windowWidth: contentWidth,
        windowHeight: contentHeight + 200,
        x: 0,
        y: 0,
        scrollX: 0,
        scrollY: 0,
        onclone: (_doc: Document, clone: HTMLElement) => {
          clone.style.left = "0";
          clone.style.top = "0";
        },
      }),
      15_000,
      "html2canvas 截图",
    );
    if (!canvas.width || !canvas.height) {
      throw new Error("渲染结果为空（内容可能过长或无法绘制）");
    }

    const out: RenderedFiles = {};
    if (formats.includes("pdf")) {
      stage("生成 PDF");
      out.pdfBase64 = await withTimeout(
        canvasToPdfBase64(canvas, pageSize, title),
        15_000,
        "生成 PDF",
      );
    }
    if (formats.includes("png")) {
      stage("生成 PNG");
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((value) => resolve(value), "image/png"),
      );
      if (!blob) throw new Error("PNG 编码失败");
      out.pngBase64 = await blobToBase64(blob);
    }
    if (!out.pdfBase64 && !out.pngBase64) {
      return { error: "未生成任何文件（formats 为空？）" };
    }
    return out;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    host.remove();
  }
}
