import type { Policy } from "@rakazo/contracts";

/**
 * The policy file as `section.rule` / value rows, in file order. Budgets are left out: they have
 * their own spend-against-limit display. Keys are the file's own names, so they are not translated.
 */
export function policyRows(policy: Policy): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  const walk = (prefix: string, node: unknown) => {
    if (Array.isArray(node)) rows.push({ key: prefix, value: node.join(", ") });
    else if (node && typeof node === "object")
      for (const [key, child] of Object.entries(node))
        walk(prefix ? `${prefix}.${key}` : key, child);
    else if (node !== undefined) rows.push({ key: prefix, value: String(node) });
  };
  for (const [section, value] of Object.entries(policy)) {
    if (section === "version" || section === "budgets") continue;
    walk(section, value);
  }
  return rows;
}
