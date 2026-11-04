import { Trans, useLingui } from "@lingui/react/macro";
import type { CapabilitySimulation } from "@rakazo/contracts";
import { CapabilityGrantScopeSchema, isBuiltinToolName } from "@rakazo/contracts";
import { Badge, Button, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

type Args = Record<string, string | number | boolean>;

/** The arguments typed as a JSON object of plain values; null when they are not one. */
function parseArgs(text: string): Args | null | undefined {
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const plain = Object.values(value).every((entry) =>
      ["string", "number", "boolean"].includes(typeof entry),
    );
    return plain ? (value as Args) : null;
  } catch {
    return null;
  }
}

/**
 * Decides a hypothetical call for one bot on the server, from its live grants. It never runs the
 * tool. A tool that is not built in also needs its server's name.
 */
export function CapabilitySimulator({ botId }: { botId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const [target, setTarget] = useState("");
  const [server, setServer] = useState("");
  const [args, setArgs] = useState("");
  const [result, setResult] = useState<CapabilitySimulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = target.trim();
  const isScope = CapabilityGrantScopeSchema.safeParse(name).success;
  const needsServer = name !== "" && !isScope && !isBuiltinToolName(name);
  const parsed = isScope ? undefined : parseArgs(args);
  async function simulate() {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await rpc.capabilityGrants.simulate({
          botId,
          ...(isScope ? { scope: name } : { tool: name }),
          ...(needsServer && server.trim() ? { server: server.trim() } : {}),
          ...(parsed ? { args: parsed } : {}),
        }),
      );
    } catch (failure) {
      setResult(null);
      setError(errorText(failure, t`Could not update`));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-2"
      data-testid="capability-simulator"
      onSubmit={(event) => {
        event.preventDefault();
        void simulate();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={t`Tool or scope`}
          className="min-w-0 flex-1"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        {needsServer ? (
          <Input
            aria-label={t`Server`}
            className="w-40"
            value={server}
            onChange={(event) => setServer(event.target.value)}
          />
        ) : null}
        {name !== "" && !isScope ? (
          <Input
            aria-label={t`Arguments`}
            aria-invalid={parsed === null}
            className="w-56"
            value={args}
            onChange={(event) => setArgs(event.target.value)}
          />
        ) : null}
        <Button
          type="submit"
          variant="outline"
          disabled={busy || name === "" || parsed === null || (needsServer && !server.trim())}
        >
          <Trans>Simulate</Trans>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? <Outcome result={result} /> : null}
    </form>
  );
}

function Outcome({ result }: { result: CapabilitySimulation }) {
  const { t } = useLingui();
  const label = { allow: t`Allow`, ask: t`Ask`, deny: t`Deny` }[result.outcome];
  return (
    <div className="space-y-1.5 text-sm" data-testid="capability-outcome">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.outcome === "deny" ? "destructive" : "secondary"}>{label}</Badge>
        {result.enforced ? null : <Badge variant="outline">{t`Shadow`}</Badge>}
        <span className="font-mono text-[13px] text-muted-foreground">
          {result.scopes.join(" ")}
        </span>
      </div>
      <ol className="space-y-0.5 font-mono text-[13px] text-muted-foreground">
        {result.trace.map((entry, index) => (
          <li key={`${entry.layer}-${entry.rule}-${entry.scope ?? ""}-${index}`}>
            {[entry.layer, entry.rule, entry.scope, entry.effect].filter(Boolean).join(" · ")}
          </li>
        ))}
      </ol>
    </div>
  );
}
