import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    delete process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION;
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });

  it("allows only pre-created pending agents through governed hire approvals", async () => {
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const input = {
      name: "Governed Hire",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "pending_approval" as const,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    };

    await expect(agentSvc.create(companyId, input)).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_agent_creation_required" },
    });

    const pending = await agentSvc.create(companyId, input, { governedCreationRequest: true });
    await expect(approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: { name: "Missing pre-created agent" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "governed_agent_creation_required" },
    });

    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: { name: pending.name, agentId: pending.id },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await approvalSvc.approve(approval.id, "board-user", "Approved");
    const replay = await approvalSvc.approve(approval.id, "board-user", "Approved again");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({ status: "idle" });
    expect(replay.applied).toBe(false);
  });

  it("keeps a legacy minting hire approval pending when governed creation is enabled", async () => {
    const companyId = await seedCompany();
    const [legacy] = await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: { name: "Legacy mint-on-approve" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    }).returning();
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";

    await expect(approvalService(db).approve(legacy!.id, "board-user", "Approved"))
      .rejects.toMatchObject({
        status: 422,
        details: { code: "governed_agent_creation_required" },
      });
    const [stored] = await db.select().from(approvals).where(eq(approvals.id, legacy!.id));
    expect(stored?.status).toBe("pending");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
  });

  it("rejects legacy hire resubmission before mutating the approval or minting an agent", async () => {
    const companyId = await seedCompany();
    const [legacy] = await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "revision_requested",
      payload: { name: "Legacy mint-on-resubmit" },
      decisionNote: "Needs a governed agent reference",
      decidedByUserId: "board-user",
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";

    await expect(approvalService(db).resubmit(legacy!.id, {
      name: "Still missing the pre-created agent",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "governed_agent_creation_required" },
    });
    const [stored] = await db.select().from(approvals).where(eq(approvals.id, legacy!.id));
    expect(stored?.status).toBe("revision_requested");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
  });

  it("rejects and replays a governed pre-created hire without reapplying termination", async () => {
    process.env.PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION = "true";
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Rejected Governed Hire",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "pending_approval",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }, { governedCreationRequest: true });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: { name: pending.name, agentId: pending.id },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    const first = await approvalSvc.reject(approval.id, "board-user", "Rejected");
    const replay = await approvalSvc.reject(approval.id, "board-user", "Rejected again");

    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({ status: "terminated" });
  });
});
