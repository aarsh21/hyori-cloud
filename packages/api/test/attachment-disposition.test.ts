import { expect, test } from "bun:test";
import { attachmentDisposition } from "#api/attachment-disposition";

for (const name of ["\uD800", "\uDC00", "legacy\uD800\uD800.txt"]) {
  test("download headers safely encode a legacy ill-formed Unicode filename", () => {
    const value = attachmentDisposition(name);
    const headers = new Headers({ "Content-Disposition": value });
    expect(headers.get("Content-Disposition")).toBe(value);
    expect(value).toContain("%EF%BF%BD");
  });
}

test("supplementary characters and RFC 5987 special characters remain safe and faithful", () => {
  const name = "📷'()*.jpg";
  const value = attachmentDisposition(name);
  expect(value).toBe("attachment; filename*=UTF-8''%F0%9F%93%B7%27%28%29%2A.jpg");
  expect(decodeURIComponent(value.split("''")[1]!)).toBe(name);
});
