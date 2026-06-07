import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import type { WorkspaceFileSelector } from "@paperclipai/shared";
import type { ParsedWorkspaceFileRef } from "@/lib/workspace-file-parser";

export interface FileViewerUrlState {
  path: string;
  line: number | null;
  column: number | null;
  workspace: WorkspaceFileSelector;
}

export interface FileViewerContextValue {
  issueId: string;
  /** Current viewer state derived from the URL, or null if closed. */
  state: FileViewerUrlState | null;
  /** True when the sheet is in browse mode (URL carries `browse=1`). */
  browse: boolean;
  /** The active browse search query (URL `q`), or null. */
  query: string | null;
  open(
    ref: Pick<ParsedWorkspaceFileRef, "path" | "line" | "column"> & { workspace?: WorkspaceFileSelector },
    opts?: { fromBrowse?: boolean },
  ): void;
  /** Open (or stay in) browse mode, optionally seeding the search query. */
  openBrowse(opts?: { q?: string }): void;
  /** From a file opened via browse, return to the browse list. */
  backToFiles(): void;
  close(): void;
}

const FileViewerContext = createContext<FileViewerContextValue | null>(null);

export function readFileViewerStateFromSearch(search: string): FileViewerUrlState | null {
  const params = new URLSearchParams(search);
  const path = params.get("file");
  if (!path) return null;
  const lineRaw = params.get("line");
  const columnRaw = params.get("column");
  const workspaceRaw = params.get("workspace");
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : NaN;
  const column = columnRaw ? Number.parseInt(columnRaw, 10) : NaN;
  const workspace = (workspaceRaw === "execution" || workspaceRaw === "project")
    ? workspaceRaw
    : "auto";
  return {
    path,
    line: Number.isFinite(line) && line > 0 ? line : null,
    column: Number.isFinite(column) && column > 0 ? column : null,
    workspace,
  };
}

export function writeFileViewerStateToSearch(current: string, next: FileViewerUrlState | null): string {
  const params = new URLSearchParams(current);
  // A direct file open/close is never a browse origin — clear browse params too.
  params.delete("browse");
  params.delete("q");
  if (!next) {
    params.delete("file");
    params.delete("line");
    params.delete("column");
    params.delete("workspace");
  } else {
    params.set("file", next.path);
    if (next.line !== null) params.set("line", String(next.line));
    else params.delete("line");
    if (next.column !== null) params.set("column", String(next.column));
    else params.delete("column");
    if (next.workspace && next.workspace !== "auto") params.set("workspace", next.workspace);
    else params.delete("workspace");
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

export interface FileViewerBrowseState {
  q: string | null;
}

export function readBrowseStateFromSearch(search: string): FileViewerBrowseState | null {
  const params = new URLSearchParams(search);
  if (params.get("browse") !== "1") return null;
  const q = params.get("q");
  return { q: q && q.length > 0 ? q : null };
}

interface FileViewerProviderProps {
  issueId: string;
  children: ReactNode;
}

export function FileViewerProvider({ issueId, children }: FileViewerProviderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readFileViewerStateFromSearch(location.search), [location.search]);
  const browseState = useMemo(() => readBrowseStateFromSearch(location.search), [location.search]);

  const navigateSearch = useCallback(
    (nextSearch: string) => {
      navigate(
        { pathname: location.pathname, hash: location.hash, search: nextSearch },
        { state: location.state, replace: false },
      );
    },
    [location.hash, location.pathname, location.state, navigate],
  );

  const open = useCallback<FileViewerContextValue["open"]>(
    (ref, opts) => {
      let nextSearch = writeFileViewerStateToSearch(location.search, {
        path: ref.path,
        line: ref.line ?? null,
        column: ref.column ?? null,
        workspace: ref.workspace ?? "auto",
      });
      if (opts?.fromBrowse) {
        const params = new URLSearchParams(nextSearch);
        params.set("browse", "1");
        const prevQ = new URLSearchParams(location.search).get("q");
        if (prevQ) params.set("q", prevQ);
        nextSearch = params.toString() ? `?${params.toString()}` : "";
      }
      navigateSearch(nextSearch);
    },
    [location.search, navigateSearch],
  );

  const openBrowse = useCallback<FileViewerContextValue["openBrowse"]>(
    (opts) => {
      const params = new URLSearchParams(location.search);
      params.delete("file");
      params.delete("line");
      params.delete("column");
      params.set("browse", "1");
      if (typeof opts?.q === "string" && opts.q.length > 0) params.set("q", opts.q);
      else params.delete("q");
      navigateSearch(params.toString() ? `?${params.toString()}` : "");
    },
    [location.search, navigateSearch],
  );

  const backToFiles = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete("file");
    params.delete("line");
    params.delete("column");
    params.delete("workspace");
    params.set("browse", "1");
    navigateSearch(params.toString() ? `?${params.toString()}` : "");
  }, [location.search, navigateSearch]);

  const close = useCallback(() => {
    const params = new URLSearchParams(writeFileViewerStateToSearch(location.search, null).replace(/^\?/, ""));
    params.delete("browse");
    params.delete("q");
    navigateSearch(params.toString() ? `?${params.toString()}` : "");
  }, [location.search, navigateSearch]);

  const value = useMemo<FileViewerContextValue>(
    () => ({
      issueId,
      state,
      browse: browseState !== null,
      query: browseState?.q ?? null,
      open,
      openBrowse,
      backToFiles,
      close,
    }),
    [issueId, state, browseState, open, openBrowse, backToFiles, close],
  );

  return <FileViewerContext.Provider value={value}>{children}</FileViewerContext.Provider>;
}

export function useFileViewer(): FileViewerContextValue | null {
  return useContext(FileViewerContext);
}

export function useRequiredFileViewer(): FileViewerContextValue {
  const ctx = useContext(FileViewerContext);
  if (!ctx) {
    throw new Error("useRequiredFileViewer must be used within a FileViewerProvider");
  }
  return ctx;
}
