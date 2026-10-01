// Lute treats a task marker without any content as an ordinary list item.
// Keep the file's Markdown plain while giving Lute content only at parse time.
const EMPTY_TASK_PLACEHOLDER = "\u200B";
const SPIN_TASK_PLACEHOLDER = "\uE000NomiEmptyTask\uE001";
const EMPTY_TASK = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\])[ \t]*(\u200B)?[ \t]*$/;
const LIST_MARKER = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/;
const QUOTE_PREFIX = /^(?:[ \t]{0,3}>[ \t]?)+/;
const FENCE = /^(`{3,}|~{3,})/;

function indentation(text: string): number {
  return [...text].reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
}

function mapEmptyTaskLines(markdown: string, forEditor: boolean): string {
  let fence: { char: string; length: number } | null = null;
  let rawBlockEnd: string | null = null;
  let listIndents: number[] = [];
  let quoteDepth = 0;

  return markdown
    .split("\n")
    .map((originalLine) => {
      const carriageReturn = originalLine.endsWith("\r") ? "\r" : "";
      const line = carriageReturn ? originalLine.slice(0, -1) : originalLine;
      const quotePrefix = line.match(QUOTE_PREFIX)?.[0] ?? "";
      const body = line.slice(quotePrefix.length);
      const trimmed = body.trimStart();
      const fenceMatch = trimmed.match(FENCE);
      const currentQuoteDepth = (quotePrefix.match(/>/g) ?? []).length;
      if (trimmed && currentQuoteDepth !== quoteDepth) listIndents = [];
      quoteDepth = currentQuoteDepth;
      const indent = indentation(body.slice(0, body.length - trimmed.length));
      const parentIndent = [...listIndents].reverse().find((level) => level < indent);
      const canStartBlock =
        indent <= 3 || (parentIndent !== undefined && indent - parentIndent <= 4);

      if (rawBlockEnd) {
        if (trimmed.toLowerCase().includes(rawBlockEnd)) rawBlockEnd = null;
        return originalLine;
      }
      if (fence) {
        if (
          fenceMatch?.[0][0] === fence.char &&
          fenceMatch[0].length >= fence.length &&
          trimmed.slice(fenceMatch[0].length).trim() === ""
        ) {
          fence = null;
        }
        return originalLine;
      }
      const rawTag = trimmed.match(/^<(pre|script|style|textarea)(?:\s|>)/i)?.[1];
      if (canStartBlock && (trimmed.startsWith("<!--") || rawTag)) {
        const end = rawTag ? `</${rawTag.toLowerCase()}>` : "-->";
        if (!trimmed.toLowerCase().includes(end)) rawBlockEnd = end;
        if (indent <= 3) {
          listIndents = [];
        }
        return originalLine;
      }
      if (fenceMatch && canStartBlock) {
        fence = { char: fenceMatch[0][0], length: fenceMatch[0].length };
        if (indent <= 3) {
          listIndents = [];
        }
        return originalLine;
      }

      const listMatch = body.match(LIST_MARKER);
      if (!listMatch) {
        if (trimmed && (!listIndents.length || indent <= listIndents[listIndents.length - 1])) {
          listIndents = [];
        }
        return originalLine;
      }

      const listIndent = indentation(listMatch[1]);
      const parentListIndent = [...listIndents].reverse().find((level) => level < listIndent);
      // Four spaces at top level are an indented code block. A child list can
      // sit up to four columns beyond its parent; deeper lines are code.
      if (listIndent > 3 && (parentListIndent === undefined || listIndent - parentListIndent > 4)) {
        return originalLine;
      }
      listIndents = listIndents.filter((level) => level < listIndent);
      listIndents.push(listIndent);

      const task = body.match(EMPTY_TASK);
      if (!task) return originalLine;
      if (forEditor) {
        return `${quotePrefix}${task[1]} ${EMPTY_TASK_PLACEHOLDER}${carriageReturn}`;
      }
      return task[2] ? `${quotePrefix}${task[1]}${carriageReturn}` : originalLine;
    })
    .join("\n");
}

export function prepareMarkdownForEditor(markdown: string): string {
  return mapEmptyTaskLines(markdown, true);
}

export function cleanMarkdownFromEditor(markdown: string): string {
  return mapEmptyTaskLines(markdown, false);
}

interface TaskLute {
  Md2VditorDOM(markdown: string): string;
  Md2VditorIRDOM(markdown: string): string;
  Md2HTML(markdown: string): string;
  SpinVditorDOM(html: string): string;
  SpinVditorIRDOM(html: string): string;
}

function protectEmptyTaskDOM(html: string): string {
  if (!html.includes("vditor-task")) return html;
  const fragment = document.createElement("template");
  fragment.innerHTML = html;
  let changed = false;
  for (const item of fragment.content.querySelectorAll<HTMLElement>("li.vditor-task")) {
    const checkbox = item.querySelector<HTMLInputElement>(
      ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
    );
    if (!checkbox) continue;
    const ownContent = item.cloneNode(true) as HTMLElement;
    ownContent.querySelectorAll("ul, ol, input, wbr, br").forEach((node) => node.remove());
    if (ownContent.textContent?.replace(/[\u200B\u2060]/g, "").trim()) continue;
    if (ownContent.querySelector("img, video, audio, svg, canvas, iframe, table, pre")) continue;
    checkbox.after(document.createTextNode(SPIN_TASK_PLACEHOLDER));
    changed = true;
  }
  return changed ? fragment.innerHTML : html;
}

/** Vditor reparses live list DOM and mode changes through Lute, bypassing the
 * initial `value` preparation. Keep empty checkboxes intact across those paths. */
export function stabilizeEmptyTasks(lute: TaskLute): void {
  const md2VditorDOM = lute.Md2VditorDOM.bind(lute);
  const md2VditorIRDOM = lute.Md2VditorIRDOM.bind(lute);
  const md2HTML = lute.Md2HTML.bind(lute);
  const spinVditorDOM = lute.SpinVditorDOM.bind(lute);
  const spinVditorIRDOM = lute.SpinVditorIRDOM.bind(lute);

  lute.Md2VditorDOM = (markdown) => md2VditorDOM(prepareMarkdownForEditor(markdown));
  lute.Md2VditorIRDOM = (markdown) => md2VditorIRDOM(prepareMarkdownForEditor(markdown));
  lute.Md2HTML = (markdown) => md2HTML(prepareMarkdownForEditor(markdown));
  lute.SpinVditorDOM = (html) =>
    spinVditorDOM(protectEmptyTaskDOM(html)).split(SPIN_TASK_PLACEHOLDER).join("");
  lute.SpinVditorIRDOM = (html) =>
    spinVditorIRDOM(protectEmptyTaskDOM(html)).split(SPIN_TASK_PLACEHOLDER).join("");
}
