import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  builtInManagedResources,
  companies,
  companyCreateIdempotencyKeys,
  companyMemberships,
  companySkills,
  companySkillVersions,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  principalPermissionGrants,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { findIdempotentCompanyId, recordCompanyCreateIdempotencyKey } from "../lib/create-idempotency.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company create idempotency route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("company create idempotency routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-create-idempotency-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(builtInManagedResources);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companyCreateIdempotencyKeys);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api/companies", companyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("replays the same company for a repeated Idempotency-Key", async () => {
    const app = createApp();

    const first = await request(app)
      .post("/api/companies")
      .set("Idempotency-Key", "provision-run-1")
      .send({ name: "Acme Robotics" })
      .expect(201);

    const replay = await request(app)
      .post("/api/companies")
      .set("Idempotency-Key", "provision-run-1")
      .send({ name: "A totally different name on retry" })
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.name).toBe("Acme Robotics");

    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(1);

    const keyRows = await db.select().from(companyCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]).toMatchObject({
      ownerPrincipalId: "local-board",
      idempotencyKey: "provision-run-1",
      companyId: first.body.id,
    });
  });

  it("reads the Idempotency-Key header case-insensitively", async () => {
    const app = createApp();

    const first = await request(app)
      .post("/api/companies")
      .set("idempotency-key", "case-insensitive-run")
      .send({ name: "Lower Case Co" })
      .expect(201);

    const replay = await request(app)
      .post("/api/companies")
      .set("IDEMPOTENCY-KEY", "case-insensitive-run")
      .send({ name: "Upper Case Retry" })
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(1);
  });

  it("creates a new company when the key differs", async () => {
    const app = createApp();

    const first = await request(app)
      .post("/api/companies")
      .set("Idempotency-Key", "run-a")
      .send({ name: "Company A" })
      .expect(201);

    const second = await request(app)
      .post("/api/companies")
      .set("Idempotency-Key", "run-b")
      .send({ name: "Company B" })
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(2);
    const keyRows = await db.select().from(companyCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(2);
  });

  it("creates a new company every time when no key is supplied", async () => {
    const app = createApp();

    const first = await request(app)
      .post("/api/companies")
      .send({ name: "No Key Co" })
      .expect(201);

    const second = await request(app)
      .post("/api/companies")
      .send({ name: "No Key Co" })
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(2);
    const keyRows = await db.select().from(companyCreateIdempotencyKeys);
    expect(keyRows).toHaveLength(0);
  });

  it("scopes idempotency keys per owner, not globally", async () => {
    const [ownerACompany] = await db
      .insert(companies)
      .values({ name: "Owner A Co", issuePrefix: "OWA" })
      .returning();
    const [ownerBCompany] = await db
      .insert(companies)
      .values({ name: "Owner B Co", issuePrefix: "OWB" })
      .returning();

    await recordCompanyCreateIdempotencyKey(db, "owner-a", "shared-literal-key", ownerACompany.id);
    await recordCompanyCreateIdempotencyKey(db, "owner-b", "shared-literal-key", ownerBCompany.id);

    await expect(findIdempotentCompanyId(db, "owner-a", "shared-literal-key")).resolves.toBe(ownerACompany.id);
    await expect(findIdempotentCompanyId(db, "owner-b", "shared-literal-key")).resolves.toBe(ownerBCompany.id);
    await expect(findIdempotentCompanyId(db, "owner-c", "shared-literal-key")).resolves.toBeNull();
  });
});
