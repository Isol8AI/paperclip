import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentCreateIdempotencyKeys,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { findIdempotentAgentId } from "../lib/create-idempotency.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent create idempotency route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("agent create idempotency routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-create-idempotency-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentCreateIdempotencyKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(overrides: Partial<typeof companies.$inferInsert> = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
      ...overrides,
    });
    return companyId;
  }

  function agentPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: "Build Bot",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      ...overrides,
    };
  }

  it("replays the same agent for a repeated Idempotency-Key", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("Idempotency-Key", "hire-run-1")
      .send(agentPayload({ name: "Build Bot" }))
      .expect(201);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("Idempotency-Key", "hire-run-1")
      .send(agentPayload({ name: "A different name on retry" }))
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.name).toBe("Build Bot");

    const allAgents = await db.select().from(agents);
    expect(allAgents.filter((row) => row.companyId === companyId)).toHaveLength(1);

    const keyRows = await db.select().from(agentCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]).toMatchObject({
      companyId,
      idempotencyKey: "hire-run-1",
      agentId: first.body.id,
    });
  });

  it("reads the Idempotency-Key header case-insensitively", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("idempotency-key", "case-insensitive-run")
      .send(agentPayload({ name: "Lower Case Bot" }))
      .expect(201);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("IDEMPOTENCY-KEY", "case-insensitive-run")
      .send(agentPayload({ name: "Upper Case Retry" }))
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    const allAgents = await db.select().from(agents);
    expect(allAgents.filter((row) => row.companyId === companyId)).toHaveLength(1);
  });

  it("creates a new agent when the key differs", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("Idempotency-Key", "run-a")
      .send(agentPayload({ name: "Agent A" }))
      .expect(201);

    const second = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("Idempotency-Key", "run-b")
      .send(agentPayload({ name: "Agent B" }))
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    const allAgents = await db.select().from(agents);
    expect(allAgents.filter((row) => row.companyId === companyId)).toHaveLength(2);
    const keyRows = await db.select().from(agentCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(2);
  });

  it("creates a new agent every time when no key is supplied", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send(agentPayload({ name: "No Key Bot" }))
      .expect(201);

    const second = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send(agentPayload({ name: "No Key Bot" }))
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    const allAgents = await db.select().from(agents);
    expect(allAgents.filter((row) => row.companyId === companyId)).toHaveLength(2);
    const keyRows = await db.select().from(agentCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(0);
  });

  it("scopes idempotency keys per company, not globally", async () => {
    const companyAId = await seedCompany();
    const companyBId = await seedCompany();
    const app = createApp();

    const inCompanyA = await request(app)
      .post(`/api/companies/${companyAId}/agents`)
      .set("Idempotency-Key", "shared-literal-key")
      .send(agentPayload({ name: "Company A Bot" }))
      .expect(201);

    const inCompanyB = await request(app)
      .post(`/api/companies/${companyBId}/agents`)
      .set("Idempotency-Key", "shared-literal-key")
      .send(agentPayload({ name: "Company B Bot" }))
      .expect(201);

    expect(inCompanyB.body.id).not.toBe(inCompanyA.body.id);
    expect(inCompanyB.body.name).toBe("Company B Bot");

    await expect(findIdempotentAgentId(db, companyAId, "shared-literal-key")).resolves.toBe(inCompanyA.body.id);
    await expect(findIdempotentAgentId(db, companyBId, "shared-literal-key")).resolves.toBe(inCompanyB.body.id);
  });

  it("expires old idempotency keys and creates fresh on replay", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const original = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send(agentPayload({ name: "Original Bot" }))
      .expect(201);

    const idempotencyKey = "expired-retry";
    const expiredCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.insert(agentCreateIdempotencyKeys).values({
      companyId,
      idempotencyKey,
      agentId: original.body.id,
      createdAt: expiredCreatedAt,
    });

    const recreated = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .set("Idempotency-Key", idempotencyKey)
      .send(agentPayload({ name: "Fresh Bot After Expiry" }))
      .expect(201);

    expect(recreated.body.id).not.toBe(original.body.id);
    expect(recreated.body.name).toBe("Fresh Bot After Expiry");

    const keyRows = await db.select().from(agentCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]).toMatchObject({
      companyId,
      idempotencyKey,
      agentId: recreated.body.id,
    });
  });
});
