// @vitest-environment jsdom

import type {
  EmployeeAccessRequest,
  EmployeeDetail,
  EmployeeGrant,
  EmployeeKnowledge,
  EmployeeKnowledgeProposal,
  EmployeeRole,
} from "@rakazo/contracts";
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
    requests: {
      list: vi.fn(async () => [] as EmployeeAccessRequest[]),
      decide: vi.fn(async () => ({ ok: true as const })),
    },
    knowledge: {
      list: vi.fn(async () => [] as EmployeeKnowledge[]),
      retire: vi.fn(async () => ({ ok: true as const })),
      proposals: {
        list: vi.fn(async () => [] as EmployeeKnowledgeProposal[]),
        decide: vi.fn(async () => ({ ok: true as const })),
      },
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

  describe("access requests", () => {
    const pendingRequest: EmployeeAccessRequest = {
      id: "req-1",
      requesterName: "Rae Request",
      requesterEmail: "rae@example.test",
      requestedRole: "collaborator",
      createdAt: "2026-11-01T00:00:00.000Z",
    };

    it("shows nothing when there are no requests", async () => {
      const api = makeApi("owner", ownerGrants);
      await render(api);
      expect(byLabel("Requests")).toBeUndefined();
    });

    it("lists requests and approves or denies them through the decide procedure", async () => {
      const api = makeApi("manager", ownerGrants);
      api.requests.list.mockResolvedValue([pendingRequest]);
      await render(api);
      expect(byLabel("Requests")?.textContent).toContain("Rae Request");
      await click(byLabel("Approve Rae Request"));
      expect(api.requests.decide).toHaveBeenCalledWith({
        employeeId: "emp-1",
        requestId: "req-1",
        decision: "approve",
      });
      await click(byLabel("Deny Rae Request"));
      expect(api.requests.decide).toHaveBeenLastCalledWith({
        employeeId: "emp-1",
        requestId: "req-1",
        decision: "deny",
      });
    });

    it("keeps the access list when the inbox cannot be read", async () => {
      const api = makeApi("owner", ownerGrants);
      api.requests.list.mockRejectedValue(new Error("boom"));
      await render(api);
      expect(byLabel("Access")?.textContent).toContain("Ola Owner");
      expect(byLabel("Requests")).toBeUndefined();
    });

    it("does not ask for requests when the person cannot manage access", async () => {
      const api = makeApi("collaborator", ownerGrants);
      await render(api);
      expect(api.requests.list).not.toHaveBeenCalled();
    });
  });

  describe("team knowledge", () => {
    const proposal: EmployeeKnowledgeProposal = {
      id: "prop-1",
      path: "refunds.md",
      content: "Refund in 14 days.",
      currentContent: null,
      stale: false,
      createdAt: "2026-11-01T00:00:00.000Z",
    };

    it("shows nothing when there is no knowledge or proposal", async () => {
      await render(makeApi("owner", ownerGrants));
      expect(byLabel("Team knowledge")).toBeUndefined();
    });

    it("shows the submitted text and approves or rejects it", async () => {
      const api = makeApi("manager", ownerGrants);
      api.knowledge.proposals.list.mockResolvedValue([proposal]);
      await render(api);
      expect(byLabel("Team knowledge")?.textContent).toContain("Refund in 14 days.");
      await click(byLabel("Approve refunds.md"));
      expect(api.knowledge.proposals.decide).toHaveBeenCalledWith({
        employeeId: "emp-1",
        proposalId: "prop-1",
        decision: "approve",
      });
      await click(byLabel("Reject refunds.md"));
      expect(api.knowledge.proposals.decide).toHaveBeenLastCalledWith({
        employeeId: "emp-1",
        proposalId: "prop-1",
        decision: "reject",
      });
    });

    it("does not offer to approve text that is out of date", async () => {
      const api = makeApi("manager", ownerGrants);
      api.knowledge.proposals.list.mockResolvedValue([{ ...proposal, stale: true }]);
      await render(api);
      expect((byLabel("Approve refunds.md") as HTMLButtonElement).disabled).toBe(true);
    });

    it("retires approved knowledge", async () => {
      const api = makeApi("owner", ownerGrants);
      api.knowledge.list.mockResolvedValue([
        { path: "policy.md", content: "x", revision: 2, updatedAt: "2026-11-01T00:00:00.000Z" },
      ]);
      await render(api);
      await click(byLabel("Retire policy.md"));
      expect(api.knowledge.retire).toHaveBeenCalledWith({ employeeId: "emp-1", path: "policy.md" });
    });

    it("does not read knowledge for someone who cannot manage access", async () => {
      const api = makeApi("collaborator", ownerGrants);
      await render(api);
      expect(api.knowledge.list).not.toHaveBeenCalled();
      expect(api.knowledge.proposals.list).not.toHaveBeenCalled();
    });
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
    await type(byLabel("Add people or groups") as HTMLInputElement, "bob");
    expect(api.people.search).toHaveBeenCalledWith({ employeeId: "emp-1", q: "bob" });
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
