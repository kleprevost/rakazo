import { Trans, useLingui } from "@lingui/react/macro";
import type { FleetOperation, FleetOperationDetail } from "@rakazo/contracts";
import {
  Badge,
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
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query";
import { AdminQuery } from "./AdminQuery";
import { formatWhen } from "./format";

const POLL_MS = 3_000;

export function useFleetLabels() {
  const { t } = useLingui();
  return {
    kind: (kind: FleetOperation["kind"]) => ({ hibernate: t`Hibernate`, wake: t`Wake` })[kind],
    operation: (status: FleetOperation["status"]) =>
      ({
        queued: t`Queued`,
        running: t`Running`,
        completed: t`Done`,
        completed_with_failures: t`Needs attention`,
      })[status],
    item: (status: FleetOperationDetail["items"][number]["status"]) =>
      ({
        queued: t`Queued`,
        running: t`Running`,
        succeeded: t`Done`,
        failed: t`Failed`,
        skipped_unsupported: t`Unsupported`,
        skipped_busy: t`Busy`,
        halted: t`Halted`,
        interrupted: t`Interrupted`,
      })[status],
  };
}

const total = (counts: FleetOperation["counts"]) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

/** Items that reached a final state, so the row reads as progress. */
const settled = (counts: FleetOperation["counts"]) =>
  total(counts) - (counts.queued ?? 0) - (counts.running ?? 0);

export function useFleetOperations() {
  return useQuery({
    ...useSpaceQueries().admin.computers.operations.list.queryOptions({ input: { limit: 20 } }),
    refetchInterval: (query: { state: { data?: { operations: FleetOperation[] } } }) =>
      query.state.data?.operations.some((operation) => operation.finishedAt === null)
        ? POLL_MS
        : false,
  });
}

export function FleetOperations({
  operations,
  locale,
  openId,
  onOpen,
}: {
  operations: FleetOperation[];
  locale: string;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const labels = useFleetLabels();
  if (operations.length === 0) return null;
  return (
    <>
      <Table data-testid="fleet-operations" className="mt-6">
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Operations</Trans>
            </TableHead>
            <TableHead>
              <Trans>Status</Trans>
            </TableHead>
            <TableHead />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {operations.map((operation) => (
            <TableRow
              key={operation.id}
              aria-label={labels.kind(operation.kind)}
              className="cursor-pointer"
              onClick={() => onOpen(operation.id)}
            >
              <TableCell className="font-medium">{labels.kind(operation.kind)}</TableCell>
              <TableCell>
                <Badge variant={operation.status === "completed" ? "secondary" : "outline"}>
                  {labels.operation(operation.status)}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {settled(operation.counts)}/{total(operation.counts)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatWhen(operation.createdAt, locale)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {openId ? (
        <OperationSheet operationId={openId} locale={locale} onClose={() => onOpen(null)} />
      ) : null}
    </>
  );
}

function OperationSheet({
  operationId,
  locale,
  onClose,
}: {
  operationId: string;
  locale: string;
  onClose: () => void;
}) {
  const labels = useFleetLabels();
  const detail = useQuery({
    ...useSpaceQueries().admin.computers.operations.get.queryOptions({ input: { operationId } }),
    refetchInterval: (query: { state: { data?: FleetOperationDetail } }) =>
      query.state.data && query.state.data.finishedAt === null ? POLL_MS : false,
  });
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{detail.data ? labels.kind(detail.data.kind) : null}</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-4 pb-4">
          <AdminQuery
            pending={detail.isPending}
            error={detail.error}
            onRetry={() => void detail.refetch()}
          >
            {detail.data ? (
              <Table data-testid="fleet-operation-items">
                <TableBody>
                  {detail.data.items.map((item) => (
                    <TableRow
                      key={item.computerId}
                      aria-label={item.bots.join(", ") || item.spaceName || item.computerId}
                    >
                      <TableCell className="font-medium">
                        {item.bots.join(", ") || item.spaceName || item.computerId}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.status === "succeeded" ? "secondary" : "outline"}>
                          {labels.item(item.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.finishedAt ? formatWhen(item.finishedAt, locale) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </AdminQuery>
        </div>
      </SheetContent>
    </Sheet>
  );
}
