import { Trans, useLingui } from "@lingui/react/macro";
import type { AdminPolicyView } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSpaceQueries } from "../../lib/query";
import { AdminQuery } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { formatUsd, formatWhen } from "./format";
import { policyRows } from "./policy-rows";

export function AdminPolicyPage() {
  return (
    <AdminShell>
      <AdminPolicy />
    </AdminShell>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Spend({
  label,
  spentUsd,
  limitUsd,
  locale,
}: {
  label: string;
  spentUsd: number;
  limitUsd: number | null;
  locale: string;
}) {
  const over = limitUsd !== null && spentUsd >= limitUsd;
  return (
    <li className="space-y-1.5 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">{label}</span>
        <span className={over ? "text-destructive" : "text-muted-foreground"}>
          {formatUsd(spentUsd, locale)}
          {limitUsd !== null ? ` / ${formatUsd(limitUsd, locale)}` : ""}
        </span>
      </div>
      {limitUsd !== null ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <meter
            className="sr-only"
            aria-label={label}
            min={0}
            max={limitUsd}
            value={Math.min(spentUsd, limitUsd)}
          />
          <div
            aria-hidden="true"
            className={`h-full ${over ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${Math.min(100, (spentUsd / limitUsd) * 100)}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}

function AdminPolicy() {
  const policy = useQuery(useSpaceQueries().admin.policy.queryOptions());
  return (
    <AdminQuery
      pending={policy.isPending}
      error={policy.error}
      onRetry={() => void policy.refetch()}
    >
      {policy.data ? <PolicyView view={policy.data} /> : null}
    </AdminQuery>
  );
}

function PolicyView({ view }: { view: AdminPolicyView }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  const rows = view.policy ? policyRows(view.policy) : [];
  const { limits, spend } = view;
  return (
    <>
      <Section title={<Trans>Policy</Trans>}>
        {view.loaded ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              <Trans>Version {view.version}</Trans>
              {view.hash ? <code className="ms-2 text-xs">{view.hash.slice(0, 12)}</code> : null}
            </p>
            {rows.length > 0 ? (
              <dl
                data-testid="admin-policy-rules"
                className="divide-y divide-border rounded-xl border border-border"
              >
                {rows.map((row) => (
                  <div key={row.key} className="flex gap-4 px-4 py-2 text-sm">
                    <dt className="w-64 shrink-0 truncate font-mono text-xs text-muted-foreground">
                      {row.key}
                    </dt>
                    <dd className="min-w-0 flex-1 break-words">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>Not loaded</Trans>
          </p>
        )}
      </Section>
      <Section title={<Trans>This month</Trans>}>
        <ul
          data-testid="admin-spend"
          className="divide-y divide-border rounded-xl border border-border"
        >
          <Spend
            label={t`Organization`}
            spentUsd={spend.organizationUsd}
            limitUsd={limits.organizationUsd}
            locale={locale}
          />
          {spend.users.map((row) => (
            <Spend
              key={`user-${row.id}`}
              label={row.label}
              spentUsd={row.spentUsd}
              limitUsd={limits.perUserUsd}
              locale={locale}
            />
          ))}
          {spend.bots.map((row) => (
            <Spend
              key={`bot-${row.id}`}
              label={row.label}
              spentUsd={row.spentUsd}
              limitUsd={limits.perBotUsd}
              locale={locale}
            />
          ))}
        </ul>
      </Section>
      <Section title={<Trans>Recent denials</Trans>}>
        {view.denied.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Nothing to show.</Trans>
          </p>
        ) : (
          <ul
            data-testid="admin-denied"
            className="divide-y divide-border rounded-xl border border-border"
          >
            {view.denied.map((event) => (
              <li key={event.id} className="flex flex-wrap gap-x-4 px-4 py-2 text-sm">
                <span className="text-muted-foreground">{formatWhen(event.createdAt, locale)}</span>
                <span className="font-mono text-xs">{event.rule}</span>
                <span>{event.subject}</span>
                <span className="text-muted-foreground">{event.userEmail}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
