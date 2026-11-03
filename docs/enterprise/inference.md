# Inference: Microsoft Foundry and OpenCode Zen

Both work through the existing Pi runtime. Nothing here needs a code path of its own beyond the
generic deployment key lookup.

## Deployment default

Set these on the API and worker (the Compose files pass them through). A deployment model needs a
key from the provider's own variable; `OPENROUTER_API_KEY` is never used for another provider.

### Microsoft Foundry (Azure OpenAI)

```
PI_DEFAULT_PROVIDER=azure
PI_DEFAULT_MODEL=<model id>
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_RESOURCE_NAME=<resource>          # or AZURE_OPENAI_BASE_URL
AZURE_OPENAI_API_VERSION=<optional>
AZURE_OPENAI_DEPLOYMENT_NAME_MAP=<model id>=<deployment name>,...
```

- The endpoint is `https://<resource>.openai.azure.com/openai/v1`. Use
  `AZURE_OPENAI_BASE_URL` instead of the resource name for a `*.services.ai.azure.com` or
  `*.cognitiveservices.azure.com` host. Azure hosts with a bare or `/openai` path are normalized to
  `/openai/v1`.
- `PI_DEFAULT_MODEL` must be a model id in Pi's Azure catalog. If your Foundry deployment has a
  different name, map it with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`
  (for example `gpt-5.1=my-gpt-deployment`).

### OpenCode Zen

```
PI_DEFAULT_PROVIDER=opencode
PI_DEFAULT_MODEL=<model id from the Zen model list>
OPENCODE_API_KEY=<key>
```

Pi's `opencode` provider talks to Zen and picks the right protocol per model. Free-tier models are
hidden from the picker because they only answer OpenCode's own app; paid Zen models are listed.

## Organization models

The deployment credentials above also serve every member, with no connection of their own. When the
deployment model can run and model credits are not metered, every catalog model of the deployment
provider appears in the model pickers, marked as provided by the organization, with its list price
per million tokens (input / output) when the catalog knows it. Models with no known price show no
price.

- `allowUserConnections: false` in the [central policy](./central-policy.md) only stops members
  adding their own credentials or endpoints. It does not hide the organization's models.
- `allowProviders` and `allowModels` still filter the list. To offer a few models, name them, for
  example `allowModels: ['azure/gpt-5.1', 'azure/gpt-5.1-mini']`.
- A member who connects their own key for the deployment provider runs on that key instead.
- **Foundry lists only deployments you name.** Azure serves a model by its deployment name, so
  Rakazo cannot tell which models exist on the resource. The picker offers `PI_DEFAULT_MODEL` plus
  every model id in `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. To expose another Foundry deployment, add
  `<catalog model id>=<deployment name>` to the map (comma separated, even when the names match) and
  restart api and worker. The model id must exist in Pi's Azure catalog.
- Other providers (for example OpenCode Zen) offer their whole catalog, narrowed by policy.
- Usage and spend by model: **Settings → Usage**; set `budgets` in the policy to cap spend.

## Per-user connections

- **Catalog providers.** Azure OpenAI and OpenCode appear in the provider list in
  **Settings → Models**. The user pastes their own key; Azure also needs the endpoint settings
  above set on the deployment, since the connection stores only a key.
- **OpenAI-compatible connection.** Choose **OpenAI-compatible** and enter the base URL, the exact
  model (deployment) name and the key:
  - Foundry: `https://<resource>.openai.azure.com/openai/v1`. Azure accepts a bearer key; if your
    resource requires it, add an `api-key` header under **Advanced** (header values are stored
    encrypted). This route needs no deployment name map.
  - Zen: `https://opencode.ai/zen/v1` for Zen models served over chat completions.

The endpoint must be HTTPS and public unless the operator allows otherwise; see
[Models](../self-host-models.md#openai-compatible-connections).

## Vision

Pick a vision-capable model so screenshot computer tools stay available. Catalog models report
image input from Pi's registry. For an OpenAI-compatible connection, enable image input on the
connection; Rakazo cannot detect it from the endpoint.

## Keyless (Entra) authentication

Not implemented. Only API keys are supported for Foundry. Entra workload identity would need a
host-credentials seam for `azure` (as exists for Bedrock and Vertex) with `@azure/identity` loaded
by dynamic `import()`. Follow-up.

## Not verified live

Everything above is covered by offline unit tests (deployment key resolution, Compose variable
passthrough) and by reading Pi's Azure and OpenCode provider code. No request was made to a real
Foundry resource or to Zen, so model ids, deployment mapping, api-version behavior and the
`api-key` header route are unconfirmed against live services.
