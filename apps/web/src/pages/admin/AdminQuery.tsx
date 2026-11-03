import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Spinner } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { errorText } from "../../lib/user-error";

/** The four states every admin page shares: loading, failed (with retry), empty, or its content. */
export function AdminQuery({
  pending,
  error,
  onRetry,
  empty = false,
  children,
}: {
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  empty?: boolean;
  children: ReactNode;
}) {
  const { t } = useLingui();
  if (pending)
    return (
      <div className="grid place-items-center py-10">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  if (error)
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
        {errorText(error, t`Couldn't load this page`)}
        <Button variant="outline" size="sm" onClick={onRetry}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  if (empty)
    return (
      <p className="py-6 text-sm text-muted-foreground">
        <Trans>Nothing to show.</Trans>
      </p>
    );
  return <>{children}</>;
}

/** The button under a paginated list; absent on the last page. */
export function LoadMore({
  query,
}: {
  query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="flex justify-center pt-2">
      <Button
        variant="outline"
        size="sm"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        <Trans>Load more</Trans>
      </Button>
    </div>
  );
}
