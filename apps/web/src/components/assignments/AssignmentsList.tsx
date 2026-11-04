import { Trans } from "@lingui/react/macro";
import type { Assignment } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { assignmentPath } from "../../lib/assignment-path";
import { useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { useWorkPhaseLabels } from "../../lib/work-phase";

const PAGE_SIZE = 20;

/** Whether an employee has any assignment, so its list shows up only once there is one. */
export function useHasAssignments(botId: string): boolean {
  const queries = useSpaceQueries();
  const first = useInfiniteQuery(
    queries.assignments.list.infiniteOptions({
      input: (cursor: string | null) => ({
        botId,
        state: "active" as const,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: () => undefined,
    }),
  );
  return (first.data?.pages[0]?.items.length ?? 0) > 0;
}

/** An employee's assignments, newest activity first; each row opens its own conversation. */
export function AssignmentsList({ botId }: { botId: string }) {
  const queries = useSpaceQueries();
  const phases = useWorkPhaseLabels();
  const list = useInfiniteQuery(
    queries.assignments.list.infiniteOptions({
      input: (cursor: string | null) => ({
        botId,
        state: "active" as const,
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
      {list.hasNextPage ? (
        <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()}>
          <Trans>Show more</Trans>
        </Button>
      ) : null}
    </div>
  );
}
