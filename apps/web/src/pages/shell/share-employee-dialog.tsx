import { useLingui } from "@lingui/react/macro";
import type {
  Bot,
  EmployeeAccessRequest,
  EmployeeDetail,
  EmployeeGrant,
  EmployeeGrantSubjectKind,
  EmployeeRole,
} from "@rakazo/contracts";
import { EMPLOYEE_ROLES } from "@rakazo/contracts";
import { evaluateEmployeeAccess, evaluateGrantChange } from "@rakazo/core";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export type EmployeesApi = ReturnType<typeof createSpaceRpc>["employees"];
type Person = { userId: string; name: string; email: string };

/** Whether the role may make this change. The server decides again; this only hides refusals. */
function allowed(
  actorRole: EmployeeRole,
  subjectKind: EmployeeGrantSubjectKind,
  from: EmployeeRole | null,
  to: EmployeeRole | null,
) {
  // The last Owner is the server's call: it counts Owners that still exist.
  return evaluateGrantChange({ actorRole, subjectKind, from, to, ownerCount: 2 }).allowed;
}

function useRoleLabels() {
  const { t } = useLingui();
  return {
    owner: t`Owner`,
    manager: t`Manager`,
    collaborator: t`Collaborator`,
    viewer: t`Viewer`,
  } satisfies Record<EmployeeRole, string>;
}

function RoleSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: EmployeeRole;
  options: EmployeeRole[];
  disabled?: boolean;
  onChange: (role: EmployeeRole) => void;
}) {
  const labels = useRoleLabels();
  return (
    <NativeSelect
      size="sm"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as EmployeeRole)}
    >
      {options.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {labels[role]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

type Loaded = {
  detail: EmployeeDetail;
  grants: EmployeeGrant[] | null;
  requests: EmployeeAccessRequest[];
};

/** Who has access to a shared employee, and its versions. Everything here is a procedure call. */
function Access({ employeeId, api }: { employeeId: string; api: EmployeesApi }) {
  const { t } = useLingui();
  const labels = useRoleLabels();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [newRole, setNewRole] = useState<EmployeeRole>("collaborator");
  const [people, setPeople] = useState<Person[]>([]);
  const searchSeq = useRef(0);

  const load = useCallback(async () => {
    const detail = await api.get({ employeeId });
    const grants = canManageAccess(detail.employee.role)
      ? await api.grants.list({ employeeId })
      : null;
    // The inbox is a convenience: a failure to read it must not hide the access list.
    const requests = grants
      ? await api.requests.list({ employeeId }).catch(() => [] as EmployeeAccessRequest[])
      : [];
    setLoaded({ detail, grants, requests });
  }, [api, employeeId]);

  useEffect(() => {
    let live = true;
    load().catch((reason: unknown) => {
      if (live) setError(errorText(reason, t`Could not load`));
    });
    return () => {
      live = false;
    };
  }, [load, t]);

  const search = (value: string) => {
    setQuery(value);
    const seq = ++searchSeq.current;
    if (value.trim().length < 3) return setPeople([]);
    api.people
      .search({ employeeId, q: value.trim() })
      .then((found) => {
        if (seq === searchSeq.current) setPeople(found);
      })
      .catch(() => {
        if (seq === searchSeq.current) setPeople([]);
      });
  };

  const run = async (change: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await change();
      await load();
    } catch (reason) {
      setError(errorText(reason, t`Could not save`));
    } finally {
      setBusy(false);
    }
  };

  const add = (subjectKind: EmployeeGrantSubjectKind, subjectValue: string) =>
    run(async () => {
      await api.grants.set({ employeeId, subjectKind, subjectValue, role: newRole });
      searchSeq.current++;
      setQuery("");
      setPeople([]);
    });

  if (!loaded) {
    return error ? (
      <p role="alert" className="text-[13px] text-destructive">
        {error}
      </p>
    ) : (
      <div className="flex justify-center py-6" aria-busy="true">
        <Spinner className="size-4" />
      </div>
    );
  }

  const { detail, grants, requests } = loaded;
  const actorRole = detail.employee.role;
  const canManage = grants !== null;
  const addRoles = EMPLOYEE_ROLES.filter((role) => allowed(actorRole, "user", null, role));
  const claimRoles = addRoles.filter((role) => allowed(actorRole, "claim", null, role));
  const groupValue = query.trim();
  const versions = detail.versions ?? [];

  return (
    <div className="space-y-4">
      {canManage ? (
        <>
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                aria-label={t`Add people or groups`}
                placeholder={t`Name, email or group`}
                value={query}
                onChange={(event) => search(event.target.value)}
              />
              <RoleSelect
                label={t`Role`}
                value={addRoles.includes(newRole) ? newRole : (addRoles.at(-1) ?? "viewer")}
                options={addRoles}
                onChange={setNewRole}
              />
            </div>
            {groupValue.length >= 2 ? (
              <ul className="space-y-1">
                {people.map((person) => (
                  <li key={person.userId}>
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start py-1.5"
                      disabled={busy}
                      onClick={() => void add("user", person.userId)}
                    >
                      <span className="truncate">{person.name}</span>
                      <span className="truncate text-muted-foreground">{person.email}</span>
                    </Button>
                  </li>
                ))}
                {claimRoles.length > 0 ? (
                  <li>
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start py-1.5"
                      disabled={busy}
                      onClick={() => void add("claim", groupValue)}
                    >
                      <span className="truncate">{t`Group ${groupValue}`}</span>
                    </Button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
          {requests.length > 0 ? (
            <div className="space-y-2">
              <SectionHeading>{t`Requests`}</SectionHeading>
              <ul className="space-y-1" aria-label={t`Requests`}>
                {requests.map((request) => (
                  <li key={request.id} className="flex items-center gap-2">
                    <span dir="auto" className="min-w-0 flex-1 truncate text-[14px]">
                      {request.requesterName}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={t`Deny ${request.requesterName}`}
                      onClick={() =>
                        void run(() =>
                          api.requests.decide({
                            employeeId,
                            requestId: request.id,
                            decision: "deny",
                          }),
                        )
                      }
                    >
                      {t`Deny`}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-label={t`Approve ${request.requesterName}`}
                      onClick={() =>
                        void run(() =>
                          api.requests.decide({
                            employeeId,
                            requestId: request.id,
                            decision: "approve",
                          }),
                        )
                      }
                    >
                      {t`Approve`}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="space-y-1" aria-label={t`Access`}>
            {grants.map((grant) => {
              const name = grant.subjectLabel ?? grant.subjectValue;
              const options = EMPLOYEE_ROLES.filter(
                (role) =>
                  role === grant.role || allowed(actorRole, grant.subjectKind, grant.role, role),
              );
              const editable = allowed(actorRole, grant.subjectKind, grant.role, null);
              return (
                <li
                  key={`${grant.subjectKind}:${grant.subjectValue}`}
                  className="flex items-center gap-2"
                >
                  <span dir="auto" className="min-w-0 flex-1 truncate text-[14px]">
                    {name}
                  </span>
                  {editable ? (
                    <>
                      <RoleSelect
                        label={t`Role for ${name}`}
                        value={grant.role}
                        options={options}
                        disabled={busy}
                        onChange={(role) =>
                          void run(() =>
                            api.grants.set({
                              employeeId,
                              subjectKind: grant.subjectKind,
                              subjectValue: grant.subjectValue,
                              role,
                            }),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Remove ${name}`}
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api.grants.remove({
                              employeeId,
                              subjectKind: grant.subjectKind,
                              subjectValue: grant.subjectValue,
                            }),
                          )
                        }
                      >
                        <X />
                      </Button>
                    </>
                  ) : (
                    <span className="text-[13px] text-muted-foreground">{labels[grant.role]}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {versions.length > 0 ? (
            <div className="space-y-2">
              <SectionHeading>{t`Versions`}</SectionHeading>
              <ul className="space-y-1">
                {versions.map((version) => (
                  <li key={version.id} className="flex items-center gap-2 text-[14px]">
                    <span className="flex-1">{t`Version ${version.number}`}</span>
                    {version.current ? <Badge variant="secondary">{t`Current`}</Badge> : null}
                    {version.state === "draft" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api.versions.publish({ employeeId, versionId: version.id }),
                          )
                        }
                      >
                        {t`Publish`}
                      </Button>
                    ) : null}
                    {version.state === "published" && !version.current ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api.versions.rollback({ employeeId, versionId: version.id }),
                          )
                        }
                      >
                        {t`Roll back`}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t`Only managers can change access`}</p>
      )}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Sharing for one of the person's bots. A private bot first becomes a shared employee in place
 * (its conversation stays theirs), then the same dialog manages who has access.
 */
export function ShareEmployeeDialog({
  bot,
  api,
  onCancel,
  onShared,
}: {
  bot: Pick<Bot, "id" | "name" | "employeeId">;
  api: EmployeesApi;
  onCancel: () => void;
  /** The bot now belongs to an employee, so the roster should refresh. */
  onShared: () => void;
}) {
  const { t } = useLingui();
  const [employeeId, setEmployeeId] = useState(bot.employeeId ?? null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const share = () => {
    if (sharing) return;
    setSharing(true);
    setError(null);
    api
      .share({ botId: bot.id })
      .then(({ employeeId: id }) => {
        setEmployeeId(id);
        onShared();
      })
      .catch((reason: unknown) => setError(errorText(reason, t`Could not share`)))
      .finally(() => setSharing(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sharing) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-words">{t`Share ${bot.name}`}</DialogTitle>
        </DialogHeader>
        {employeeId ? (
          <Access employeeId={employeeId} api={api} />
        ) : (
          <>
            {error ? (
              <p role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={sharing}>
                {t`Cancel`}
              </Button>
              <Button onClick={share} disabled={sharing}>
                {t`Share`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function canManageAccess(role: EmployeeRole) {
  return evaluateEmployeeAccess({ role, action: "manage_grants" }).allowed;
}
