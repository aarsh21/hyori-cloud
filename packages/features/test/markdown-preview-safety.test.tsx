import { expect } from "bun:test";
import { MarkdownPane } from "#features/files/react/quick-preview.tsx";
import { createFakeApi, mount, screen, test } from "#features-test/mounted.tsx";

/**
 * Everything a markdown file could say that would matter if markup or a scheme ever reached the
 * DOM. The renderer must answer with inert text and, for links, one safe anchor.
 */
const HOSTILE = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(2)">',
  '<iframe src="https://evil.example"></iframe>',
  "<svg onload='alert(3)'></svg>",
  '<a href="javascript:alert(4)">raw html link</a>',
  "[script link](javascript:alert(5))",
  "![script image](javascript:alert(6))",
  "[data link](data:text/html,<b>pepper</b>)",
  "![data image](data:text/html,<b>pepper</b>)",
  "[vbscript link](vbscript:msgbox(7))",
  "![vbscript image](vbscript:msgbox(7))",
  "[safe link](https://example.com/docs)",
].join("\n\n");

test("a markdown preview renders hostile files as inert text with no unsafe anchors", () => {
  const { container } = mount(<MarkdownPane text={{ text: HOSTILE }} />, createFakeApi({}));

  // Nothing the file wrote became an element inside the preview.
  const sheet = container.querySelector('[aria-label="Preview content"]');

  expect(sheet?.querySelectorAll("script, iframe, object, embed, img, svg")).toHaveLength(0);

  // The one anchor that exists is the https link, and it leaves the app safely.
  const anchors = Array.from(sheet?.querySelectorAll("a") ?? []);
  expect(anchors).toHaveLength(1);
  expect(anchors[0]?.getAttribute("href")).toBe("https://example.com/docs");
  expect(anchors[0]?.rel).toContain("noopener");

  // Blocked link and image syntax keeps its label instead of vanishing.
  for (const label of [
    "script link",
    "script image",
    "data link",
    "data image",
    "vbscript link",
    "vbscript image",
  ]) {
    expect(screen.getByText(label)).toBeTruthy();
  }

  // Raw markup stays visible text, never elements the browser could run.
  expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
  expect(screen.getByText('<a href="javascript:alert(4)">raw html link</a>')).toBeTruthy();
});
