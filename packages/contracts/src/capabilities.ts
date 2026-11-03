import * as z from "zod";

/*
 * Capability scopes: `<domain>.<verb>`, or `ext.<slug>.<verb>` for connector tools with no known
 * domain. Verbs do not imply each other. Vendor names never appear here: product slugs only
 * show up as admin-supplied data in policy mappings. See
 * docs/enterprise/features/capability-broker.md.
 */

/** Verbs per built-in domain. */
export const CAPABILITY_DOMAIN_VERBS = {
  calendar: ["read", "write", "delete"],
  mail: ["read", "write", "send", "delete"],
  contacts: ["read", "write", "delete"],
  docs: ["read", "write", "delete"],
  tickets: ["read", "write", "delete"],
  chat: ["read", "write", "send", "delete"],
  files: ["read", "write", "delete"],
  web: ["fetch", "submit"],
  computer: ["shell", "browser", "screen", "host"],
  secrets: ["use"],
  spend: ["purchase"],
  fleet: ["manage", "spawn", "delegate"],
  schedule: ["create"],
} as const satisfies Record<string, readonly string[]>;

export type CapabilityDomain = keyof typeof CAPABILITY_DOMAIN_VERBS;

export const CAPABILITY_EXT_VERBS = ["read", "write", "admin"] as const;

/** Verbs that only observe. Every other verb needs an admin (or an admin allow-list) to grant. */
export const CAPABILITY_READ_VERBS: readonly string[] = ["read", "fetch"];

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A server or app name turned into the slug used in `ext.<slug>.<verb>`. */
export function capabilitySlug(name: string | undefined): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return SLUG.test(slug) ? slug : "unknown";
}

function isDomain(value: string): value is CapabilityDomain {
  return Object.hasOwn(CAPABILITY_DOMAIN_VERBS, value);
}

/** A concrete scope such as `mail.send` or `ext.acme.read`. */
export function isConcreteScope(scope: string): boolean {
  const parts = scope.split(".");
  if (parts[0] === "ext") {
    return (
      parts.length === 3 &&
      SLUG.test(parts[1] ?? "") &&
      (CAPABILITY_EXT_VERBS as readonly string[]).includes(parts[2] ?? "")
    );
  }
  const [domain, verb] = parts;
  if (parts.length !== 2 || !domain || !verb || !isDomain(domain)) return false;
  return (CAPABILITY_DOMAIN_VERBS[domain] as readonly string[]).includes(verb);
}

/** `calendar.*` or `ext.<slug>.*`: every verb of one domain. */
export function isDomainWildcardScope(scope: string): boolean {
  if (!scope.endsWith(".*")) return false;
  const head = scope.slice(0, -2);
  if (head.startsWith("ext.")) return SLUG.test(head.slice(4));
  return isDomain(head);
}

/** Whether `pattern` (concrete, `domain.*`, `ext.*` or `*.*`) covers the concrete `scope`. */
export function capabilityScopeCovers(pattern: string, scope: string): boolean {
  if (pattern === "*.*") return true;
  if (pattern.endsWith(".*")) return scope.startsWith(pattern.slice(0, -1));
  return pattern === scope;
}

/** A scope with no wildcard. */
export const CapabilityScopeSchema = z
  .string()
  .refine(isConcreteScope, { message: "Unknown capability scope" });
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;

/** What a grant may name: a concrete scope or a domain wildcard. Never `*.*`. */
export const CapabilityGrantScopeSchema = z
  .string()
  .refine((scope) => isConcreteScope(scope) || isDomainWildcardScope(scope), {
    message: "Unknown capability scope",
  });

/** What an admin policy list may name: a grant scope, `ext.*` or `*.*`. */
export const CapabilityPolicyScopeSchema = z
  .string()
  .refine(
    (scope) =>
      scope === "*.*" ||
      scope === "ext.*" ||
      isConcreteScope(scope) ||
      isDomainWildcardScope(scope),
    { message: "Unknown capability scope" },
  );

export const CAPABILITY_RESOURCE_KINDS = [
  "connection",
  "mcp_server",
  "host",
  "path",
  "recipient_domain",
  "resource_arg",
] as const;
export const CapabilityResourceKindSchema = z.enum(CAPABILITY_RESOURCE_KINDS);
export type CapabilityResourceKind = z.infer<typeof CapabilityResourceKindSchema>;

/** A grant narrows to resources of one kind. `host` and `resource_arg` take globs. */
export const CapabilityResourceSchema = z.strictObject({
  kind: CapabilityResourceKindSchema,
  match: z.string().min(1).max(256),
});
export type CapabilityResource = z.infer<typeof CapabilityResourceSchema>;

export const CAPABILITY_GRANT_KINDS = ["bot", "delegation", "shared_identity"] as const;
export const CAPABILITY_EFFECTS = ["allow", "ask", "deny"] as const;
export const CAPABILITY_GRANTED_VIA = ["owner", "admin", "policy"] as const;

/** One grant row as the evaluator sees it. Expired or revoked rows are ignored. */
export const CapabilityGrantSchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    kind: z.enum(CAPABILITY_GRANT_KINDS),
    scope: CapabilityGrantScopeSchema,
    resource: CapabilityResourceSchema.optional(),
    effect: z.enum(CAPABILITY_EFFECTS).default("allow"),
    /** Delegation: whose credentials or data the bot may use. */
    principalUserId: z.string().min(1).max(128).optional(),
    sharedIdentityId: z.string().min(1).max(128).optional(),
    createdVia: z.enum(CAPABILITY_GRANTED_VIA),
    expiresAt: z.date().optional(),
    revokedAt: z.date().optional(),
  })
  .superRefine((grant, ctx) => {
    if (grant.kind === "delegation" && !grant.principalUserId) {
      ctx.addIssue({ code: "custom", message: "A delegation needs principalUserId" });
    }
    if (grant.kind === "shared_identity" && !grant.sharedIdentityId) {
      ctx.addIssue({ code: "custom", message: "A shared identity grant needs sharedIdentityId" });
    }
  });
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

const globs = z.string().min(1).max(256);

/**
 * Admin classification of connector and MCP tools. Slug globs are the same slugs
 * `integrations.allowConnectors` uses. The first matching mapping wins.
 */
export const CapabilityMappingSchema = z
  .strictObject({
    match: z.union([
      z.strictObject({
        source: z.enum(["mcp", "installed"]),
        server: globs.optional(),
        tool: globs.optional(),
      }),
      z.strictObject({
        source: z.literal("connector"),
        app: globs.optional(),
        tool: globs.optional(),
      }),
    ]),
    scopes: z.array(CapabilityScopeSchema).min(1).max(8),
    /** Argument whose value is the call's resource for a `resource_arg` grant. */
    resourceArg: z.string().min(1).max(128).optional(),
    /** Believe the server's `readOnlyHint`/`destructiveHint` for this mapping. */
    trustAnnotations: z.boolean().optional(),
    /** Scopes used instead of `scopes` when a trusted annotation says the call is read-only. */
    readScopes: z.array(CapabilityScopeSchema).min(1).max(8).optional(),
  })
  .superRefine((mapping, ctx) => {
    if (mapping.readScopes && !mapping.trustAnnotations) {
      ctx.addIssue({ code: "custom", message: "readScopes needs trustAnnotations: true" });
    }
  });
export type CapabilityMapping = z.infer<typeof CapabilityMappingSchema>;

/** The `capabilities` section of central policy. Absent = no change in behavior. */
export const CapabilityPolicySchema = z.strictObject({
  /** Force grant enforcement for every bot. */
  requireGrants: z.boolean().optional(),
  /** Scopes any grant may contain; omit = no ceiling. `*.*` is allowed only here and below. */
  ceiling: z.array(CapabilityPolicyScopeSchema).max(200).optional(),
  deny: z.array(CapabilityPolicyScopeSchema).max(200).optional(),
  alwaysAsk: z.array(CapabilityPolicyScopeSchema).max(200).optional(),
  /** Non-read scopes bot owners may grant themselves; every other non-read scope needs an admin. */
  ownerGrantable: z.array(CapabilityGrantScopeSchema).max(200).optional(),
  mappings: z.array(CapabilityMappingSchema).max(500).optional(),
});
export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>;

/** The acting requester. With shared employees each user has their own instance, so the owner is
 * the requester; service-instance work runs as the service principal. */
export const RunPrincipalSchema = z.strictObject({
  actingUserId: z.string().min(1).max(128),
  sharedIdentityId: z.string().min(1).max(128).optional(),
});
export type RunPrincipal = z.infer<typeof RunPrincipalSchema>;
