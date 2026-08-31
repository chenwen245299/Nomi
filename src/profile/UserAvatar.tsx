import { useRef, useSyncExternalStore } from "react";
import { View } from "react-native";
import { RiSparkling2Fill } from "@remixicon/react";
import { accentFor, useTheme } from "../theme";

const STORAGE_KEY = "nomi.userAvatar.v1";
const listeners = new Set<() => void>();

function snapshot(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function publish(value: string) {
  window.localStorage.setItem(STORAGE_KEY, value);
  for (const listener of listeners) listener();
}

async function cropAvatar(file: File): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取头像"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onerror = () => reject(new Error("无法解析头像图片"));
    element.onload = () => resolve(element);
    element.src = source;
  });
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    192,
    192,
  );
  return canvas.toDataURL("image/webp", 0.86);
}

export function UserAvatar({ size = 28 }: { size?: number }) {
  const theme = useTheme();
  const accent = accentFor("chat");
  const image = useSyncExternalStore(subscribe, snapshot, () => null);
  const radius = Math.max(8, Math.round(size * 0.3));

  if (image) {
    return (
      <img
        alt="用户头像"
        draggable={false}
        src={image}
        style={{
          border: `1px solid ${theme.t.edgeHighlight}`,
          borderRadius: radius,
          display: "block",
          height: size,
          objectFit: "cover",
          width: size,
        }}
      />
    );
  }

  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: accent.accent,
        borderColor: theme.t.edgeHighlight,
        borderRadius: radius,
        borderWidth: 1,
        height: size,
        justifyContent: "center",
        width: size,
      }}
    >
      <RiSparkling2Fill color={theme.t.onAccent} size={Math.round(size * 0.53)} />
    </View>
  );
}

export function EditableUserAvatar({ size = 34 }: { size?: number }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div style={{ position: "relative" }}>
      <button
        aria-label="修改用户头像"
        onClick={() => inputRef.current?.click()}
        style={{
          background: "transparent",
          border: 0,
          borderRadius: Math.max(8, Math.round(size * 0.3)),
          cursor: "pointer",
          display: "block",
          padding: 0,
        }}
        title="点击修改头像"
        type="button"
      >
        <UserAvatar size={size} />
      </button>
      <input
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void cropAvatar(file).then(publish);
        }}
        ref={inputRef}
        style={{ display: "none" }}
        type="file"
      />
    </div>
  );
}
