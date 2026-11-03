import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type { TodayArtifact, TodayAttention, TodayRun, TodaySummary } from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import { Button, buttonVariants, SectionHeading } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Shimmer } from "../components/ai/primitives";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

/** Live updates: the summary refreshes while the page is open, and stops after a refused read. */
const REFRESH_MS = 10_000;

type Chat = { botId: string; groupId: string | null };
const chatPath = ({ botId, groupId }: Chat) => (groupId ? `/app/g/${groupId}` : `/app/${botId}`);
const chatTarget = ({ botId, groupId }: Chat) => (groupId ? { groupId } : { botId });

export function TodayPage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const summary = useQuery(
    queries.today.summary.queryOptions({
      refetchInterval: (query) =>
        query.state.error && !isRetryableError(query.state.error) ? false : REFRESH_MS,
      refetchOnWindowFocus: true,
    }),
  );
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="font-medium">
          <Trans>Today</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {summary.data ? (
          <TodayView summary={summary.data} />
        ) : summary.error ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
            <p className="text-destructive">{errorText(summary.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
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

export function TodayView({ summary }: { summary: TodaySummary }) {
  const { attention, active, completed, upcoming } = summary;
  if (!attention.length && !active.length && !completed.length && !upcoming.length) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="today-empty">
        <Trans>Nothing today</Trans>
      </p>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4" data-testid="today">
      {attention.length ? (
        <Section title={<Trans>Needs attention</Trans>} count={summary.counts.attention}>
          {attention.map((item) => (
            <AttentionRow key={item.key} item={item} />
          ))}
        </Section>
      ) : null}
      {active.length ? (
        <Section title={<Trans>Working</Trans>} count={active.length}>
          {active.map((run) => (
            <RunRow key={run.runId} run={run} />
          ))}
        </Section>
      ) : null}
      {completed.length ? (
        <Section title={<Trans>Done</Trans>} count={summary.counts.completed}>
          {completed.map((run) => (
            <RunRow key={run.runId} run={run} />
          ))}
        </Section>
      ) : null}
      {upcoming.length ? (
        <Section title={<Trans>Coming up</Trans>} count={upcoming.length}>
          {upcoming.map((item) => (
            <li key={item.routineId} className="flex items-baseline gap-2 py-2 text-sm">
              <Link to={chatPath(item)} className="min-w-0 flex-1 truncate hover:underline">
                <span className="font-medium">{item.botName}</span>{" "}
                <span className="text-muted-foreground">{item.name}</span>
              </Link>
              <time dateTime={item.nextRunAt} className="shrink-0 text-xs text-muted-foreground">
                {new Date(item.nextRunAt).toLocaleString(i18n.locale || "en", {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </li>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <SectionHeading as="h2" className="mb-1">
        {title} <span className="font-normal text-muted-foreground">{count}</span>
      </SectionHeading>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

function RunRow({ run }: { run: TodayRun }) {
  const running = run.status === "running" || run.status === "queued" || run.status === "leased";
  return (
    <li className="py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <Link to={chatPath(run)} className="min-w-0 flex-1 truncate hover:underline">
          <span className="font-medium">{run.botName}</span>{" "}
          <span className="text-muted-foreground">{run.title}</span>
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground">
          {running ? (
            <Shimmer>
              <Trans>Running</Trans>
            </Shimmer>
          ) : (
            formatRelativeTime(run.at)
          )}
        </span>
      </div>
      {run.artifacts.length ? (
        <ul className="mt-1 flex flex-wrap gap-2">
          {run.artifacts.map((artifact) => (
            <ArtifactLink key={artifact.id} artifact={artifact} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ArtifactLink({ artifact }: { artifact: TodayArtifact }) {
  return (
    <li>
      <Link
        to={`/app/artifacts/${artifact.id}`}
        className="inline-block max-w-56 truncate rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
      >
        {artifact.name}
      </Link>
    </li>
  );
}

function AttentionRow({ item }: { item: TodayAttention }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: queries.today.summary.key() });
    } catch (cause) {
      setError(errorText(cause, t`Could not complete action`));
    } finally {
      setBusy(false);
    }
  };
  const detail =
    item.kind === "approval" || item.kind === "question" ? item.text : (item.error ?? item.title);
  return (
    <li className="py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <Link to={chatPath(item)} className="min-w-0 flex-1 hover:underline">
          <span className="font-medium">{item.botName}</span>{" "}
          <span className={item.kind.startsWith("failed") ? "text-destructive" : undefined}>
            {detail}
          </span>
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(item.at)}
        </span>
      </div>
      {item.kind === "approval" ? (
        <div className="mt-1.5 flex gap-2">
          {item.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.id === "deny" ? "outline" : "default"}
              disabled={busy}
              onClick={() =>
                void act(() =>
                  rpc.threads.answer({
                    ...chatTarget(item),
                    runId: item.runId,
                    messageId: item.messageId,
                    answer: action.id,
                  }),
                )
              }
            >
              {action.id === "deny" ? <Trans>Deny</Trans> : <Trans>Allow</Trans>}
            </Button>
          ))}
        </div>
      ) : null}
      {item.kind === "failed_routine" ? (
        <div className="mt-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(() =>
                rpc.routines.testRun({
                  routineId: item.routineId,
                  clientNonce: `today-retry:${item.runId}`,
                }),
              )
            }
          >
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
