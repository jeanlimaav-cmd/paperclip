// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  readFileViewerStateFromSearch,
  writeFileViewerStateToSearch,
} from "./FileViewerContext";

describe("readFileViewerStateFromSearch", () => {
  it("returns null when no file param is present", () => {
    expect(readFileViewerStateFromSearch("")).toBeNull();
    expect(readFileViewerStateFromSearch("?other=1")).toBeNull();
  });

  it("reads file, line, column, workspace from the search", () => {
    const state = readFileViewerStateFromSearch("?file=ui/src/a.ts&line=42&column=3&workspace=project");
    expect(state).toEqual({
      path: "ui/src/a.ts",
      line: 42,
      column: 3,
      workspace: "project",
    });
  });

  it("defaults to auto workspace when param missing", () => {
    const state = readFileViewerStateFromSearch("?file=ui/src/a.ts");
    expect(state?.workspace).toBe("auto");
  });

  it("clamps invalid workspace to auto", () => {
    const state = readFileViewerStateFromSearch("?file=ui/src/a.ts&workspace=bogus");
    expect(state?.workspace).toBe("auto");
  });

  it("treats invalid line/column as null", () => {
    const state = readFileViewerStateFromSearch("?file=x.ts&line=abc&column=-1");
    expect(state?.line).toBeNull();
    expect(state?.column).toBeNull();
  });
});

describe("writeFileViewerStateToSearch", () => {
  it("sets all params when opening", () => {
    const next = writeFileViewerStateToSearch(
      "?existing=1",
      { path: "ui/src/a.ts", line: 42, column: 3, workspace: "project" },
    );
    const params = new URLSearchParams(next);
    expect(params.get("file")).toBe("ui/src/a.ts");
    expect(params.get("line")).toBe("42");
    expect(params.get("column")).toBe("3");
    expect(params.get("workspace")).toBe("project");
    expect(params.get("existing")).toBe("1");
  });

  it("omits workspace when auto", () => {
    const next = writeFileViewerStateToSearch(
      "",
      { path: "a.ts", line: null, column: null, workspace: "auto" },
    );
    expect(next.includes("workspace")).toBe(false);
  });

  it("clears viewer params when closing", () => {
    const next = writeFileViewerStateToSearch(
      "?file=a.ts&line=1&column=2&workspace=project&keep=yes",
      null,
    );
    const params = new URLSearchParams(next);
    expect(params.get("file")).toBeNull();
    expect(params.get("line")).toBeNull();
    expect(params.get("column")).toBeNull();
    expect(params.get("workspace")).toBeNull();
    expect(params.get("keep")).toBe("yes");
  });

  it("returns empty string when no params remain", () => {
    const next = writeFileViewerStateToSearch("?file=a.ts", null);
    expect(next).toBe("");
  });
});
