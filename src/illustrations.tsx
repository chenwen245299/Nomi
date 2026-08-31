import chatSvg from "./assets/illustrations/chat.svg?raw";
import financeSvg from "./assets/illustrations/finance.svg?raw";
import notesSvg from "./assets/illustrations/notes.svg?raw";
import travelSvg from "./assets/illustrations/travel.svg?raw";
import type { SectionId } from "./theme";

// Hand-drawn spot illustrations (koboyo, free for commercial use). Each SVG uses
// fill="currentColor", so the wrapper's `color` themes it (rendered in a soft
// neutral tone). Rendered as inline DOM (react-native-web is DOM under the hood)
// so currentColor inherits — an <img> source could not be recolored.
const ILLUSTRATIONS: Partial<Record<SectionId, string>> = {
  chat: chatSvg,
  notes: notesSvg,
  travel: travelSvg,
  finance: financeSvg,
};

export function EmptyIllustration({
  section,
  color,
  size = 116,
}: {
  section: SectionId;
  color: string;
  size?: number;
}) {
  const svg = ILLUSTRATIONS[section];
  if (!svg) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="nomi-illustration"
      style={{
        alignItems: "center",
        color,
        display: "flex",
        height: size,
        justifyContent: "center",
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
