// Robust "copy to clipboard" for both the Tauri (macOS WKWebView) desktop build
// and the plain web build.
//
// Why this exists: call sites used `navigator.clipboard?.writeText(...)`, which
// fails silently in two ways inside WKWebView — the optional chain no-ops when
// `navigator.clipboard` is absent, and the returned promise rejects with
// `NotAllowedError` whenever the webview document isn't the focused one (very
// common right after a click on a nested control, or in a torn-off tab window).
// Both cases were swallowed, so a copy "occasionally works, frequently fails".
//
// The reliable path in WebKit is the *synchronous* `document.execCommand("copy")`
// run inside the click gesture — it needs neither a secure context nor window
// focus. That is exactly what vditor itself uses for its own copy buttons, so it
// is proven to work in this app's runtime. We prefer it on the desktop build and
// keep the async Clipboard API as the primary path on the web.

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Synchronous copy via a throwaway <textarea> + execCommand. Must run inside the
 *  user-gesture call stack (no awaits before it) to keep transient activation. */
function copyViaExecCommand(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    // Keep it inside the viewport (WebKit can skip selection on fully off-screen
    // nodes) but visually and interactively inert.
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.padding = "0";
    textarea.style.border = "none";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);

    // Preserve whatever the user had selected — the temporary textarea steals it.
    const selection = document.getSelection();
    const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);

    if (saved && selection) {
      selection.removeAllRanges();
      selection.addRange(saved);
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copy `text` to the clipboard, returning whether it succeeded so callers can
 * show real feedback. Never rejects.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // Desktop (Tauri/WKWebView): the async Clipboard API is the flaky one, so use
  // the synchronous execCommand path first.
  if (inTauri() && copyViaExecCommand(text)) return true;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Absent API or a rejected promise (NotAllowedError / not focused) — fall
    // through to the legacy path.
  }

  return copyViaExecCommand(text);
}
