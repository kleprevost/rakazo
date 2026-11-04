import { Trans, useLingui } from "@lingui/react/macro";
import type { AdminBot, AdminQuarantine } from "@rakazo/contracts";
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
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
  const { i18n } = useLingui();
  const bots = useInfiniteQuery(
    useSpaceQueries().admin.bots.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const quarantines = useQuery(useSpaceQueries().admin.quarantine.list.queryOptions());
  const rows = bots.data?.pages.flatMap((page) => page.bots) ?? [];
  const changed = () => {
    void bots.refetch();
    void quarantines.refetch();
  };
  return (
    <AdminQuery
      pending={bots.isPending}
      error={bots.error}
      onRetry={() => void bots.refetch()}
      empty={rows.length === 0}
    >
      <Quarantines items={quarantines.data?.quarantines ?? []} onChanged={changed} />
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
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((bot) => (
            <BotRow key={bot.id} bot={bot} locale={i18n.locale} onChanged={changed} />
          ))}
        </TableBody>
      </Table>
      <LoadMore query={bots} />
    </AdminQuery>
  );
}

/** The quarantines in force, each with Release, and the control that quarantines every bot. */
function Quarantines({ items, onChanged }: { items: AdminQuarantine[]; onChanged: () => void }) {
  const { t } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(change: () => Promise<unknown>) {
    setBusy(true);
    try {
      await change();
      onChanged();
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="admin-quarantines">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-3 text-sm">
          <Badge variant="destructive">{t`Quarantined`}</Badge>
          <span className="font-medium">
            {item.scopeKind === "all" ? t`All` : (item.scopeName ?? item.scopeId)}
          </span>
          <span className="text-muted-foreground">{item.reason}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            disabled={busy}
            onClick={() => void run(() => rpc.admin.quarantine.lift({ id: item.id }))}
          >
            <Trans>Release</Trans>
          </Button>
        </div>
      ))}
      {items.some((item) => item.scopeKind === "all") ? null : (
        <Button
          variant={confirming ? "destructive" : "outline"}
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={() =>
            confirming
              ? void run(() => rpc.admin.quarantine.start({ scopeKind: "all" }))
              : setConfirming(true)
          }
          onBlur={() => setConfirming(false)}
        >
          {confirming ? <Trans>Confirm</Trans> : <Trans>Quarantine all</Trans>}
        </Button>
      )}
    </div>
  );
}

function BotRow({
  bot,
  locale,
  onChanged,
}: {
  bot: AdminBot;
  locale: string;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingQuarantine, setConfirmingQuarantine] = useState(false);
  async function quarantine() {
    setBusy(true);
    try {
      await rpc.admin.quarantine.start({ scopeKind: "bot", scopeId: bot.id });
      onChanged();
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setBusy(false);
      setConfirmingQuarantine(false);
    }
  }
  async function toggle() {
    setBusy(true);
    try {
      if (bot.suspendedAt) await rpc.admin.bots.resume({ botId: bot.id });
      else await rpc.admin.bots.suspend({ botId: bot.id });
      onChanged();
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  return (
    <TableRow aria-label={bot.name}>
      <TableCell className="font-medium">
        {bot.name}
        {bot.archived ? (
          <Badge variant="outline" className="ms-2">
            {t`Archived`}
          </Badge>
        ) : null}
        {bot.suspendedAt ? (
          <Badge variant="secondary" className="ms-2">
            {t`Suspended`}
          </Badge>
        ) : null}
        {bot.quarantinedAt ? (
          <Badge variant="destructive" className="ms-2">
            {t`Quarantined`}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>{bot.ownerEmail ?? bot.ownerName}</TableCell>
      <TableCell>{bot.spaceName}</TableCell>
      <TableCell>{bot.model}</TableCell>
      <TableCell className="text-muted-foreground">
        {bot.lastActiveAt ? formatWhen(bot.lastActiveAt, locale) : null}
      </TableCell>
      <TableCell className="text-end">{formatUsd(bot.monthlySpendUsd, locale)}</TableCell>
      <TableCell className="text-end">
        <Button
          variant={confirming ? "destructive" : "ghost"}
          size="sm"
          disabled={busy}
          onClick={() => (bot.suspendedAt || confirming ? void toggle() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          {bot.suspendedAt ? (
            <Trans>Resume</Trans>
          ) : confirming ? (
            <Trans>Confirm</Trans>
          ) : (
            <Trans>Suspend</Trans>
          )}
        </Button>
        {bot.quarantinedAt ? null : (
          <Button
            variant={confirmingQuarantine ? "destructive" : "ghost"}
            size="sm"
            disabled={busy}
            onClick={() =>
              confirmingQuarantine ? void quarantine() : setConfirmingQuarantine(true)
            }
            onBlur={() => setConfirmingQuarantine(false)}
          >
            {confirmingQuarantine ? <Trans>Confirm</Trans> : <Trans>Quarantine</Trans>}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
