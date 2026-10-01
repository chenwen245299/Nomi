import DOMPurify from "dompurify";
import { marked } from "marked";

// GitHub-flavoured, single-newline → <br> (chat text is written line by line).
marked.setOptions({ breaks: true, gfm: true });

function escapeMath(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Marked does not interpret display-math delimiters by itself. Turn a standalone
// `$$ ... $$` block into the same safe DOM hook that Vditor's KaTeX renderer
// consumes elsewhere in Nomi. A tokenizer extension (rather than a regex
// pre-pass) leaves dollar signs inside fenced code blocks untouched.
marked.use({
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start(source: string) {
        const match = /(?:^|\n) {0,3}\$\$/.exec(source);
        if (!match) return undefined;
        return (match.index ?? 0) + (match[0].startsWith("\n") ? 1 : 0);
      },
      tokenizer(source: string) {
        const match = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(
          source,
        );
        if (!match) return undefined;
        return { type: "displayMath", raw: match[0], text: match[1].trim() };
      },
      renderer(token) {
        return `<div class="language-math">${escapeMath(String(token.text ?? ""))}</div>\n`;
      },
    },
  ],
});

/**
 * Render assistant markdown to sanitized HTML for a `dangerouslySetInnerHTML`
 * container. Sanitising matters because the text comes from a remote model.
 */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

/**
 * Flatten assistant markdown to readable plain text for text-to-speech, so the
 * reader does not pronounce `#`, `*`, link syntax or table pipes. Rendering to
 * HTML first (reusing the sanitiser) then taking `textContent` keeps code and
 * list text while dropping the markup.
 */
export function markdownToPlainText(md: string): string {
  if (typeof document === "undefined") return md ?? "";
  const doc = new DOMParser().parseFromString(renderMarkdown(md ?? ""), "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
