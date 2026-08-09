ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "resolved_by_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL;
