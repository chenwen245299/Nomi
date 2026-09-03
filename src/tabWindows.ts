// Tearing a tab off the titlebar opens it in its own window. The two halves of
// that gesture live here: handing a tab to the backend when it is dropped
// outside the titlebar, and claiming the tab a freshly opened window was born
// with. Everything else (data, settings) each window loads for itself.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Mirrors `DETACHED_LABEL_PREFIX` in src-tauri/src/windowing.rs. */
const DETACHED_LABEL_PREFIX = "tab-";

const isTauriRuntime = () => "__TAURI_INTERNALS__" in window;

/** The label of the window this webview runs in; "main" outside Tauri. */
function windowLabel(): string {
  if (!isTauriRuntime()) return "main";
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

/** False only in a window that was torn off from a tab. Work that must happen
 *  once per app rather than once per window (auto-update) hangs off this. */
export function isMainWindow(): boolean {
  return !windowLabel().startsWith(DETACHED_LABEL_PREFIX);
}

/** The tab this window was opened with, claimed once — `null` for the main
 *  window, and for a torn-off window that reloaded. */
export async function takeDetachedTab(): Promise<unknown> {
  const label = windowLabel();
  if (!isTauriRuntime() || !label.startsWith(DETACHED_LABEL_PREFIX)) return null;
  try {
    const payload = await invoke<string | null>("take_tab_payload", { label });
    return payload ? (JSON.parse(payload) as unknown) : null;
  } catch {
    // No payload, or the backend is older than this frontend — open on 对话.
    return null;
  }
}

/** Where the new window should land, in logical pixels: `x`/`y` is its
 *  top-left on screen, `width`/`height` the size of the window it came from. */
export type DetachPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Opens `tab` in a new window. Resolves false when nothing opened (outside
 *  Tauri, or the window failed to build) so the caller can keep the tab. */
export async function detachTabToWindow(tab: unknown, at: DetachPlacement): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("open_tab_window", {
      payload: JSON.stringify(tab),
      // Keep the titlebar reachable even when dropped at the top of the screen.
      x: Math.round(at.x),
      y: Math.max(0, Math.round(at.y)),
      width: Math.round(at.width),
      height: Math.round(at.height),
    });
    return true;
  } catch (error) {
    console.error("打开新窗口失败", error);
    return false;
  }
}
