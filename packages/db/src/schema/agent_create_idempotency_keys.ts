import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// Maps a client-supplied `Idempotency-Key` header, scoped to the company the
// agent is being created in, to the agent it produced, so a retried
// `POST /companies/:companyId/agents` with the same key replays the original
// agent instead of minting a duplicate.
export const agentCreateIdempotencyKeys = pgTable(
  "agent_create_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("agent_create_idempotency_keys_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    agentIdx: index("agent_create_idempotency_keys_agent_idx").on(table.agentId),
    companyCreatedAtIdx: index("agent_create_idempotency_keys_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
