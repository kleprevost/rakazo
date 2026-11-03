import { Trans, useLingui } from "@lingui/react/macro";
import type { AdminComputer } from "@rakazo/contracts";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query";
import { AdminQuery, LoadMore } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { formatWhen } from "./format";

const PAGE_SIZE = 50;

export function AdminComputersPage() {
  return (
    <AdminShell>
      <AdminComputers />
    </AdminShell>
  );
}

function AdminComputers() {
  const { i18n } = useLingui();
  const computers = useInfiniteQuery(
    useSpaceQueries().admin.computers.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const rows = computers.data?.pages.flatMap((page) => page.computers) ?? [];
  return (
    <AdminQuery
      pending={computers.isPending}
      error={computers.error}
      onRetry={() => void computers.refetch()}
      empty={rows.length === 0}
    >
      <Table data-testid="admin-computers">
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>AI employees</Trans>
            </TableHead>
            <TableHead>
              <Trans>Owner</Trans>
            </TableHead>
            <TableHead>
              <Trans>Provider</Trans>
            </TableHead>
            <TableHead>
              <Trans>Status</Trans>
            </TableHead>
            <TableHead>
              <Trans>Image</Trans>
            </TableHead>
            <TableHead>
              <Trans>Isolation</Trans>
            </TableHead>
            <TableHead>
              <Trans>Last active</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((computer) => (
            <ComputerRow key={computer.id} computer={computer} locale={i18n.locale} />
          ))}
        </TableBody>
      </Table>
      <LoadMore query={computers} />
    </AdminQuery>
  );
}

function ComputerRow({ computer, locale }: { computer: AdminComputer; locale: string }) {
  const { t } = useLingui();
  const names = computer.bots.map((bot) => bot.name).join(", ") || computer.spaceName;
  const status =
    {
      stopped: t`Stopped`,
      booting: t`Starting`,
      running: t`Running`,
      suspending: t`Stopping`,
      error: t`Error`,
      quarantined: t`Quarantined`,
    }[computer.state] ?? computer.state;
  const notReported =
    computer.inspection === "skipped_unsupported" || computer.inspection === "unavailable";
  const reported = (value: string | null) => value ?? (notReported ? t`Not reported` : null);
  return (
    <TableRow aria-label={names ?? computer.id}>
      <TableCell className="font-medium">{names}</TableCell>
      <TableCell>{computer.ownerEmail ?? computer.ownerName}</TableCell>
      <TableCell>{computer.kind}</TableCell>
      <TableCell>
        <Badge variant={computer.state === "running" ? "secondary" : "outline"}>{status}</Badge>
      </TableCell>
      <TableCell className="max-w-48 truncate text-muted-foreground">
        {reported(computer.image)}
      </TableCell>
      <TableCell className="text-muted-foreground">{reported(computer.isolation)}</TableCell>
      <TableCell className="text-muted-foreground">
        {computer.lastActivityAt ? formatWhen(computer.lastActivityAt, locale) : null}
      </TableCell>
    </TableRow>
  );
}
