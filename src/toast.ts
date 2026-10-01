// A tiny, dependency-free toast. One floating pill, reused across calls, mounted
// straight onto <body> so any module can surface a transient message without
// threading state through the React tree.

let host: HTMLDivElement | null = null;
let hideTimer: number | undefined;

export function showToast(message: string): void {
  if (typeof document === "undefined") return;
  if (!host) {
    host = document.createElement("div");
    host.setAttribute("role", "status");
    Object.assign(host.style, {
      position: "fixed",
      left: "50%",
      bottom: "36px",
      transform: "translateX(-50%)",
      zIndex: "99999",
      maxWidth: "min(520px, 90vw)",
      padding: "10px 16px",
      borderRadius: "11px",
      background: "rgba(28, 28, 30, 0.94)",
      color: "#fff",
      fontSize: "13px",
      lineHeight: "1.5",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.32)",
      backdropFilter: "blur(14px)",
      WebkitBackdropFilter: "blur(14px)",
      textAlign: "center",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 160ms ease",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(host);
  }
  host.textContent = message;
  requestAnimationFrame(() => {
    if (host) host.style.opacity = "1";
  });
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (host) host.style.opacity = "0";
  }, 3400);
}
