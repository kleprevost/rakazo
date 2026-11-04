// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  capabilityGrants: { list: vi.fn(), set: vi.fn(), revoke: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part);
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

import { BotAccess } from "./BotAccess";

const grant = (overrides: object = {}) => ({
  id: "g1",
  kind: "delegation",
  scope: "calendar.read",
  resource: null,
  effect: "allow",
  principalUserId: "u1",
  createdVia: "owner",
  createdByUserId: "u1",
  expiresAt: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  inherited: false,
  ...overrides,
});

beforeEach(() => vi.resetAllMocks());

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <QueryClientProvider client={client}>
        <BotAccess botId="b1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return host;
}

it("shows nothing while the broker is off for the bot, or the viewer is not its owner", async () => {
  rpcMock.capabilityGrants.list.mockResolvedValueOnce({
    mode: null,
    active: false,
    grants: [],
    grantable: ["calendar.read"],
  });
  expect((await render()).textContent).toBe("");
  rpcMock.capabilityGrants.list.mockRejectedValueOnce(new Error("Not found"));
  expect((await render()).textContent).toBe("");
});

it("lists what the bot may do with its expiry, revokes it, and adds a scope with the chosen expiry", async () => {
  const live = [
    grant({ expiresAt: "2030-01-05T00:00:00.000Z" }),
    grant({ id: "g2", scope: "mail.send", effect: "deny", createdVia: "admin" }),
  ];
  rpcMock.capabilityGrants.list.mockImplementation(async () => ({
    mode: "enforce",
    active: true,
    grants: live,
    grantable: ["calendar.read", "web.fetch"],
  }));
  rpcMock.capabilityGrants.revoke.mockResolvedValue({ ok: true });
  rpcMock.capabilityGrants.set.mockResolvedValue(grant());
  const host = await render();
  expect(host.textContent).toContain("Access");
  const rows = [...host.querySelectorAll('[data-testid="capability-grant"]')];
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("calendar.read"),
    expect.stringContaining("mail.send"),
  ]);
  expect(rows[0]?.textContent).toContain("2030");
  expect(rows[1]?.textContent).toContain("Deny");

  const options = [
    ...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Add access"] option'),
  ].map((option) => option.value);
  expect(options).toEqual(["", "web.fetch"]);

  const choose = async (label: string, value: string) =>
    act(async () => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        value,
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await choose("Expires", "7");
  await choose("Add access", "web.fetch");
  expect(rpcMock.capabilityGrants.set).toHaveBeenCalledWith({
    botId: "b1",
    scope: "web.fetch",
    effect: "allow",
    expiresAt: expect.any(String),
  });
  const expiresAt = rpcMock.capabilityGrants.set.mock.calls[0]?.[0].expiresAt as string;
  const days = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);

  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Revoke calendar.read"]')?.click(),
  );
  expect(rpcMock.capabilityGrants.revoke).toHaveBeenCalledWith({ id: "g1" });
});

it("is empty until something is granted and keeps an employee's inherited grants unrevokable", async () => {
  rpcMock.capabilityGrants.list.mockResolvedValue({
    mode: "shadow",
    active: true,
    grants: [grant({ inherited: true, kind: "bot" })],
    grantable: [],
  });
  const host = await render();
  expect(host.querySelector('button[aria-label^="Revoke"]')).toBeNull();
  expect(host.querySelector("select")).toBeNull();
});
