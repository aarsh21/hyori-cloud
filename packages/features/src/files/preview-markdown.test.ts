import { expect, test } from "bun:test";
import {
  parseInline,
  parseMarkdown,
  safeHref,
  type MarkdownBlock,
} from "#features/files/preview-markdown.ts";

/**
 * The first block of `text`, as the variant a test asserts. Wrong shapes still fail the
 * expectations each test states below.
 */
function firstBlock<Type extends MarkdownBlock["type"]>(
  text: string,
  type: Type,
): Extract<MarkdownBlock, { type: Type }> {
  const block = parseMarkdown(text)[0];

  if (block === undefined || block.type !== type) {
    throw new Error(`expected a ${type} block from ${JSON.stringify(text)}`);
  }

  // SAFETY: the guard above proved the block carries the asserted type; generics defeat TS's own
  // narrowing across `block.type !== type`.
  return block as Extract<MarkdownBlock, { type: Type }>;
}

test("headings, paragraphs and dividers parse by shape", () => {
  const blocks = parseMarkdown("# Title\n\nWords in a paragraph.\n\n---\n###### Small");

  expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "divider", "heading"]);
  expect(blocks[0]).toMatchObject({ level: 1 });
  expect(blocks[3]).toMatchObject({ level: 6 });
});

test("a heading without a space is a paragraph, like CommonMark", () => {
  expect(parseMarkdown("#Not a heading")[0]!.type).toBe("paragraph");
});

test("fenced code keeps its language and body, tilde fences close, truncation stays honest", () => {
  const fenced = firstBlock("```rust\nfn main() {}\n```\n", "code");

  expect(fenced).toMatchObject({ type: "code", language: "rust", text: "fn main() {}" });

  expect(firstBlock("~~~\na\n~~~\n", "code").text).toBe("a");
  expect(firstBlock("```\nunterminated", "code").text).toBe("unterminated");
});

test("lists nest by indentation and keep ordered and unordered apart", () => {
  const list = firstBlock("- one\n  - nested\n- two\n\n1. first\n2. second\n", "list");

  expect(list.ordered).toBe(false);
  expect(list.items).toHaveLength(2);
  expect(list.items[0]!.children[0]).toMatchObject({
    type: "list",
    ordered: false,
    items: [{ inline: [{ type: "text", text: "nested" }] }],
  });

  const ordered = firstBlock("1. first\n2. second\n", "list");

  expect(ordered.ordered).toBe(true);
  expect(ordered.items).toHaveLength(2);
});

test("task markers read as the item's checked state, and only at an item's start", () => {
  const tasks = firstBlock("- [x] done\n- [ ] open\n- [X] upper case\n- plain\n", "list");

  expect(tasks.items.map((item) => item.task)).toEqual([true, false, true, undefined]);
  expect(tasks.items[0]!.inline).toEqual([{ type: "text", text: "done" }]);

  // A bracket later in the line stays literal text, and an empty marker is not a task.
  expect(firstBlock("- see [x] mid-sentence\n", "list").items[0]!.task).toBeUndefined();
  expect(firstBlock("- [] no space inside\n", "list").items[0]!.task).toBeUndefined();

  // A task may carry nested content like any other item.
  expect(firstBlock("- [x] parent\n  - child\n", "list").items[0]!.children[0]).toMatchObject({
    type: "list",
  });
});

test("a quote parses its own blocks", () => {
  const quote = firstBlock("> # Quoted\n> body text\n\nafter", "quote");

  expect(quote.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
});

test("tables read the header row and stop at a blank line", () => {
  const table = firstBlock(
    "| Name | Size |\n| --- | --- |\n| a.pdf | 10 |\n| b.pdf | 20 |\n\ndone",
    "table",
  );

  expect(table.rows).toHaveLength(3);
  expect(table.rows[0]![0]).toEqual([{ type: "text", text: "Name" }]);
});

test("inline code, bold, emphasis and links parse", () => {
  expect(parseInline("run `cargo test` now")).toEqual([
    { type: "text", text: "run " },
    { type: "code", text: "cargo test" },
    { type: "text", text: " now" },
  ]);

  expect(parseInline("**bold** and *thin*")).toEqual([
    { type: "strong", inline: [{ type: "text", text: "bold" }] },
    { type: "text", text: " and " },
    { type: "emphasis", inline: [{ type: "text", text: "thin" }] },
  ]);

  expect(parseInline("see [the docs](https://example.com/docs)")).toEqual([
    { type: "text", text: "see " },
    {
      type: "link",
      href: "https://example.com/docs",
      inline: [{ type: "text", text: "the docs" }],
    },
  ]);
});

test("emphasis stays literal without a closing run or an opening edge", () => {
  expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", text: "2 * 3 = 6" }]);
  expect(parseInline("* never closes")).toEqual([{ type: "text", text: "* never closes" }]);
  expect(parseInline("escap\\*ed")).toEqual([{ type: "text", text: "escap*ed" }]);
});

test("images become links over their alt text and never load by themselves", () => {
  expect(parseInline("![A cat](https://example.com/cat.png)")).toEqual([
    {
      type: "link",
      href: "https://example.com/cat.png",
      inline: [{ type: "text", text: "A cat" }],
    },
  ]);
  expect(parseInline("![](https://example.com/cat.png)")[0]).toMatchObject({
    inline: [{ type: "text", text: "https://example.com/cat.png" }],
  });
});

test("link hrefs filter to what a browser can open safely", () => {
  expect(safeHref("https://example.com")).toBe("https://example.com");
  expect(safeHref("/docs/file.txt")).toBe("/docs/file.txt");
  expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
  expect(safeHref("javascript:alert(1)")).toBeNull();
  expect(safeHref("data:text/html,hi")).toBeNull();
  expect(safeHref("vbscript:msgbox")).toBeNull();
  // The URL parser strips what a scheme might hide behind, so these still resolve to a scheme.
  expect(safeHref("  javascript:alert(1)")).toBeNull();
  expect(safeHref("java\tscript:alert(1)")).toBeNull();
  expect(safeHref("DATA:text/html,hi")).toBeNull();
});

test("javascript, data and vbscript urls stay unusable from link and image syntax", () => {
  for (const scheme of ["javascript:alert(1)", "data:text/html,<b>hi</b>", "vbscript:msgbox"]) {
    // The parser keeps the href it read; the render gate is what refuses it.
    for (const syntax of ["[click]", "![logo]"]) {
      const node = parseInline(`${syntax}(${scheme})`)[0];

      if (node === undefined || node.type !== "link") {
        throw new Error(`expected a link node from ${syntax}`);
      }

      expect(node.href).toBe(scheme);
      expect(safeHref(node.href)).toBeNull();
    }
  }
});

test("markup in a paragraph stays text", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://evil.example"></iframe>',
    "<svg onload='alert(1)'></svg>",
    '<a href="javascript:alert(1)">click me</a>',
    "<details open ontoggle=alert(1)>",
  ].join(" ");

  expect(firstBlock(hostile, "paragraph").inline).toEqual([{ type: "text", text: hostile }]);
});
