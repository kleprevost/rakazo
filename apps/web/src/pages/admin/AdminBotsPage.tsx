import { Trans, useLingui } from "@lingui/react/macro";
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
import { formatUsd, formatWhen } from "./format";

const PAGE_SIZE = 50;

export function AdminBotsPage() {
  return (
    <AdminShell>
      <AdminBots />
    </AdminShell>
  );
}

function AdminBots() {
  const { t, i18n } = useLingui();
  const bots = useInfiniteQuery(
    useSpaceQueries().admin.bots.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const rows = bots.data?.pages.flatMap((page) => page.bots) ?? [];
  return (
    <AdminQuery
      pending={bots.isPending}
      error={bots.error}
      onRetry={() => void bots.refetch()}
      empty={rows.length === 0}
    >
      <Table data-testid="admin-bots">
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Name</Trans>
            </TableHead>
            <TableHead>
              <Trans>Owner</Trans>
            </TableHead>
            <TableHead>
              <Trans>Space</Trans>
            </TableHead>
            <TableHead>
              <Trans>Model</Trans>
            </TableHead>
            <TableHead>
              <Trans>Last active</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>This month</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((bot) => (
            <TableRow key={bot.id} aria-label={bot.name}>
              <TableCell className="font-medium">
                {bot.name}
                {bot.archived ? (
                  <Badge variant="outline" className="ms-2">
                    {t`Archived`}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{bot.ownerEmail ?? bot.ownerName}</TableCell>
              <TableCell>{bot.spaceName}</TableCell>
              <TableCell>{bot.model}</TableCell>
              <TableCell className="text-muted-foreground">
                {bot.lastActiveAt ? formatWhen(bot.lastActiveAt, i18n.locale) : null}
              </TableCell>
              <TableCell className="text-end">
                {formatUsd(bot.monthlySpendUsd, i18n.locale)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore query={bots} />
    </AdminQuery>
  );
}
