import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine circuit-breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine circuit breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof routineService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-circuit-breaker-");
    db = createDb(tempDb.connectionString);
    svc = routineService(db, { heartbeat: { wakeup: vi.fn(async () => ({ id: randomUUID() })) } });
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRoutine(opts: {
    consecutiveFailureCount?: number;
    autoPauseThreshold?: number | null;
    autoPauseEnabled?: boolean | null;
    status?: "active" | "paused";
    autoPausedAt?: Date | null;
  } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: issuePrefix(companyId) });
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Friday",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [routine] = await db.insert(routines).values({
      companyId,
      title: "Market Intelligence Sweep -> Email",
      assigneeAgentId: agent.id,
      status: opts.status ?? "active",
      consecutiveFailureCount: opts.consecutiveFailureCount ?? 0,
      autoPauseThreshold: opts.autoPauseThreshold ?? 3,
      autoPauseEnabled: opts.autoPauseEnabled ?? null,
      autoPausedAt: opts.autoPausedAt ?? null,
      autoPauseReason: opts.autoPausedAt ? "consecutive_failures" : null,
    }).returning();
    return { companyId, routine };
  }

  // Seed a routine run + its execution issue, then move the issue to a terminal
  // status so syncRunStatusForIssue produces the success/failure verdict.
  async function resolveRunVia(companyId: string, routineId: string, issueStatus: "done" | "blocked" | "cancelled") {
    const runId = randomUUID();
    await db.insert(routineRuns).values({
      id: runId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
    });
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "sweep run",
      status: issueStatus,
      originKind: "routine_execution",
      originRunId: runId,
    }).returning();
    return svc.syncRunStatusForIssue(issue.id);
  }

  async function getRoutine(id: string) {
    const [r] = await db.select().from(routines).where(eq(routines.id, id));
    return r;
  }

  it("resets consecutiveFailureCount to 0 on a completed (done) run", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2 });
    await resolveRunVia(companyId, routine.id, "done");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(0);
    expect(r.status).toBe("active");
  });

  it("increments on a failed (blocked) run but does not pause below threshold", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 1, autoPauseThreshold: 3 });
    await resolveRunVia(companyId, routine.id, "blocked");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(2);
    expect(r.status).toBe("active");
  });

  it("pauses the routine when the failure count reaches the threshold", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: 3 });
    await resolveRunVia(companyId, routine.id, "blocked");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(3);
    expect(r.status).toBe("paused");
    expect(r.autoPauseReason).toBe("consecutive_failures");
    expect(r.autoPausedAt).not.toBeNull();
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, routine.id));
    expect(events.some((e) => e.action === "routine.auto_paused")).toBe(true);
  });

  it("treats a cancelled run as a failure for the breaker", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: 3 });
    await resolveRunVia(companyId, routine.id, "cancelled");
    const r = await getRoutine(routine.id);
    expect(r.status).toBe("paused");
  });

  it("honors a per-routine autoPauseEnabled=false override (never pauses)", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: 3, autoPauseEnabled: false });
    await resolveRunVia(companyId, routine.id, "blocked");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(3);
    expect(r.status).toBe("active");
  });

  it("uses the instance-settings default threshold (3) when the routine has no override", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: null });
    await resolveRunVia(companyId, routine.id, "blocked");
    const r = await getRoutine(routine.id);
    expect(r.status).toBe("paused");
  });

  it("resets failure state when a paused routine is re-enabled", async () => {
    const { routine } = await seedRoutine({ status: "paused", consecutiveFailureCount: 3, autoPausedAt: new Date() });
    await svc.update(routine.id, { status: "active" }, { userId: "u_test" });
    const r = await getRoutine(routine.id);
    expect(r.status).toBe("active");
    expect(r.consecutiveFailureCount).toBe(0);
    expect(r.autoPausedAt).toBeNull();
    expect(r.autoPauseReason).toBeNull();
  });

  it("does not fire a paused routine from tickScheduledTriggers", async () => {
    const { companyId, routine } = await seedRoutine({ status: "paused", consecutiveFailureCount: 3, autoPausedAt: new Date() });
    await db.insert(routineTriggers).values({
      companyId,
      routineId: routine.id,
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    const { triggered } = await svc.tickScheduledTriggers(new Date());
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(triggered).toBe(0);
    expect(runs.length).toBe(0);
  });
});
