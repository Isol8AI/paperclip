import { AsyncLocalStorage } from "node:async_hooks";
import { forbidden } from "../errors.js";

const GOVERNED_AGENT_CREATION_ENV = "PAPERCLIP_REQUIRE_GOVERNED_AGENT_CREATION";

/**
 * Deployment-level fence for installations whose external control plane owns
 * agent limits, artifacts, and runtime pairing.
 *
 * FAILURE DIRECTION IS DELIBERATE: anything that is not `1|true|yes|on` —
 * unset, empty, whitespace, `"flase"`, `"0"` — reads as OFF. An opt-in fence
 * MUST fail open, because the alternative is that a typo in one deployment's
 * environment silently bricks agent creation for every vanilla Paperclip
 * install that never asked for this. The cost of failing open is that an
 * operator can believe the fence is armed when it is not, which is why the
 * value is asserted in the deployer's own tests rather than trusted as a
 * string (Isol8 does this in `apps/infra/test/paperclip-stack.test.ts`) and
 * why `governedAgentCreationRequired()` is exported for a health/debug read.
 */
export function governedAgentCreationRequired(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env[GOVERNED_AGENT_CREATION_ENV];
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Whether the in-flight HTTP request is authenticated as an AGENT principal.
 *
 * `agentService.create` is the single seam every agent creation crosses (it
 * owns the only `insert(agents)` in the server), but a service has no request
 * to inspect — which is why earlier attempts fenced the individual routes and
 * kept missing one. `company-portability.importBundle` was the one that got
 * away: `POST /companies/:id/imports/apply` admits `role === "ceo"` agents
 * through `assertSameCompanyCeoAgentOrBoard` and never consults
 * `agents:create` at all.
 *
 * AsyncLocalStorage carries the actor from the auth middleware down to the
 * seam, so the fence lives in one place and every route — including ones
 * added by a future upstream rebase — inherits it.
 *
 * No store (background workers, cron, plugin host, startup reconcile) means no
 * agent-authenticated request is in play, so those paths are allowed.
 */
const agentPrincipalStore = new AsyncLocalStorage<boolean>();

export function runAsCreationPrincipal<T>(isAgentPrincipal: boolean, fn: () => T): T {
  return agentPrincipalStore.run(isAgentPrincipal, fn);
}

/** Throws when an agent principal tries to create an agent in a governed deployment. */
export function assertAgentCreationAllowed() {
  if (!governedAgentCreationRequired()) return;
  if (agentPrincipalStore.getStore() !== true) return;
  throw forbidden(
    "Agent principals cannot create agents in this deployment; its control plane owns the roster.",
    { code: "governed_agent_creation_required" },
  );
}
