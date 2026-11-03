import type { Policy } from "@rakazo/contracts";
import type { PolicyDecision } from "./policy.js";
import { policyGlobMatches } from "./policy.js";

const ALLOWED: PolicyDecision = { allowed: true };

/**
 * Whether a user may connect or use an app. Matches the app slug shown in the connector
 * catalog and on the saved connection (for example `gmail`), not the managed provider that
 * serves it. Case-insensitive; `*` and `?` globs. Omitted `allowConnectors` allows any.
 */
export function evaluateConnectorUse(policy: Policy | undefined, slug: string): PolicyDecision {
  const allowed = policy?.integrations?.allowConnectors;
  if (!allowed) return ALLOWED;
  const app = slug.trim();
  if (app && allowed.some((glob) => policyGlobMatches(glob.trim(), app))) return ALLOWED;
  return { allowed: false, rule: "integrations.allowConnectors" };
}

/** The apps a user may see; entries without a slug are dropped when a list is set. */
export function filterConnectorCatalog<T extends { slug: string }>(
  policy: Policy | undefined,
  items: T[],
): T[] {
  if (!policy?.integrations?.allowConnectors) return items;
  return items.filter((item) => evaluateConnectorUse(policy, item.slug).allowed);
}

/** Lowercase, no trailing dot, no IPv6 brackets. */
function canonicalHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * The hostname a request to `value` contacts. A full URL goes through the URL parser so
 * userinfo (`https://allowed.com@evil.com` is evil.com), ports, odd IP spellings and
 * punycode resolve the way the network stack sees them. Anything else is read as a bare host.
 * Returns undefined for input that is not a usable host.
 */
export function policyRequestHost(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.includes("://")) {
    try {
      return canonicalHost(new URL(text).hostname) || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const url = new URL(`https://${text}`);
    return url.username || url.password || url.pathname !== "/" || url.search || url.hash
      ? undefined
      : canonicalHost(url.hostname) || undefined;
  } catch {
    return undefined;
  }
}

function hostMatches(pattern: string, host: string): boolean {
  const entry = canonicalHost(pattern);
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(2);
    // A wildcard covers subdomains only: not the apex, and never an IP literal.
    return (
      suffix.length > 0 &&
      !suffix.includes("*") &&
      !host.includes(":") &&
      !/^[\d.]+$/.test(host) &&
      host.endsWith(`.${suffix}`)
    );
  }
  return !entry.includes("*") && entry === host;
}

/**
 * Whether a remote MCP or OpenAPI/GraphQL tool source may be contacted. `target` is a URL or a
 * bare host. Exact hostname or `*.example.com` subdomain wildcard; ports are ignored. A target
 * that cannot be parsed is refused whenever a list is set. Omitted `allowHosts` allows any.
 */
export function evaluateToolSourceHost(policy: Policy | undefined, target: string): PolicyDecision {
  const allowed = policy?.integrations?.mcp?.allowHosts;
  if (!allowed) return ALLOWED;
  const host = policyRequestHost(target);
  if (host && allowed.some((pattern) => hostMatches(pattern, host))) return ALLOWED;
  return { allowed: false, rule: "integrations.mcp.allowHosts" };
}

/**
 * Local-command (stdio) MCP servers have no host to check, so a host allowlist blocks them.
 * A later explicit setting may allow them.
 */
export function evaluateStdioMcp(policy: Policy | undefined): PolicyDecision {
  return policy?.integrations?.mcp?.allowHosts
    ? { allowed: false, rule: "integrations.mcp.allowHosts" }
    : ALLOWED;
}
