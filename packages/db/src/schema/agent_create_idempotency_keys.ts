import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentCreateIdempotencyKeys = pgTable(
  "agent_create_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    completionPayload: jsonb("completion_payload").$type<Record<string, unknown>>().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("agent_create_idempotency_keys_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    agentIdx: index("agent_create_idempotency_keys_agent_idx").on(table.agentId),
  }),
);
