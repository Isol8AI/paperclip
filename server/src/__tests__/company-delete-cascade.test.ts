import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  companySkills,
  companySkillTestRuns,
  companySkillVersions,
  costEvents,
  createDb,
  feedbackExports,
  feedbackVotes,
  financeEvents,
  goals,
  heartbeatRuns,
  heartbeatRunWatchdogDecisions,
  inboxDismissals,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  projects,
  routines,
  secretAccessEvents,
  toolMcpGateways,
  toolProfiles,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company delete cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company delete cascade", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes a company whose object graph populates every FK path", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const approvalId = randomUUID();
    const budgetPolicyId = randomUUID();
    const costEventId = randomUUID();
    const skillId = randomUUID();
    const skillVersionId = randomUUID();
    const toolProfileId = randomUUID();
    const feedbackVoteId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Doomed Corp",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Atlas",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // goals <- projects.goal_id (no ON DELETE): deleting goals before projects
    // is the historical 500 on companies with goal-linked projects.
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Q3 revenue",
      ownerAgentId: agentId,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Rocket",
      goalId,
      leadAgentId: agentId,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId,
      title: "Ship it",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    // cost/finance events pinned to the run: the old order deleted
    // heartbeat_runs before cost_events/finance_events and cost_events before
    // finance_events, violating both run FKs and finance_events.cost_event_id.
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId,
      goalId,
      projectId,
      heartbeatRunId: runId,
      provider: "bedrock",
      model: "sonnet",
      costCents: 42,
      occurredAt: new Date(),
    });

    await db.insert(financeEvents).values({
      id: randomUUID(),
      companyId,
      eventKind: "cost",
      biller: "bedrock",
      amountCents: 42,
      occurredAt: new Date(),
      costEventId,
      heartbeatRunId: runId,
      goalId,
      projectId,
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(heartbeatRunWatchdogDecisions).values({
      id: randomUUID(),
      companyId,
      runId,
      decision: "continue",
    });

    // issue_thread_interactions.issue_id has no ON DELETE: this is the exact
    // constraint the production DELETE /api/companies/:id 500 pointed at.
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "question",
      payload: {},
      createdByAgentId: agentId,
      resolvedByAgentId: agentId,
    });

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Blocking comment",
    });

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(issueInboxArchives).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(feedbackVotes).values({
      id: feedbackVoteId,
      companyId,
      issueId,
      targetType: "comment",
      targetId: randomUUID(),
      authorUserId: "user-1",
      vote: "up",
    });

    await db.insert(feedbackExports).values({
      id: randomUUID(),
      companyId,
      feedbackVoteId,
      issueId,
      authorUserId: "user-1",
      targetType: "comment",
      targetId: randomUUID(),
      vote: "up",
      targetSummary: {},
    });

    await db.insert(issueWatchdogs).values({
      id: randomUUID(),
      companyId,
      issueId,
      watchdogAgentId: agentId,
    });

    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget_exception",
      payload: {},
      requestedByAgentId: agentId,
    });

    await db.insert(budgetPolicies).values({
      id: budgetPolicyId,
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "daily",
    });

    await db.insert(budgetIncidents).values({
      id: randomUUID(),
      companyId,
      policyId: budgetPolicyId,
      approvalId,
      scopeType: "company",
      scopeId: companyId,
      metric: "cost_cents",
      windowKind: "daily",
      windowStart: new Date(),
      windowEnd: new Date(),
      thresholdType: "hard",
      amountLimit: 100,
      amountObserved: 250,
    });

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "paperclipai/paperclip/deleter",
      slug: "deleter",
      name: "Deleter",
      markdown: "# Deleter",
    });

    await db.insert(companySkillVersions).values({
      id: skillVersionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 1,
    });

    await db.insert(companySkillTestRuns).values({
      id: randomUUID(),
      companyId,
      skillId,
      inputSnapshot: "input",
      skillVersionId,
      agentId,
      issueId,
    });

    await db.insert(toolProfiles).values({
      id: toolProfileId,
      companyId,
      profileKey: "default",
      name: "Default",
    });

    await db.insert(toolMcpGateways).values({
      id: randomUUID(),
      companyId,
      name: "Gateway",
      slug: "gateway",
      profileId: toolProfileId,
      agentId,
      issueId,
      projectId,
    });

    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId,
      scopeType: "issue",
      serviceName: "dev-server",
      status: "running",
      lifecycle: "active",
      provider: "process",
      projectId,
      issueId,
      ownerAgentId: agentId,
      startedByRunId: runId,
    });

    await db.insert(secretAccessEvents).values({
      id: randomUUID(),
      companyId,
      secretId: null,
      provider: "env",
      actorType: "agent",
      consumerType: "agent",
      consumerId: agentId,
      outcome: "granted",
    });

    await db.insert(inboxDismissals).values({
      id: randomUUID(),
      companyId,
      userId: "user-1",
      itemKey: "welcome-card",
    });

    await db.insert(agentConfigRevisions).values({
      id: randomUUID(),
      companyId,
      agentId,
      beforeConfig: {},
      afterConfig: {},
    });

    await db.insert(routines).values({
      id: randomUUID(),
      companyId,
      title: "Weekly report",
      assigneeAgentId: agentId,
      projectId,
      goalId,
    });

    // Control rows in a second company must survive the scoped delete.
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Survivor Inc",
      issuePrefix: `S${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Keeper",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "Keep me",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-2",
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      issueId: otherIssueId,
      kind: "question",
      payload: {},
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(goals).where(eq(goals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(projects).where(eq(projects.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(financeEvents).where(eq(financeEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(heartbeatRunWatchdogDecisions).where(eq(heartbeatRunWatchdogDecisions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(feedbackExports).where(eq(feedbackExports.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueWatchdogs).where(eq(issueWatchdogs.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(approvals).where(eq(approvals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(companySkillVersions).where(eq(companySkillVersions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(companySkillTestRuns).where(eq(companySkillTestRuns.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(routines).where(eq(routines.companyId, companyId))).resolves.toHaveLength(0);

    // The unrelated company's rows are untouched.
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
    await expect(db.select().from(agents).where(eq(agents.companyId, otherCompanyId))).resolves.toHaveLength(1);
    await expect(db.select().from(issues).where(eq(issues.companyId, otherCompanyId))).resolves.toHaveLength(1);
    await expect(
      db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, otherCompanyId)),
    ).resolves.toHaveLength(1);
  }, 30_000);
});
