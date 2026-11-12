import { describe, expect, test } from "bun:test";
import { formatCloudPath, parseCloudPath } from "#features/cloud/cloud-path.ts";

describe("editor paths", () => {
  test("a signed-in editor has its own path", () => {
    expect(parseCloudPath("/edit/file_1")).toEqual({ section: "editor", fileId: "file_1" });
    expect(formatCloudPath({ section: "editor", fileId: "file_1" })).toBe("/edit/file_1");
  });

  test("a link's editor stays under the link", () => {
    expect(parseCloudPath("/share/tok/edit/file_1")).toEqual({
      section: "publicEditor",
      token: "tok",
      fileId: "file_1",
    });
    expect(formatCloudPath({ section: "publicEditor", token: "tok", fileId: "file_1" })).toBe(
      "/share/tok/edit/file_1",
    );
  });

  test("special characters survive the trip", () => {
    const location = { section: "publicEditor", token: "a/b", fileId: "c d" } as const;

    expect(parseCloudPath(formatCloudPath(location))).toEqual(location);
  });

  test("a link's folder path is still a folder, even one with that name", () => {
    expect(parseCloudPath("/share/tok/edit")).toEqual({
      section: "publicShare",
      token: "tok",
      folderId: "edit",
    });
    expect(parseCloudPath("/share/tok/folder_1")).toEqual({
      section: "publicShare",
      token: "tok",
      folderId: "folder_1",
    });
  });

  test("anything longer isn't a location", () => {
    expect(parseCloudPath("/share/tok/edit/a/b").section).toBe("notFound");
    expect(parseCloudPath("/edit").section).toBe("notFound");
    expect(parseCloudPath("/edit/a/b").section).toBe("notFound");
  });
});
