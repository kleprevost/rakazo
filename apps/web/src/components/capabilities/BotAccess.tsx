import { Trans, useLingui } from "@lingui/react/macro";
import type { CapabilityGrantView } from "@rakazo/contracts";
import {
  Badge,
  Button,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/** The grants and mode of one bot, shared by the owner's Access section and the admin page. */
export function useBotGrants(botId: string) {
  return useQuery(useSpaceQueries().capabilityGrants.list.queryOptions({ input: { botId } }));
}

const DAY_MS = 24 * 60 * 60_000;

function expiry(days: string): string | undefined {
  return days ? new Date(Date.now() + Number(days) * DAY_MS).toISOString() : undefined;
}

/**
 * What the bot may do for you, with an expiry. Absent while the broker is off for this bot, and
 * for anyone who is not its owner; empty until the first scope is added.
 */
export function BotAccess({ botId }: { botId: string }) {
  const grants = useBotGrants(botId);
  if (!grants.data?.active) return null;
  return (
    <section data-testid="bot-access">
      <SectionHeading variant="label" className="mb-2">
        <Trans>Access</Trans>
      </SectionHeading>
      <div className="space-y-3 rounded-xl bg-muted/50 p-4">
        <GrantEditor botId={botId} onChanged={() => void grants.refetch()} />
      </div>
    </section>
  );
}

/** The live grants with Revoke, and a picker for the scopes the viewer may add. */
export function GrantEditor({
  botId,
  editable = true,
  onChanged,
}: {
  botId: string;
  editable?: boolean;
  onChanged?: () => void;
}) {
  const { t, i18n } = useLingui();
  const rpc = useSpaceRpc();
  const grants = useBotGrants(botId);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const data = grants.data;
  if (!data) return null;
  async function run(change: () => Promise<unknown>) {
    setBusy(true);
    try {
      await change();
      await grants.refetch();
      onChanged?.();
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setBusy(false);
    }
  }
  const taken = new Set(data.grants.map((grant) => `${grant.effect}:${grant.scope}`));
  const addable = data.grantable.filter((scope) => !taken.has(`allow:${scope}`));
  return (
    <div className="space-y-2">
      {data.grants.map((grant) => (
        <GrantRow
          key={grant.id}
          grant={grant}
          locale={i18n.locale}
          disabled={busy || !editable}
          onRevoke={() => void run(() => rpc.capabilityGrants.revoke({ id: grant.id }))}
        />
      ))}
      {editable && addable.length ? (
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label={t`Add access`}
            value=""
            disabled={busy}
            className="min-w-0 flex-1"
            onChange={(event) => {
              const scope = event.target.value;
              const expiresAt = expiry(days);
              if (scope)
                void run(() =>
                  rpc.capabilityGrants.set({
                    botId,
                    scope,
                    effect: "allow",
                    ...(expiresAt ? { expiresAt } : {}),
                  }),
                );
            }}
          >
            <NativeSelectOption value="">{t`Add access`}</NativeSelectOption>
            {addable.map((scope) => (
              <NativeSelectOption key={scope} value={scope}>
                {scope}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={t`Expires`}
            value={days}
            disabled={busy}
            onChange={(event) => setDays(event.target.value)}
          >
            <NativeSelectOption value="">{t`Never`}</NativeSelectOption>
            <NativeSelectOption value="1">{t`1 day`}</NativeSelectOption>
            <NativeSelectOption value="7">{t`7 days`}</NativeSelectOption>
            <NativeSelectOption value="30">{t`30 days`}</NativeSelectOption>
          </NativeSelect>
        </div>
      ) : null}
    </div>
  );
}

function GrantRow({
  grant,
  locale,
  disabled,
  onRevoke,
}: {
  grant: CapabilityGrantView;
  locale: string;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex min-h-9 items-center gap-2 text-sm" data-testid="capability-grant">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{grant.scope}</span>
      {grant.effect === "allow" ? null : (
        <Badge variant={grant.effect === "deny" ? "destructive" : "secondary"}>
          {grant.effect === "deny" ? t`Deny` : t`Ask`}
        </Badge>
      )}
      {grant.expiresAt ? (
        <span className="text-xs text-muted-foreground">
          {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
            new Date(grant.expiresAt),
          )}
        </span>
      ) : null}
      {grant.inherited ? null : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Revoke ${grant.scope}`}
          disabled={disabled}
          onClick={onRevoke}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
