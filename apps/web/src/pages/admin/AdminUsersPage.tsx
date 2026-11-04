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
            <UserRow
              key={user.id}
              user={user}
              locale={i18n.locale}
              onChanged={() => void users.refetch()}
            />
          ))}
        </TableBody>
      </Table>
      <LoadMore query={users} />
    </AdminQuery>
  );
}

function UserRow({
  user,
  locale,
  onChanged,
}: {
  user: AdminUser;
  locale: string;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const { can } = useAdminRoles();
  const [confirming, setConfirming] = useState<"end" | "credentials" | "deactivate" | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>, done?: string, failed?: string) {
    setBusy(true);
    try {
      await action();
      if (done) toast.success(done);
      onChanged();
    } catch (error) {
      toast.error(errorText(error, failed ?? t`Could not update account`));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }
  const confirmable = (
    kind: "end" | "credentials" | "deactivate",
    label: string,
    action: () => Promise<unknown>,
    done?: string,
    failed?: string,
  ) => (
    <Button
      variant={confirming === kind ? "destructive" : "ghost"}
      size="sm"
      disabled={busy}
      onClick={() => (confirming === kind ? void run(action, done, failed) : setConfirming(kind))}
      onBlur={() => setConfirming(null)}
    >
      {confirming === kind ? <Trans>Confirm</Trans> : label}
    </Button>
  );
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
          {user.deprovisionedAt ? <Badge variant="destructive">{t`Deactivated`}</Badge> : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {user.lastSignInAt ? formatWhen(user.lastSignInAt, locale) : null}
      </TableCell>
      <TableCell className="text-end">
        {user.isSelf || !can("security") ? null : user.deprovisionedAt ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => rpc.admin.users.reactivate({ userId: user.id }))}
          >
            <Trans>Reactivate</Trans>
          </Button>
        ) : (
          <>
            {confirmable(
              "end",
              t`End sessions`,
              () => rpc.admin.users.endSessions({ userId: user.id }),
              t`Sessions ended`,
              t`Could not end sessions`,
            )}
            {confirmable(
              "credentials",
              t`Revoke credentials`,
              () => rpc.admin.credentials.revoke({ userId: user.id }),
              t`Credentials revoked`,
              t`Could not revoke credentials`,
            )}
            {confirmable("deactivate", t`Deactivate`, () =>
              rpc.admin.users.deprovision({ userId: user.id }),
            )}
          </>
        )}
      </TableCell>
    </TableRow>
  );
}
