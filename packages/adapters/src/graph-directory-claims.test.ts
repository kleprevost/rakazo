import { describe, expect, it, vi } from "vitest";
import {
  createDirectoryClaimsSource,
  directoryClaimsSupported,
} from "./directory-claims-source.js";
import { createGraphDirectoryClaims, isGraphIssuer } from "./graph-directory-claims.js";

const issuer = "https://login.microsoftonline.com/tenant-1/v2.0";
const GRAPH = "https://graph.microsoft.com";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function setup(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return route(url, init);
  }) as unknown as typeof fetch;
  const source = createGraphDirectoryClaims({
    issuer,
    clientId: "client",
    clientSecret: "secret",
    fetch: fetchFake,
  });
  return { source, calls, fetchFake };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const token = () => json({ access_token: "graph-token", expires_in: 3600 });
const subject = { userId: "u1", email: "o'Neil@example.test" };

describe("directory group reads", () => {
  it("reads security group ids and ignores other groups", async () => {
    const { source, calls } = setup({
      "/tenant-1/oauth2/v2.0/token": token,
      "/v1.0/users": (url) => {
        expect(url.searchParams.get("$filter")).toBe(
          "mail eq 'o''Neil@example.test' or userPrincipalName eq 'o''Neil@example.test'",
        );
        return json({ value: [{ id: "dir-1" }] });
      },
      "/v1.0/users/dir-1/transitiveMemberOf/microsoft.graph.group": () =>
        json({
          value: [
            { id: "g1", securityEnabled: true },
            { id: "mailing", securityEnabled: false },
            { id: "g2", securityEnabled: true },
          ],
        }),
    });
    await expect(source.claimsFor(subject)).resolves.toEqual({
      status: "found",
      values: ["g1", "g2"],
    });
    // The token is fetched once and reused.
    await source.claimsFor(subject);
    expect(calls.filter((call) => call.includes("oauth2"))).toHaveLength(1);
  });

  it("follows next links on the directory host and marks an overlong list truncated", async () => {
    let pages = 0;
    const { source } = setup({
      "/tenant-1/oauth2/v2.0/token": token,
      "/v1.0/users": () => json({ value: [{ id: "dir-1" }] }),
      "/v1.0/users/dir-1/transitiveMemberOf/microsoft.graph.group": () => {
        pages++;
        return json({
          value: [{ id: `g${pages}`, securityEnabled: true }],
          "@odata.nextLink": `${GRAPH}/v1.0/users/dir-1/transitiveMemberOf/microsoft.graph.group?page=${pages}`,
        });
      },
    });
    const result = await source.claimsFor(subject);
    expect(result).toMatchObject({ status: "found", truncated: true });
    expect(pages).toBe(10);
  });

  it("refuses a next link to another host", async () => {
    const { source, fetchFake } = setup({
      "/tenant-1/oauth2/v2.0/token": token,
      "/v1.0/users": () => json({ value: [{ id: "dir-1" }] }),
      "/v1.0/users/dir-1/transitiveMemberOf/microsoft.graph.group": () =>
        json({ value: [], "@odata.nextLink": "https://attacker.example.test/steal" }),
    });
    await expect(source.claimsFor(subject)).rejects.toThrow(/foreign link/);
    expect(
      vi.mocked(fetchFake).mock.calls.every(([url]) => !String(url).includes("attacker")),
    ).toBe(true);
  });

  it("reports no match as missing, and an ambiguous or failing read as an error", async () => {
    const { source: none } = setup({
      "/tenant-1/oauth2/v2.0/token": token,
      "/v1.0/users": () => json({ value: [] }),
    });
    await expect(none.claimsFor(subject)).resolves.toEqual({ status: "missing" });
    const { source: two } = setup({
      "/tenant-1/oauth2/v2.0/token": token,
      "/v1.0/users": () => json({ value: [{ id: "a" }, { id: "b" }] }),
    });
    await expect(two.claimsFor(subject)).rejects.toThrow(/ambiguous/);
    for (const status of [429, 500]) {
      const { source } = setup({
        "/tenant-1/oauth2/v2.0/token": token,
        "/v1.0/users": () => json({}, status),
      });
      await expect(source.claimsFor(subject)).rejects.toThrow(String(status));
    }
    const { source: noToken } = setup({
      "/tenant-1/oauth2/v2.0/token": () => json({ error: "invalid_client" }, 401),
    });
    await expect(noToken.claimsFor(subject)).rejects.toThrow(/token request/);
  });
});

describe("directory source selection", () => {
  it("supports only known sign-in clouds and loads the adapter on demand", async () => {
    expect(isGraphIssuer(issuer)).toBe(true);
    expect(directoryClaimsSupported("https://idp.example.test/realm")).toBe(false);
    await expect(
      createDirectoryClaimsSource({
        issuer: "https://idp.example.test/realm",
        clientId: "c",
        clientSecret: "s",
      }),
    ).rejects.toThrow(/does not support/);
    const source = await createDirectoryClaimsSource({
      issuer,
      clientId: "c",
      clientSecret: "s",
    });
    expect(typeof source.claimsFor).toBe("function");
  });
});
