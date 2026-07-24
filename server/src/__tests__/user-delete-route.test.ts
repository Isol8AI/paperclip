import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  deleteUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
  listBoardApiKeys: vi.fn(),
  createNamedBoardApiKey: vi.fn(),
  getBoardApiKeyForUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

let appImportCounter = 0;

async function createApp(actor: any, db: any = {} as any) {
  appImportCounter += 1;
  const routeModulePath = `../routes/access.js?user-delete-route-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?user-delete-route-${appImportCounter}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { ...actor };
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

describe.sequential("DELETE /api/admin/users/:userId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it.sequential("rejects a caller who is not an instance admin", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "regular-user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).delete("/api/admin/users/target-user-1");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(403);
    expect(mockAccessService.deleteUser).not.toHaveBeenCalled();
  }, 20_000);

  it.sequential("rejects an unauthenticated (non-board) caller", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);

    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).delete("/api/admin/users/target-user-1");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(401);
    expect(mockAccessService.deleteUser).not.toHaveBeenCalled();
  }, 20_000);

  it.sequential("does not trust a stale isInstanceAdmin claim on the actor -- it re-checks the database", async () => {
    // The actor carries isInstanceAdmin: true, but the (mocked) database says
    // otherwise. The route must ask access.isInstanceAdmin() rather than
    // trusting req.actor.isInstanceAdmin, so this must still be rejected.
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "regular-user-1",
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app).delete("/api/admin/users/target-user-1");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(403);
    expect(mockAccessService.deleteUser).not.toHaveBeenCalled();
  }, 20_000);

  it.sequential("allows an instance admin to delete a user", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.deleteUser.mockResolvedValue({
      id: "target-user-1",
      email: "wiped@example.test",
    });

    const app = await createApp({
      type: "board",
      userId: "admin-user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).delete("/api/admin/users/target-user-1");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, id: "target-user-1", email: "wiped@example.test" });
    expect(mockAccessService.deleteUser).toHaveBeenCalledWith("target-user-1", {
      actorUserId: "admin-user-1",
    });
  }, 20_000);

  it.sequential("404s when the target user does not exist", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.deleteUser.mockResolvedValue(null);

    const app = await createApp({
      type: "board",
      userId: "admin-user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).delete("/api/admin/users/does-not-exist");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(404);
  }, 20_000);

  it.sequential("local_implicit board sessions (single-user local mode) may delete without a DB admin-role lookup", async () => {
    mockAccessService.deleteUser.mockResolvedValue({ id: "target-user-1", email: "x@example.test" });

    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).delete("/api/admin/users/target-user-1");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.isInstanceAdmin).not.toHaveBeenCalled();
  }, 20_000);
});
