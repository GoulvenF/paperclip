import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeIsolatedTaskDirectory, shouldUseIsolatedTaskDirectory } from "./isolated-task-directory.js";

const policy = {
  trustPreset: "low_trust_review",
  environmentDriver: "sandbox",
  mode: "isolated_workspace",
  hasProjectWorkspace: false,
  projectWorkspaceId: null,
  workspaceStrategies: [undefined, null, {}],
};

describe("repository-free low-trust workspace selection", () => {
  it("selects a private directory for sandbox tasks without a repository", () => {
    expect(shouldUseIsolatedTaskDirectory(policy)).toBe(true);
  });

  it.each([
    { trustPreset: "standard" },
    { environmentDriver: "local" },
    { environmentDriver: "ssh" },
    { mode: "shared_workspace" },
    { hasProjectWorkspace: true },
    { projectWorkspaceId: "workspace-1" },
    { workspaceStrategies: [{ type: "git_worktree" }] },
    { workspaceStrategies: [{ existingBranch: "main" }] },
    { workspaceStrategies: [{ provisionCommand: "setup" }] },
  ])("preserves configured workspace requirements: %j", (override) => {
    expect(shouldUseIsolatedTaskDirectory({ ...policy, ...override })).toBe(false);
  });
});

describe("isolated task directories", () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-task-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    return { companyId: "company-1", agentId: "agent-1", issueId: "issue-1" };
  }

  it("retains a task's files across turns without sharing them with another task, agent, or company", async () => {
    const identity = await setup();
    const cwd = await materializeIsolatedTaskDirectory(identity);
    await writeFile(path.join(cwd, "notes.txt"), "private task output");
    expect(await materializeIsolatedTaskDirectory(identity)).toBe(cwd);
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe("private task output");
    for (const other of [{ issueId: "issue-2" }, { agentId: "agent-2" }, { companyId: "company-2" }]) {
      const otherCwd = await materializeIsolatedTaskDirectory({ ...identity, ...other });
      expect(otherCwd).not.toBe(cwd);
      expect(otherCwd.startsWith(`${cwd}${path.sep}`)).toBe(false);
      expect(await readdir(otherCwd)).toEqual([]);
    }
  });

  it("rejects a symlink to another task's directory", async () => {
    const identity = await setup();
    const cwd = await materializeIsolatedTaskDirectory(identity);
    await symlink(cwd, path.join(path.dirname(cwd), "issue-2"));
    await expect(materializeIsolatedTaskDirectory({ ...identity, issueId: "issue-2" }))
      .rejects.toThrow("not a private directory");
  });

  it("rejects path traversal identities", async () => {
    const identity = await setup();
    await expect(materializeIsolatedTaskDirectory({ ...identity, issueId: "../outside" }))
      .rejects.toThrow("Invalid isolated task workspace identity");
  });
});
