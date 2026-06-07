// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { WorkspaceFileListItem, WorkspaceFileListResponse } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileBrowser, describeUnavailable } from "./WorkspaceFileBrowser";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: unknown) => useQueryMock(options),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createItem(overrides: Partial<WorkspaceFileListItem> = {}): WorkspaceFileListItem {
  return {
    kind: "file",
    provider: "git_worktree",
    title: "IssueDetail.tsx",
    relativePath: "ui/src/pages/IssueDetail.tsx",
    displayPath: "ui/src/pages/IssueDetail.tsx",
    workspaceLabel: "Isolated workspace",
    workspaceKind: "execution_workspace",
    workspaceId: "ws-1",
    contentType: "text/plain; charset=utf-8",
    byteSize: 2048,
    modifiedAt: new Date(Date.now() - 120_000).toISOString(),
    previewKind: "text",
    capabilities: { preview: true, download: false, listChildren: false },
    ...overrides,
  };
}

function availableResponse(items: WorkspaceFileListItem[], truncated = false): WorkspaceFileListResponse {
  return {
    kind: "workspace_file_list",
    state: "available",
    workspace: {
      provider: "git_worktree",
      workspaceLabel: "Isolated workspace",
      workspaceKind: "execution_workspace",
      workspaceId: "ws-1",
    },
    query: { workspace: "auto", mode: "changed", q: null, limit: 100 },
    items,
    scannedCount: items.length,
    truncated,
  };
}

function unavailableResponse(reason: string): WorkspaceFileListResponse {
  return {
    kind: "workspace_file_list",
    state: "unavailable",
    unavailableReason: reason,
    workspace: null,
    query: { workspace: "auto", mode: "changed", q: null, limit: 100 },
    items: [],
    scannedCount: 0,
    truncated: false,
  };
}

function ok(data: WorkspaceFileListResponse) {
  return { data, isFetching: false, isError: false, error: null, refetch: vi.fn() };
}

describe("WorkspaceFileBrowser", () => {
  let container: HTMLDivElement;
  const roots: Root[] = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    useQueryMock.mockReset();
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => {
        root.unmount();
      });
    }
    container.remove();
  });

  function renderBrowser(onOpen = vi.fn()) {
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(<WorkspaceFileBrowser issueId="issue-1" onOpen={onOpen} />);
    });
    return { root, onOpen };
  }

  it("renders the Recently changed list as a listbox and opens a row with its relative path", () => {
    useQueryMock.mockReturnValue(
      ok(availableResponse([createItem(), createItem({ relativePath: "README.md", displayPath: "README.md" })])),
    );

    const { onOpen } = renderBrowser();

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.textContent).toContain("Recently changed");
    expect(container.textContent).toContain("From Isolated workspace");

    const option = Array.from(container.querySelectorAll('[role="option"]')).find(
      (el) => el.getAttribute("title") === "ui/src/pages/IssueDetail.tsx",
    );
    expect(option).not.toBeUndefined();

    act(() => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith({ path: "ui/src/pages/IssueDetail.tsx", workspace: "auto" });
  });

  it("does not render a Recent/All toggle", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    renderBrowser();
    expect(container.textContent).not.toContain("All files");
    expect(container.textContent).not.toContain("Recent changes / All");
  });

  it("discloses truncation in the footer", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()], true)));
    renderBrowser();
    expect(container.textContent).toContain("refine the search to narrow");
  });

  it("opens the highlighted row when Enter is pressed in the search field", () => {
    useQueryMock.mockReturnValue(ok(availableResponse([createItem()])));
    const { onOpen } = renderBrowser();
    const input = container.querySelector("input")!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith({ path: "ui/src/pages/IssueDetail.tsx", workspace: "auto" });
  });

  it("shows the remote-workspace state without file rows", () => {
    useQueryMock.mockReturnValue(ok(unavailableResponse("remote_workspace")));
    renderBrowser();
    expect(container.textContent).toContain("Remote workspace preview not supported");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("shows the no-workspace state when the issue has no workspace", () => {
    useQueryMock.mockReturnValue(ok(unavailableResponse("no_workspace")));
    renderBrowser();
    expect(container.textContent).toContain("No workspace yet");
  });
});

describe("describeUnavailable", () => {
  it("maps reasons to copy that matches the viewer's denial voice", () => {
    expect(describeUnavailable("remote_workspace").title).toBe("Remote workspace preview not supported");
    expect(describeUnavailable("no_workspace").title).toBe("No workspace yet");
    expect(describeUnavailable("no_local_workspace").title).toBe("No workspace yet");
    expect(describeUnavailable("workspace_unavailable").title).toBe("Workspace is no longer available");
    expect(describeUnavailable("archived").title).toBe("Workspace is no longer available");
  });

  it("never leaks the raw reason code as the body", () => {
    for (const reason of ["remote_workspace", "no_workspace", "workspace_unavailable", "weird_unknown"]) {
      const { body } = describeUnavailable(reason);
      expect(body).not.toBe(reason);
      expect(body).not.toMatch(/^[a-z_]+$/);
    }
  });
});
