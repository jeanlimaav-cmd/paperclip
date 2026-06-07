import { describe, expect, it } from "vitest";
import {
  buildWorkspaceFileHref,
  parseWorkspaceFileHref,
  remarkWorkspaceFileRefs,
} from "./remark-workspace-file-refs";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

function textNode(value: string): MarkdownNode {
  return { type: "text", value };
}

function inlineCode(value: string): MarkdownNode {
  return { type: "inlineCode", value };
}

function paragraph(children: MarkdownNode[]): MarkdownNode {
  return { type: "paragraph", children };
}

function runPlugin(tree: MarkdownNode): MarkdownNode {
  const transform = remarkWorkspaceFileRefs();
  transform(tree);
  return tree;
}

describe("remarkWorkspaceFileRefs", () => {
  it("converts a matching inline code span into a workspace-file link", () => {
    const tree = paragraph([
      textNode("Check "),
      inlineCode("ui/src/pages/IssueDetail.tsx:42"),
      textNode(" please."),
    ]);
    runPlugin(tree);
    expect(tree.children).toHaveLength(3);
    const link = tree.children![1];
    expect(link.type).toBe("link");
    expect(link.url?.startsWith("workspace-file:")).toBe(true);
    const parsed = parseWorkspaceFileHref(link.url);
    expect(parsed?.path).toBe("ui/src/pages/IssueDetail.tsx");
    expect(parsed?.line).toBe(42);
  });

  it("does not linkify plain text path mentions outside inline code", () => {
    const tree = paragraph([textNode("see ui/src/pages/IssueDetail.tsx for details")]);
    runPlugin(tree);
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0].type).toBe("text");
  });

  it("does not linkify prose words that look like filenames", () => {
    const tree = paragraph([inlineCode("README.md")]);
    runPlugin(tree);
    expect(tree.children![0].type).toBe("inlineCode");
  });

  it("round-trips workspace file hrefs", () => {
    const href = buildWorkspaceFileHref({ path: "a/b.ts", line: 5, column: 2, raw: "a/b.ts:5:2" });
    const parsed = parseWorkspaceFileHref(href);
    expect(parsed?.path).toBe("a/b.ts");
    expect(parsed?.line).toBe(5);
    expect(parsed?.column).toBe(2);
  });

  it("does not descend into existing links", () => {
    const tree: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: "https://example.com",
          children: [inlineCode("ui/src/a.ts:1")],
        },
      ],
    };
    runPlugin(tree);
    const inner = tree.children![0].children![0];
    expect(inner.type).toBe("inlineCode");
  });
});
