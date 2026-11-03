import { Trans, useLingui } from "@lingui/react/macro";
import type { SecurityEventType } from "@rakazo/contracts";
import { SECURITY_EVENT_TYPES } from "@rakazo/contracts";
import {
  Input,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { AdminQuery, LoadMore } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { formatWhen } from "./format";

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export function AdminAuditPage() {
  return (
    <AdminShell>
      <AdminAudit />
    </AdminShell>
  );
}

/** A `YYYY-MM-DD` day as a UTC instant. The end filter is exclusive, so "to" means the day after. */
export function dayStart(day: string, afterDays = 0): string | undefined {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? undefined : new Date(at + afterDays * DAY_MS).toISOString();
}

function AdminAudit() {
  const { t, i18n } = useLingui();
  const [type, setType] = useState<SecurityEventType | "">("");
  const [typedUser, setTypedUser] = useState("");
  const [user, setUser] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const events = useInfiniteQuery(
    useSpaceQueries().admin.audit.infiniteOptions({
      input: (cursor: string | null) => ({
        limit: PAGE_SIZE,
        ...(type ? { type } : {}),
        ...(user ? { user } : {}),
        ...(dayStart(from) ? { from: dayStart(from) } : {}),
        ...(dayStart(to, 1) ? { to: dayStart(to, 1) } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const rows = events.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setUser(typedUser.trim());
        }}
      >
        <NativeSelect
          aria-label={t`Type`}
          value={type}
          onChange={(event) => setType(event.target.value as SecurityEventType | "")}
        >
          <NativeSelectOption value="">{t`All`}</NativeSelectOption>
          {SECURITY_EVENT_TYPES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input
          type="search"
          aria-label={t`User`}
          placeholder={t`Email`}
          className="w-56"
          maxLength={254}
          value={typedUser}
          onChange={(event) => setTypedUser(event.target.value)}
          onBlur={() => setUser(typedUser.trim())}
        />
        <Input
          type="date"
          aria-label={t`From`}
          className="w-40"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Input
          type="date"
          aria-label={t`To`}
          className="w-40"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </form>
      <AdminQuery
        pending={events.isPending}
        error={events.error}
        onRetry={() => void events.refetch()}
        empty={rows.length === 0}
      >
        <Table data-testid="admin-audit">
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>When</Trans>
              </TableHead>
              <TableHead>
                <Trans>Type</Trans>
              </TableHead>
              <TableHead>
                <Trans>User</Trans>
              </TableHead>
              <TableHead>
                <Trans>Details</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatWhen(event.createdAt, i18n.locale)}
                </TableCell>
                <TableCell className="font-mono text-xs">{event.type}</TableCell>
                <TableCell>{event.userEmail}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {[event.ip, ...Object.entries(event.metadata).map(([k, v]) => `${k}: ${v}`)]
                    .filter(Boolean)
                    .join(" · ")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <LoadMore query={events} />
      </AdminQuery>
    </>
  );
}
