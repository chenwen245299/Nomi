import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import "./editor.css";
import {
  resolveToolbar,
  VDITOR_CDN,
  type EditorLang,
  type EditorMode,
  type ToolbarItem,
  type ToolbarPreset,
  type VditorOptions,
} from "./vditorAssets";

type UploadHandler = NonNullable<NonNullable<VditorOptions["upload"]>["handler"]>;

// Lute/Vditor does not consistently recognise a task marker with no content
// after it when a document is parsed again. Give only those empty task lines an
// invisible editor-side character, then remove it at every public/save boundary
// so the Markdown file remains plain `- [ ]`.
const EMPTY_TASK_PLACEHOLDER = "\u200B";
const EMPTY_TASK_LINE = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\])[ \t]*(?=\r?$)/gm;
const PLACEHOLDER_AFTER_TASK = new RegExp(
  `^([ \\t]*(?:[-+*]|\\d+[.)])[ \\t]+\\[[ xX]\\][ \\t]*)${EMPTY_TASK_PLACEHOLDER}`,
  "gm",
);

function prepareMarkdownForEditor(markdown: string): string {
  return markdown.replace(EMPTY_TASK_LINE, `$1 ${EMPTY_TASK_PLACEHOLDER}`);
}

function cleanMarkdownFromEditor(markdown: string): string {
  return markdown.replace(PLACEHOLDER_AFTER_TASK, "$1").replace(EMPTY_TASK_LINE, "$1");
}

/** One image the host resolved for an upload/paste/drop. `url` is whatever the
 * editor should reference in `![alt](url)` — normally a short local Blob URL
 * while the host persists its portable on-disk relative path. */
export interface UploadedImage {
  url: string;
  alt?: string;
}

/** Imperative handle for hosts that need to read/drive the editor directly. */
export interface MarkdownEditorHandle {
  getValue(): string;
  setValue(markdown: string, clearStack?: boolean): void;
  insertValue(markdown: string): void;
  focus(): void;
  blur(): void;
  getMode(): EditorMode | null;
  /** Escape hatch: the underlying Vditor instance (null until init finishes). */
  getInstance(): Vditor | null;
}

export interface MarkdownEditorProps {
  /** Initial Markdown, applied once on mount. To load a *different* document,
   *  change the component `key` so it remounts — this is cursor- and undo-safe. */
  value?: string;
  /** Initial editing surface. Default: "wysiwyg". */
  mode?: EditorMode;
  /** Toolbar preset name or an explicit item list. Default: "full". */
  toolbar?: ToolbarPreset | ToolbarItem[];
  placeholder?: string;
  minHeight?: number;
  /** Fixed height for embedded use. Omit to fill (and scroll within) the parent. */
  height?: number | string;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** RGB triplet (e.g. "224,149,43") that tints the editor chrome to the host accent. */
  accentRgb?: string;
  lang?: EditorLang;
  onChange?: (markdown: string) => void;
  /** ⌘/Ctrl+S inside the editor. */
  onSave?: (markdown: string) => void;
  /** Fires when the editor loses focus — a good moment to persist. */
  onBlur?: (markdown: string) => void;
  /** Called for pasted / dropped / picked images. Resolve to the URLs to insert. */
  onImageUpload?: (files: File[]) => Promise<UploadedImage[]>;
  /** Fires once the async init completes, with a ready-to-use handle. */
  onReady?: (handle: MarkdownEditorHandle) => void;
  /** Receives the imperative handle (React-19 style: passed as an explicit prop so
   *  it never collides with the internal container ref). */
  handleRef?: Ref<MarkdownEditorHandle>;
  /** Optional external host for the toolbar. This lets a feature place the
   *  editing controls in its document header while Vditor still owns them. */
  toolbarHost?: HTMLElement | null;
  className?: string;
}

/**
 * A modular, fully-offline Markdown editor wrapping
 * [vditor](https://github.com/Vanessa219/vditor). It renders a plain DOM subtree
 * (fine inside react-native-web) and never touches the network: all runtime assets
 * come from the vendored local CDN and no server upload/link endpoints are set.
 *
 * Reuse it from any feature: `import { MarkdownEditor } from "../editor"`.
 */
export function MarkdownEditor({
  value,
  mode = "wysiwyg",
  toolbar = "full",
  placeholder,
  minHeight = 200,
  height,
  readOnly = false,
  autoFocus = false,
  accentRgb,
  lang = "zh_CN",
  onChange,
  onSave,
  onBlur,
  onImageUpload,
  onReady,
  handleRef,
  toolbarHost,
  className,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const vditorRef = useRef<Vditor | null>(null);
  const toolbarHostRef = useRef<HTMLElement | null>(toolbarHost ?? null);
  const portaledToolbarRef = useRef<HTMLElement | null>(null);
  // True once vditor's async init (Lute load) has finished and the instance exists.
  const [ready, setReady] = useState(false);

  // Latest callbacks + init-time flags live in a ref so the once-created vditor
  // instance always sees current values without re-initialising on every render.
  const cbRef = useRef({ onChange, onSave, onBlur, onImageUpload, onReady, autoFocus });
  useEffect(() => {
    cbRef.current = { onChange, onSave, onBlur, onImageUpload, onReady, autoFocus };
  });

  useEffect(() => {
    toolbarHostRef.current = toolbarHost ?? null;
    const toolbarElement = containerRef.current?.querySelector<HTMLElement>(".vditor-toolbar");
    if (toolbarElement && toolbarHost) {
      toolbarHost.appendChild(toolbarElement);
      portaledToolbarRef.current = toolbarElement;
    }
  }, [toolbarHost, ready]);

  const makeHandle = useCallback(
    (): MarkdownEditorHandle => ({
      getValue: () => cleanMarkdownFromEditor(vditorRef.current?.getValue() ?? ""),
      setValue: (markdown, clearStack) =>
        vditorRef.current?.setValue(prepareMarkdownForEditor(markdown), clearStack),
      insertValue: (markdown) => vditorRef.current?.insertValue(prepareMarkdownForEditor(markdown)),
      focus: () => vditorRef.current?.focus(),
      blur: () => vditorRef.current?.blur(),
      getMode: () => vditorRef.current?.getCurrentMode() ?? null,
      getInstance: () => vditorRef.current,
    }),
    [],
  );

  useImperativeHandle(handleRef, makeHandle, [makeHandle]);

  // Initialise vditor exactly once. Switching documents is done by remounting
  // (the host changes `key`), which is simpler and safer than diffing content.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    let cancelled = false;

    const instance = new Vditor(element, {
      cdn: VDITOR_CDN,
      lang,
      mode,
      value: prepareMarkdownForEditor(value ?? ""),
      minHeight,
      ...(height !== undefined ? { height } : {}),
      placeholder,
      // Never persist to localStorage: it would bleed content across documents.
      cache: { enable: false },
      toolbar: resolveToolbar(toolbar),
      preview: { hljs: { lineNumber: true }, math: { engine: "KaTeX" } },
      // Local-only image handling. No `url`/`linkToImgUrl` is set, so vditor never
      // performs a network upload; the host resolves files and we insert the URLs.
      upload: {
        multiple: true,
        accept: "image/*",
        // vditor types `handler` as `Promise<string> | Promise<null>`; our async
        // function returns `Promise<string | null>` (error message, or null on
        // success), so cast to the field's type — behaviour is identical.
        handler: (async (files: File[]): Promise<string | null> => {
          const handler = cbRef.current.onImageUpload;
          if (!handler) {
            return "当前不支持插入图片。";
          }
          try {
            const images = await handler(files);
            for (const image of images) {
              instance.insertValue(`![${image.alt ?? ""}](${image.url})\n`);
            }
            return null;
          } catch (error) {
            return String(error);
          }
        }) as unknown as UploadHandler,
      },
      input(next) {
        cbRef.current.onChange?.(cleanMarkdownFromEditor(next));
      },
      blur(next) {
        cbRef.current.onBlur?.(cleanMarkdownFromEditor(next));
      },
      keydown(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          cbRef.current.onSave?.(cleanMarkdownFromEditor(instance.getValue()));
        }
      },
      after() {
        if (cancelled) {
          try {
            instance.destroy();
          } catch {
            /* raced with unmount before init completed */
          }
          return;
        }
        vditorRef.current = instance;
        const toolbarElement = element.querySelector<HTMLElement>(".vditor-toolbar");
        const externalHost = toolbarHostRef.current;
        if (toolbarElement && externalHost) {
          externalHost.appendChild(toolbarElement);
          portaledToolbarRef.current = toolbarElement;
        }
        if (cbRef.current.autoFocus) {
          instance.focus();
        }
        cbRef.current.onReady?.(makeHandle());
        // Flip `ready` so the readOnly effect reconciles the *current* prop against
        // the now-existing instance (covers a toggle during async init).
        setReady(true);
      },
    });

    return () => {
      cancelled = true;
      const current = vditorRef.current;
      vditorRef.current = null;
      // Vditor's destroy() only clears its own root. Put a portaled toolbar back
      // first so it is removed with the editor instead of leaking into the header.
      const portaledToolbar = portaledToolbarRef.current;
      if (portaledToolbar && !element.contains(portaledToolbar)) {
        element.prepend(portaledToolbar);
      }
      portaledToolbarRef.current = null;
      if (current) {
        try {
          current.destroy();
        } catch {
          /* already torn down */
        }
      }
    };
    // Init-once: structural props are read at mount; change `key` to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply `readOnly` whenever it changes AND once the instance becomes ready — so a
  // toggle during vditor's async init isn't lost.
  useEffect(() => {
    const instance = vditorRef.current;
    if (!instance) {
      return;
    }
    if (readOnly) {
      instance.disabled();
    } else {
      instance.enable();
    }
  }, [readOnly, ready]);

  // Keep the accent tint in sync.
  useEffect(() => {
    if (accentRgb) {
      containerRef.current?.style.setProperty("--nomi-editor-accent", accentRgb);
    }
  }, [accentRgb]);

  const fill = height === undefined;
  const classes = ["nomi-editor", fill ? "nomi-editor--fill" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return <div className={classes} ref={containerRef} />;
}
