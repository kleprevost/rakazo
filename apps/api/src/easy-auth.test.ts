import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { easyAuthMiddleware } from "./easy-auth.js";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
}));

function appWith(pass: Parameters<typeof easyAuthMiddleware>[0]) {
  const app = new Hono();
  app.use("*", easyAuthMiddleware(pass));
  app.all("*", (c) => c.json({ cookie: c.req.raw.headers.get("cookie") }));
  return app;
}

describe("easyAuthMiddleware", () => {
  it("does nothing when the mode is off", async () => {
    const app = appWith(undefined);
    const response = await app.request("/rpc/x", {
      headers: { "x-ms-token-aad-id-token": "token", cookie: "a=1" },
    });
    expect(await response.json()).toEqual({ cookie: "a=1" });
  });

  it("skips requests that carry neither the platform token nor a cookie", async () => {
    const pass = vi.fn();
    await appWith(pass).request("/health");
    expect(pass).not.toHaveBeenCalled();
  });

  it("hands the rewritten cookie to later handlers and appends the new cookies", async () => {
    const pass = vi.fn(async () => ({
      cookie: "session=new",
      setCookies: ["session=new; Path=/; HttpOnly"],
    }));
    const response = await appWith(pass).request("/rpc/x", {
      headers: { "x-ms-token-aad-id-token": "token", "x-rakazo-client-ip": "6.6.6.6" },
    });
    expect(await response.json()).toEqual({ cookie: "session=new" });
    expect(response.headers.getSetCookie()).toEqual(["session=new; Path=/; HttpOnly"]);
    const [headers] = pass.mock.calls[0] as unknown as [Headers];
    // A caller cannot choose the address Better Auth records.
    expect(headers.get("x-rakazo-client-ip")).toBeNull();
  });

  it("removes a cookie the pass ended and leaves other requests unchanged", async () => {
    const ended = vi.fn(async () => ({ cookie: "", setCookies: ["session=; Max-Age=0"] }));
    const response = await appWith(ended).request("/rpc/x", { headers: { cookie: "session=old" } });
    expect(await response.json()).toEqual({ cookie: null });
    const unchanged = vi.fn(async () => ({ cookie: undefined, setCookies: [] }));
    const kept = await appWith(unchanged).request("/rpc/x", { headers: { cookie: "a=1" } });
    expect(await kept.json()).toEqual({ cookie: "a=1" });
  });

  it("does not sign a request in again while it signs out", async () => {
    const pass = vi.fn(async () => ({ cookie: undefined, setCookies: [] }));
    const app = appWith(pass);
    await app.request("/api/auth/sign-out", { method: "POST", headers: { cookie: "a=1" } });
    await app.request("/api/auth/get-session", { headers: { cookie: "a=1" } });
    expect(pass.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { create: false },
      { create: true },
    ]);
  });

  it("leaves the request body for later handlers", async () => {
    const cases = [
      vi.fn(async () => ({ cookie: undefined, setCookies: [] })),
      vi.fn(async () => ({ cookie: "session=new", setCookies: ["session=new; Path=/"] })),
    ];
    for (const pass of cases) {
      const app = new Hono();
      app.use("*", easyAuthMiddleware(pass));
      app.post("/rpc/x", async (c) => c.json(await c.req.json()));
      const response = await app.request("/rpc/x", {
        method: "POST",
        body: JSON.stringify({ json: { id: "a" } }),
        headers: {
          "content-type": "application/json",
          cookie: "session=old",
          "x-ms-token-aad-id-token": "token",
          "x-rakazo-client-ip": "6.6.6.6",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ json: { id: "a" } });
    }
  });
});
