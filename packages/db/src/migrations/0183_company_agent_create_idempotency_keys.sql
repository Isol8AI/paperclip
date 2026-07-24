CREATE TABLE IF NOT EXISTS "company_create_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_principal_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_create_idempotency_keys_owner_key_uq"
  ON "company_create_idempotency_keys" USING btree ("owner_principal_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_create_idempotency_keys_company_idx"
  ON "company_create_idempotency_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_create_idempotency_keys_owner_created_at_idx"
  ON "company_create_idempotency_keys" USING btree ("owner_principal_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_create_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_create_idempotency_keys_company_key_uq"
  ON "agent_create_idempotency_keys" USING btree ("company_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_create_idempotency_keys_agent_idx"
  ON "agent_create_idempotency_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_create_idempotency_keys_company_created_at_idx"
  ON "agent_create_idempotency_keys" USING btree ("company_id", "created_at");
