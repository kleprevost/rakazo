import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AdminComputer, AdminComputerDetail, FleetOperation } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  NativeSelect,
  NativeSelectOption,
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
  toast,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import {
  FleetOperations,
  shortDigest,
  useFleetLabels,
  useFleetOperations,
} from "./AdminFleetOperations";
import { AdminQuery, LoadMore } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { useAdminRoles } from "./admin-roles";
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
  const { i18n, t } = useLingui();
  const labels = useFleetLabels();
  const canRun = useAdminRoles().can("fleet");
  const [notApproved, setNotApproved] = useState(false);
  const [quarantinedOnly, setQuarantinedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openOperation, setOpenOperation] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [confirmQuarantine, setConfirmQuarantine] = useState(false);
  const [image, setImage] = useState("");
  const operations = useFleetOperations();
  // The approved images come from the policy, read only once there is something to recreate.
  const policy = useQuery({
    ...useSpaceQueries().admin.policy.queryOptions(),
    enabled: selected.size > 0,
  });
  const approved = policy.data?.policy?.computers?.images?.allow ?? [];
  const computers = useInfiniteQuery(
    useSpaceQueries().admin.computers.list.infiniteOptions({
      input: (cursor: string | null) => ({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(notApproved ? { imageCompliance: "not_approved" as const } : {}),
        ...(quarantinedOnly ? { quarantined: true as const } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const rows = computers.data?.pages.flatMap((page) => page.computers) ?? [];
  // Only a policy that lists approved images gives a computer a standing to filter on.
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function start(kind: FleetOperation["kind"]) {
    setStarting(true);
    try {
      const created = await rpc.admin.computers.operations.create({
        kind,
        computerIds: [...selected],
        ...(kind === "recreate" && image ? { imageDigest: image } : {}),
      });
      setSelected(new Set());
      setOpenOperation(created.id);
      await operations.refetch();
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setStarting(false);
    }
  }
  // Release is offered once a selected computer is quarantined; the filter once any is.
  const canRelease = rows.some((computer) => selected.has(computer.id) && computer.quarantinedAt);
  async function contain(kind: "quarantine" | "release") {
    setStarting(true);
    try {
      const input = { computerIds: [...selected] };
      let stopping: string | null = null;
      if (kind === "quarantine")
        stopping = (await rpc.admin.computers.quarantine(input)).operationId;
      else await rpc.admin.computers.release(input);
      setSelected(new Set());
      if (stopping) setOpenOperation(stopping);
      await Promise.all([computers.refetch(), operations.refetch()]);
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setStarting(false);
    }
  }
  const governed = notApproved || rows.some((computer) => Boolean(computer.imageCompliance));
  return (
    <>
      {governed ? (
        <Button
          variant={notApproved ? "secondary" : "outline"}
          size="sm"
          aria-pressed={notApproved}
          className="mb-3"
          onClick={() => setNotApproved(!notApproved)}
        >
          <Trans>Not approved</Trans>
        </Button>
      ) : null}
      {quarantinedOnly || rows.some((computer) => computer.quarantinedAt) ? (
        <Button
          variant={quarantinedOnly ? "secondary" : "outline"}
          size="sm"
          aria-pressed={quarantinedOnly}
          className="mb-3 mr-2"
          onClick={() => setQuarantinedOnly(!quarantinedOnly)}
        >
          <Trans>Quarantined</Trans>
        </Button>
      ) : null}
      {selected.size > 0 ? (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-muted-foreground tabular-nums">{selected.size}</span>
          {(["hibernate", "wake", "recreate"] as const).map((kind) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              disabled={starting}
              onClick={() => void start(kind)}
            >
              {labels.kind(kind)}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={starting}
            onClick={() => setConfirmTerminate(true)}
          >
            {labels.kind("terminate")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={starting}
            onClick={() => setConfirmQuarantine(true)}
          >
            <Trans>Quarantine</Trans>
          </Button>
          {canRelease ? (
            <Button
              variant="outline"
              size="sm"
              disabled={starting}
              onClick={() => void contain("release")}
            >
              <Trans>Release</Trans>
            </Button>
          ) : null}
          {approved.length > 0 ? (
            <NativeSelect
              aria-label={t`Image`}
              size="sm"
              value={image}
              onChange={(event) => setImage(event.target.value)}
            >
              <NativeSelectOption value="">{t`Default`}</NativeSelectOption>
              {approved.map((entry) => (
                <NativeSelectOption key={entry.digest} value={entry.digest}>
                  {entry.tag ?? shortDigest(entry.digest)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={confirmTerminate} onOpenChange={setConfirmTerminate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Plural
                value={selected.size}
                one="Terminate # computer?"
                other="Terminate # computers?"
              />
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={starting}
              onClick={() => {
                setConfirmTerminate(false);
                void start("terminate");
              }}
            >
              {labels.kind("terminate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmQuarantine} onOpenChange={setConfirmQuarantine}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Plural
                value={selected.size}
                one="Quarantine # computer?"
                other="Quarantine # computers?"
              />
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={starting}
              onClick={() => {
                setConfirmQuarantine(false);
                void contain("quarantine");
              }}
            >
              <Trans>Quarantine</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AdminQuery
        pending={computers.isPending}
        error={computers.error}
        onRetry={() => void computers.refetch()}
        empty={rows.length === 0}
      >
        <Table data-testid="admin-computers">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                {canRun ? (
                  <Checkbox
                    aria-label={t`Select all`}
                    checked={rows.length > 0 && rows.every((computer) => selected.has(computer.id))}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked ? new Set(rows.map((computer) => computer.id)) : new Set(),
                      )
                    }
                  />
                ) : null}
              </TableHead>
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
              <ComputerRow
                key={computer.id}
                computer={computer}
                locale={i18n.locale}
                selected={canRun ? selected.has(computer.id) : null}
                onToggle={() => toggle(computer.id)}
              />
            ))}
          </TableBody>
        </Table>
        <LoadMore query={computers} />
      </AdminQuery>
      <FleetOperations
        operations={operations.data?.operations ?? []}
        locale={i18n.locale}
        openId={openOperation}
        onOpen={setOpenOperation}
      />
    </>
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

function ComputerRow({
  computer,
  locale,
  selected,
  onToggle,
}: {
  computer: AdminComputer;
  locale: string;
  /** Null when the viewer cannot run fleet operations. */
  selected: boolean | null;
  onToggle: () => void;
}) {
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
      suspended: t`Hibernated`,
      error: t`Error`,
      quarantined: t`Quarantined`,
    }[computer.state] ?? computer.state;
  const notReported =
    computer.inspection === "skipped_unsupported" || computer.inspection === "unavailable";
  const reported = (value: string | null) => value ?? (notReported ? t`Not reported` : null);
  return (
    <TableRow aria-label={names ?? computer.id}>
      <TableCell>
        {selected === null ? null : (
          <Checkbox
            aria-label={names ?? computer.id}
            checked={selected}
            onCheckedChange={onToggle}
          />
        )}
      </TableCell>
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
        {computer.quarantinedAt ? (
          <Badge variant="destructive" className="ml-2">
            {t`Quarantined`}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="max-w-48 truncate text-muted-foreground">
        {reported(computer.image)}
        {computer.imageCompliance === "not_approved" ? (
          <Badge variant="outline" className="ml-2">
            {t`Not approved`}
          </Badge>
        ) : null}
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
