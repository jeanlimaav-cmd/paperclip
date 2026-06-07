import express from "express";
import type { Request } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, executionWorkspaces, goals, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { errorHandler } from "../middleware/index.js";
import {
  createFileResourceLimiter,
  createFileResourceListLimiter,
  fileResourceRoutes,
  type WorkspaceFileResourceService,
} from "../routes/file-resources.js";
import {
  WORKSPACE_FILE_TEXT_MAX_BYTES,
  workspaceFileResourceService,
} from "../services/workspace-file-resources.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestGraph = {
  companyId: string;
  otherCompanyId: string;
  issueId: string;
  otherIssueId: string;
  projectId: string;
  workspaceRoot: string;
  executionRoot: string;
};

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-resources-"));
  const projectRoot = path.join(root, "project");
  const executionRoot = path.join(root, "execution");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(executionRoot, { recursive: true });
  return { root, projectRoot, executionRoot };
}

async function seedGraph(db: Db, input: {
  projectRoot: string;
  executionRoot?: string | null;
  projectSourceType?: string;
}): Promise<TestGraph> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const companyId = crypto.randomUUID();
  const otherCompanyId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const otherGoalId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const projectWorkspaceId = crypto.randomUUID();
  const otherProjectWorkspaceId = crypto.randomUUID();
  const executionWorkspaceId = crypto.randomUUID();
  const issueId = crypto.randomUUID();
  const otherIssueId = crypto.randomUUID();

  await db.insert(companies).values([
    { id: companyId, name: `Company ${suffix}`, issuePrefix: `F${suffix.slice(0, 4).toUpperCase()}` },
    { id: otherCompanyId, name: `Other ${suffix}`, issuePrefix: `G${suffix.slice(0, 4).toUpperCase()}` },
  ]);
  await db.insert(goals).values([
    { id: goalId, companyId, title: "Goal", level: "company", status: "active" },
    { id: otherGoalId, companyId: otherCompanyId, title: "Other goal", level: "company", status: "active" },
  ]);
  await db.insert(projects).values([
    { id: projectId, companyId, goalId, name: "Project", status: "in_progress" },
    { id: otherProjectId, companyId: otherCompanyId, goalId: otherGoalId, name: "Other project", status: "in_progress" },
  ]);
  await db.insert(projectWorkspaces).values([
    {
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: input.projectSourceType ?? "local_path",
      cwd: input.projectRoot,
      isPrimary: true,
    },
    {
      id: otherProjectWorkspaceId,
      companyId: otherCompanyId,
      projectId: otherProjectId,
      name: "Other workspace",
      sourceType: "local_path",
      cwd: input.projectRoot,
      isPrimary: true,
    },
  ]);
  await db.insert(issues).values([
    {
      id: issueId,
      companyId,
      projectId,
      goalId,
      projectWorkspaceId,
      title: "Read a file",
      status: "todo",
      priority: "medium",
    },
    {
      id: otherIssueId,
      companyId: otherCompanyId,
      projectId: otherProjectId,
      goalId: otherGoalId,
      projectWorkspaceId: otherProjectWorkspaceId,
      title: "Other issue",
      status: "todo",
      priority: "medium",
    },
  ]);
  await db.insert(executionWorkspaces).values({
    id: executionWorkspaceId,
    companyId,
    projectId,
    projectWorkspaceId,
    sourceIssueId: issueId,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Issue worktree",
    status: "active",
    cwd: input.executionRoot ?? null,
    providerType: input.executionRoot ? "git_worktree" : "remote_managed",
    providerRef: input.executionRoot ?? "remote-workspace",
  });
  await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));

  return {
    companyId,
    otherCompanyId,
    issueId,
    otherIssueId,
    projectId,
    workspaceRoot: input.projectRoot,
    executionRoot: input.executionRoot ?? input.projectRoot,
  };
}

function createApp(
  db: Db,
  actor: Request["actor"],
  routeOpts: Parameters<typeof fileResourceRoutes>[1] = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", fileResourceRoutes(db, routeOpts));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("workspace file resources", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-file-resources-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves and reads a project file without exposing absolute paths", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "src", "app.ts"), "export const ok = true;\n", { encoding: "utf8" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "src", "app.ts"), "export const ok = true;\n", "utf8");
    });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "src/app.ts" });

    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body.resource.displayPath).toBe("src/app.ts");
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(res.body.content.data).toContain("export const ok");
  });

  it("falls back from an execution workspace miss to the project workspace", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Project\n", "utf8");

    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, {
      path: "README.md",
      workspace: "auto",
    });

    expect(resolved.workspaceKind).toBe("project_workspace");
    expect(resolved.displayPath).toBe("README.md");
    expect(resolved.capabilities.preview).toBe(true);
  });

  it("lists and searches safe file candidates from the preferred execution workspace", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.mkdir(path.join(executionRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(executionRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(executionRoot, "src", "app.ts"), "export const ok = true;\n", "utf8");
    await fs.writeFile(path.join(executionRoot, ".env"), "TOKEN=secret\n", "utf8");
    await fs.writeFile(path.join(executionRoot, "node_modules", "pkg", "index.ts"), "export {}\n", "utf8");
    await fs.writeFile(path.join(executionRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(projectRoot, "src-project.ts"), "export const project = true;\n", "utf8");
    await fs.writeFile(path.join(root, "outside.ts"), "secret\n", "utf8");
    await fs.symlink(path.join(root, "outside.ts"), path.join(executionRoot, "escape.ts"));

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "auto", q: "src", limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("available");
    expect(res.body.workspace.workspaceKind).toBe("execution_workspace");
    expect(res.body.items.map((item: { displayPath: string }) => item.displayPath)).toEqual(["src/app.ts"]);
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(JSON.stringify(res.body)).not.toContain(".env");
    expect(JSON.stringify(res.body)).not.toContain("node_modules");
    expect(JSON.stringify(res.body)).not.toContain("escape.ts");
    expect(JSON.stringify(res.body)).not.toContain("blob.bin");
  });

  it("enforces default and hard list/search caps", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        fs.writeFile(
          path.join(projectRoot, "src", `file-${String(index).padStart(2, "0")}.ts`),
          "export {}\n",
          "utf8",
        ),
      ),
    );
    const tooDeepDir = path.join(projectRoot, ...Array.from({ length: 21 }, (_, index) => `deep-${index}`));
    await fs.mkdir(tooDeepDir, { recursive: true });
    await fs.writeFile(path.join(tooDeepDir, "too-deep.ts"), "export const hidden = true;\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const defaultLimit = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all" });
    expect(defaultLimit.status).toBe(200);
    expect(defaultLimit.body.query.limit).toBe(25);
    expect(defaultLimit.body.items).toHaveLength(25);
    expect(defaultLimit.body.truncated).toBe(true);

    const tooLargeLimit = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all", limit: 101 });
    expect(tooLargeLimit.status).toBe(422);
    expect(tooLargeLimit.body?.details?.code).toBe("invalid_query");

    const tooDeep = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all", q: "too-deep", limit: 100 });
    expect(tooDeep.status).toBe(200);
    expect(tooDeep.body.items).toEqual([]);
    expect(tooDeep.body.truncated).toBe(true);
  });

  it("supports recent mode, limit caps, and list activity logging", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "old.ts"), "export const old = true;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "new.ts"), "export const newer = true;\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "recent", limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.truncated).toBe(true);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const listRead = rows.find((row) => row.action === "issue.file_resource_list");
    expect(listRead).toBeTruthy();
    expect(listRead?.details).toMatchObject({
      outcome: "success",
      workspaceSelector: "project",
      mode: "recent",
      resultCount: 1,
      truncated: true,
    });
    expect(JSON.stringify(listRead?.details)).not.toContain(projectRoot);
    expect(JSON.stringify(listRead?.details)).not.toContain("old.ts");
    expect(JSON.stringify(listRead?.details)).not.toContain("new.ts");
  });

  it("rejects overlong list searches and redacts the raw query from denial audit details", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const rawQuery = "é".repeat(65);

    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", q: rawQuery });

    expect(res.status).toBe(422);
    expect(res.body?.details?.code).toBe("invalid_query");
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const denied = rows.find((row) => row.action === "issue.file_resource_list_denied");
    expect(denied?.details).toMatchObject({
      outcome: "denied",
      workspaceSelector: "project",
      mode: "all",
      denialReason: "invalid_query",
    });
    expect(JSON.stringify(denied?.details)).not.toContain(rawQuery);
  });

  it("rejects control characters in the path without crashing the audit log", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const nullByte = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=foo%00bar.ts`);
    expect(nullByte.status).toBe(422);
    expect(nullByte.body?.details?.code).toBe("invalid_path");

    const resolveNullByte = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve?workspace=project&path=foo%00bar.ts`);
    expect(resolveNullByte.status).toBe(422);
    expect(resolveNullByte.body?.details?.code).toBe("invalid_path");

    const otherControl = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=a%0Bb.ts`);
    expect(otherControl.status).toBe(422);
    expect(otherControl.body?.details?.code).toBe("invalid_path");
  });

  it("rejects traversal, encoded traversal, backslash traversal, and double-encoding without double-decoding", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "safe.txt"), "safe\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=..%2Fsecret.txt`)).status).toBe(403);
    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=%2e%2e%2Fsecret.txt`)).status).toBe(403);
    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "..\\secret.txt" })).status).toBe(422);
    const doubleEncoded = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=%252e%252e%252Fsecret.txt`);
    expect(doubleEncoded.status).toBe(404);
  });

  it("blocks symlink escapes and symlinks to denied sensitive files", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(root, "outside-secret.txt"), "secret\n", "utf8");
    await fs.mkdir(path.join(projectRoot, "safe"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "safe", ".env"), "TOKEN=secret\n", "utf8");
    await fs.symlink(path.join(root, "outside-secret.txt"), path.join(projectRoot, "escape.txt"));
    await fs.symlink(path.join(projectRoot, "safe", ".env"), path.join(projectRoot, "linked-env"));

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const escape = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "escape.txt" });
    const linkedSecret = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "linked-env" });

    expect(escape.status).toBe(403);
    expect(linkedSecret.status).toBe(403);
  });

  it("rejects denied paths, non-regular files, oversized text, binary, and HTML while previewing SVG as source", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, ".git", "config"), "[core]\n", "utf8");
    await fs.mkdir(path.join(projectRoot, "folder"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "big.txt"), Buffer.alloc(WORKSPACE_FILE_TEXT_MAX_BYTES + 1, "a"));
    await fs.writeFile(path.join(projectRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(projectRoot, "index.html"), "<script>alert(1)</script>", "utf8");
    await fs.writeFile(path.join(projectRoot, "icon.svg"), "<svg></svg>\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    for (const filePath of [".git/config", "folder", "big.txt", "blob.bin", "index.html"]) {
      const res = await request(app)
        .get(`/api/issues/${graph.issueId}/file-resources/content`)
        .query({ workspace: "project", path: filePath });
      expect([403, 422]).toContain(res.status);
    }
    const svg = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "icon.svg" });
    expect(svg.status).toBe(200);
    expect(svg.body.resource.previewKind).toBe("text");
    expect(svg.body.content.data).toContain("<svg");
  });

  it("rejects remote workspaces without fetching provider resources", async () => {
    const { projectRoot } = await makeWorkspace();
    const graph = await seedGraph(db, {
      projectRoot,
      executionRoot: null,
      projectSourceType: "remote_managed",
    });

    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, {
      path: "README.md",
      workspace: "project",
    });
    expect(resolved.kind).toBe("remote_resource");
    expect(resolved.capabilities.preview).toBe(false);

    await expect(workspaceFileResourceService(db).readContent(graph.issueId, {
      path: "http://169.254.169.254/latest/meta-data/",
      workspace: "project",
    })).rejects.toMatchObject({ status: 422 });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const listed = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project" });
    expect(listed.status).toBe(200);
    expect(listed.body.state).toBe("unavailable");
    expect(listed.body.unavailableReason).toBe("remote_workspace");
    expect(listed.body.items).toEqual([]);
  });

  it("blocks agents and cross-company board users before content reads", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Secret\n", "utf8");
    const agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: graph.companyId,
      name: "File audit agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    });

    const agentApp = createApp(db, {
      type: "agent",
      agentId,
      companyId: graph.companyId,
      source: "agent_key",
    });
    const boardApp = createApp(db, {
      type: "board",
      userId: "mallory",
      companyIds: [graph.otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(agentApp).get(`/api/issues/${graph.issueId}/file-resources/resolve`).query({ path: "README.md" })).status).toBe(403);
    expect((await request(boardApp).get(`/api/issues/${graph.issueId}/file-resources/resolve`).query({ path: "README.md" })).status).toBe(403);
    expect((await request(agentApp).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ path: "README.md" })).status).toBe(403);
    expect((await request(boardApp).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ path: "README.md" })).status).toBe(403);
    expect((await request(agentApp).get(`/api/issues/${graph.issueId}/file-resources/list`)).status).toBe(403);
    expect((await request(boardApp).get(`/api/issues/${graph.issueId}/file-resources/list`)).status).toBe(403);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const listDenials = rows.filter((row) => row.action === "issue.file_resource_list_denied");
    const resolveDenials = rows.filter((row) => row.action === "issue.file_resource_resolve_denied");
    const contentDenials = rows.filter((row) => row.action === "issue.file_resource_content_denied");
    expect(listDenials).toHaveLength(2);
    expect(resolveDenials).toHaveLength(2);
    expect(contentDenials).toHaveLength(2);
    expect(JSON.stringify(listDenials.map((row) => row.details))).not.toContain("README.md");
    expect(JSON.stringify(rows.map((row) => row.details))).not.toContain(projectRoot);
  });

  it("logs successful content reads and denied security-relevant attempts", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Project\n", "utf8");
    await fs.writeFile(path.join(projectRoot, ".env"), "TOKEN=secret\n", "utf8");
    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "README.md" });
    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: ".env" });

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    expect(rows.some((row) => row.action === "issue.file_resource_content_read")).toBe(true);
    expect(rows.some((row) => row.action === "issue.file_resource_content_denied")).toBe(true);
    expect(JSON.stringify(rows.map((row) => row.details))).not.toContain(projectRoot);
  });

  it("logs successful resolves and resolve/content limiter denials", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Visible\n", "utf8");

    const app = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );

    const resolved = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ workspace: "project", path: "README.md" });
    expect(resolved.status).toBe(200);

    const rowsAfterResolve = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const resolveRead = rowsAfterResolve.find((row) => row.action === "issue.file_resource_resolve");
    expect(resolveRead?.details).toMatchObject({
      outcome: "success",
      workspaceKind: "project_workspace",
      displayPath: "README.md",
    });
    expect(JSON.stringify(resolveRead?.details)).not.toContain(projectRoot);

    let releaseSlowResolve: (() => void) | null = null;
    let slowResolveStarted: (() => void) | null = null;
    const slowResolve = new Promise<void>((resolve) => {
      releaseSlowResolve = resolve;
    });
    const resolveStarted = new Promise<void>((resolve) => {
      slowResolveStarted = resolve;
    });
    const resolveLimitedService: WorkspaceFileResourceService = {
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        slowResolveStarted?.();
        await slowResolve;
        return {
          kind: "file",
          provider: "local_fs",
          title: "README.md",
          displayPath: "README.md",
          workspaceLabel: "Workspace",
          workspaceKind: "project_workspace",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          previewKind: "text",
          capabilities: { preview: true, download: false, listChildren: false },
        };
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const resolveLimitedApp = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service: resolveLimitedService,
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );
    const firstResolve = request(resolveLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ path: "README.md" });
    const firstResolveResponse = firstResolve.then((res) => res);
    await resolveStarted;
    const secondResolve = await request(resolveLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ path: "README.md" });
    expect(secondResolve.status).toBe(429);
    releaseSlowResolve?.();
    expect((await firstResolveResponse).status).toBe(200);

    let releaseSlowContent: (() => void) | null = null;
    let slowContentStarted: (() => void) | null = null;
    const slowContent = new Promise<void>((resolve) => {
      releaseSlowContent = resolve;
    });
    const contentStarted = new Promise<void>((resolve) => {
      slowContentStarted = resolve;
    });
    const contentLimitedService: WorkspaceFileResourceService = {
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        throw new Error("not used");
      }),
      readContent: vi.fn(async () => {
        slowContentStarted?.();
        await slowContent;
        return {
          resource: {
            kind: "file",
            provider: "local_fs",
            title: "README.md",
            displayPath: "README.md",
            workspaceLabel: "Workspace",
            workspaceKind: "project_workspace",
            workspaceId: "11111111-1111-4111-8111-111111111111",
            previewKind: "text",
            capabilities: { preview: true, download: false, listChildren: false },
          },
          content: { encoding: "utf8", data: "# Visible\n" },
        };
      }),
    };
    const contentLimitedApp = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service: contentLimitedService,
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );
    const firstContent = request(contentLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ path: "README.md" });
    const firstContentResponse = firstContent.then((res) => res);
    await contentStarted;
    const secondContent = await request(contentLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ path: "README.md" });
    expect(secondContent.status).toBe(429);
    releaseSlowContent?.();
    expect((await firstContentResponse).status).toBe(200);

    const rowsAfterLimits = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    expect(rowsAfterLimits.some((row) => row.action === "issue.file_resource_resolve_denied")).toBe(true);
    expect(rowsAfterLimits.some((row) => row.action === "issue.file_resource_content_denied")).toBe(true);
    expect(JSON.stringify(rowsAfterLimits.map((row) => row.details))).not.toContain(projectRoot);
  });

  it("uses tighter list-specific rate and concurrency limits", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    let releaseSlowList: (() => void) | null = null;
    let slowListStarted: (() => void) | null = null;
    const slowList = new Promise<void>((resolve) => {
      releaseSlowList = resolve;
    });
    const listStarted = new Promise<void>((resolve) => {
      slowListStarted = resolve;
    });
    const service: WorkspaceFileResourceService = {
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      list: vi.fn(async () => {
        slowListStarted?.();
        await slowList;
        return {
          kind: "workspace_file_list",
          state: "available",
          workspace: {
            provider: "local_fs",
            workspaceLabel: "Workspace",
            workspaceKind: "project_workspace",
            workspaceId: "11111111-1111-4111-8111-111111111111",
          },
          query: {
            workspace: "auto",
            mode: "all",
            q: null,
            limit: 25,
          },
          items: [],
          scannedCount: 0,
          truncated: false,
        };
      }),
      resolve: vi.fn(async () => {
        throw new Error("not used");
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const app = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service,
        listLimiter: createFileResourceListLimiter({ maxConcurrent: 1, maxRequests: 2, windowMs: 60_000 }),
      },
    );

    const first = request(app).get(`/api/issues/${graph.issueId}/file-resources/list`);
    const firstResponse = first.then((res) => res);
    await listStarted;
    const second = await request(app).get(`/api/issues/${graph.issueId}/file-resources/list`);
    expect(second.status).toBe(429);
    releaseSlowList?.();
    expect((await firstResponse).status).toBe(200);
    const third = await request(app).get(`/api/issues/${graph.issueId}/file-resources/list`);
    expect(third.status).toBe(429);
  });
});

describeEmbeddedPostgres("file resource route guards", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-file-resource-guards-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("enforces bounded rate and concurrency limits", async () => {
    const companyId = crypto.randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Rate limit company",
      issuePrefix: "RAT",
    });
    let releaseSlowRead: (() => void) | null = null;
    let slowReadStarted: (() => void) | null = null;
    const slowRead = new Promise<void>((resolve) => {
      releaseSlowRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      slowReadStarted = resolve;
    });
    const service: WorkspaceFileResourceService = {
      getIssue: vi.fn(async () => ({ companyId })),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        slowReadStarted?.();
        await slowRead;
        return {
          kind: "file",
          provider: "local_fs",
          title: "README.md",
          displayPath: "README.md",
          workspaceLabel: "Workspace",
          workspaceKind: "project_workspace",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          previewKind: "text",
          capabilities: { preview: true, download: false, listChildren: false },
        };
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", fileResourceRoutes(db, {
      service,
      limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 2, windowMs: 60_000 }),
    }));
    app.use(errorHandler);

    const first = request(app).get("/api/issues/issue-1/file-resources/resolve").query({ path: "README.md" });
    const firstResponse = first.then((res) => res);
    await readStarted;
    const second = await request(app).get("/api/issues/issue-1/file-resources/resolve").query({ path: "README.md" });
    expect(second.status).toBe(429);
    releaseSlowRead?.();
    expect((await firstResponse).status).toBe(200);
    const third = await request(app).get("/api/issues/issue-1/file-resources/resolve").query({ path: "README.md" });
    expect(third.status).toBe(429);
  });
});
