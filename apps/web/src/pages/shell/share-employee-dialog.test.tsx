// @vitest-environment jsdom

import type { EmployeeDetail, EmployeeGrant, EmployeeRole } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import type { EmployeesApi } from "./share-employee-dialog";
import { ShareEmployeeDialog } from "./share-employee-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const grant = (
  subjectKind: "user" | "claim",
  subjectValue: string,
  role: EmployeeRole,
  subjectLabel?: string,
): EmployeeGrant => ({
  subjectKind,
  subjectValue,
  role,
  grantedBy: "u-owner",
  expiresAt: null,
  subjectLabel,
});

function detail(role: EmployeeRole, versions: EmployeeDetail["versions"] = null): EmployeeDetail {
  return {
    employee: {
      id: "emp-1",
      name: "Ada",
      description: "",
      status: "published",
      listing: "unlisted",
      role,
      currentVersion: 1,
      suspended: false,
    },
    versions,
  };
}

function version(id: string, number: number, state: "draft" | "published", current = false) {
  return {
    id,
    number,
    state,
    role: "",
    instructions: "",
    skills: [],
    capabilityPolicy: {},
    modelPolicy: {},
    publishedAt: null,
    current,
  };
}

function makeApi(
  role: EmployeeRole,
  grants: EmployeeGrant[],
  versions: EmployeeDetail["versions"] = null,
) {
  const api = {
    get: vi.fn(async () => detail(role, versions)),
    share: vi.fn(async () => ({ employeeId: "emp-1" })),
    people: {
      search: vi.fn(async () => [{ userId: "u-bob", name: "Bob Lee", email: "bob@example.test" }]),
    },
    grants: {
      list: vi.fn(async () => grants),
      set: vi.fn(async () => grants[0]!),
      remove: vi.fn(async () => ({ ok: true as const })),
    },
    versions: {
      publish: vi.fn(async () => detail(role).employee),
      rollback: vi.fn(async () => detail(role).employee),
    },
  };
  return api;
}

async function render(api: ReturnType<typeof makeApi>, employeeId: string | null = "emp-1") {
  await act(async () => {
    root.render(
      <ShareEmployeeDialog
        bot={{ id: "bot-1", name: "Ada", employeeId }}
        api={api as unknown as EmployeesApi}
        onCancel={() => undefined}
        onShared={() => undefined}
      />,
    );
  });
}

const byLabel = (label: string) =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined;

async function click(element: Element | undefined) {
  if (!element) throw new Error("Missing element");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLElement | undefined, value: string) {
  if (!select) throw new Error("Missing select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.includes(text));
const options = (select: HTMLElement | undefined) =>
  [...(select?.querySelectorAll("option") ?? [])].map((option) => option.value);

const ownerGrants = [
  grant("user", "u-owner", "owner", "Ola Owner"),
  grant("user", "u-man", "manager", "Mia Manager"),
  grant("claim", "sales", "collaborator"),
];

describe("ShareEmployeeDialog", () => {
  it("shows a spinner while loading", async () => {
    const api = makeApi("owner", ownerGrants);
    api.get.mockImplementation(() => new Promise(() => undefined));
    await render(api);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("shows the server error when loading fails", async () => {
    const api = makeApi("owner", ownerGrants);
    api.get.mockRejectedValue(new Error("Employee not found"));
    await render(api);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Employee not found");
  });

  it("lets an owner see everyone and set any role", async () => {
    const api = makeApi("owner", ownerGrants);
    await render(api);
    const list = byLabel("Access");
    expect(list?.textContent).toContain("Ola Owner");
    expect(list?.textContent).toContain("sales");
    expect(options(byLabel("Role for Mia Manager"))).toEqual([
      "viewer",
      "collaborator",
      "manager",
      "owner",
    ]);
    // A directory group cannot be an Owner, so the choice is not offered.
    expect(options(byLabel("Role for sales"))).toEqual(["viewer", "collaborator", "manager"]);
  });

  it("changes a role and removes a grant through the grant procedures", async () => {
    const api = makeApi("owner", ownerGrants);
    await render(api);
    await choose(byLabel("Role for Mia Manager"), "viewer");
    expect(api.grants.set).toHaveBeenCalledWith({
      employeeId: "emp-1",
      subjectKind: "user",
      subjectValue: "u-man",
      role: "viewer",
    });
    await click(byLabel("Remove sales"));
    expect(api.grants.remove).toHaveBeenCalledWith({
      employeeId: "emp-1",
      subjectKind: "claim",
      subjectValue: "sales",
    });
    expect(api.grants.list).toHaveBeenCalledTimes(3);
  });

  it("adds a person found by search with the chosen role", async () => {
    const api = makeApi("owner", ownerGrants);
    await render(api);
    await choose(byLabel("Role"), "viewer");
    await type(byLabel("Add people or groups") as HTMLInputElement, "bo");
    expect(api.people.search).toHaveBeenCalledWith({ employeeId: "emp-1", q: "bo" });
    await click(button("Bob Lee"));
    expect(api.grants.set).toHaveBeenCalledWith({
      employeeId: "emp-1",
      subjectKind: "user",
      subjectValue: "u-bob",
      role: "viewer",
    });
  });

  it("adds a directory group by its value", async () => {
    const api = makeApi("owner", ownerGrants);
    await render(api);
    await type(byLabel("Add people or groups") as HTMLInputElement, "finance-team");
    await click(button("Group finance-team"));
    expect(api.grants.set).toHaveBeenCalledWith({
      employeeId: "emp-1",
      subjectKind: "claim",
      subjectValue: "finance-team",
      role: "collaborator",
    });
  });

  it("shows the server's refusal when the last owner is changed", async () => {
    const api = makeApi("owner", ownerGrants);
    api.grants.set.mockRejectedValue(new Error("An employee needs at least one Owner"));
    await render(api);
    await choose(byLabel("Role for Ola Owner"), "viewer");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "An employee needs at least one Owner",
    );
  });

  it("gives a manager only the roles it may grant and leaves owners alone", async () => {
    const api = makeApi("manager", ownerGrants);
    await render(api);
    expect(byLabel("Role for Ola Owner")).toBeUndefined();
    expect(byLabel("Remove Ola Owner")).toBeUndefined();
    expect(byLabel("Role for Mia Manager")).toBeUndefined();
    expect(options(byLabel("Role for sales"))).toEqual(["viewer", "collaborator"]);
    expect(options(byLabel("Role"))).toEqual(["viewer", "collaborator"]);
  });

  it("does not ask a collaborator for grants", async () => {
    const api = makeApi("collaborator", ownerGrants);
    await render(api);
    expect(api.grants.list).not.toHaveBeenCalled();
    expect(byLabel("Add people or groups")).toBeUndefined();
    expect(document.body.textContent).toContain("Only managers can change access");
  });

  it("publishes a draft and rolls back to an earlier version", async () => {
    const api = makeApi("owner", ownerGrants, [
      version("v3", 3, "draft"),
      version("v2", 2, "published", true),
      version("v1", 1, "published"),
    ]);
    await render(api);
    await click(button("Publish"));
    expect(api.versions.publish).toHaveBeenCalledWith({ employeeId: "emp-1", versionId: "v3" });
    await click(button("Roll back"));
    expect(api.versions.rollback).toHaveBeenCalledWith({ employeeId: "emp-1", versionId: "v1" });
  });

  it("shares a private bot in place before managing access", async () => {
    const api = makeApi("owner", ownerGrants);
    await render(api, null);
    expect(api.get).not.toHaveBeenCalled();
    await click(button("Share"));
    expect(api.share).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(api.get).toHaveBeenCalledWith({ employeeId: "emp-1" });
    expect(byLabel("Access")).toBeDefined();
  });
});
