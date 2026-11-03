import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma"> & {
  env: Pick<RouterDeps["env"], "adminEmails">;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin">;
};

/**
 * Accounts listed in RAKAZO_ADMIN_EMAILS, or whose SSO identity carries an OIDC_ADMIN_VALUES
 * value, once their email is verified.
 */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  const admins = deps.env.adminEmails ?? [];
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.emailVerified) return false;
  if (admins.includes(user.email.toLowerCase())) return true;
  return deps.auth.isSsoAdmin(userId);
}

export async function requireAdmin(deps: AdminDeps, userId: string): Promise<void> {
  if (!(await isAdmin(deps, userId))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}
