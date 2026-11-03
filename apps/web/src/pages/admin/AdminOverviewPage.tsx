import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSpaceQueries } from "../../lib/query";
import { AdminQuery } from "./AdminQuery";
import { AdminShell } from "./AdminShell";

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 text-sm">
      <dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

export function AdminOverviewPage() {
  return (
    <AdminShell>
      <AdminOverview />
    </AdminShell>
  );
}

function AdminOverview() {
  const { t } = useLingui();
  const overview = useQuery(useSpaceQueries().admin.overview.queryOptions());
  const data = overview.data;
  return (
    <AdminQuery
      pending={overview.isPending}
      error={overview.error}
      onRetry={() => void overview.refetch()}
    >
      {data ? (
        <dl
          data-testid="admin-overview"
          className="divide-y divide-border rounded-xl border border-border"
        >
          <Row label={<Trans>Sign-in</Trans>}>
            {data.auth.password ? <Badge variant="secondary">{t`Password`}</Badge> : null}
            {data.auth.sso ? <Badge variant="secondary">{t`SSO`}</Badge> : null}
            {data.auth.easyAuth ? <Badge variant="secondary">{t`Easy Auth`}</Badge> : null}
          </Row>
          <Row label={<Trans>Default model</Trans>}>{data.defaultModel}</Row>
          <Row label={<Trans>Computers</Trans>}>{data.computerProvider}</Row>
          <Row label={<Trans>Policy</Trans>}>
            {data.policy.loaded ? (
              <>
                <Trans>Version {data.policy.version}</Trans>
                <code className="text-xs text-muted-foreground">
                  {data.policy.hash?.slice(0, 12)}
                </code>
              </>
            ) : (
              <span className="text-muted-foreground">
                <Trans>Not loaded</Trans>
              </span>
            )}
          </Row>
          <Row label={<Trans>Users</Trans>}>{data.userCount}</Row>
          <Row label={<Trans>AI employees</Trans>}>{data.botCount}</Row>
        </dl>
      ) : null}
    </AdminQuery>
  );
}
