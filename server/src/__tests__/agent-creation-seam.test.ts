import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { agentService } from "../services/agents.js";
import { runAsCreationPrincipal } from "../services/agent-creation-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The fence lives at agentService.create — the single seam every agent
 * creation crosses — rather than at the routes, because the routes kept
 * hiding one: `POST /companies/:id/imports/apply` admits `role === "ceo"`
 * agents and never consults `agents:create`.
 *
 * These tests stand up the same middleware order as app.ts (actor, then the
 * AsyncLocalStorage entry) in front of a route that creates an agent, so they
 * cover both the seam check and the context propagation through express —
 * which is the part that silently does nothing if the middleware is dropped.
 */
describeEmbeddedPostgres("governed agent creation seam", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-creation-seam-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    delete process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION;
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Seam ${randomUUID()}`,
        issuePrefix: `SM${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    return company!.id;
  }

  // Stands in for every route that reaches agentService.create — including
  // the import path, which is why the fence is not on any single route.
  function createApp(actor: Record<string, unknown>, companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use((req, _res, next) => {
      runAsCreationPrincipal((req as any).actor?.type === "agent", next);
    });
    app.post("/create", async (_req, res, next) => {
      try {
        const agent = await agentService(db).create(companyId, {
          name: "Imported",
          role: "general",
          adapterType: "process",
          adapterConfig: {},
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        });
        res.status(201).json(agent);
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);
    return app;
  }

  const agentActor = { type: "agent", agentId: randomUUID(), companyId: "x", source: "agent_key" };
  const boardActor = { type: "board", userId: "board-user", source: "session" };

  it("blocks an agent principal at the seam, whatever route it came through", async () => {
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";
    const companyId = await seedCompany();

    const res = await request(createApp({ ...agentActor, companyId }, companyId)).post("/create");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe("governed_agent_creation_required");
    expect(await db.select().from(agents)).toHaveLength(0);
  });

  it("lets board principals through", async () => {
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";
    const companyId = await seedCompany();

    const res = await request(createApp(boardActor, companyId)).post("/create");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await db.select().from(agents)).toHaveLength(1);
  });

  it("lets agent principals through when the deployment has not opted in", async () => {
    const companyId = await seedCompany();

    const res = await request(createApp({ ...agentActor, companyId }, companyId)).post("/create");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await db.select().from(agents)).toHaveLength(1);
  });

  it("allows creation with no request context at all (workers, cron, startup reconcile)", async () => {
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";
    const companyId = await seedCompany();

    await expect(agentService(db).create(companyId, {
      name: "Background",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    })).resolves.toMatchObject({ name: "Background" });
  });

  it("fails OPEN on an unset, empty, or malformed flag value", async () => {
    // Deliberate: a typo must not brick agent creation for deployments that
    // never opted in. Documented in agent-creation-policy.ts.
    const companyId = await seedCompany();
    for (const value of ["", "   ", "flase", "0", "off", "no"]) {
      process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = value;
      const res = await request(createApp({ ...agentActor, companyId }, companyId)).post("/create");
      expect(res.status, `value=${JSON.stringify(value)} body=${JSON.stringify(res.body)}`).toBe(201);
      await db.delete(agents);
    }
  });

  it("arms on every documented truthy spelling", async () => {
    const companyId = await seedCompany();
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = value;
      const res = await request(createApp({ ...agentActor, companyId }, companyId)).post("/create");
      expect(res.status, `value=${JSON.stringify(value)}`).toBe(403);
    }
    expect(await db.select().from(agents)).toHaveLength(0);
  });
});
