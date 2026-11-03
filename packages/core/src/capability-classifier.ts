import type {
  CapabilityMapping,
  CapabilityResourceKind,
  CapabilityScope,
  Policy,
} from "@rakazo/contracts";
import { capabilitySlug, isBuiltinToolName } from "@rakazo/contracts";
import { BUILTIN_TOOL_SCOPES } from "./capability-builtin-scopes.js";
import { policyGlobMatches } from "./policy.js";

export type CallSource = "builtin" | "connector" | "mcp" | "installed";

/** What the gate knows about a call. Never the model's claim about what the tool does. */
export type ClassifyInput = {
  source: CallSource;
  /** The tool's own name (a built-in's name, or the connector's tool name). */
  tool: string;
  /** Server slug (`mcp`, `installed`) or app slug (`connector`). */
  slug?: string;
  connectionId?: string;
  /** The MCP server id the route resolved to. */
  serverId?: string;
  /** Effect verified by the server for installed APIs (query/GET is `read`). */
  effect?: "read" | "write";
  /** Untrusted hints from an MCP server. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  args?: Readonly<Record<string, unknown>>;
  /** Actions named by a batch tool; an unidentified one is `undefined` and takes the top scope. */
  batchActions?: ReadonlyArray<string | undefined>;
};

export type ClassifyBasis = "mapping" | "builtin" | "declared" | "annotation" | "unmapped" | "none";

export type CallResources = Partial<Record<CapabilityResourceKind, string>>;

export type Classification = {
  scopes: CapabilityScope[];
  resources: CallResources;
  basis: ClassifyBasis;
  /** True when nothing mapped the call and the answer is the `ext.<slug>` fallback. */
  unmapped: boolean;
};

function stringArg(args: ClassifyInput["args"], name: string): string | undefined {
  const value = args?.[name];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function urlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

const HOST_ARG_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "browser_navigate"]);
const PATH_ARG_TOOLS: ReadonlySet<string> = new Set([
  "list_files",
  "read_file",
  "write_file",
  "attach_file",
]);

function baseResources(input: ClassifyInput, resourceArg?: string): CallResources {
  const resources: CallResources = {};
  if (input.connectionId) resources.connection = input.connectionId;
  if (input.serverId) resources.mcp_server = input.serverId;
  if (input.source === "builtin") {
    if (HOST_ARG_TOOLS.has(input.tool)) {
      const host = urlHost(stringArg(input.args, "url"));
      if (host) resources.host = host;
    }
    if (PATH_ARG_TOOLS.has(input.tool)) {
      const path = stringArg(input.args, "path");
      if (path) resources.path = path;
    }
  }
  if (resourceArg) {
    const value = stringArg(input.args, resourceArg);
    if (value) resources.resource_arg = value;
  }
  return resources;
}

function mappingFor(
  mappings: readonly CapabilityMapping[],
  input: ClassifyInput,
  slug: string,
  tool: string,
): CapabilityMapping | undefined {
  return mappings.find(({ match }) => {
    if (match.source !== input.source) return false;
    const pattern = match.source === "connector" ? match.app : match.server;
    if (pattern && !policyGlobMatches(pattern, slug)) return false;
    return !match.tool || policyGlobMatches(match.tool, tool);
  });
}

function extScope(slug: string, verb: "read" | "write" | "admin"): CapabilityScope {
  return `ext.${slug}.${verb}`;
}

type One = { scopes: CapabilityScope[]; basis: ClassifyBasis; unmapped: boolean };

function classifyExternal(
  input: ClassifyInput,
  tool: string | undefined,
  slug: string,
  mappings: readonly CapabilityMapping[],
): One & { mapping?: CapabilityMapping | undefined } {
  const mapping = tool === undefined ? undefined : mappingFor(mappings, input, slug, tool);
  if (mapping) {
    const hints = input.annotations;
    const readScopes =
      mapping.trustAnnotations && hints?.readOnlyHint === true && hints.destructiveHint !== true
        ? mapping.readScopes
        : undefined;
    return {
      scopes: readScopes ?? mapping.scopes,
      basis: readScopes ? "annotation" : "mapping",
      unmapped: false,
      mapping,
    };
  }
  // Hints can only tighten here: destructive is the top scope, and a read claim is a candidate
  // that still needs its own `ext.<slug>.read` grant.
  const hints = input.annotations;
  if (hints?.destructiveHint === true) {
    return { scopes: [extScope(slug, "admin")], basis: "annotation", unmapped: true };
  }
  if (input.effect) {
    return { scopes: [extScope(slug, input.effect)], basis: "declared", unmapped: true };
  }
  if (hints?.readOnlyHint === true) {
    return { scopes: [extScope(slug, "read")], basis: "annotation", unmapped: true };
  }
  if (hints?.readOnlyHint === false) {
    return { scopes: [extScope(slug, "write")], basis: "annotation", unmapped: true };
  }
  return { scopes: [extScope(slug, "admin")], basis: "unmapped", unmapped: true };
}

/**
 * Map a call to the scopes it needs and the resources the classifier can read from it. Order of
 * authority: admin mapping, built-in table, server-verified effect, annotations (tighten only),
 * then the `ext.<slug>` fallback at the highest verb. Tool-name patterns are never used.
 */
export function classifyCall(input: ClassifyInput, policy?: Policy): Classification {
  if (input.source === "builtin") {
    if (!isBuiltinToolName(input.tool)) {
      return {
        scopes: [extScope("builtin", "admin")],
        resources: baseResources(input),
        basis: "unmapped",
        unmapped: true,
      };
    }
    const scopes = [...BUILTIN_TOOL_SCOPES[input.tool]];
    return {
      scopes,
      resources: baseResources(input),
      basis: scopes.length ? "builtin" : "none",
      unmapped: false,
    };
  }

  const mappings = policy?.capabilities?.mappings ?? [];
  const slug = capabilitySlug(input.slug);
  const actions = input.batchActions ?? [input.tool];
  const scopes = new Set<CapabilityScope>();
  let basis: ClassifyBasis = "mapping";
  let unmapped = false;
  let resourceArg: string | undefined;
  actions.forEach((action, index) => {
    const one = classifyExternal(input, action, slug, mappings);
    // An unidentified batch action takes the highest scope.
    const result: One =
      action === undefined
        ? { scopes: [extScope(slug, "admin")], basis: "unmapped", unmapped: true }
        : one;
    for (const scope of result.scopes) scopes.add(scope);
    unmapped ||= result.unmapped;
    if (index === 0 || result.unmapped) basis = result.basis;
    resourceArg ??= one.mapping?.resourceArg;
  });
  return { scopes: [...scopes], resources: baseResources(input, resourceArg), basis, unmapped };
}
