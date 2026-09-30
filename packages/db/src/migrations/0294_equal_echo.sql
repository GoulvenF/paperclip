CREATE TABLE IF NOT EXISTS "issue_human_work_grants" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "issue_human_work_grants" ADD CONSTRAINT "issue_human_work_grants_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "issue_human_work_grants" ADD CONSTRAINT "issue_human_work_grants_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION revoke_issue_human_work_grant() RETURNS trigger AS $$
BEGIN
  DELETE FROM issue_human_work_grants WHERE issue_id = OLD.id AND company_id = OLD.company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint
DROP TRIGGER IF EXISTS issue_human_work_grant_reassignment ON issues;

--> statement-breakpoint
CREATE TRIGGER issue_human_work_grant_reassignment
AFTER UPDATE OF assignee_agent_id, assignee_user_id ON issues
FOR EACH ROW WHEN (OLD.assignee_agent_id IS DISTINCT FROM NEW.assignee_agent_id
  OR OLD.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id)
EXECUTE FUNCTION revoke_issue_human_work_grant();
