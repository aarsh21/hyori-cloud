import { describe, expect, test } from "bun:test";
import { formatCloudPath, parseCloudPath, type CloudLocation } from "#features/cloud/cloud-path.ts";

const locations: CloudLocation[] = [
  { section: "files", folderId: null },
  { section: "files", folderId: "abc_1" },
  { section: "shared" },
  { section: "trash" },
  { section: "photos" },
  { section: "albums" },
  { section: "album", albumId: "a1" },
  { section: "admin" },
  { section: "invite", token: "tok/en" },
  { section: "passwordReset", token: "tok/en" },
  { section: "publicShare", token: "tok", folderId: null },
  { section: "publicShare", token: "tok", folderId: "f1" },
];

describe("cloud paths", () => {
  test.each(locations)("round trips %j", (location) => {
    expect(parseCloudPath(formatCloudPath(location))).toEqual(location);
  });

  test("ignores query strings and trailing slashes", () => {
    expect(parseCloudPath("/trash/?x=1#y")).toEqual({ section: "trash" });
  });

  test("matches the public link path the server issues", () => {
    expect(parseCloudPath("/share/token123")).toEqual({
      section: "publicShare",
      token: "token123",
      folderId: null,
    });
  });

  test("unknown and malformed paths are not found, not silently the file root", () => {
    expect(parseCloudPath("/nope")).toEqual({ section: "notFound" });
    expect(parseCloudPath("/folders/a/b")).toEqual({ section: "notFound" });
    expect(parseCloudPath("/folders/%E0%A4%A")).toEqual({ section: "notFound" });
  });
});
