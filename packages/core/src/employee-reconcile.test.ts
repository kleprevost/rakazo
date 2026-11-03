import { describe, expect, it } from "vitest";
import { diffEntitlements, entitlementDiffIsEmpty } from "./employee-reconcile.js";

const row = (employeeId: string, source: "grant" | "claim", role: "viewer" | "manager") => ({
  employeeId,
  userId: "u1",
  source,
  role,
});

describe("diffEntitlements", () => {
  it("is empty when nothing changed", () => {
    const rows = [row("e1", "grant", "viewer")];
    expect(entitlementDiffIsEmpty(diffEntitlements(rows, rows))).toBe(true);
  });

  it("adds, updates and removes by key", () => {
    const diff = diffEntitlements(
      [row("e1", "grant", "viewer"), row("e1", "claim", "viewer")],
      [row("e1", "grant", "manager"), row("e2", "claim", "viewer")],
    );
    expect(diff.update).toEqual([row("e1", "grant", "manager")]);
    expect(diff.add).toEqual([row("e2", "claim", "viewer")]);
    expect(diff.remove).toEqual([{ employeeId: "e1", userId: "u1", source: "claim" }]);
  });

  it("removes everything when nothing is desired", () => {
    expect(diffEntitlements([row("e1", "claim", "viewer")], []).remove).toHaveLength(1);
  });
});
