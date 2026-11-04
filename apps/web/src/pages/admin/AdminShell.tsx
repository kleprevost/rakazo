import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, NavLink } from "react-router-dom";
import { PageLoading } from "../../components/PageLoading";
import { useSpaceQueries } from "../../lib/query";
import { WindowChrome } from "../WindowChrome";
import { useAdminRoles } from "./admin-roles";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `shrink-0 rounded-md px-3 py-1.5 text-sm ${
    isActive
      ? "bg-muted font-medium text-foreground"
      : "text-muted-foreground hover:text-foreground"
  }`;

/**
 * The frame of every admin page: admin-only (anyone else is sent back to the app; the API
 * enforces the same check), with the section's sub-navigation.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const me = useQuery(queries.me.queryOptions());
  const { roles, can } = useAdminRoles();
  const isAdmin = roles.length > 0;
  const overview = useQuery({ ...queries.admin.overview.queryOptions(), enabled: isAdmin });
  if (me.isPending) return <PageLoading />;
  if (!isAdmin) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Admin</Trans>
        </h1>
      </header>
      <nav aria-label={t`Admin`} className="flex gap-1 overflow-x-auto border-b px-4 py-2">
        <NavLink to="/admin" end className={linkClass}>
          <Trans>Overview</Trans>
        </NavLink>
        {can("security", "auditor") ? (
          <NavLink to="/admin/users" className={linkClass}>
            <Trans>Users</Trans>
          </NavLink>
        ) : null}
        {can("security", "auditor") ? (
          <NavLink to="/admin/bots" className={linkClass}>
            <Trans>AI employees</Trans>
          </NavLink>
        ) : null}
        {can("security", "auditor") && overview.data?.capabilityBroker ? (
          <NavLink to="/admin/capabilities" className={linkClass}>
            <Trans>Capabilities</Trans>
          </NavLink>
        ) : null}
        {can("fleet", "auditor") ? (
          <NavLink to="/admin/computers" className={linkClass}>
            <Trans>Computers</Trans>
          </NavLink>
        ) : null}
        {can("security", "fleet", "auditor") ? (
          <NavLink to="/admin/policy" className={linkClass}>
            <Trans>Policy</Trans>
          </NavLink>
        ) : null}
        {can("security", "auditor") ? (
          <NavLink to="/admin/audit" className={linkClass}>
            <Trans>Audit log</Trans>
          </NavLink>
        ) : null}
        {can() && overview.data?.modelCredits ? (
          <NavLink to="/admin/access" className={linkClass}>
            <Trans>Free access</Trans>
          </NavLink>
        ) : null}
        {can() ? (
          <NavLink to="/admin/plugins" className={linkClass}>
            <Trans>Plugin submissions</Trans>
          </NavLink>
        ) : null}
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">{children}</div>
      </main>
    </div>
  );
}
