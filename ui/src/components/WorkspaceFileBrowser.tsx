import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cloud, FileCode2, FolderOpen, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { fileResourcesApi } from "@/api/file-resources";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { parseWorkspaceFileRef } from "@/lib/workspace-file-parser";
import type {
  WorkspaceFileListItem,
  WorkspaceFileListMode,
  WorkspaceFileSelector,
} from "@paperclipai/shared";

const WORKSPACE_OPTIONS: ReadonlyArray<{ value: WorkspaceFileSelector; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "execution", label: "Execution" },
  { value: "project", label: "Project" },
];

// Hard list cap. The spec called out ~50 to keep reads cheap; 100 trades a bit
// more scan for fewer "refine to narrow" dead-ends on large trees. Footer always
// discloses truncation so the cap is never silent.
const LIST_LIMIT = 100;

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx + 1);
}

/**
 * Maps a server `unavailableReason` to a calm, board-readable explanation.
 * Copy is kept in sync with `describeDenial` in FileViewerSheet so the browse
 * states and the viewer's error panels read in one voice. Substring matching
 * keeps it resilient to small reason-string changes on the server.
 */
export function describeUnavailable(reason: string): { title: string; body: string; icon: ReactNode } {
  const lower = reason.toLowerCase();
  if (lower.includes("remote")) {
    return {
      icon: <Cloud aria-hidden="true" className="h-5 w-5 text-muted-foreground" />,
      title: "Remote workspace preview not supported",
      body: "This workspace is hosted remotely and is not available for inline preview yet.",
    };
  }
  if (lower.includes("no_workspace") || lower.includes("no_local")) {
    return {
      icon: <FolderOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />,
      title: "No workspace yet",
      body: "This issue does not have a workspace to browse. Files appear here once a run creates one.",
    };
  }
  if (lower.includes("archiv") || lower.includes("cleaned") || lower.includes("unavailable")) {
    return {
      icon: <FolderOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />,
      title: "Workspace is no longer available",
      body: "The isolated worktree for this issue has been cleaned up, so files cannot be previewed.",
    };
  }
  return {
    icon: <AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-500" />,
    title: "Workspace unavailable",
    body: "These workspace files can't be browsed right now.",
  };
}

function StateMessage({ icon, title, body }: { icon: ReactNode; title: string; body?: string }) {
  return (
    <div className="flex items-start gap-3 px-1 py-8 text-sm">
      {icon}
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {body ? <p className="text-muted-foreground">{body}</p> : null}
      </div>
    </div>
  );
}

function WorkspaceSelector({
  value,
  onChange,
}: {
  value: WorkspaceFileSelector;
  onChange: (next: WorkspaceFileSelector) => void;
}) {
  return (
    <div role="group" aria-label="Workspace" className="inline-flex shrink-0 rounded-md border border-border p-0.5">
      {WORKSPACE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2 py-1 text-xs transition-colors",
            value === option.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface WorkspaceFileRowProps {
  item: WorkspaceFileListItem;
  optionId: string;
  selected: boolean;
  showTimestamp: boolean;
  onOpen: () => void;
  onHover: () => void;
}

function WorkspaceFileRow({ item, optionId, selected, showTimestamp, onOpen, onHover }: WorkspaceFileRowProps) {
  const name = basename(item.displayPath);
  const dir = dirname(item.displayPath);
  const stamp = showTimestamp && item.modifiedAt ? timeAgo(item.modifiedAt) : null;
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={selected}
      onClick={onOpen}
      onMouseEnter={onHover}
      title={item.displayPath}
      className={cn(
        "flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 sm:min-h-0",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <FileCode2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {/* Desktop (>=sm): single line, directory truncates and basename stays visible. */}
      <span className="hidden min-w-0 flex-1 items-baseline gap-0 overflow-hidden sm:flex">
        {dir ? (
          <span className="min-w-0 shrink truncate font-mono text-xs text-muted-foreground">{dir}</span>
        ) : null}
        <span className="shrink-0 truncate font-mono text-xs text-foreground">{name}</span>
      </span>
      {/* Mobile (<sm): two lines, basename first so the filename is always readable. */}
      <span className="flex min-w-0 flex-1 flex-col overflow-hidden sm:hidden">
        <span className="truncate font-mono text-xs text-foreground">{name}</span>
        {dir ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
            {dir}
          </span>
        ) : null}
      </span>
      {stamp ? (
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">{stamp}</span>
      ) : null}
    </div>
  );
}

export interface WorkspaceFileBrowserProps {
  issueId: string;
  onOpen: (ref: {
    path: string;
    workspace: WorkspaceFileSelector;
    line?: number | null;
    column?: number | null;
  }) => void;
  /** Seed the search field (e.g. from a URL-backed deep link). */
  initialQuery?: string | null;
  className?: string;
}

export function WorkspaceFileBrowser({ issueId, onOpen, initialQuery, className }: WorkspaceFileBrowserProps) {
  const [workspace, setWorkspace] = useState<WorkspaceFileSelector>("auto");
  const [searchInput, setSearchInput] = useState(initialQuery ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery?.trim() ?? "");
  // When the workspace has no git change-tracking we silently fall back to a full
  // listing for the default (empty-query) view, per spec.
  const [recentUnavailable, setRecentUnavailable] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchInput.trim()), 150);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // A new search or workspace should re-attempt recent-change tracking.
  useEffect(() => {
    setRecentUnavailable(false);
  }, [workspace]);

  const q = debouncedQuery || null;
  const isSearch = q !== null;
  const mode: WorkspaceFileListMode = isSearch ? "all" : recentUnavailable ? "all" : "changed";

  const listQuery = useQuery({
    queryKey: queryKeys.issues.fileResources(issueId, { workspace, mode, q, limit: LIST_LIMIT }),
    queryFn: () => fileResourcesApi.list(issueId, { workspace, mode, q, limit: LIST_LIMIT }),
    retry: false,
    staleTime: 15_000,
  });

  const data = listQuery.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const workspaceLabel = data?.workspace?.workspaceLabel ?? null;

  // Silent fallback: empty-query view with no change-tracking → list everything.
  useEffect(() => {
    if (!isSearch && data?.state === "unavailable" && (data.unavailableReason ?? "").toLowerCase().includes("changed")) {
      setRecentUnavailable(true);
    }
  }, [data, isSearch]);

  // Keep the highlighted option valid as results change.
  useEffect(() => {
    setHighlightedIndex(items.length > 0 ? 0 : -1);
  }, [items, q, workspace]);

  const announcement = useMemo(() => {
    if (listQuery.isFetching) return "Loading workspace files…";
    if (listQuery.isError) return "Unable to load workspace files.";
    if (data?.state === "unavailable") return describeUnavailable(data.unavailableReason ?? "").title;
    if (items.length === 0) return "No matching files.";
    return `${items.length} file${items.length === 1 ? "" : "s"} found.`;
  }, [data, items.length, listQuery.isError, listQuery.isFetching]);

  function openTypedPath() {
    const value = searchInput.trim();
    if (!value) return;
    const parsed = parseWorkspaceFileRef(value);
    if (parsed) onOpen({ path: parsed.path, workspace, line: parsed.line, column: parsed.column });
    else onOpen({ path: value, workspace });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => (items.length === 0 ? -1 : Math.min(items.length - 1, current + 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => (items.length === 0 ? -1 : Math.max(0, current - 1)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = highlightedIndex >= 0 ? items[highlightedIndex] : undefined;
      if (item) onOpen({ path: item.relativePath, workspace });
      else openTypedPath();
    }
  }

  const activeOptionId = highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined;

  let body: ReactNode;
  if (listQuery.isFetching && !data) {
    body = (
      <div className="space-y-1.5 py-2" aria-busy="true">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2 px-2 py-1.5">
            <div className="h-3.5 w-3.5 shrink-0 rounded bg-muted" />
            <div className="h-3 flex-1 rounded bg-muted" style={{ maxWidth: `${80 - index * 8}%` }} />
          </div>
        ))}
      </div>
    );
  } else if (listQuery.isError) {
    const status = listQuery.error instanceof ApiError ? listQuery.error.status : 0;
    body = (
      <StateMessage
        icon={<AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-500" />}
        title="Couldn't load files"
        body={
          status === 404
            ? "Workspace browsing isn't available for this issue."
            : "Something went wrong loading workspace files."
        }
      />
    );
  } else if (data?.state === "unavailable") {
    const detail = describeUnavailable(data.unavailableReason ?? "");
    body = <StateMessage icon={detail.icon} title={detail.title} body={detail.body} />;
  } else if (items.length === 0) {
    body = (
      <StateMessage
        icon={<Search aria-hidden="true" className="h-5 w-5 text-muted-foreground" />}
        title={isSearch ? `No files match “${q}”` : "No recently changed files yet"}
        body="Try searching by name or path."
      />
    );
  } else {
    body = (
      <div role="listbox" id={listboxId} aria-label="Workspace files" className="space-y-0.5 py-1">
        {items.map((item, index) => (
          <WorkspaceFileRow
            key={`${item.workspaceId}:${item.relativePath}`}
            item={item}
            optionId={`${listboxId}-opt-${index}`}
            selected={index === highlightedIndex}
            showTimestamp={!isSearch}
            onOpen={() => onOpen({ path: item.relativePath, workspace })}
            onHover={() => setHighlightedIndex(index)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search files by name or path…"
          aria-label="Search workspace files"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={items.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="h-8 pl-8 font-mono text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Workspace</span>
        <WorkspaceSelector value={workspace} onChange={setWorkspace} />
      </div>

      <div className="flex items-baseline justify-between gap-2 pt-1">
        <span className="text-xs font-medium text-muted-foreground">
          {isSearch ? <>Files matching “{q}”</> : "Recently changed"}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {listQuery.isFetching ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> : null}
          {data?.state === "available" && items.length > 0 ? <span>· {items.length}</span> : null}
        </span>
      </div>

      {workspaceLabel ? (
        <div className="truncate text-[11px] text-muted-foreground" title={workspaceLabel}>
          From {workspaceLabel}
        </div>
      ) : null}

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>

      {data?.truncated ? (
        <div className="border-t border-border pt-2 text-[11px] text-muted-foreground">
          Showing first {items.length} — refine the search to narrow.
        </div>
      ) : null}
    </div>
  );
}
