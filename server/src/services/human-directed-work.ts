import { and, eq, isNotNull, or } from "drizzle-orm";
import { issueHumanWorkGrants, issues, type Db } from "@paperclipai/db";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";

type Writer = Pick<Db, "insert">;
type Reader = Pick<Db, "select">;

/** Called within the task write transaction, with authenticated server actor fields. */
export async function recordHumanDirectedWork(
  db: Writer,
  issue: { id: string; companyId: string; assigneeAgentId: string | null },
  actor: { userId?: string | null; agentId?: string | null },
) {
  if (!actor.userId || actor.agentId || !issue.assigneeAgentId) return;
  await db.insert(issueHumanWorkGrants).values({
    issueId: issue.id,
    companyId: issue.companyId,
    agentId: issue.assigneeAgentId,
    userId: actor.userId,
  }).onConflictDoUpdate({
    target: issueHumanWorkGrants.issueId,
    set: { agentId: issue.assigneeAgentId, userId: actor.userId, createdAt: new Date() },
  });
}

/**
 * This exception belongs only to the current task. It is never serialized into
 * trustBoundary (which would make it inherited authority for unrelated work).
 * The caller supplies a task identity loaded from the bound run, not a tool's
 * target or a claimed responsible user. Normal low-trust powers stay unchanged.
 */
export async function withHumanDirectedWork(
  db: Reader,
  resolution: TrustPresetResolution,
  input: { companyId: string; agentId: string; issueId: string | null },
): Promise<TrustPresetResolution> {
  if (resolution.kind !== "low_trust_review" || !input.issueId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.issueId) ||
      resolution.boundary.companyId !== input.companyId) return resolution;
  // Read the current assignment and receipt in one snapshot. Conversation
  // identity is immutable and established by the authenticated first-write route.
  const [issue] = await db.select({ id: issues.id })
    .from(issues)
    .leftJoin(issueHumanWorkGrants, and(
      eq(issueHumanWorkGrants.issueId, issues.id),
      eq(issueHumanWorkGrants.companyId, issues.companyId),
      eq(issueHumanWorkGrants.agentId, input.agentId),
    ))
    .where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
      eq(issues.assigneeAgentId, input.agentId),
      or(
        and(eq(issues.conversationAgentId, input.agentId), isNotNull(issues.conversationUserId)),
        isNotNull(issueHumanWorkGrants.issueId),
      ),
    ));
  return issue ? { ...resolution, humanDirectedIssueId: issue.id } : resolution;
}
