import type {
  DirectoryClaimsResult,
  DirectoryClaimsSource,
  DirectorySubject,
} from "@rakazo/adapter-kit";

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 999;
/** Past this many pages the list is reported truncated, so claim grants fail closed. */
const MAX_PAGES = 10;

/** Sign-in authority to the API host of the same cloud. */
const CLOUDS: Record<string, string> = {
  "login.microsoftonline.com": "https://graph.microsoft.com",
  "login.microsoftonline.us": "https://graph.microsoft.us",
  "login.partner.microsoftonline.cn": "https://microsoftgraph.chinacloudapi.cn",
};

export interface GraphDirectoryOptions {
  /** The v2.0 issuer of the app registration: https://<authority>/<tenant>/v2.0. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Whether the issuer names a cloud this adapter can read groups from. */
export function isGraphIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).hostname in CLOUDS;
  } catch {
    return false;
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Reads transitive security-group membership with the app's own credentials (application
 * permission `GroupMember.Read.All` and `User.ReadBasic.All`). Plain REST; no SDK.
 */
export function createGraphDirectoryClaims(options: GraphDirectoryOptions): DirectoryClaimsSource {
  const issuer = new URL(options.issuer);
  const base = CLOUDS[issuer.hostname];
  const tenant = issuer.pathname.split("/").filter(Boolean)[0];
  if (!base || !tenant) throw new Error("The issuer is not a supported directory");
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;

  const accessToken = async (signal: AbortSignal) => {
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    const response = await request(
      `${issuer.origin}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: options.clientId,
          client_secret: options.clientSecret,
          scope: `${base}/.default`,
        }),
        signal,
      },
    );
    const data = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!response.ok || typeof data?.access_token !== "string")
      throw new Error(`directory token request failed with status ${response.status}`);
    const lifetime = typeof data.expires_in === "number" ? data.expires_in : 300;
    cached = { token: data.access_token, expiresAt: now() + lifetime * 1000 };
    return cached.token;
  };

  const get = async (url: string, signal: AbortSignal) => {
    // A next link is followed only on the same host, so the token never goes elsewhere.
    if (new URL(url).origin !== base) throw new Error("directory returned a foreign link");
    const response = await request(url, {
      headers: { authorization: `Bearer ${await accessToken(signal)}` },
      signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`directory request failed with status ${response.status}`);
    return (await response.json()) as { value?: unknown; "@odata.nextLink"?: unknown };
  };

  return {
    async claimsFor(
      subject: DirectorySubject,
      outer?: AbortSignal,
    ): Promise<DirectoryClaimsResult> {
      const signal = AbortSignal.any([
        AbortSignal.timeout(TIMEOUT_MS * (MAX_PAGES + 2)),
        ...(outer ? [outer] : []),
      ]);
      const email = quote(subject.email);
      const found = await get(
        `${base}/v1.0/users?$select=id&$top=2&$filter=${encodeURIComponent(
          `mail eq ${email} or userPrincipalName eq ${email}`,
        )}`,
        signal,
      );
      const users = Array.isArray(found?.value) ? (found.value as Array<{ id?: unknown }>) : [];
      if (users.length === 0) return { status: "missing" };
      // Two entries for one address: which one signed in is unknown, so nothing is concluded.
      const id = users.length === 1 ? users[0]?.id : undefined;
      if (typeof id !== "string") throw new Error("directory entry is ambiguous");
      const values = new Set<string>();
      let next: string | undefined =
        `${base}/v1.0/users/${encodeURIComponent(id)}/transitiveMemberOf/microsoft.graph.group` +
        `?$select=id,securityEnabled&$top=${PAGE_SIZE}`;
      for (let page = 0; next; page++) {
        if (page >= MAX_PAGES) return { status: "found", values: [...values], truncated: true };
        const body = await get(next, signal);
        if (!body) return { status: "missing" };
        for (const group of Array.isArray(body.value)
          ? (body.value as Array<{ id?: unknown; securityEnabled?: unknown }>)
          : []) {
          // The sign-in token lists security groups, so mailing lists add nothing here.
          if (typeof group.id === "string" && group.securityEnabled === true) values.add(group.id);
        }
        next = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
      }
      return { status: "found", values: [...values] };
    },
  };
}
