import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCreateIdempotencyKeys, companyCreateIdempotencyKeys } from "@paperclipai/db";
import type { Request } from "express";

// How long a replayed `Idempotency-Key` stays honored. Mirrors
// ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS in services/issues.ts -- after
// this window a repeat of the same key is treated as a brand new create
// rather than a replay of the original response.
export const CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS = 7;
const CREATE_IDEMPOTENCY_KEY_RETENTION_MS = CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Reads the client-supplied `Idempotency-Key` header. Express's
 * `Request#header()` already matches header names case-insensitively (per
 * the HTTP spec), so only the header VALUE needs trimming/normalizing here.
 * A request without the header (or with a blank one) returns null, which
 * callers treat as "no idempotency requested" -- today's create-every-time
 * behavior.
 */
export function readIdempotencyKeyHeader(req: Pick<Request, "header">): string | null {
  const raw = req.header("Idempotency-Key");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Looks up a prior company created under the same (owner, idempotency key)
 * pair. Scoped by owner principal rather than company id, since the company
 * being created does not exist yet. Expired mappings (older than
 * CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS) are pruned for that owner first so
 * an old key can legitimately be reused later.
 */
export async function findIdempotentCompanyId(
  db: Db,
  ownerPrincipalId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - CREATE_IDEMPOTENCY_KEY_RETENTION_MS);
  await db
    .delete(companyCreateIdempotencyKeys)
    .where(and(
      eq(companyCreateIdempotencyKeys.ownerPrincipalId, ownerPrincipalId),
      lt(companyCreateIdempotencyKeys.createdAt, cutoff),
    ));

  const row = await db
    .select({ companyId: companyCreateIdempotencyKeys.companyId })
    .from(companyCreateIdempotencyKeys)
    .where(and(
      eq(companyCreateIdempotencyKeys.ownerPrincipalId, ownerPrincipalId),
      eq(companyCreateIdempotencyKeys.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.companyId ?? null;
}

/**
 * Records that (owner, idempotency key) produced `companyId`, so a retry
 * with the same key can replay it. `onConflictDoNothing` makes this safe
 * against a concurrent duplicate insert for the same key racing this one --
 * whichever wins the unique constraint stays authoritative; this call never
 * throws over that race.
 */
export async function recordCompanyCreateIdempotencyKey(
  db: Db,
  ownerPrincipalId: string,
  idempotencyKey: string,
  companyId: string,
): Promise<void> {
  await db
    .insert(companyCreateIdempotencyKeys)
    .values({ ownerPrincipalId, idempotencyKey, companyId })
    .onConflictDoNothing();
}

/**
 * Looks up a prior agent created under the same (company, idempotency key)
 * pair. Expired mappings are pruned for that company first, same as
 * findIdempotentCompanyId above.
 */
export async function findIdempotentAgentId(
  db: Db,
  companyId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - CREATE_IDEMPOTENCY_KEY_RETENTION_MS);
  await db
    .delete(agentCreateIdempotencyKeys)
    .where(and(
      eq(agentCreateIdempotencyKeys.companyId, companyId),
      lt(agentCreateIdempotencyKeys.createdAt, cutoff),
    ));

  const row = await db
    .select({ agentId: agentCreateIdempotencyKeys.agentId })
    .from(agentCreateIdempotencyKeys)
    .where(and(
      eq(agentCreateIdempotencyKeys.companyId, companyId),
      eq(agentCreateIdempotencyKeys.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.agentId ?? null;
}

/**
 * Records that (company, idempotency key) produced `agentId`. See
 * recordCompanyCreateIdempotencyKey for the onConflictDoNothing rationale.
 */
export async function recordAgentCreateIdempotencyKey(
  db: Db,
  companyId: string,
  idempotencyKey: string,
  agentId: string,
): Promise<void> {
  await db
    .insert(agentCreateIdempotencyKeys)
    .values({ companyId, idempotencyKey, agentId })
    .onConflictDoNothing();
}
