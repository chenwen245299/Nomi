import { useEffect } from "react";
import { createPortal } from "react-dom";
import { RiCloseLine, RiDownload2Line } from "@remixicon/react";

export type AttachmentPreviewKind = "image" | "pdf" | "video";

/** Shared full-window preview used by chat attachments and finance receipts. */
export function AttachmentPreviewModal({
  kind,
  name,
  onClose,
  onDownload,
  url,
}: {
  kind: AttachmentPreviewKind;
  name: string;
  onClose: () => void;
  onDownload?: () => void;
  url: string;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      aria-label={kind === "pdf" ? "PDF 预览" : kind === "video" ? "视频预览" : "图片预览"}
      aria-modal="true"
      onClick={onClose}
      role="dialog"
      style={{
        alignItems: "center",
        backdropFilter: "blur(14px)",
        background: "rgba(12, 18, 28, 0.72)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: 36,
        position: "fixed",
        zIndex: 3000,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          position: "fixed",
          right: 24,
          top: 22,
        }}
      >
        {onDownload ? (
          <button
            aria-label={`下载 ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
            style={{
              alignItems: "center",
              background: "rgba(255,255,255,0.14)",
              border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: 999,
              color: "#fff",
              cursor: "pointer",
              display: "flex",
              height: 34,
              justifyContent: "center",
              width: 34,
            }}
            type="button"
          >
            <RiDownload2Line color="#FFFFFF" size={18} />
          </button>
        ) : null}
        <button
          aria-label="关闭附件预览"
          onClick={onClose}
          style={{
            alignItems: "center",
            background: "rgba(255,255,255,0.14)",
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 999,
            color: "#fff",
            cursor: "pointer",
            display: "flex",
            height: 34,
            justifyContent: "center",
            width: 34,
          }}
          type="button"
        >
          <RiCloseLine color="#FFFFFF" size={20} />
        </button>
      </div>
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          alignItems: "center",
          display: "flex",
          height: kind === "pdf" ? "88vh" : "auto",
          justifyContent: "center",
          maxHeight: "88vh",
          maxWidth: "92vw",
          width: kind === "pdf" ? "min(1000px, 92vw)" : "auto",
        }}
      >
        {kind === "pdf" ? (
          <iframe
            src={url}
            style={{
              background: "#FFFFFF",
              border: 0,
              borderRadius: 12,
              boxShadow: "0 28px 80px rgba(0,0,0,0.42)",
              height: "100%",
              width: "100%",
            }}
            title={`PDF 预览：${name}`}
          />
        ) : kind === "video" ? (
          <video
            autoPlay
            controls
            src={url}
            style={{
              background: "#000000",
              borderRadius: 12,
              boxShadow: "0 28px 80px rgba(0,0,0,0.42)",
              maxHeight: "88vh",
              maxWidth: "92vw",
            }}
          />
        ) : (
          <img
            alt={name}
            src={url}
            style={{
              borderRadius: 12,
              boxShadow: "0 28px 80px rgba(0,0,0,0.42)",
              maxHeight: "88vh",
              maxWidth: "92vw",
              objectFit: "contain",
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
