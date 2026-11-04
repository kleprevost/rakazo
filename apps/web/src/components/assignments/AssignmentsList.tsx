import { Trans } from "@lingui/react/macro";
import type { Assignment } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { assignmentPath } from "../../lib/assignment-path";
import { useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { useWorkPhaseLabels } from "../../lib/work-phase";

const PAGE_SIZE = 20;

type State = "active" | "archived";

/** Whether an employee has an assignment in this state, so a list shows up only once there is one. */
function useHasAssignments(botId: string, state: State): boolean {
  const queries = useSpaceQueries();
  const first = useInfiniteQuery(
    queries.assignments.list.infiniteOptions({
      input: (cursor: string | null) => ({
        botId,
        state,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: () => undefined,
    }),
  );
  return (first.data?.pages[0]?.items.length ?? 0) > 0;
}

/** Whether the Assignments tab is worth showing: the employee has an active or archived job. */
export function useAnyAssignments(botId: string): boolean {
  const active = useHasAssignments(botId, "active");
  const archived = useHasAssignments(botId, "archived");
  return active || archived;
}

/** An employee's assignments, newest activity first; each row opens its own conversation. */
export function AssignmentsList({ botId }: { botId: string }) {
  const queries = useSpaceQueries();
  const phases = useWorkPhaseLabels();
  const [state, setState] = useState<State>("active");
  const hasArchived = useHasAssignments(botId, "archived");
  const list = useInfiniteQuery(
    queries.assignments.list.infiniteOptions({
      input: (cursor: string | null) => ({
        botId,
        state,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const items: Assignment[] = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div data-testid="assignments-list" className="space-y-1">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to={assignmentPath(item.id)}
              className="flex items-baseline gap-2 py-2 text-sm hover:underline"
            >
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{phases[item.phase]}</span>
              <time dateTime={item.updatedAt} className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTime(item.updatedAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
      {state === "archived" ? (
        <Button variant="ghost" size="sm" onClick={() => setState("active")}>
          <Trans>Active</Trans>
        </Button>
      ) : hasArchived ? (
        <Button variant="ghost" size="sm" onClick={() => setState("archived")}>
          <Trans>Archived</Trans>
        </Button>
      ) : null}
      {list.hasNextPage ? (
        <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()}>
          <Trans>Show more</Trans>
        </Button>
      ) : null}
    </div>
  );
}
