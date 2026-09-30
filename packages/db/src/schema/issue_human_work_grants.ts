import { foreignKey, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

/** Server-owned receipt of a human directing the current assignee's work. */
export const issueHumanWorkGrants = pgTable("issue_human_work_grants", {
  issueId: uuid("issue_id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }).onDelete("cascade"),
  agentFk: foreignKey({ columns: [table.companyId, table.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
}));
