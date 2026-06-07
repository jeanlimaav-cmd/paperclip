import { describe, expect, it } from "vitest";
import { describeDenial } from "./FileViewerSheet";

describe("describeDenial", () => {
  it("returns the curated body for too_large regardless of fallback", () => {
    expect(describeDenial("too_large", "").body).toBe(
      "This file exceeds the supported preview size.",
    );
    expect(describeDenial("too_large", "ignored fallback").body).toBe(
      "This file exceeds the supported preview size.",
    );
  });

  it("does not leak the raw denial code as body when fallback is empty", () => {
    for (const code of [
      "denied_by_policy_sensitive",
      "outside_workspace_root",
      "workspace_archived",
      "binary_unsupported",
      "remote_preview_unsupported",
    ]) {
      const { body } = describeDenial(code, "");
      expect(body).not.toBe(code);
      expect(body).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("falls back to the generic message for unknown codes with empty fallback", () => {
    const { body, title } = describeDenial("", "");
    expect(title).toBe("Can't preview this file");
    expect(body).toBe("The viewer was unable to load this file.");
  });

  it("prefers a human-readable server message for unknown codes", () => {
    const { body } = describeDenial("unknown_code", "Server refused the request.");
    expect(body).toBe("Server refused the request.");
  });
});
