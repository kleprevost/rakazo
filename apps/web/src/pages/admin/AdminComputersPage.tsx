import { Trans, useLingui } from "@lingui/react/macro";
import type { AdminComputer, AdminComputerDetail } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { AdminQuery, LoadMore } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { formatBytes, formatWhen } from "./format";

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
              <Trans>Health</Trans>
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

function useHealthLabel() {
  const { t } = useLingui();
  return (health: AdminComputer["health"]) =>
    ({
      ok: t`Healthy`,
      degraded: t`Degraded`,
      unreachable: t`Unreachable`,
      unknown: t`Unknown`,
    })[health];
}

function ComputerRow({ computer, locale }: { computer: AdminComputer; locale: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const healthLabel = useHealthLabel();
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
      <TableCell className="font-medium">
        <Button variant="link" className="h-auto p-0" onClick={() => setOpen(true)}>
          {names}
        </Button>
        {open ? (
          <ComputerDetailSheet
            computerId={computer.id}
            title={names ?? computer.id}
            locale={locale}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </TableCell>
      <TableCell>{computer.ownerEmail ?? computer.ownerName}</TableCell>
      <TableCell>{computer.kind}</TableCell>
      <TableCell>
        <Badge variant={computer.state === "running" ? "secondary" : "outline"}>{status}</Badge>
      </TableCell>
      <TableCell className="max-w-48 truncate text-muted-foreground">
        {reported(computer.image)}
      </TableCell>
      <TableCell className="text-muted-foreground">{reported(computer.isolation)}</TableCell>
      <TableCell>
        <Badge variant={computer.health === "ok" ? "secondary" : "outline"}>
          {healthLabel(computer.health)}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {computer.lastActivityAt ? formatWhen(computer.lastActivityAt, locale) : null}
      </TableCell>
    </TableRow>
  );
}

function ComputerDetailSheet({
  computerId,
  title,
  locale,
  onClose,
}: {
  computerId: string;
  title: string;
  locale: string;
  onClose: () => void;
}) {
  const detail = useQuery(
    useSpaceQueries().admin.computers.get.queryOptions({ input: { computerId } }),
  );
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-4 pb-4">
          <AdminQuery
            pending={detail.isPending}
            error={detail.error}
            onRetry={() => void detail.refetch()}
          >
            {detail.data ? <ComputerDetail detail={detail.data} locale={locale} /> : null}
          </AdminQuery>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ComputerDetail({ detail, locale }: { detail: AdminComputerDetail; locale: string }) {
  const { t } = useLingui();
  const healthLabel = useHealthLabel();
  const { observation } = detail;
  const egress = observation?.egress
    ? {
        open: t`Open`,
        restricted: t`Restricted`,
        isolated: t`Isolated`,
        unknown: t`Unknown`,
      }[observation.egress.mode]
    : null;
  const rows: Array<[string, string | null]> = [
    [t`Health`, healthLabel(detail.health)],
    [t`Image`, detail.imageDigest ?? detail.image],
    [t`Isolation`, detail.isolation],
    [t`Egress`, egress],
    [t`Restarts`, observation?.restartCount?.toString() ?? null],
    [t`CPU`, observation?.usage?.cpuMillis != null ? `${observation.usage.cpuMillis} m` : null],
    [
      t`Memory`,
      observation?.usage?.memoryBytes != null
        ? [
            formatBytes(observation.usage.memoryBytes, locale),
            observation.usage.memoryLimitBytes != null
              ? formatBytes(observation.usage.memoryLimitBytes, locale)
              : null,
          ]
            .filter(Boolean)
            .join(" / ")
        : null,
    ],
    [
      t`Disk`,
      detail.disk
        ? `${formatBytes(detail.disk.usedBytes, locale)} / ${formatBytes(
            detail.disk.usedBytes + detail.disk.freeBytes,
            locale,
          )}`
        : null,
    ],
    [t`Last active`, detail.lastActivityAt ? formatWhen(detail.lastActivityAt, locale) : null],
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="admin-computer-detail">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {rows
          .filter(([, value]) => value !== null)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
      </dl>
      {detail.runs.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground" data-testid="computer-runs">
          {detail.runs.map((run) => (
            <li key={run.startedAt}>
              {formatWhen(run.startedAt, locale)}
              {run.endReason ? ` · ${run.endReason}` : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
