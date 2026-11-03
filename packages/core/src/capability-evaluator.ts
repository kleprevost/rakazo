import type { CapabilityGrant, CapabilityResource, Policy, RunPrincipal } from "@rakazo/contracts";
import { CAPABILITY_READ_VERBS, capabilityScopeCovers } from "@rakazo/contracts";
import type { CallResources, Classification, ClassifyInput } from "./capability-classifier.js";
import { classifyCall } from "./capability-classifier.js";
import { policyGlobMatches } from "./policy.js";

export type CapabilityOutcome = "allow" | "ask" | "deny";

export type CapabilityLayer =
  | "quarantine"
  | "ceiling"
  | "principal"
  | "grant"
  | "delegation"
  | "approval";

/** One step of the decision. Scope names, ids and rule names only: never arguments or content. */
export type CapabilityTraceEntry = {
  layer: CapabilityLayer;
  /** A policy rule name, a grant id, or a layer verdict. */
  rule: string;
  scope?: string;
  /** `none` marks a row that was looked at and ignored (expired, revoked, not permitted). */
  effect: CapabilityOutcome | "none";
  source?: CapabilityGrant["createdVia"];
  detail?: string;
  expiresAt?: string;
};

export type CapabilityDecision = {
  outcome: CapabilityOutcome;
  /** Why the call was denied or must ask: the first deciding rule in layer order. */
  rule?: string;
  trace: CapabilityTraceEntry[];
};

/** The credential a call would use. */
export type CapabilityCredential =
  | { kind: "none" }
  | { kind: "personal"; userId: string }
  | { kind: "shared"; identityId: string };

export type CapabilitySnapshot = {
  now: Date;
  policy?: Policy | undefined;
  /** Set when the bot is quarantined (bot, space, group or all). */
  quarantine?: { id: string } | undefined;
  /** The acting requester, derived by the server from the run source. */
  principal: RunPrincipal;
  /** Every grant row for the bot, in any state. */
  grants: readonly CapabilityGrant[];
  /** What the existing approval engine would do, if it was asked. It can only narrow. */
  approval?: "allow" | "ask" | "block" | undefined;
};

export type CapabilityQuery = {
  /** Every scope the call needs; each must pass. Empty for a call with no external effect. */
  scopes: readonly string[];
  resources?: CallResources | undefined;
  credential?: CapabilityCredential | undefined;
};

/** A concrete scope whose verb only observes. Wildcards and `ext.<slug>.read` handled by verb. */
function isReadGrantScope(scope: string): boolean {
  const parts = scope.split(".");
  const verb = parts[parts.length - 1] ?? "";
  return verb !== "*" && CAPABILITY_READ_VERBS.includes(verb);
}

function normalizedPath(value: string): string | undefined {
  const parts = value.split("/");
  return parts.includes("..") ? undefined : value.replace(/\/{2,}/g, "/");
}

/** Whether a call's resource satisfies a grant's. A value that cannot be read never matches. */
export function capabilityResourceMatches(
  resource: CapabilityResource,
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  switch (resource.kind) {
    case "connection":
    case "mcp_server":
      return resource.match === value;
    case "path": {
      const path = normalizedPath(value);
      const prefix = normalizedPath(resource.match);
      if (path === undefined || prefix === undefined) return false;
      const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
      return path === prefix || path.startsWith(base);
    }
    default:
      return policyGlobMatches(resource.match, value);
  }
}

type Row = { grant: CapabilityGrant; live: boolean; detail?: string };

function rowFor(grant: CapabilityGrant, snapshot: CapabilitySnapshot): Row {
  if (grant.revokedAt && grant.revokedAt <= snapshot.now) {
    return { grant, live: false, detail: "revoked" };
  }
  if (grant.expiresAt && grant.expiresAt <= snapshot.now) {
    return { grant, live: false, detail: "expired" };
  }
  // An owner may grant read scopes alone; anything else needs an admin or the admin allow-list.
  // A row that only narrows (ask, deny) is always honored.
  if (grant.effect === "allow" && grant.createdVia === "owner" && !isReadGrantScope(grant.scope)) {
    const listed = snapshot.policy?.capabilities?.ownerGrantable?.some((pattern) =>
      capabilityScopeCovers(pattern, grant.scope),
    );
    if (!listed) return { grant, live: false, detail: "owner_not_permitted" };
  }
  return { grant, live: true };
}

type Verdicts = { deny?: string; ask?: string };

function note(verdicts: Verdicts, effect: CapabilityOutcome, rule: string): void {
  if (effect === "deny") verdicts.deny ??= rule;
  else if (effect === "ask") verdicts.ask ??= rule;
}

function entryFor(
  layer: CapabilityLayer,
  row: Row,
  scope: string,
  effect: CapabilityOutcome | "none",
): CapabilityTraceEntry {
  const entry: CapabilityTraceEntry = {
    layer,
    rule: row.grant.id,
    scope,
    effect,
    source: row.grant.createdVia,
  };
  if (row.detail) entry.detail = row.detail;
  if (row.grant.expiresAt) entry.expiresAt = row.grant.expiresAt.toISOString();
  return entry;
}

/** Check each required scope against one set of grant rows. */
function checkGrants(
  layer: "grant" | "delegation",
  grants: readonly Row[],
  query: CapabilityQuery,
  missing: string,
  trace: CapabilityTraceEntry[],
  verdicts: Verdicts,
): void {
  for (const scope of query.scopes) {
    const covering = grants.filter(({ grant }) => capabilityScopeCovers(grant.scope, scope));
    let allowed = false;
    let resourceBlocked = false;
    for (const row of covering) {
      if (!row.live) {
        trace.push(entryFor(layer, row, scope, "none"));
        continue;
      }
      const { grant } = row;
      const value = grant.resource ? query.resources?.[grant.resource.kind] : undefined;
      const fits = !grant.resource || capabilityResourceMatches(grant.resource, value);
      if (grant.effect === "allow") {
        if (fits) {
          allowed = true;
          trace.push(entryFor(layer, row, scope, "allow"));
        } else {
          resourceBlocked = true;
          trace.push({ ...entryFor(layer, row, scope, "none"), detail: "resource" });
        }
        continue;
      }
      // A restriction whose resource cannot be read still applies: fail closed.
      const applies = !grant.resource || fits || value === undefined;
      if (!applies) {
        trace.push({ ...entryFor(layer, row, scope, "none"), detail: "resource" });
        continue;
      }
      trace.push(entryFor(layer, row, scope, grant.effect));
      note(verdicts, grant.effect, grant.effect === "deny" ? "grant_deny" : "grant_ask");
    }
    if (!allowed) {
      const rule = resourceBlocked ? "resource" : missing;
      trace.push({ layer, rule, scope, effect: "deny" });
      note(verdicts, "deny", rule);
    }
  }
}

/**
 * The one capability decision. Layers, in order: quarantine (hard stop), org ceiling, principal,
 * bot grants, user delegation, approvals. Each layer can only narrow the result; within the
 * outcome, deny beats ask beats allow. Pure: callers load the snapshot and own the mode
 * (off, shadow, enforce) and what to do with the outcome.
 */
export function evaluateCapability(
  snapshot: CapabilitySnapshot,
  query: CapabilityQuery,
): CapabilityDecision {
  const trace: CapabilityTraceEntry[] = [];
  const verdicts: Verdicts = {};

  if (snapshot.quarantine) {
    trace.push({
      layer: "quarantine",
      rule: "quarantine",
      effect: "deny",
      detail: snapshot.quarantine.id,
    });
    return { outcome: "deny", rule: "quarantine", trace };
  }

  const org = snapshot.policy?.capabilities;
  for (const scope of query.scopes) {
    if (org?.deny?.some((pattern) => capabilityScopeCovers(pattern, scope))) {
      trace.push({ layer: "ceiling", rule: "capabilities.deny", scope, effect: "deny" });
      note(verdicts, "deny", "capabilities.deny");
    } else if (
      org?.ceiling &&
      !org.ceiling.some((pattern) => capabilityScopeCovers(pattern, scope))
    ) {
      trace.push({ layer: "ceiling", rule: "capabilities.ceiling", scope, effect: "deny" });
      note(verdicts, "deny", "capabilities.ceiling");
    } else if (org?.alwaysAsk?.some((pattern) => capabilityScopeCovers(pattern, scope))) {
      trace.push({ layer: "ceiling", rule: "capabilities.alwaysAsk", scope, effect: "ask" });
      note(verdicts, "ask", "capabilities.alwaysAsk");
    }
  }

  const { principal } = snapshot;
  const credential = query.credential ?? { kind: "none" };
  if (credential.kind === "personal" && credential.userId !== principal.actingUserId) {
    trace.push({ layer: "principal", rule: "principal_mismatch", effect: "deny" });
    note(verdicts, "deny", "principal_mismatch");
  }
  if (credential.kind === "shared" && credential.identityId !== principal.sharedIdentityId) {
    trace.push({ layer: "principal", rule: "principal_mismatch", effect: "deny" });
    note(verdicts, "deny", "principal_mismatch");
  }

  if (query.scopes.length) {
    const rows = snapshot.grants.map((grant) => rowFor(grant, snapshot));
    // A delegation by the acting user also serves as that user's bot grant, so one row can do both.
    const applicable = rows.filter(({ grant }) => {
      if (grant.kind === "bot") return true;
      if (grant.kind === "delegation") return grant.principalUserId === principal.actingUserId;
      return (
        principal.sharedIdentityId !== undefined &&
        grant.sharedIdentityId === principal.sharedIdentityId
      );
    });
    checkGrants("grant", applicable, query, "no_grant", trace, verdicts);

    // A personal credential needs its owner's delegation, a shared one an explicit shared-identity
    // grant. Neither is satisfied by a plain bot grant, and neither falls back to the other.
    if (credential.kind === "personal") {
      const delegations = rows.filter(
        ({ grant }) => grant.kind === "delegation" && grant.principalUserId === credential.userId,
      );
      checkGrants("delegation", delegations, query, "not_delegated", trace, verdicts);
    } else if (credential.kind === "shared") {
      const shared = rows.filter(
        ({ grant }) =>
          grant.kind === "shared_identity" && grant.sharedIdentityId === credential.identityId,
      );
      checkGrants("delegation", shared, query, "no_grant", trace, verdicts);
    }
  }

  if (snapshot.approval === "block") {
    trace.push({ layer: "approval", rule: "approval_block", effect: "deny" });
    note(verdicts, "deny", "approval_block");
  } else if (snapshot.approval === "ask") {
    trace.push({ layer: "approval", rule: "approval_ask", effect: "ask" });
    note(verdicts, "ask", "approval_ask");
  }

  if (verdicts.deny) return { outcome: "deny", rule: verdicts.deny, trace };
  if (verdicts.ask) return { outcome: "ask", rule: verdicts.ask, trace };
  return { outcome: "allow", trace };
}

/** Classify a call and decide it in one step: what the gate and the simulator both run. */
export function evaluateCall(
  snapshot: CapabilitySnapshot,
  call: ClassifyInput,
  credential?: CapabilityCredential,
): CapabilityDecision & { classification: Classification } {
  const classification = classifyCall(call, snapshot.policy);
  const decision = evaluateCapability(snapshot, {
    scopes: classification.scopes,
    resources: classification.resources,
    credential,
  });
  return { ...decision, classification };
}
