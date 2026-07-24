import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping user hard-delete cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

process.env.BETTER_AUTH_SECRET ??= "paperclip-user-delete-test-secret";

function testAuthConfig(): Config {
  return {
    deploymentMode: "authenticated",
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    allowedHostnames: ["localhost"],
    port: 3100,
  } as Config;
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

function adminActor(userId: string): Express.Request["actor"] {
  // isInstanceAdmin: false is deliberate -- the route re-checks the DB
  // (instanceUserRoles), it must not rely on this stale claim.
  return {
    type: "board",
    userId,
    source: "session",
    companyIds: [],
    memberships: [],
    isInstanceAdmin: false,
  };
}

describeEmbeddedPostgres("admin user hard-delete (embedded postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-delete-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes the user plus its company membership, permission grants, and instance-admin role", async () => {
    const adminId = `admin-${randomUUID()}`;
    await db.insert(instanceUserRoles).values({ userId: adminId, role: "instance_admin" });

    const targetId = randomUUID();
    await db.insert(authUsers).values({
      id: targetId,
      name: "Target User",
      email: `target-${randomUUID()}@example.test`,
    });

    const company = await db
      .insert(companies)
      .values({
        name: `Delete Co ${randomUUID()}`,
        issuePrefix: `DC${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: targetId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: targetId,
      permissionKey: "tasks:assign",
    });
    await db.insert(instanceUserRoles).values({ userId: targetId, role: "instance_admin" });

    const app = await createApp(db, adminActor(adminId));
    const res = await request(app).delete(`/api/admin/users/${targetId}`);

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: targetId });

    const remainingUser = await db.select().from(authUsers).where(eq(authUsers.id, targetId));
    expect(remainingUser).toHaveLength(0);

    const remainingMemberships = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.principalId, targetId));
    expect(remainingMemberships, "company_memberships must not dangle after delete").toHaveLength(0);

    const remainingGrants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, targetId));
    expect(remainingGrants, "principal_permission_grants must not dangle after delete").toHaveLength(0);

    const remainingRole = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.userId, targetId));
    expect(remainingRole, "instance_user_roles must not dangle after delete").toHaveLength(0);

    // The admin who performed the delete is untouched.
    const adminRoleStillThere = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.userId, adminId));
    expect(adminRoleStillThere).toHaveLength(1);
  });

  it("404s for a user id that does not exist and leaves nothing behind", async () => {
    const adminId = `admin-${randomUUID()}`;
    await db.insert(instanceUserRoles).values({ userId: adminId, role: "instance_admin" });

    const app = await createApp(db, adminActor(adminId));
    const res = await request(app).delete(`/api/admin/users/${randomUUID()}`);

    expect(res.status).toBe(404);
  });

  it("rejects a caller who is not an instance admin, even with a real DB behind it", async () => {
    const callerId = `not-admin-${randomUUID()}`;
    const targetId = randomUUID();
    await db.insert(authUsers).values({
      id: targetId,
      name: "Target User",
      email: `target-${randomUUID()}@example.test`,
    });

    const app = await createApp(db, adminActor(callerId));
    const res = await request(app).delete(`/api/admin/users/${targetId}`);

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(403);

    const stillThere = await db.select().from(authUsers).where(eq(authUsers.id, targetId));
    expect(stillThere).toHaveLength(1);
  });

  it("allows a wiped email to sign up again through Better Auth after the hard delete", async () => {
    const adminId = `admin-${randomUUID()}`;
    await db.insert(instanceUserRoles).values({ userId: adminId, role: "instance_admin" });

    const auth = createBetterAuthInstance(db, testAuthConfig(), ["http://localhost:3100"]);
    const email = `reclaim-${randomUUID()}@example.test`;

    const firstSignUp = await auth.api.signUpEmail({
      body: { email, password: "correct horse battery staple", name: "First Owner" },
    });
    expect(firstSignUp?.user?.email).toBe(email);
    const firstUserId = firstSignUp!.user!.id as string;

    // Today's dead end: signing up again with the same email is rejected --
    // Better Auth has no way to tell this is meant to replace the old user.
    await expect(
      auth.api.signUpEmail({
        body: { email, password: "another-password-entirely", name: "Duplicate Attempt" },
      }),
    ).rejects.toThrow();

    const app = await createApp(db, adminActor(adminId));
    const deleteRes = await request(app).delete(`/api/admin/users/${firstUserId}`);
    expect(deleteRes.status, deleteRes.text || JSON.stringify(deleteRes.body)).toBe(200);

    // The same email can now be reclaimed.
    const secondSignUp = await auth.api.signUpEmail({
      body: { email, password: "correct horse battery staple 2", name: "Second Owner" },
    });
    expect(secondSignUp?.user?.email).toBe(email);
    expect(secondSignUp!.user!.id).not.toBe(firstUserId);

    const rows = await db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(secondSignUp!.user!.id);
  });
});
