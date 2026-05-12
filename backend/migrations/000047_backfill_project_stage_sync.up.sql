-- Backfill — project status mirrors its source opportunity's stage.
--
-- Bug: until this point the project's status was only stamped at creation
-- (always 'planning') and on Pipeline closure. Every other stage transition
-- left the project frozen at 'planning' regardless of what the engagement
-- was actually doing. The Projects list, dashboards and the closed-task
-- guard all rely on this field, so the entire delivery roster looked stuck
-- in planning.
--
-- This migration is idempotent and only touches rows that are demonstrably
-- out of sync: project is still 'planning' but the opportunity has advanced
-- past it. We restrict to the post-planning, project-relevant stages — the
-- same allow-list the new handler in opportunities.Transition syncs.
UPDATE projects p
   SET status = o.stage,
       updated_at = now()
  FROM opportunities o
 WHERE p.opportunity_id = o.id
   AND p.tenant_id      = o.tenant_id
   AND p.deleted_at IS NULL
   AND p.status = 'planning'
   AND o.stage IN ('in_progress', 'qa_review', 'client_acceptance', 'invoiced', 'paid', 'closed');
