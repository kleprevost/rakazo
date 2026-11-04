import { Trans, useLingui } from "@lingui/react/macro";
import type {
  PublishedSkill,
  SkillAudience,
  SkillAudienceInput,
  SkillDiff,
  SkillReviewItem,
} from "@rakazo/contracts";
import { Button, Input, Textarea, toast } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { AdminQuery } from "./AdminQuery";
import { AdminShell } from "./AdminShell";

/** Platform admins review submitted skills and choose who runs which approved version. */
export function AdminSkillsPage() {
  return (
    <AdminShell>
      <AdminSkills />
    </AdminShell>
  );
}

const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

function useRefresh() {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queries.skillPublishing.review.list.key() }),
      queryClient.invalidateQueries({ queryKey: queries.skillPublishing.catalog.key() }),
    ]);
}

function AdminSkills() {
  const queries = useSpaceQueries();
  const reviews = useQuery(queries.skillPublishing.review.list.queryOptions({ input: {} }));
  const catalog = useQuery(queries.skillPublishing.catalog.queryOptions({ input: {} }));
  const waiting = reviews.data ?? [];
  const skills = catalog.data ?? [];
  return (
    <AdminQuery
      pending={reviews.isPending || catalog.isPending}
      error={reviews.error ?? catalog.error}
      onRetry={() => {
        void reviews.refetch();
        void catalog.refetch();
      }}
      empty={waiting.length === 0 && skills.length === 0}
    >
      <div data-testid="admin-skills" className="flex flex-col gap-6">
        {waiting.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">
              <Trans>Waiting for review</Trans>
            </h2>
            {waiting.map((item) => (
              <Review key={item.versionId} item={item} />
            ))}
          </section>
        ) : null}
        {skills.map((skill) => (
          <Skill key={skill.id} skill={skill} />
        ))}
      </div>
    </AdminQuery>
  );
}

function Review({ item }: { item: SkillReviewItem }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const detail = useQuery({
    ...queries.skillPublishing.review.get.queryOptions({ input: { versionId: item.versionId } }),
    enabled: open,
  });

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    try {
      await rpc.skillPublishing.review.decide({
        versionId: item.versionId,
        decision,
        ...(decision === "reject" && reason.trim() ? { reason: reason.trim() } : {}),
      });
      await refresh();
    } catch (err) {
      toast.error(errorText(err, t`Could not save`));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-3" data-testid="skill-review">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 text-left text-sm"
        onClick={() => setOpen(!open)}
      >
        <span className="font-medium">{item.name}</span>
        <span className="text-muted-foreground">v{item.number}</span>
        <span className="text-muted-foreground">{item.authorName}</span>
      </button>
      {open && detail.data ? (
        <div className="mt-3 flex flex-col gap-3">
          <Diff diff={detail.data.diff} />
          {rejecting ? (
            <Textarea
              aria-label={t`Reason`}
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(event) => setReason(event.target.value)}
            />
          ) : null}
          <div className="flex gap-2">
            {rejecting ? (
              <Button variant="destructive" disabled={busy} onClick={() => void decide("reject")}>
                <Trans>Reject</Trans>
              </Button>
            ) : (
              <>
                <Button disabled={busy} onClick={() => void decide("approve")}>
                  <Trans>Approve</Trans>
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                  <Trans>Reject</Trans>
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Diff({ diff }: { diff: SkillDiff }) {
  const { t } = useLingui();
  const labels: Record<SkillDiff[number]["field"], string> = {
    name: t`Name`,
    whenToUse: t`When to use`,
    inputs: t`Inputs`,
    steps: t`Steps`,
    howToCheck: t`How to check`,
    whatToReturn: t`What to return`,
    approvalBoundaries: t`Approval boundaries`,
    failureHandling: t`Failure handling`,
  };
  return (
    <div className="flex flex-col gap-3" data-testid="skill-diff">
      {diff.map((entry) => (
        <div key={entry.field}>
          <div className="mb-1 text-xs text-muted-foreground">{labels[entry.field]}</div>
          <pre className="whitespace-pre-wrap text-[13px]">
            {entry.lines.map((line, index) => (
              <div
                key={index}
                className={
                  line.op === "add"
                    ? "text-success"
                    : line.op === "remove"
                      ? "text-destructive line-through"
                      : "text-muted-foreground"
                }
              >
                {line.op === "add" ? "+ " : line.op === "remove" ? "- " : "  "}
                {line.text}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

function Skill({ skill }: { skill: PublishedSkill }) {
  const { t } = useLingui();
  const refresh = useRefresh();
  const approved = skill.versions.filter((version) => version.status === "approved");
  const [busy, setBusy] = useState(false);
  const [rollbackTo, setRollbackTo] = useState("");

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (err) {
      toast.error(errorText(err, t`Could not save`));
    }
    setBusy(false);
  }

  const versionSelect = (value: string, onChange: (id: string) => void, label: string) => (
    <select
      aria-label={label}
      className={selectClass}
      value={value}
      disabled={busy}
      onChange={(event) => onChange(event.target.value)}
    >
      {value === "" ? <option value="" /> : null}
      {approved.map((version) => (
        <option key={version.id} value={version.id}>
          v{version.number}
        </option>
      ))}
    </select>
  );

  return (
    <section className="flex flex-col gap-2" data-testid="published-skill">
      <h2 className="text-sm font-medium">{skill.name}</h2>
      {skill.audiences.map((audience) => (
        <div key={audience.id} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{audienceLabel(audience, t`Everyone`)}</span>
          {versionSelect(
            audience.versionId,
            (versionId) =>
              void run(() =>
                rpc.skillPublishing.publish({
                  skillId: skill.id,
                  versionId,
                  audience: toInput(audience),
                }),
              ),
            t`Version`,
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => rpc.skillPublishing.unpublish({ audienceId: audience.id }))
            }
          >
            <Trans>Remove</Trans>
          </Button>
        </div>
      ))}
      {approved.length > 1 ? (
        <div className="flex items-center gap-2">
          {versionSelect(rollbackTo, setRollbackTo, t`Version`)}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !rollbackTo}
            onClick={() =>
              void run(() =>
                rpc.skillPublishing.rollback({ skillId: skill.id, versionId: rollbackTo }),
              )
            }
          >
            <Trans>Roll back</Trans>
          </Button>
        </div>
      ) : null}
      {approved.length > 0 ? (
        <AddAudience skillId={skill.id} versions={approved} busy={busy} run={run} />
      ) : null}
    </section>
  );
}

function AddAudience({
  skillId,
  versions,
  busy,
  run,
}: {
  skillId: string;
  versions: PublishedSkill["versions"];
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useLingui();
  const [kind, setKind] = useState<SkillAudienceInput["kind"]>("user");
  const [value, setValue] = useState("");
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const audience: SkillAudienceInput | null =
    kind === "all" ? { kind } : value.trim() ? { kind, value: value.trim() } : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t`Audience`}
        className={selectClass}
        value={kind}
        onChange={(event) => setKind(event.target.value as SkillAudienceInput["kind"])}
      >
        <option value="user">{t`Person`}</option>
        <option value="claim">{t`Group`}</option>
        <option value="all">{t`Everyone`}</option>
      </select>
      {kind === "all" ? null : (
        <Input
          className="w-56"
          aria-label={kind === "user" ? t`User ID` : t`Group`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <select
        aria-label={t`Version`}
        className={selectClass}
        value={versionId}
        onChange={(event) => setVersionId(event.target.value)}
      >
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            v{version.number}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={busy || !audience}
        onClick={() =>
          audience
            ? void run(async () => {
                await rpc.skillPublishing.publish({ skillId, versionId, audience });
                setValue("");
              })
            : undefined
        }
      >
        <Trans>Publish</Trans>
      </Button>
    </div>
  );
}

const audienceLabel = (audience: SkillAudience, everyone: string) =>
  audience.kind === "all" ? everyone : audience.value;

const toInput = (audience: SkillAudience): SkillAudienceInput =>
  audience.kind === "all" ? { kind: "all" } : { kind: audience.kind, value: audience.value };
