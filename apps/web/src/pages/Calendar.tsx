import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CalendarOutcome,
  CalendarRange,
  CalendarRoutine,
  CalendarRun,
} from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import {
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SectionHeading,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

const REFRESH_MS = 60_000;
type Mode = "day" | "week";

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
/** Calendar-day arithmetic in local time, so a daylight-saving change never shifts a day. */
const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const mondayOf = (date: Date) => addDays(date, -((date.getDay() + 6) % 7));
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function chatPath({ botId, groupId }: CalendarRoutine) {
  return groupId ? `/app/g/${encodeURIComponent(groupId)}` : `/app/${encodeURIComponent(botId)}`;
}

type Item = {
  key: string;
  at: Date;
  routine: CalendarRoutine;
  run: CalendarRun | null;
};

export function CalendarPage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const start = mode === "week" ? mondayOf(anchor) : anchor;
  const days = mode === "week" ? 7 : 1;
  const input = { from: start.toISOString(), to: addDays(start, days).toISOString() };
  const range = useQuery(
    queries.calendar.range.queryOptions({
      input,
      refetchInterval: (query) =>
        query.state.error && !isRetryableError(query.state.error) ? false : REFRESH_MS,
      refetchOnWindowFocus: true,
    }),
  );
  const step = (direction: 1 | -1) => setAnchor(addDays(anchor, direction * days));
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="mr-auto font-medium">
          <Trans>Calendar</Trans>
        </h1>
        <ToggleGroup
          aria-label={t`Calendar`}
          value={[mode]}
          onValueChange={([next]) => {
            if (next) setMode(next as Mode);
          }}
          spacing={1}
          className="rounded-lg bg-muted p-1"
        >
          <ToggleGroupItem
            value="day"
            className="h-7 px-3 text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>Day</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="week"
            className="h-7 px-3 text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>Week</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
          <Trans>Today</Trans>
        </Button>
        <Button variant="ghost" size="icon" aria-label={t`Previous`} onClick={() => step(-1)}>
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t`Next`} onClick={() => step(1)}>
          <ChevronRight />
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {range.data ? (
          <CalendarView range={range.data} start={start} days={days} />
        ) : range.error ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
            <p className="text-destructive">{errorText(range.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void range.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : (
          <PageLoading />
        )}
      </main>
    </div>
  );
}

export function CalendarView({
  range,
  start,
  days,
}: {
  range: CalendarRange;
  start: Date;
  days: number;
}) {
  const routines = useMemo(
    () => new Map([...range.routines, ...range.unscheduled].map((r) => [r.routineId, r])),
    [range],
  );
  const [actionError, setActionError] = useState("");
  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    const add = (item: Item) => {
      const key = dayKey(item.at);
      map.set(key, [...(map.get(key) ?? []), item]);
    };
    for (const run of range.past) {
      const routine = routines.get(run.routineId);
      if (routine) add({ key: run.runId, at: new Date(run.at), routine, run });
    }
    for (const occurrence of range.upcoming) {
      const routine = routines.get(occurrence.routineId);
      if (routine)
        add({
          key: `${occurrence.routineId}:${occurrence.at}`,
          at: new Date(occurrence.at),
          routine,
          run: null,
        });
    }
    for (const items of map.values()) items.sort((a, b) => a.at.getTime() - b.at.getTime());
    return map;
  }, [range, routines]);

  if (!range.routines.length && !range.unscheduled.length) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="calendar-empty">
        <Trans>Nothing scheduled</Trans>
      </p>
    );
  }
  const dates = Array.from({ length: days }, (_, index) => addDays(start, index));
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4" data-testid="calendar">
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      <div className={days > 1 ? "grid gap-4 md:grid-cols-7" : "grid gap-4"}>
        {dates.map((date) => (
          <section key={dayKey(date)} className="min-w-0">
            <SectionHeading as="h2" className="mb-1">
              {date.toLocaleDateString(i18n.locale || "en", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </SectionHeading>
            <ul className="divide-y divide-border">
              {(byDay.get(dayKey(date)) ?? []).map((item) => (
                <ItemRow key={item.key} item={item} onError={setActionError} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {range.unscheduled.length ? (
        <section>
          <SectionHeading as="h2" className="mb-1">
            <Trans>Event-triggered</Trans>
          </SectionHeading>
          <ul className="divide-y divide-border">
            {range.unscheduled.map((routine) => (
              <li key={routine.routineId} className="flex items-center gap-2 py-2 text-sm">
                <Link to={chatPath(routine)} className="min-w-0 flex-1 truncate hover:underline">
                  <span className="font-medium">{routine.botName}</span>{" "}
                  <span className="text-muted-foreground">{routine.name}</span>
                </Link>
                <RoutineActions routine={routine} onError={setActionError} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function OutcomeLabel({ outcome }: { outcome: CalendarOutcome }) {
  switch (outcome) {
    case "success":
      return <Trans>Done</Trans>;
    case "failed":
      return <Trans>Failed</Trans>;
    case "skipped":
      return <Trans>Skipped</Trans>;
    case "running":
      return <Trans>Running</Trans>;
  }
}

function ItemRow({ item, onError }: { item: Item; onError: (message: string) => void }) {
  const { routine, run } = item;
  const base = chatPath(routine);
  const to = run?.messageId ? `${base}?m=${encodeURIComponent(run.messageId)}` : base;
  return (
    <li
      className={`flex items-center gap-2 py-2 text-sm ${run ? "" : "text-muted-foreground"}`}
      data-testid={run ? "calendar-past" : "calendar-upcoming"}
    >
      <Link to={to} className="min-w-0 flex-1 hover:underline">
        <time dateTime={item.at.toISOString()} className="block text-xs text-muted-foreground">
          {item.at.toLocaleTimeString(i18n.locale || "en", { hour: "numeric", minute: "2-digit" })}
          {run ? (
            <span className={run.outcome === "failed" ? "text-destructive" : undefined}>
              {" · "}
              <OutcomeLabel outcome={run.outcome} />
            </span>
          ) : null}
        </time>
        <span className="block truncate">
          <span className="font-medium">{routine.botName}</span> {routine.name}
        </span>
      </Link>
      <RoutineActions routine={routine} onError={onError} />
    </li>
  );
}

function RoutineActions({
  routine,
  onError,
}: {
  routine: CalendarRoutine;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError("");
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: queries.calendar.range.key() });
    } catch (cause) {
      onError(errorText(cause, t`Could not complete action`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Actions`}
        disabled={busy}
        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuItem
          onClick={() =>
            void act(() =>
              rpc.routines.update({ routineId: routine.routineId, active: !routine.active }),
            )
          }
        >
          {routine.active ? <Trans>Pause</Trans> : <Trans>Resume</Trans>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void act(() => rpc.routines.testRun({ routineId: routine.routineId }))}
        >
          <Trans>Run now</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigate(`${chatPath(routine)}?routine=${routine.routineId}`)}
        >
          <Trans>Edit</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
