import type { MouseEvent } from "react";
import { useMemo } from "react";
import { useLocation } from "@/lib/router";
import { readFileViewerStateFromSearch, useFileViewer, writeFileViewerStateToSearch } from "@/context/FileViewerContext";
import { parseWorkspaceFileRef } from "@/lib/workspace-file-parser";
import { MarkdownBody } from "./MarkdownBody";

type MarkdownBodyProps = Parameters<typeof MarkdownBody>[0];

const INLINE_CODE_RE = /`([^`\r\n]+)`/g;

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/([\\\]])/g, "\\$1");
}

export function linkWorkspaceFileInlineCode(markdown: string, currentPathname: string, currentSearch: string, currentHash: string) {
  return markdown.replace(INLINE_CODE_RE, (token, rawCode: string) => {
    const ref = parseWorkspaceFileRef(rawCode);
    if (!ref) return token;
    const nextSearch = writeFileViewerStateToSearch(currentSearch, {
      path: ref.path,
      line: ref.line,
      column: ref.column,
      workspace: "auto",
    });
    const href = `${currentPathname}${nextSearch}${currentHash}`;
    return `[\`${escapeMarkdownLinkLabel(ref.raw)}\`](${href})`;
  });
}

export function WorkspaceFileMarkdownBody({
  children,
  ...props
}: MarkdownBodyProps) {
  const location = useLocation();
  const viewer = useFileViewer();
  const linkedMarkdown = useMemo(
    () => linkWorkspaceFileInlineCode(children, location.pathname, location.search, location.hash),
    [children, location.hash, location.pathname, location.search],
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!viewer) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;

    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== location.pathname) return;
    const next = readFileViewerStateFromSearch(url.search);
    if (!next) return;

    event.preventDefault();
    viewer.open(next);
  };

  return (
    <div onClick={handleClick}>
      <MarkdownBody {...props}>{linkedMarkdown}</MarkdownBody>
    </div>
  );
}
