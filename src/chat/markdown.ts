import DOMPurify from "dompurify";
import { marked } from "marked";

// GitHub-flavoured, single-newline → <br> (chat text is written line by line).
marked.setOptions({ breaks: true, gfm: true });

/**
 * Render assistant markdown to sanitized HTML for a `dangerouslySetInnerHTML`
 * container. Sanitising matters because the text comes from a remote model.
 */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
