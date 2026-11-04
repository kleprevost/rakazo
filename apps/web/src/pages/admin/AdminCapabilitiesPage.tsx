import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AdminCapabilityBot, CapabilityMode } from "@rakazo/contracts";
import {
  Badge,
  Button,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { GrantEditor, useBotGrants } from "../../components/capabilities/BotAccess";
import { CapabilitySimulator } from "../../components/capabilities/CapabilitySimulator";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { AdminQuery, LoadMore } from "./AdminQuery";
import { AdminShell } from "./AdminShell";
import { useAdminRoles } from "./admin-roles";

const PAGE_SIZE = 50;

export function AdminCapabilitiesPage() {
  return (
    <AdminShell>
      <AdminCapabilities />
    </AdminShell>
  );
}

function AdminCapabilities() {
  const bots = useInfiniteQuery(
    useSpaceQueries().admin.capabilities.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const [open, setOpen] = useState<string | null>(null);
  const rows = bots.data?.pages.flatMap((page) => page.bots) ?? [];
  return (
    <AdminQuery
      pending={bots.isPending}
      error={bots.error}
      onRetry={() => void bots.refetch()}
      empty={rows.length === 0}
    >
      <Table data-testid="admin-capabilities">
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Name</Trans>
            </TableHead>
            <TableHead>
              <Trans>Owner</Trans>
            </TableHead>
            <TableHead>
              <Trans>Mode</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>Grants</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>Would deny</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              open={open === bot.id}
              onToggle={() => setOpen(open === bot.id ? null : bot.id)}
              onChanged={() => void bots.refetch()}
            />
          ))}
        </TableBody>
      </Table>
      <LoadMore query={bots} />
    </AdminQuery>
  );
}

function BotRow({
  bot,
  open,
  onToggle,
  onChanged,
}: {
  bot: AdminCapabilityBot;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <TableRow aria-label={bot.name}>
        <TableCell className="font-medium">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            className="-ms-2"
            onClick={onToggle}
          >
            {bot.name}
          </Button>
        </TableCell>
        <TableCell>{bot.ownerEmail}</TableCell>
        <TableCell>
          {bot.mode === "enforce" ? (
            <Badge>{t`Enforce`}</Badge>
          ) : bot.mode === "shadow" ? (
            <Badge variant="secondary">{t`Shadow`}</Badge>
          ) : (
            <span className="text-muted-foreground">{t`Off`}</span>
          )}
        </TableCell>
        <TableCell className="text-end">{bot.grants}</TableCell>
        <TableCell className="text-end">{bot.mode === "shadow" ? bot.wouldDeny : null}</TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={5} className="space-y-4 whitespace-normal">
            <BotDetail bot={bot} onChanged={onChanged} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/** One bot: its mode with what shadow recorded, its grants with Revoke, and the simulator. */
function BotDetail({ bot, onChanged }: { bot: AdminCapabilityBot; onChanged: () => void }) {
  const canChange = useAdminRoles().can("security");
  const grants = useBotGrants(bot.id);
  return (
    <>
      <ModeControl bot={bot} editable={canChange} onChanged={onChanged} />
      <GrantEditor
        botId={bot.id}
        editable={canChange}
        onChanged={() => {
          void grants.refetch();
          onChanged();
        }}
      />
      <CapabilitySimulator botId={bot.id} />
    </>
  );
}

function ModeControl({
  bot,
  editable,
  onChanged,
}: {
  bot: AdminCapabilityBot;
  editable: boolean;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const summary = useQuery({
    ...useSpaceQueries().capabilityGrants.shadowSummary.queryOptions({ input: { botId: bot.id } }),
    enabled: bot.mode === "shadow",
  });
  async function change(mode: CapabilityMode | null) {
    setBusy(true);
    try {
      await rpc.capabilityGrants.setMode({ botId: bot.id, mode });
      onChanged();
    } catch (error) {
      toast.error(errorText(error, t`Could not update`));
    } finally {
      setBusy(false);
    }
  }
  const denied = summary.data?.denied ?? 0;
  return (
    <div className="space-y-2">
      <NativeSelect
        aria-label={t`Mode`}
        value={bot.mode ?? ""}
        disabled={busy || !editable}
        onChange={(event) => void change((event.target.value || null) as CapabilityMode | null)}
      >
        <NativeSelectOption value="">{t`Off`}</NativeSelectOption>
        <NativeSelectOption value="shadow">{t`Shadow`}</NativeSelectOption>
        <NativeSelectOption value="enforce">{t`Enforce`}</NativeSelectOption>
      </NativeSelect>
      {summary.data ? (
        <p className="text-sm text-muted-foreground" data-testid="capability-shadow-summary">
          <Plural
            value={denied}
            one="# call would have been denied in 7 days"
            other="# calls would have been denied in 7 days"
          />
          {summary.data.scopes.length
            ? ` · ${summary.data.scopes.map((entry) => `${entry.scope} ${entry.count}`).join(", ")}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
