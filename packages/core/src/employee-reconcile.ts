import type { EmployeeEntitlementSource, EmployeeRole } from "@rakazo/contracts";

/**
 * The difference between the entitlement rows a person has and the rows their grants and claims
 * now give them. Pure, so the same diff serves one user, one employee, and the tests.
 */
export type EntitlementKey = {
  employeeId: string;
  userId: string;
  source: EmployeeEntitlementSource;
};
export type EntitlementRow = EntitlementKey & { role: EmployeeRole };

export type EntitlementDiff = {
  add: EntitlementRow[];
  update: EntitlementRow[];
  remove: EntitlementKey[];
};

const keyOf = (row: EntitlementKey) => `${row.employeeId}\u0000${row.userId}\u0000${row.source}`;

export function diffEntitlements(
  current: readonly EntitlementRow[],
  desired: readonly EntitlementRow[],
): EntitlementDiff {
  const have = new Map(current.map((row) => [keyOf(row), row]));
  const want = new Map(desired.map((row) => [keyOf(row), row]));
  const add: EntitlementRow[] = [];
  const update: EntitlementRow[] = [];
  for (const [key, row] of want) {
    const existing = have.get(key);
    if (!existing) add.push(row);
    else if (existing.role !== row.role) update.push(row);
  }
  const remove = [...have]
    .filter(([key]) => !want.has(key))
    .map(([, row]) => ({ employeeId: row.employeeId, userId: row.userId, source: row.source }));
  return { add, update, remove };
}

export function entitlementDiffIsEmpty(diff: EntitlementDiff): boolean {
  return diff.add.length === 0 && diff.update.length === 0 && diff.remove.length === 0;
}
