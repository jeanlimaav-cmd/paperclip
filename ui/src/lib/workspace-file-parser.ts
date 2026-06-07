export interface ParsedWorkspaceFileRef {
  path: string;
  line: number | null;
  column: number | null;
  /** The original matched text (useful for rendering) */
  raw: string;
}

/**
 * Match a workspace file reference inside an inline code span.
 *
 * Accepts POSIX-style relative paths with at least one slash or a recognizable
 * file extension. Supports optional line/column suffixes:
 *
 *  - `path/to/file.ext`
 *  - `path/to/file.ext:42`
 *  - `path/to/file.ext:42:3`
 *  - `path/to/file.ext#L42`
 *  - `path/to/file.ext#L42C3`
 */
const WORKSPACE_FILE_REF_RE =
  /^([A-Za-z0-9_.\-+][A-Za-z0-9_./\-+]*\.[A-Za-z0-9_+\-]{1,10})(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)?$/;

const BARE_NO_EXT_RE = /^([A-Za-z0-9_.\-+][A-Za-z0-9_./\-+]+\/[A-Za-z0-9_.\-+]+)(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)?$/;

const INVALID_PREFIXES = ["/", "./", "../", "~/"];

function toPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function looksLikeWorkspaceFilePath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes("//")) return false;
  if (INVALID_PREFIXES.some((prefix) => path === prefix.slice(0, -1))) return false;
  if (/^\.+$/.test(path)) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/**
 * Attempt to parse the given text as a workspace file reference.
 * Returns null if the text does not look like one.
 */
export function parseWorkspaceFileRef(input: string): ParsedWorkspaceFileRef | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(WORKSPACE_FILE_REF_RE) ?? trimmed.match(BARE_NO_EXT_RE);
  if (!match) return null;
  const [, rawPath, colonLine, colonCol, hashLine, hashCol] = match;
  if (!rawPath) return null;
  if (!looksLikeWorkspaceFilePath(rawPath)) return null;

  const line = toPositiveInt(colonLine) ?? toPositiveInt(hashLine);
  const column = toPositiveInt(colonCol) ?? toPositiveInt(hashCol);

  // Disambiguate against plain prose filenames like `README.md`:
  // require either a slash in the path or a line anchor.
  if (!rawPath.includes("/") && line === null) return null;

  return {
    path: rawPath,
    line,
    column,
    raw: trimmed,
  };
}

export function formatWorkspaceFileRefDisplay(ref: ParsedWorkspaceFileRef): string {
  if (ref.line && ref.column) return `${ref.path}:${ref.line}:${ref.column}`;
  if (ref.line) return `${ref.path}:${ref.line}`;
  return ref.path;
}
