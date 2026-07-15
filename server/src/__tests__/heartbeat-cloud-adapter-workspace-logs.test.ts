import { describe, expect, it } from "vitest";
import {
  adapterExecutesRemotely,
  buildSessionResetLogLine,
  deriveRemoteWorkspaceCwd,
  selectRuntimeWorkspaceLogWarnings,
} from "../services/heartbeat.ts";

// Remote-execution adapters (openclaw_gateway) never receive the locally
// resolved cwd — the agent executes in its own workspace on the user's
// container. Run logs must name that remote workspace instead of warning
// about a local fallback directory the run never uses, and must not claim a
// saved session was skipped when none existed.

const AGENT_ID = "ddd8bb72-2c43-442a-b582-a3e57a352465";

describe("adapterExecutesRemotely", () => {
  it("is true for openclaw_gateway", () => {
    expect(adapterExecutesRemotely("openclaw_gateway")).toBe(true);
  });

  it("is false for local process adapters and missing types", () => {
    for (const adapterType of ["claude_code", "codex", "", null, undefined]) {
      expect(adapterExecutesRemotely(adapterType)).toBe(false);
    }
  });
});

describe("deriveRemoteWorkspaceCwd", () => {
  it("returns null for non-remote adapters", () => {
    expect(
      deriveRemoteWorkspaceCwd({
        adapterType: "claude_code",
        agentId: AGENT_ID,
        adapterConfig: { claimedApiKeyPath: `~/.openclaw/workspaces/${AGENT_ID}/key.json` },
      }),
    ).toBeNull();
  });

  it("derives the workspace from claimedApiKeyPath and expands ~", () => {
    expect(
      deriveRemoteWorkspaceCwd({
        adapterType: "openclaw_gateway",
        agentId: AGENT_ID,
        adapterConfig: {
          claimedApiKeyPath: `~/.openclaw/workspaces/${AGENT_ID}/paperclip-claimed-api-key.json`,
        },
      }),
    ).toBe(`/home/node/.openclaw/workspaces/${AGENT_ID}`);
  });

  it("keeps absolute claimedApiKeyPath directories as-is", () => {
    expect(
      deriveRemoteWorkspaceCwd({
        adapterType: "openclaw_gateway",
        agentId: AGENT_ID,
        adapterConfig: {
          claimedApiKeyPath: `/home/node/.openclaw/workspaces/${AGENT_ID}/paperclip-claimed-api-key.json`,
        },
      }),
    ).toBe(`/home/node/.openclaw/workspaces/${AGENT_ID}`);
  });

  it("falls back to the agent-id convention when claimedApiKeyPath is absent", () => {
    for (const adapterConfig of [null, undefined, {}, { claimedApiKeyPath: "" }]) {
      expect(
        deriveRemoteWorkspaceCwd({
          adapterType: "openclaw_gateway",
          agentId: AGENT_ID,
          adapterConfig,
        }),
      ).toBe(`/home/node/.openclaw/workspaces/${AGENT_ID}`);
    }
  });

  it("falls back on malformed claimedApiKeyPath values", () => {
    for (const claimedApiKeyPath of ["key.json", "/key.json", 42, { nested: true }]) {
      expect(
        deriveRemoteWorkspaceCwd({
          adapterType: "openclaw_gateway",
          agentId: AGENT_ID,
          adapterConfig: { claimedApiKeyPath },
        }),
      ).toBe(`/home/node/.openclaw/workspaces/${AGENT_ID}`);
    }
  });
});

describe("selectRuntimeWorkspaceLogWarnings", () => {
  const localWarnings = [
    'No project or prior session workspace was available. Using fallback workspace "/paperclip/instances/default/workspaces/x" for this run.',
  ];

  it("replaces local warnings with one remote-workspace line for remote runs", () => {
    const lines = selectRuntimeWorkspaceLogWarnings({
      remoteWorkspaceCwd: `/home/node/.openclaw/workspaces/${AGENT_ID}`,
      localWarnings,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("executing in remote workspace");
    expect(lines[0]).toContain(`/home/node/.openclaw/workspaces/${AGENT_ID}`);
  });

  it("passes local warnings through unchanged for local runs", () => {
    expect(
      selectRuntimeWorkspaceLogWarnings({ remoteWorkspaceCwd: null, localWarnings }),
    ).toEqual(localWarnings);
  });
});

describe("buildSessionResetLogLine", () => {
  const base = {
    resetTaskSession: true,
    sessionResetReason: "wake reason is issue_assigned",
    taskKey: "54d0bbe8-92fc-41a5-9ed7-6da80000582c",
    hadSavedTaskSession: true,
  };

  it("logs the skip when a saved session actually existed", () => {
    expect(buildSessionResetLogLine(base)).toBe(
      'Skipping saved session resume for task "54d0bbe8-92fc-41a5-9ed7-6da80000582c" because wake reason is issue_assigned.',
    );
  });

  it("omits the task clause when there is no task key", () => {
    expect(buildSessionResetLogLine({ ...base, taskKey: null })).toBe(
      "Skipping saved session resume because wake reason is issue_assigned.",
    );
  });

  it("stays silent when no saved session existed", () => {
    expect(buildSessionResetLogLine({ ...base, hadSavedTaskSession: false })).toBeNull();
  });

  it("stays silent when the session is not being reset", () => {
    expect(buildSessionResetLogLine({ ...base, resetTaskSession: false })).toBeNull();
    expect(buildSessionResetLogLine({ ...base, sessionResetReason: null })).toBeNull();
  });
});
