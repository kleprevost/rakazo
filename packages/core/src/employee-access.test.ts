import type { EmployeeAction, EmployeeRole } from "@rakazo/contracts";
import { EMPLOYEE_ACTIONS, EMPLOYEE_ROLES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { EmployeeGrantInput } from "./employee-access.js";
import {
  effectiveEmployeeRole,
  evaluateEmployeeAccess,
  evaluateGrantChange,
  resolveEmployeeEntitlements,
} from "./employee-access.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const PAST = new Date("2026-11-01T00:00:00Z");
const FUTURE = new Date("2026-12-01T00:00:00Z");

// Roles that may do each action. Anything not listed is denied.
const ALLOWED: Record<EmployeeAction, EmployeeRole[]> = {
  view_card: ["viewer", "collaborator", "manager", "owner"],
  use: ["collaborator", "manager", "owner"],
  propose_knowledge: ["collaborator", "manager", "owner"],
  edit: ["manager", "owner"],
  publish: ["manager", "owner"],
  approve_knowledge: ["manager", "owner"],
  configure_credentials: ["manager", "owner"],
  manage_grants: ["manager", "owner"],
  authorize_shared_credential: ["owner"],
  delete: ["owner"],
  read_instance_content: [],
};

describe("evaluateEmployeeAccess", () => {
  for (const action of EMPLOYEE_ACTIONS) {
    for (const role of EMPLOYEE_ROLES) {
      const allowed = ALLOWED[action].includes(role);
      it(`${role} ${allowed ? "may" : "may not"} ${action}`, () => {
        expect(evaluateEmployeeAccess({ role, action }).allowed).toBe(allowed);
      });
    }
    it(`denies ${action} without an entitlement`, () => {
      expect(evaluateEmployeeAccess({ role: null, action }).allowed).toBe(false);
    });
  }

  it("never lets any role read an instance's private content", () => {
    for (const role of [...EMPLOYEE_ROLES, null]) {
      expect(evaluateEmployeeAccess({ role, action: "read_instance_content" })).toEqual({
        allowed: false,
        reason: "private_content",
      });
    }
  });

  it("lets a Viewer see the card but not run the employee", () => {
    expect(evaluateEmployeeAccess({ role: "viewer", action: "view_card" }).allowed).toBe(true);
    expect(evaluateEmployeeAccess({ role: "viewer", action: "use" })).toEqual({
      allowed: false,
      reason: "insufficient_role",
    });
  });

  it("blocks running while suspended or retired, not for other actions", () => {
    const suspended = { status: "published", suspendedAt: NOW } as const;
    expect(evaluateEmployeeAccess({ role: "owner", action: "use", employee: suspended })).toEqual({
      allowed: false,
      reason: "suspended",
    });
    expect(
      evaluateEmployeeAccess({
        role: "owner",
        action: "use",
        employee: { status: "retired" },
      }),
    ).toEqual({ allowed: false, reason: "retired" });
    expect(
      evaluateEmployeeAccess({ role: "manager", action: "manage_grants", employee: suspended })
        .allowed,
    ).toBe(true);
  });

  describe("shared credentials", () => {
    it("lets a Manager configure but not authorize a shared credential", () => {
      expect(
        evaluateEmployeeAccess({ role: "manager", action: "configure_credentials" }).allowed,
      ).toBe(true);
      expect(
        evaluateEmployeeAccess({
          role: "manager",
          action: "authorize_shared_credential",
          userId: "m",
        }),
      ).toEqual({ allowed: false, reason: "not_credential_approver" });
    });

    it("lets a listed approver authorize, whatever their Manager or Collaborator role", () => {
      for (const role of ["collaborator", "manager"] as const) {
        expect(
          evaluateEmployeeAccess({
            role,
            action: "authorize_shared_credential",
            userId: "approver",
            credentialApproverUserIds: ["approver"],
          }).allowed,
        ).toBe(true);
      }
    });

    it("does not let a listed Viewer or an unentitled person authorize", () => {
      const listed = { userId: "v", credentialApproverUserIds: ["v"] };
      expect(
        evaluateEmployeeAccess({ role: "viewer", action: "authorize_shared_credential", ...listed })
          .allowed,
      ).toBe(false);
      expect(
        evaluateEmployeeAccess({ role: null, action: "authorize_shared_credential", ...listed })
          .allowed,
      ).toBe(false);
    });

    it("does not let an unlisted person authorize", () => {
      expect(
        evaluateEmployeeAccess({
          role: "manager",
          action: "authorize_shared_credential",
          userId: "other",
          credentialApproverUserIds: ["approver"],
        }).allowed,
      ).toBe(false);
    });
  });
});

describe("resolveEmployeeEntitlements", () => {
  const identity = { userId: "u1", claimValues: ["g-eng", "g-ops"] };
  const grant = (g: Partial<EmployeeGrantInput> & Pick<EmployeeGrantInput, "role">) =>
    ({ subjectKind: "user", subjectValue: "u1", ...g }) satisfies EmployeeGrantInput;

  it("gives nothing without a matching grant", () => {
    const grants = [
      grant({ role: "owner", subjectValue: "someone-else" }),
      grant({ role: "manager", subjectKind: "claim", subjectValue: "g-sales" }),
    ];
    expect(resolveEmployeeEntitlements(identity, grants, NOW)).toEqual([]);
  });

  it("resolves explicit and claim sources and takes the highest overall", () => {
    const rows = resolveEmployeeEntitlements(
      identity,
      [
        grant({ role: "viewer" }),
        grant({ role: "manager", subjectKind: "claim", subjectValue: "g-eng" }),
        grant({ role: "collaborator", subjectKind: "claim", subjectValue: "g-ops" }),
      ],
      NOW,
    );
    expect(rows).toEqual([
      { role: "viewer", source: "grant" },
      { role: "manager", source: "claim" },
    ]);
    expect(effectiveEmployeeRole(rows)).toBe("manager");
  });

  it("never lets a claim confer Owner", () => {
    const rows = resolveEmployeeEntitlements(
      identity,
      [grant({ role: "owner", subjectKind: "claim", subjectValue: "g-eng" })],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("ignores expired grants and keeps unexpired ones", () => {
    expect(
      resolveEmployeeEntitlements(identity, [grant({ role: "owner", expiresAt: PAST })], NOW),
    ).toEqual([]);
    expect(
      resolveEmployeeEntitlements(identity, [grant({ role: "owner", expiresAt: NOW })], NOW),
    ).toEqual([]);
    expect(
      resolveEmployeeEntitlements(identity, [grant({ role: "owner", expiresAt: FUTURE })], NOW),
    ).toEqual([{ role: "owner", source: "grant" }]);
  });

  it("fails closed on claim grants when the directory truncated the claim", () => {
    const grants = [
      grant({ role: "collaborator", subjectKind: "claim", subjectValue: "g-eng" }),
      grant({ role: "viewer" }),
    ];
    expect(
      resolveEmployeeEntitlements({ ...identity, claimsTruncated: true }, grants, NOW),
    ).toEqual([{ role: "viewer", source: "grant" }]);
  });

  it("removes access when the claim value is gone", () => {
    const grants = [grant({ role: "collaborator", subjectKind: "claim", subjectValue: "g-eng" })];
    expect(resolveEmployeeEntitlements({ userId: "u1", claimValues: [] }, grants, NOW)).toEqual([]);
  });

  it("has no effective role without entitlements", () => {
    expect(effectiveEmployeeRole([])).toBeNull();
  });
});

describe("evaluateGrantChange", () => {
  const base = { subjectKind: "user", ownerCount: 2 } as const;

  it("lets an Owner change any role", () => {
    for (const to of EMPLOYEE_ROLES) {
      expect(evaluateGrantChange({ ...base, actorRole: "owner", from: null, to }).allowed).toBe(
        true,
      );
    }
  });

  it("limits a Manager to Collaborator and Viewer grants", () => {
    expect(
      evaluateGrantChange({ ...base, actorRole: "manager", from: null, to: "collaborator" })
        .allowed,
    ).toBe(true);
    expect(
      evaluateGrantChange({ ...base, actorRole: "manager", from: "viewer", to: null }).allowed,
    ).toBe(true);
    for (const [from, to] of [
      [null, "manager"],
      [null, "owner"],
      ["manager", "viewer"],
      ["owner", null],
    ] as const) {
      expect(evaluateGrantChange({ ...base, actorRole: "manager", from, to })).toEqual({
        allowed: false,
        reason: "insufficient_role",
      });
    }
  });

  it("refuses Collaborators, Viewers and strangers", () => {
    for (const actorRole of ["collaborator", "viewer", null] as const) {
      expect(evaluateGrantChange({ ...base, actorRole, from: null, to: "viewer" }).allowed).toBe(
        false,
      );
    }
  });

  it("refuses a claim grant of Owner", () => {
    expect(
      evaluateGrantChange({
        ...base,
        subjectKind: "claim",
        actorRole: "owner",
        from: null,
        to: "owner",
      }),
    ).toEqual({ allowed: false, reason: "claim_cannot_be_owner" });
  });

  it("keeps the last Owner, by removal or demotion", () => {
    for (const to of [null, "manager"] as const) {
      expect(
        evaluateGrantChange({ ...base, ownerCount: 1, actorRole: "owner", from: "owner", to }),
      ).toEqual({ allowed: false, reason: "last_owner" });
    }
    expect(
      evaluateGrantChange({ ...base, ownerCount: 2, actorRole: "owner", from: "owner", to: null })
        .allowed,
    ).toBe(true);
  });
});
