import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Maps a client-supplied `Idempotency-Key` header (scoped to the actor that
// requested the create, since a company does not exist yet to scope by) to
// the company it produced, so a retried `POST /companies` with the same key
// replays the original company instead of minting a duplicate.
export const companyCreateIdempotencyKeys = pgTable(
  "company_create_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerKeyIdx: uniqueIndex("company_create_idempotency_keys_owner_key_uq").on(
      table.ownerPrincipalId,
      table.idempotencyKey,
    ),
    companyIdx: index("company_create_idempotency_keys_company_idx").on(table.companyId),
    ownerCreatedAtIdx: index("company_create_idempotency_keys_owner_created_at_idx").on(
      table.ownerPrincipalId,
      table.createdAt,
    ),
  }),
);
