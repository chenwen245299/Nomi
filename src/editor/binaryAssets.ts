import { invoke } from "@tauri-apps/api/core";

const OWNER_HEADER = "x-nomi-owner";
const NAME_HEADER = "x-nomi-file-name";

/** Encode small UTF-8 metadata as an ASCII-safe header value. Image bytes stay
 * in the raw IPC body, so they never expand into a Base64 JSON string. */
function encodeHeader(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function writeImageBytes(
  command: string,
  owner: string,
  name: string,
  file: File,
): Promise<string> {
  const bytes = await file.arrayBuffer();
  return invoke<string>(command, bytes, {
    headers: {
      [OWNER_HEADER]: encodeHeader(owner),
      [NAME_HEADER]: encodeHeader(name),
    },
  });
}

export async function readImageBlob(
  command: string,
  args: Record<string, unknown>,
  mime: string,
): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>(command, args);
  return new Blob([bytes], { type: mime });
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const table: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
  };
  return table[ext] ?? "application/octet-stream";
}
