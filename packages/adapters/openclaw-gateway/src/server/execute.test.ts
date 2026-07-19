import { describe, expect, it } from "vitest";
import {
  awaitRunResilient,
  buildAgentParams,
  isWaitPending,
  pickAssistantChunk,
  resolveSessionKey,
} from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});

describe("pickAssistantChunk (whitespace preservation)", () => {
  // Mirrors the adapter's assistant accumulator: push each streamed chunk,
  // then join and trim once. Regression guard for #1275 (agent-posted
  // Paperclip comments stored with all whitespace stripped).
  const summarize = (deltas: string[]): string =>
    deltas
      .map((delta) => pickAssistantChunk({ delta }))
      .filter((chunk): chunk is string => chunk !== null)
      .join("")
      .trim();

  it("keeps the leading space each LLM token carries (no per-chunk trim)", () => {
    expect(pickAssistantChunk({ delta: " work" })).toBe(" work");
    expect(pickAssistantChunk({ delta: "Planning" })).toBe("Planning");
  });

  it("preserves every inter-word space across a token-by-token stream", () => {
    // Fine-grained tokenization: every inter-word space rides as a LEADING
    // char on the next token — exactly the cadence that produced the
    // all-whitespace-stripped prod row.
    const tokens = [
      "Planning",
      "-",
      "only",
      " work",
      " completed",
      " locally",
      ".",
      " -",
      " Created",
      " plan",
      " artifact",
      ":",
      " plan",
      ".",
      "md",
    ];
    const intended = "Planning-only work completed locally. - Created plan artifact: plan.md";
    expect(tokens.join("")).toBe(intended);
    // Fixed behavior: spaces survive. (Old code trimmed each token then
    // join("")'d, storing "Planning-onlyworkcompletedlocally.-Createdplanartifact:plan.md".)
    expect(summarize(tokens)).toBe(intended);
    expect(/\s/.test(summarize(tokens))).toBe(true);
  });

  it("preserves spaces regardless of chunk cadence and bullets/newlines", () => {
    expect(summarize(["hello", " world", " foo", " bar"])).toBe("hello world foo bar");
    expect(summarize(["- item one", "\n", "- item two"])).toBe("- item one\n- item two");
  });

  it("falls back to data.text when no delta is present, without trimming", () => {
    expect(pickAssistantChunk({ text: " snapshot text " })).toBe(" snapshot text ");
    expect(pickAssistantChunk({ delta: "", text: " fallback" })).toBe(" fallback");
    expect(pickAssistantChunk({})).toBeNull();
  });
});

describe("isWaitPending", () => {
  it("treats a slice-expiry timeout (timeoutPhase, no endedAt) as pending", () => {
    expect(isWaitPending({ status: "timeout", timeoutPhase: "gateway_draining" })).toBe(true);
    expect(isWaitPending({ status: "timeout", timeoutPhase: "queue", providerStarted: false })).toBe(true);
  });

  it("treats a terminated run (ok/error, or timeout WITH endedAt) as not pending", () => {
    expect(isWaitPending({ status: "ok", endedAt: 10 })).toBe(false);
    expect(isWaitPending({ status: "error", endedAt: 10, error: "boom" })).toBe(false);
    expect(isWaitPending({ status: "timeout", endedAt: 10, stopReason: "timeout" })).toBe(false);
  });

  it("is not pending for empty or terminal-without-marker payloads", () => {
    expect(isWaitPending(null)).toBe(false);
    expect(isWaitPending(undefined)).toBe(false);
    expect(isWaitPending({ status: "ok" })).toBe(false);
  });
});

describe("awaitRunResilient", () => {
  const noopLog = async () => {};
  const noSleep = async () => {};

  it("polls agent.wait through slice-expiry timeouts until the run terminates", async () => {
    const responses: Array<Record<string, unknown>> = [
      { status: "timeout", timeoutPhase: "gateway_draining" },
      { status: "timeout", timeoutPhase: "gateway_draining" },
      { status: "ok", endedAt: 1, result: { text: "done" } },
    ];
    let call = 0;
    const client = {
      request: async <T>(): Promise<T> => responses[call++] as T,
      close: () => {},
    };
    const result = await awaitRunResilient({
      client,
      runId: "run-1",
      waitSliceMs: 1_000,
      maxRunMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => client,
      onLog: noopLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    expect(call).toBe(3);
  });

  it("reconnects a fresh connection and resumes agent.wait after a drop", async () => {
    let reconnects = 0;
    let closedCount = 0;
    const makeClient = (failFirst: boolean) => {
      let asked = false;
      return {
        request: async <T>(): Promise<T> => {
          if (failFirst && !asked) {
            asked = true;
            throw new Error("gateway closed (1006): idle");
          }
          return { status: "ok", endedAt: 1 } as T;
        },
        close: () => {
          closedCount += 1;
        },
      };
    };
    const result = await awaitRunResilient({
      client: makeClient(true),
      runId: "run-1",
      waitSliceMs: 1_000,
      maxRunMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => {
        reconnects += 1;
        return makeClient(false);
      },
      onLog: noopLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    expect(reconnects).toBe(1);
    expect(closedCount).toBeGreaterThanOrEqual(1); // dropped connection was closed
  });

  it("gives up with max_run_exceeded once the ceiling is reached", async () => {
    let clock = 0;
    const client = {
      request: async <T>(): Promise<T> =>
        ({ status: "timeout", timeoutPhase: "gateway_draining" }) as T,
      close: () => {},
    };
    const result = await awaitRunResilient({
      client,
      runId: "run-1",
      waitSliceMs: 100,
      maxRunMs: 300,
      connectTimeoutMs: 10,
      connectClient: async () => client,
      onLog: noopLog,
      now: () => {
        const t = clock;
        clock += 200;
        return t;
      },
      sleep: noSleep,
    });
    expect(result.status).toBe("timeout");
    expect(result.timeoutPhase).toBe("max_run_exceeded");
  });
});
