import { Trans, useLingui } from "@lingui/react/macro";
import type { EmployeeDirectoryEntry } from "@rakazo/contracts";
import { Button, buttonVariants } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

/** Listed AI employees and the person's own, each with the one action that fits their access. */
export function EmployeesPage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const directory = useQuery(queries.employees.directory.queryOptions());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const act = async (employeeId: string, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(employeeId);
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(errorText(cause, t`Could not complete action`));
    } finally {
      setBusyId(null);
    }
  };
  const add = (entry: EmployeeDirectoryEntry) =>
    act(entry.id, async () => {
      const { botId } = await rpc.employees.addInstance({ employeeId: entry.id });
      navigate(`/app/${encodeURIComponent(botId)}`);
    });
  const request = (entry: EmployeeDirectoryEntry) =>
    act(entry.id, async () => {
      await rpc.employees.requests.create({ employeeId: entry.id });
      await queryClient.invalidateQueries({ queryKey: queries.employees.directory.key() });
    });

  const entries = directory.data ?? [];
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="font-medium">
          <Trans>Employees</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {directory.data ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-4">
            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="employees-empty">
                <Trans>No employees yet</Trans>
              </p>
            ) : (
              <ul className="divide-y divide-border" data-testid="employees">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center gap-3 py-3"
                    data-testid={`employee-${entry.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="truncate text-[14px] font-medium">
                        {entry.name}
                      </p>
                      {entry.description ? (
                        <p dir="auto" className="line-clamp-2 text-[13px] text-muted-foreground">
                          {entry.description}
                        </p>
                      ) : null}
                      {entry.ownerName ? (
                        <p dir="auto" className="truncate text-[12px] text-muted-foreground">
                          {entry.ownerName}
                        </p>
                      ) : null}
                    </div>
                    {entry.canUse ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId !== null}
                        onClick={() => void add(entry)}
                      >
                        <Trans>Add</Trans>
                      </Button>
                    ) : entry.role === null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId !== null || entry.requested}
                        onClick={() => void request(entry)}
                      >
                        {entry.requested ? <Trans>Requested</Trans> : <Trans>Request access</Trans>}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : directory.error ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
            <p className="text-destructive">{errorText(directory.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void directory.refetch()}>
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
