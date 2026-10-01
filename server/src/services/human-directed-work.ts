import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";

/**
 * Derive exact-task authority from existing server-owned execution records.
 * Responsible-user attribution alone is insufficient: it is also inherited by
 * agent-created work. Never read authority or retry ancestry from tool payloads.
 */
export async function withHumanDirectedWork(
  db: Pick<Db, "execute">,
  resolution: TrustPresetResolution,
  input: { companyId: string; agentId: string; runId: string },
): Promise<TrustPresetResolution> {
  if (resolution.kind !== "low_trust_review" ||
      resolution.boundary.companyId !== input.companyId) return resolution;

  // One snapshot binds the live run, current assignee, and authenticated wake.
  // Reassignment already cancels the old run; cancelled executions cannot lend
  // authority to retries, even if the task is later assigned back to this agent.
  // UNION deduplicates rows so a malformed retry cycle terminates without a cap.
  const [issue] = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE current_task AS (
      SELECT i.id, i.conversation_agent_id, i.conversation_user_id, r.id AS run_id
      FROM heartbeat_runs r
      JOIN issues i ON i.id::text = coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')
        AND i.company_id = r.company_id AND i.assignee_agent_id = r.agent_id
      WHERE r.id = ${input.runId}::uuid AND r.company_id = ${input.companyId}::uuid
        AND r.agent_id = ${input.agentId}::uuid AND r.status = 'running'
    ), task_runs AS (
      SELECT r.id, r.retry_of_run_id
      FROM heartbeat_runs r JOIN current_task t ON t.run_id = r.id
      UNION
      SELECT parent.id, parent.retry_of_run_id
      FROM heartbeat_runs parent JOIN task_runs child ON parent.id = child.retry_of_run_id
      JOIN current_task t ON t.id::text = coalesce(parent.context_snapshot->>'issueId', parent.context_snapshot->>'taskId')
      WHERE parent.company_id = ${input.companyId}::uuid AND parent.agent_id = ${input.agentId}::uuid
        AND parent.status <> 'cancelled'
    )
    SELECT t.id FROM current_task t
    WHERE (t.conversation_agent_id = ${input.agentId}::uuid AND t.conversation_user_id IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM agent_wakeup_requests w JOIN task_runs r ON w.run_id = r.id
        WHERE w.company_id = ${input.companyId}::uuid AND w.agent_id = ${input.agentId}::uuid
          AND w.requested_by_actor_type = 'user' AND nullif(trim(w.requested_by_actor_id), '') IS NOT NULL
          AND w.status NOT IN ('skipped', 'cancelled')
          AND coalesce(w.payload->>'issueId', w.payload->>'taskId',
            w.payload->'_paperclipWakeContext'->>'issueId', w.payload->'_paperclipWakeContext'->>'taskId') = t.id::text
          -- Connector sender attribution can also use a user id. Its durable
          -- inbound receipts are not authenticated board instructions.
          AND (w.idempotency_key IS NULL OR w.idempotency_key NOT LIKE 'chat-inbound:%')
      )
  `);
  return issue ? { ...resolution, humanDirectedIssueId: issue.id } : resolution;
}
