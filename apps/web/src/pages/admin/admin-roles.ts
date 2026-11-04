import type { AdminRole } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query";

/** The viewer's operator roles. The server enforces them; this only shows what will work. */
export function useAdminRoles() {
  const me = useQuery(useSpaceQueries().me.queryOptions()).data;
  const roles: AdminRole[] = me?.adminRoles?.length
    ? me.adminRoles
    : me?.isAdmin
      ? ["platform"]
      : [];
  return {
    roles,
    /** Whether the viewer holds one of the roles (`platform` holds all). */
    can: (...allowed: AdminRole[]) =>
      roles.includes("platform") || allowed.some((role) => roles.includes(role)),
  };
}
