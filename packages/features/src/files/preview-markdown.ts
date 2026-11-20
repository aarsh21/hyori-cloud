export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; inline: readonly MarkdownInline[] }
  | { type: "emphasis"; inline: readonly MarkdownInline[] }
  | { type: "link"; href: string; inline: readonly MarkdownInline[] };

export type MarkdownListItem = {
  inline: readonly MarkdownInline[];
  children: readonly MarkdownBlock[];
  /** Present only when the item opened with a GFM task marker; true when it was checked. */
  task?: boolean | undefined;
};

export type MarkdownBlock =
  | { type: "heading"; level: number; inline: readonly MarkdownInline[] }
  | { type: "paragraph"; inline: readonly MarkdownInline[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "quote"; blocks: readonly MarkdownBlock[] }
  | { type: "list"; ordered: boolean; items: readonly MarkdownListItem[] }
  | { type: "table"; rows: readonly (readonly (readonly MarkdownInline[])[])[] }
  | { type: "divider" };

/** A list block, the variant `parseList` owns. */
export type MarkdownList = Extract<MarkdownBlock, { type: "list" }>;

/** A block-level parse result: the block it produced and the first line it left unconsumed. */
type ParsedBlock<Block extends MarkdownBlock> = { block: Block; next: number };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const THEMATIC = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]*(.*)$/;
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * A preview subset, not a CommonMark implementation: headings, lists, quotes, fences, tables and
 * inline styles that read as the author wrote them. Anything else stays literal text, and no
 * markup passes through raw, so a markdown file can never bring scripts into the preview.
 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  return parseBlocks(text.split(/\r\n|\r|\n/));
}

function parseBlocks(lines: readonly string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  function flush() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  }

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;

    if (line.trim() === "") {
      flush();
      index += 1;
      continue;
    }

    const fence = line.match(FENCE);

    if (fence !== null) {
      flush();
      const closing = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*$`);
      const body: string[] = [];
      let scan = index + 1;

      while (scan < lines.length && !closing.test(lines[scan]!)) {
        body.push(lines[scan]!);
        scan += 1;
      }

      blocks.push({
        type: "code",
        language: fence[2]!.trim().split(/\s+/)[0] || null,
        text: body.join("\n"),
      });
      index = scan < lines.length ? scan + 1 : scan;
      continue;
    }

    const heading = line.match(HEADING);

    if (heading !== null) {
      flush();
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        inline: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (THEMATIC.test(line)) {
      flush();
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];

      while (index < lines.length) {
        const match = lines[index]!.match(QUOTE);

        if (match === null) break;
        quoted.push(match[1]!);
        index += 1;
      }

      blocks.push({ type: "quote", blocks: parseBlocks(quoted) });
      continue;
    }

    if (isRow(line) && index + 1 < lines.length && isDelimiterRow(lines[index + 1]!)) {
      flush();
      const rows: (readonly MarkdownInline[])[][] = [];
      rows.push(splitRow(line).map((cell) => parseInline(cell)));

      let scan = index + 2;

      while (scan < lines.length && isRow(lines[scan]!) && lines[scan]!.trim() !== "") {
        rows.push(splitRow(lines[scan]!).map((cell) => parseInline(cell)));
        scan += 1;
      }

      blocks.push({ type: "table", rows });
      index = scan;
      continue;
    }

    if (ITEM.test(line)) {
      flush();
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flush();

  return blocks;
}

function parseList(lines: readonly string[], start: number): ParsedBlock<MarkdownList> {
  const base = lines[start]!.match(ITEM)![1]!.length;
  const ordered = /\d/.test(lines[start]!.match(ITEM)![2]!);
  const items: MarkdownListItem[] = [];

  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === "") break;

    const item = line.match(ITEM);

    if (item === null || item[1]!.length < base) break;

    if (item[1]!.length === base) {
      // A list of the other kind at the same level is a new list, not this one.
      if (/\d/.test(item[2]!) !== ordered) break;

      const text = item[3]!.trim();
      const task = text.match(TASK);

      const parsed: MarkdownListItem = {
        inline: parseInline(task === null ? text : task[2]!.trim()),
        children: [],
      };

      if (task !== null) parsed.task = task[1] !== " ";

      items.push(parsed);
      index += 1;
      continue;
    }

    const last = items[items.length - 1];

    if (last === undefined) break;

    if (item[1]!.length > base) {
      const nested = parseList(lines, index);

      items[items.length - 1] = { ...last, children: [...last.children, nested.block] };
      index = nested.next;
      continue;
    }

    // An indented line that isn't a new item continues the item's own text.
    items[items.length - 1] = {
      ...last,
      inline: [...last.inline, { type: "text", text: ` ${line.trim()}` }],
    };
    index += 1;
  }

  return { block: { type: "list", ordered, items }, next: index };
}

function isRow(line: string): boolean {
  return line.includes("|");
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);

  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();

  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);

  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

  return trimmed.split("|").map((cell) => cell.trim());
}

/** Links open in a new tab, so a preview only ever links somewhere a browser can go safely. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href, "https://preview.hyori.invalid");

    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return href;
    }
  } catch {
    return null;
  }

  return null;
}

export function parseInline(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let buffer = "";
  let index = 0;

  function flush() {
    if (buffer !== "") {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  }

  while (index < text.length) {
    const char = text[index]!;

    if (char === "\\") {
      const next = text[index + 1];

      if (next !== undefined && PUNCTUATION.test(next)) {
        buffer += next;
        index += 2;
        continue;
      }
    }

    if (char === "`") {
      const run = runLength(text, index, "`");
      const closing = findRun(text, index + run, "`", run);

      if (closing !== null) {
        const content = text.slice(index + run, closing);

        flush();
        nodes.push({
          type: "code",
          // Code spans keep a literal space on both ends only to protect one at the edge.
          text: content.length >= 2 && /^ |\n$/.test(content) ? content.slice(1, -1) : content,
        });
        index = closing + run;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const run = Math.min(runLength(text, index, char), 2);

      if (isOpener(text, index, run)) {
        const closing = findRun(text, index + run, char, run);

        if (closing !== null && !/\s/.test(text[closing - 1] ?? "x")) {
          flush();
          const content = text.slice(index + run, closing);

          nodes.push(
            run === 2
              ? { type: "strong", inline: parseInline(content) }
              : { type: "emphasis", inline: parseInline(content) },
          );
          index = closing + run;
          continue;
        }
      }
    }

    const link = parseLink(text, index);

    if (link !== null) {
      flush();
      nodes.push(link.node);
      index = link.next;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();

  return nodes;
}

function isOpener(text: string, index: number, run: number): boolean {
  return !/\s/.test(text[index + run] ?? "x");
}

function runLength(text: string, index: number, char: string): number {
  let length = 0;

  while (text[index + length] === char) length += 1;

  return length;
}

function findRun(text: string, from: number, char: string, length: number): number | null {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== char) continue;

    const run = runLength(text, index, char);

    if (run === length) return index;
  }

  return null;
}

function parseLink(text: string, start: number): { node: MarkdownInline; next: number } | null {
  const image = text[start] === "!";
  const open = start + (image ? 1 : 0);

  if (text[open] !== "[") return null;

  const close = text.indexOf("]", open + 1);

  if (close === -1 || text[close + 1] !== "(") return null;

  let depth = 0;
  let end = -1;

  for (let index = close + 2; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;

    if (text[index] === ")") {
      if (depth === 0) {
        end = index;
        break;
      }

      depth -= 1;
    }
  }

  if (end === -1) return null;

  const label = text.slice(open + 1, close);
  const href = text.slice(close + 2, end).trim();
  // Images load nothing on their own: the preview keeps the link so the reader chooses to follow.
  const inline = image ? parseInline(label === "" ? href : label) : parseInline(label);

  return { node: { type: "link", href, inline }, next: end + 1 };
}
