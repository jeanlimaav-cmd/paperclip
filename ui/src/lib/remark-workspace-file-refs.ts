import { parseWorkspaceFileRef, type ParsedWorkspaceFileRef } from "./workspace-file-parser";

const WORKSPACE_FILE_HREF_SCHEME = "workspace-file:";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

export function buildWorkspaceFileHref(ref: ParsedWorkspaceFileRef): string {
  const params = new URLSearchParams();
  params.set("path", ref.path);
  if (ref.line !== null) params.set("line", String(ref.line));
  if (ref.column !== null) params.set("column", String(ref.column));
  return `${WORKSPACE_FILE_HREF_SCHEME}?${params.toString()}`;
}

export function parseWorkspaceFileHref(href: string | null | undefined): ParsedWorkspaceFileRef | null {
  if (!href || typeof href !== "string") return null;
  if (!href.startsWith(WORKSPACE_FILE_HREF_SCHEME)) return null;
  const rest = href.slice(WORKSPACE_FILE_HREF_SCHEME.length);
  const withoutLeadingQuestion = rest.startsWith("?") ? rest.slice(1) : rest;
  const params = new URLSearchParams(withoutLeadingQuestion);
  const path = params.get("path");
  if (!path) return null;
  const lineRaw = params.get("line");
  const columnRaw = params.get("column");
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : NaN;
  const column = columnRaw ? Number.parseInt(columnRaw, 10) : NaN;
  return {
    path,
    line: Number.isFinite(line) && line > 0 ? line : null,
    column: Number.isFinite(column) && column > 0 ? column : null,
    raw: path,
  };
}

function createWorkspaceFileLinkNode(ref: ParsedWorkspaceFileRef): MarkdownNode {
  return {
    type: "link",
    url: buildWorkspaceFileHref(ref),
    children: [{ type: "inlineCode", value: ref.raw }],
  };
}

function rewriteMarkdownTree(node: MarkdownNode) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  // Don't descend into existing links or code blocks; only rewrite inlineCode within flowing text.
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const ref = parseWorkspaceFileRef(child.value);
      if (ref) {
        nextChildren.push(createWorkspaceFileLinkNode(ref));
        continue;
      }
    }
    rewriteMarkdownTree(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkWorkspaceFileRefs() {
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree);
  };
}

export const WORKSPACE_FILE_HREF_PREFIX = WORKSPACE_FILE_HREF_SCHEME;
