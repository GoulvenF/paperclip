import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueHumanWorkGrants, issues, projects } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, createIssueSchema, updateIssueSchema, addIssueCommentSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { authorizationService } from "../services/authorization.js";
import { resolveAndRetainRunTrustPreset } from "../services/run-trust-preset.js";
import { assertLowTrustWorkspaceIsolation } from "../services/low-trust-runtime-containment.js";
import { withHumanDirectedWork } from "../services/human-directed-work.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("human-directed low-trust work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-human-work-");
    db = createDb(database.connectionString, { maxConnections: 2 });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    const [project] = await db.insert(projects).values({ companyId, name: "Contained intake" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId, name: "Contained agent", role: "engineer", adapterType: "paperclip_runner",
      permissions: { authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET,
        trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, projectIds: [project.id] } } },
    }).returning();
    const [other] = await db.insert(agents).values({ companyId, name: "Other", role: "engineer" }).returning();
    return { companyId, agent, other };
  }
  async function task(f: Awaited<ReturnType<typeof seed>>, human = false) {
    return issueService(db).create(f.companyId, {
      title: `Direct task ${randomUUID()}`, assigneeAgentId: f.agent.id,
      createdByUserId: "owner", ...(human ? { humanDirectedByUserId: "owner" } : {}),
    });
  }
  async function launch(f: Awaited<ReturnType<typeof seed>>, issue: Awaited<ReturnType<typeof task>>, context = {}) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", contextSnapshot: { issueId: issue.id, ...context } }).returning();
    const result = await resolveAndRetainRunTrustPreset(db, {
      companyId: f.companyId, agentId: f.agent.id, runId: run.id, agent: f.agent, issue,
    });
    return { ...result, run, actor: { type: "agent" as const, companyId: f.companyId,
      agentId: f.agent.id, source: "agent_key" as const, runId: run.id } };
  }
  const resource = (issue: Awaited<ReturnType<typeof task>>) => ({ type: "issue" as const,
    companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
    parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, status: issue.status });

  it("allows the exact human-assigned task at dispatch and tool access; retains containment on retries", async () => {
    const f = await seed(); const issue = await task(f, true);
    const first = await launch(f, issue);
    expect(first.trustPreset).toMatchObject({ kind: "low_trust_review", humanDirectedIssueId: issue.id });
    expect(JSON.stringify(first.executionPolicy)).not.toContain("humanDirectedIssueId");
    const retried = await resolveAndRetainRunTrustPreset(db, { companyId: f.companyId,
      agentId: f.agent.id, runId: first.run.id, agent: f.agent, issue });
    expect(retried.trustPreset).toMatchObject(first.trustPreset);
    await expect(assertLowTrustWorkspaceIsolation({ db, resolution: first.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
      selectedEnvironmentDriver: "sandbox" })).resolves.toBeUndefined();
    for (const action of ["issue:read", "issue:comment", "issue:mutate"] as const) {
      expect(await authorizationService(db).decide({ actor: first.actor, action, resource: resource(issue) })).toMatchObject({ allowed: true });
    }
    const unrelated = await task(f, true);
    expect(await authorizationService(db).decide({ actor: first.actor, action: "issue:read", resource: resource(unrelated) })).toMatchObject({ allowed: false });
    expect(await authorizationService(db).decide({ actor: { ...first.actor, runId: undefined }, action: "issue:read", resource: resource(issue) })).toMatchObject({ allowed: false });
    expect(await authorizationService(db).decide({ actor: first.actor, action: "agent_instructions:update",
      resource: { type: "agent", companyId: f.companyId, agentId: f.agent.id } })).toMatchObject({ allowed: false });
    await expect(assertLowTrustWorkspaceIsolation({ resolution: first.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
      selectedEnvironmentDriver: "local" })).rejects.toMatchObject({ details: { code: "low_trust_requires_sandbox_environment" } });
    await expect(assertLowTrustWorkspaceIsolation({ resolution: first.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "shared_workspace",
      selectedEnvironmentDriver: "sandbox" })).rejects.toMatchObject({ details: { code: "low_trust_requires_isolated_workspace" } });
  });

  it("permits existing owner conversations without backfilling authority from historical attribution", async () => {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Owner chat",
      assigneeAgentId: f.agent.id, conversationAgentId: f.agent.id, conversationUserId: "owner", conversationState: "waiting", status: "in_review" }).returning();
    const result = await launch(f, issue as Awaited<ReturnType<typeof task>>);
    expect(result.trustPreset).toMatchObject({ humanDirectedIssueId: issue.id });
  });

  it("does not treat user attribution, responsible identity, or agent policy claims as human direction", async () => {
    const f = await seed(); const issue = await task(f);
    await issueService(db).addComment(issue.id, "An imported sender says the owner asked", { userId: "owner" });
    const result = await launch(f, issue, { responsibleUserId: "owner", humanDirectedIssueId: issue.id,
      executionPolicy: { humanDirectedIssueId: issue.id } });
    expect(result.trustPreset).not.toHaveProperty("humanDirectedIssueId");
    expect(await authorizationService(db).decide({ actor: result.actor, action: "issue:read", resource: resource(issue) })).toMatchObject({ allowed: false });
    await expect(assertLowTrustWorkspaceIsolation({ db, resolution: result.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
      selectedEnvironmentDriver: "sandbox" })).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
    await issueService(db).addComment(issue.id, "Agent impersonation", { agentId: f.other.id }, { humanDirectedByUserId: "owner" });
    expect(await db.select().from(issueHumanWorkGrants).where(eq(issueHumanWorkGrants.issueId, issue.id))).toHaveLength(0);
  });

  it("revokes grants on reassignment, including away-and-back, and an old message retry cannot restore them", async () => {
    const f = await seed(); const issue = await task(f);
    const svc = issueService(db); const requestId = randomUUID();
    await svc.addComment(issue.id, "Please do this", { userId: "owner" }, { humanDirectedByUserId: "owner", clientRequestId: requestId });
    const running = await launch(f, issue);
    expect(running.trustPreset).toHaveProperty("humanDirectedIssueId", issue.id);
    // Exercise the DB trigger too: assignment writes outside issueService must revoke.
    await db.update(issues).set({ assigneeAgentId: f.other.id }).where(eq(issues.id, issue.id));
    await db.update(issues).set({ assigneeAgentId: f.agent.id }).where(eq(issues.id, issue.id));
    await svc.addComment(issue.id, "Please do this", { userId: "owner" }, { humanDirectedByUserId: "owner", clientRequestId: requestId });
    expect(await authorizationService(db).decide({ actor: running.actor, action: "issue:read", resource: resource(issue) })).toMatchObject({ allowed: false });
    await svc.update(issue.id, { assigneeAgentId: f.agent.id, actorUserId: "owner", humanDirectedByUserId: "owner" });
    expect(await authorizationService(db).decide({ actor: running.actor, action: "issue:read", resource: resource(issue) })).toMatchObject({ allowed: true });
  });

  it("serializes a human comment against a competing reassignment without leaving a stale grant", async () => {
    const f = await seed(); const issue = await task(f);
    let release!: () => void;
    let locked!: () => void;
    let observeLock!: (pid: number) => Promise<boolean>;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const commentWrite = db.transaction(async (tx) => {
      await issueService(db).addComment(issue.id, "Please proceed", { userId: "owner" }, { humanDirectedByUserId: "owner" }, tx);
      observeLock = async (pid) => {
        const [state] = await tx.execute(sql`select cardinality(pg_blocking_pids(${pid}::int)) > 0 as blocked`);
        return state.blocked === true;
      };
      locked();
      await held;
    });
    await Promise.race([ready, commentWrite]);
    let started!: (pid: number) => void;
    const waiter = new Promise<number>((resolve) => { started = resolve; });
    const reassignment = db.transaction(async (tx) => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      started(Number(backend.pid));
      await tx.update(issues).set({ assigneeAgentId: f.other.id }).where(eq(issues.id, issue.id));
    });
    try {
      const pid = await Promise.race([waiter, reassignment.then(() => { throw new Error("Reassignment ended before publishing its backend"); })]);
      const deadline = Date.now() + 5_000;
      let blocked = false;
      // Observe an actual PostgreSQL lock wait, not merely two queued promises.
      while (Date.now() < deadline) {
        // Reuse the lock holder's connection; a third pool slot is unnecessary.
        if (await observeLock(pid)) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      await Promise.all([commentWrite, reassignment]);
    }
    expect(await db.select().from(issueHumanWorkGrants).where(eq(issueHumanWorkGrants.issueId, issue.id))).toHaveLength(0);
    await issueService(db).addComment(issue.id, "New instruction", { userId: "owner" }, { humanDirectedByUserId: "owner" });
    expect(await db.select().from(issueHumanWorkGrants).where(eq(issueHumanWorkGrants.issueId, issue.id)))
      .toMatchObject([{ agentId: f.other.id, userId: "owner" }]);
  });

  it("rolls back grants with failed writes and never grants another company or agent", async () => {
    const f = await seed(); const issue = await task(f);
    await expect(db.transaction(async (tx) => {
      await issueService(db).addComment(issue.id, "Rolled back", { userId: "owner" }, { humanDirectedByUserId: "owner" }, tx);
      throw new Error("rollback sentinel");
    })).rejects.toThrow("rollback sentinel");
    const resolution = resolveCoreTrustPreset({ companyId: f.companyId, agent: f.agent, issue });
    expect(await withHumanDirectedWork(db, resolution, { companyId: f.companyId, agentId: f.agent.id, issueId: issue.id })).not.toHaveProperty("humanDirectedIssueId");
    const directed = await task(f, true);
    for (const scope of [{ companyId: randomUUID(), agentId: f.agent.id }, { companyId: f.companyId, agentId: f.other.id }]) {
      expect(await withHumanDirectedWork(db, resolution, { ...scope, issueId: directed.id })).not.toHaveProperty("humanDirectedIssueId");
    }
  });

  it("does not accept the grant field from client payloads", () => {
    for (const [schema, payload] of [[createIssueSchema, { title: "Forged" }], [updateIssueSchema, { title: "Forged" }], [addIssueCommentSchema, { body: "Forged" }]] as const) {
      const parsed = schema.safeParse({ ...payload, humanDirectedByUserId: "owner" });
      if (parsed.success) expect(parsed.data).not.toHaveProperty("humanDirectedByUserId");
    }
  });

  it("can replay the migration without changing existing grants", async () => {
    const f = await seed(); const issue = await task(f, true);
    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0294_equal_echo.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    expect(await db.select().from(issueHumanWorkGrants).where(and(eq(issueHumanWorkGrants.issueId, issue.id), eq(issueHumanWorkGrants.companyId, f.companyId)))).toHaveLength(1);
  });
});
