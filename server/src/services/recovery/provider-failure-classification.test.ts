import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});

describe("classifyAdapterFailureForRecovery (daily budget cap)", () => {
  const now = new Date("2026-07-24T18:31:07.000Z");

  it("parks a gateway wait error carrying the daily-cap denial at the next UTC midnight", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "openclaw_gateway_wait_error",
      error: "isol8: daily free limit reached — resets at midnight UTC",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-25T00:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parks a gateway agent error carrying the daily-cap denial too", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "openclaw_gateway_agent_error",
      error: "agent request rejected: daily free limit reached",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-25T00:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("prefers the adapter's persisted (jittered) retryNotBefore over the computed midnight", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "isol8: daily free limit reached — resets at midnight UTC",
      resultJson: { retryNotBefore: "2026-07-25T00:03:21.000Z" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-25T00:03:21.000Z"),
      parsedResetTime: true,
    });
  });

  it("parks adapter_failed runs carrying the daily-cap denial at the next UTC midnight", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "run failed: daily free limit reached — resets at midnight UTC",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-25T00:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("keeps ordinary gateway errors on their existing retry behavior", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "openclaw_gateway_wait_error",
      error: "OpenClaw gateway run failed",
      resultJson: null,
    }, now)).toBeNull();
  });

  it("does not classify gateway errors as configuration_incomplete from message text alone", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "openclaw_gateway_wait_error",
      error: "bootstrap diagnostics mention a missing api key marker",
      resultJson: null,
    }, now)).toBeNull();
  });
});
