const GOVERNED_AGENT_CREATION_ENV = "PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION";

/**
 * Deployment-level fence for installations whose external control plane owns
 * agent limits, artifacts, and runtime pairing. Disabled by default so normal
 * Paperclip deployments retain the native create, hire, import, and catalog
 * workflows.
 */
export function governedAgentCreationRequired(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env[GOVERNED_AGENT_CREATION_ENV];
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
