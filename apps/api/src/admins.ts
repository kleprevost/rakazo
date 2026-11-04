import { ORPCError } from "@orpc/server";
import type { AdminRole } from "@rakazo/contracts";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma"> & {
  env: Pick<
    RouterDeps["env"],
    "adminEmails" | "ssoAdminEnabled" | "operatorEmails" | "ssoOperatorRolesEnabled"
  >;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin"> &
    Partial<Pick<RouterDeps["auth"], "ssoOperatorRoles">>;
};

const OPERATOR_ROLES = ["security", "fleet", "auditor"] as const;

/**
 * The operator roles an account holds, in order. Config only: `platform` is today's admin
 * (RAKAZO_ADMIN_EMAILS or an OIDC_ADMIN_VALUES claim); the others come from RAKAZO_<ROLE>_EMAILS
 * or OIDC_<ROLE>_VALUES. Every role needs a verified email.
 */
export async function adminRoles(deps: AdminDeps, userId: string): Promise<AdminRole[]> {
  const emails = deps.env.operatorEmails;
  const listed = (deps.env.adminEmails?.length ?? 0) > 0;
  const operators = OPERATOR_ROLES.some((role) => (emails?.[role]?.length ?? 0) > 0);
  const sso = deps.env.ssoAdminEnabled || deps.env.ssoOperatorRolesEnabled;
  if (!listed && !operators && !sso) return [];
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.emailVerified) return [];
  const email = user.email.toLowerCase();
  const roles: AdminRole[] = [];
  if (
    deps.env.adminEmails?.includes(email) ||
    (deps.env.ssoAdminEnabled && (await deps.auth.isSsoAdmin(userId)))
  )
    roles.push("platform");
  const viaSso = deps.env.ssoOperatorRolesEnabled
    ? ((await deps.auth.ssoOperatorRoles?.(userId)) ?? [])
    : [];
  for (const role of OPERATOR_ROLES)
    if (emails?.[role]?.includes(email) || viaSso.includes(role)) roles.push(role);
  return roles;
}

/** Whether the account is a platform admin: today's admin, who may do everything. */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  return (await adminRoles(deps, userId)).includes("platform");
}

/** Whether the account holds `platform` or any of the given roles. */
export async function hasAdminRole(
  deps: AdminDeps,
  userId: string,
  role: AdminRole | readonly AdminRole[],
): Promise<boolean> {
  const allowed: readonly AdminRole[] = ["platform", ...(Array.isArray(role) ? role : [role])];
  return (await adminRoles(deps, userId)).some((r) => allowed.includes(r));
}

/**
 * Allows the account when it holds `platform` or any of the given roles; otherwise FORBIDDEN.
 * The per-procedure mapping is in docs/enterprise/features/admin-roles.md.
 */
export async function requireAdminRole(
  deps: AdminDeps,
  userId: string,
  role: AdminRole | readonly AdminRole[],
): Promise<void> {
  if (!(await hasAdminRole(deps, userId, role)))
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}

/** Any operator role: the Admin section and its overview. */
export async function requireAnyAdminRole(deps: AdminDeps, userId: string): Promise<void> {
  await requireAdminRole(deps, userId, [...OPERATOR_ROLES]);
}
