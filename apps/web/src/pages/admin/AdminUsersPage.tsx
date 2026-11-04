import { Trans, useLingui } from "@lingui/react/macro";
import type { AdminUser } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { AdminQuery, LoadMore } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { useAdminRoles } from "./admin-roles";
import { formatWhen } from "./format";

const PAGE_SIZE = 50;

export function AdminUsersPage() {
  return (
    <AdminShell>
      <AdminUsers />
    </AdminShell>
  );
}

function AdminUsers() {
  const { i18n } = useLingui();
  const users = useInfiniteQuery(
    useSpaceQueries().admin.users.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const rows = users.data?.pages.flatMap((page) => page.users) ?? [];
  return (
    <AdminQuery
      pending={users.isPending}
      error={users.error}
      onRetry={() => void users.refetch()}
      empty={rows.length === 0}
    >
      <Table data-testid="admin-users">
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Email</Trans>
            </TableHead>
            <TableHead>
              <Trans>Role</Trans>
            </TableHead>
            <TableHead>
              <Trans>Last sign-in</Trans>
            </TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((user) => (
            <UserRow key={user.id} user={user} locale={i18n.locale} />
          ))}
        </TableBody>
      </Table>
      <LoadMore query={users} />
    </AdminQuery>
  );
}

function UserRow({ user, locale }: { user: AdminUser; locale: string }) {
  const { t } = useLingui();
  const { can } = useAdminRoles();
  const [confirming, setConfirming] = useState(false);
  const [confirmingCredentials, setConfirmingCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  async function revokeCredentials() {
    setBusy(true);
    try {
      await rpc.admin.credentials.revoke({ userId: user.id });
      toast.success(t`Credentials revoked`);
    } catch (error) {
      toast.error(errorText(error, t`Could not revoke credentials`));
    } finally {
      setBusy(false);
      setConfirmingCredentials(false);
    }
  }
  async function endSessions() {
    setBusy(true);
    try {
      await rpc.admin.users.endSessions({ userId: user.id });
      toast.success(t`Sessions ended`);
    } catch (error) {
      toast.error(errorText(error, t`Could not end sessions`));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  return (
    <TableRow aria-label={user.email}>
      <TableCell className="min-w-0">
        <div className="truncate font-medium">{user.name}</div>
        <div className="truncate text-muted-foreground">{user.email}</div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {user.adminVia === "email" ? (
            <Badge variant="secondary">{t`Admin (email list)`}</Badge>
          ) : user.adminVia === "sso" ? (
            <Badge variant="secondary">{t`Admin (SSO)`}</Badge>
          ) : (
            <Badge variant="outline">{t`Member`}</Badge>
          )}
          {user.ssoLinked ? <Badge variant="outline">{t`SSO`}</Badge> : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {user.lastSignInAt ? formatWhen(user.lastSignInAt, locale) : null}
      </TableCell>
      <TableCell className="text-end">
        {user.isSelf || !can("security") ? null : (
          <div className="flex justify-end gap-1">
            <Button
              variant={confirming ? "destructive" : "ghost"}
              size="sm"
              disabled={busy}
              onClick={() => (confirming ? void endSessions() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
            >
              {confirming ? <Trans>Confirm</Trans> : <Trans>End sessions</Trans>}
            </Button>
            <Button
              variant={confirmingCredentials ? "destructive" : "ghost"}
              size="sm"
              disabled={busy}
              onClick={() =>
                confirmingCredentials ? void revokeCredentials() : setConfirmingCredentials(true)
              }
              onBlur={() => setConfirmingCredentials(false)}
            >
              {confirmingCredentials ? <Trans>Confirm</Trans> : <Trans>Revoke credentials</Trans>}
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
