const GOVERNED_AGENT_CREATION_ENV = "PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION";

/**
 * Deployment-level fence for installations whose external control plane owns
 * agent limits, artifacts, and runtime pairing.
 *
 * It fences the two ways an AGENT principal can grow the roster: the
 * `agents:create` authorization decision (plus the one create route that does
 * not consult it, catalog team install), and filing a `hire_agent` approval
 * whose approval MINTS an agent. Board principals are untouched, so every
 * native create, hire, import, and catalog workflow keeps upstream behaviour.
 *
 * Disabled by default.
 */
export function governedAgentCreationRequired(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env[GOVERNED_AGENT_CREATION_ENV];
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
