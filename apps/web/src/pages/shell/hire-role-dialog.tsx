import { Trans, useLingui } from "@lingui/react/macro";
import type { RoleConnectionKind, RoleTemplateListItem } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SectionHeading,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { cronLabels } from "../../lib/cron";
import { errorText } from "../../lib/user-error";

export interface HireRoleDialogProps {
  load: () => Promise<RoleTemplateListItem[]>;
  onHire: (templateId: string) => Promise<void>;
  onBack: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <SectionHeading variant="label">{title}</SectionHeading>
      {children}
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 text-[13px] text-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** Mounted only while open. Pick a role, see what hiring creates, confirm. */
export function HireRoleDialog({ load, onHire, onBack }: HireRoleDialogProps) {
  const { t, i18n } = useLingui();
  const [items, setItems] = useState<RoleTemplateListItem[] | null>(null);
  const [selected, setSelected] = useState<RoleTemplateListItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    load()
      .then((loaded) => live && setItems(loaded))
      .catch((err: unknown) => live && setError(errorText(err, t`Could not load roles`)));
    return () => {
      live = false;
    };
    // The loader is stable for the dialog's lifetime.
  }, []);

  const connectionLabel: Record<RoleConnectionKind, string> = {
    email: t`Email`,
    calendar: t`Calendar`,
    documents: t`Documents`,
    chat: t`Chat`,
    tickets: t`Tickets`,
    crm: t`CRM`,
  };

  async function hire() {
    if (!selected || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onHire(selected.template.id);
    } catch (err) {
      setError(errorText(err, t`Could not hire`));
      setSubmitting(false);
    }
  }

  const template = selected?.template;
  const routinesBlocked = selected?.blocked.some((item) => item.part === "routines");
  const othersBlocked = selected?.blocked.some((item) => item.part !== "routines");
  const blockedNote = (
    <span className="text-[12px] text-destructive">
      <Trans>Blocked by your organization</Trans>
    </span>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onBack();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="hire-role-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-center">{template ? template.role : t`Hire`}</DialogTitle>
        </DialogHeader>
        {template ? (
          <div className="flex flex-col gap-4" data-testid="hire-role-preview">
            <p className="text-[13px] text-muted-foreground">{template.description}</p>
            <details>
              <summary className="cursor-pointer text-[13px] text-foreground">
                <Trans>Instructions</Trans>
              </summary>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted-foreground">
                {template.instructions}
              </p>
            </details>
            {template.routines.length ? (
              <Section title={t`Routines`}>
                <List
                  items={template.routines.map(
                    (routine) =>
                      `${routine.name}, ${formatCron(routine.cron, cronLabels(i18n.locale))}`,
                  )}
                />
                {routinesBlocked ? blockedNote : null}
              </Section>
            ) : null}
            {template.skills.length ? (
              <Section title={t`Skills`}>
                <List items={template.skills.map((skill) => skill.name)} />
              </Section>
            ) : null}
            {template.connections.length || othersBlocked ? (
              <Section title={t`Works with`}>
                <List
                  items={template.connections.map((connection) => connectionLabel[connection.kind])}
                />
                {othersBlocked ? blockedNote : null}
              </Section>
            ) : null}
            {template.approvals.askBefore.length ? (
              <Section title={t`Asks before`}>
                <List items={template.approvals.askBefore} />
              </Section>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="hire-role-list">
            {items?.map((item) => (
              <Button
                key={item.template.id}
                type="button"
                variant="outline"
                className="h-auto flex-col items-start gap-0.5 whitespace-normal py-2 text-left"
                onClick={() => setSelected(item)}
              >
                <span>{item.template.role}</span>
                <span className="text-[12px] font-normal text-muted-foreground">
                  {item.template.description}
                </span>
              </Button>
            ))}
          </div>
        )}
        {error ? (
          <p role="alert" data-testid="hire-role-error" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => (template ? setSelected(null) : onBack())}
          >
            <Trans>Back</Trans>
          </Button>
          {template ? (
            <Button type="button" disabled={submitting} onClick={() => void hire()}>
              <Trans>Hire</Trans>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
