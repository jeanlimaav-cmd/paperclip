// @vitest-environment node

import { describe, expect, it } from "vitest";
import { linkWorkspaceFileInlineCode } from "./WorkspaceFileMarkdownBody";

describe("linkWorkspaceFileInlineCode", () => {
  it("links workspace file refs in inline code to the current issue file viewer", () => {
    const markdown = linkWorkspaceFileInlineCode(
      "Check `ui/src/pages/IssueDetail.tsx:42` please.",
      "/issues/PAP-1",
      "?tab=chat",
      "#comment-1",
    );

    expect(markdown).toContain("[`ui/src/pages/IssueDetail.tsx:42`](");
    expect(markdown).toContain("/issues/PAP-1?tab=chat&file=ui%2Fsrc%2Fpages%2FIssueDetail.tsx&line=42#comment-1");
  });

  it("leaves non-file inline code unchanged", () => {
    expect(linkWorkspaceFileInlineCode("Run `pnpm test`.", "/issues/PAP-1", "", "")).toBe("Run `pnpm test`.");
  });
});
