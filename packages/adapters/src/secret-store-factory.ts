import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  RealtimeFanout,
  SecretContext,
  SecretPutOptions,
  SecretStore,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import {
  AZURE_KEY_VAULT_REF_PREFIX,
  AzureKeyVaultSecretStore,
  azureKeyVaultUrl,
} from "./azure-key-vault-secret-store.js";
import type { InfisicalSecretStoreOptions } from "./infisical-secret-store.js";
import { INFISICAL_REF_PREFIX, InfisicalSecretStore } from "./infisical-secret-store.js";
import { SecretChanges } from "./secret-changes.js";
import { EncryptedSecretStore } from "./secrets.js";

export function secretStoreOptionsFromEnv(
  source: NodeJS.ProcessEnv,
): InfisicalSecretStoreOptions | undefined {
  const provider = source.SECRET_STORE?.trim() || "encrypted";
  if (provider === "encrypted") return undefined;
  if (provider === "azure-key-vault") return undefined;
  if (provider !== "infisical") throw new Error("Unsupported SECRET_STORE");
  const required = (name: string) => {
    const value = source[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const baseUrl = required("INFISICAL_URL");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid INFISICAL_URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid INFISICAL_URL");
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback && source.INFISICAL_ALLOW_INSECURE_HTTP !== "true")
    throw new Error("INFISICAL_URL requires HTTPS or INFISICAL_ALLOW_INSECURE_HTTP=true");
  const folder = required("INFISICAL_FOLDER");
  if (!folder.startsWith("/")) throw new Error("INFISICAL_FOLDER must start with /");
  return {
    baseUrl,
    clientId: required("INFISICAL_CLIENT_ID"),
    clientSecret: required("INFISICAL_CLIENT_SECRET"),
    projectId: required("INFISICAL_PROJECT_ID"),
    environment: required("INFISICAL_ENVIRONMENT"),
    folder,
  };
}

/** A remote store plus the ref prefix that routes to it. */
type RemoteSecretStore = SecretStore & { invalidate(ref: string): void };
const remotePrefix = (store: RemoteSecretStore) =>
  store instanceof AzureKeyVaultSecretStore ? AZURE_KEY_VAULT_REF_PREFIX : INFISICAL_REF_PREFIX;

const heldNotifications = new AsyncLocalStorage<Array<() => Promise<void>>>();

/** Sends change notifications from writes inside `work` once it settles. A write
 * inside a database transaction would otherwise wait on a second pooled
 * connection to notify while its own transaction holds the first. */
export async function holdSecretNotifications<T>(work: () => Promise<T>): Promise<T> {
  const held: Array<() => Promise<void>> = [];
  try {
    return await heldNotifications.run(held, work);
  } finally {
    for (const notify of held) await notify();
  }
}

/** Routing is private to the store; consumers only see opaque refs. */
export class ComposedSecretStore extends SecretChanges implements SecretStore {
  private readonly origin = randomUUID();
  private closed = false;
  private starting?: Promise<void>;
  private unsubscribe?: () => Promise<void>;
  private readonly subscriptions: Array<() => void> = [];
  constructor(
    private readonly encrypted: SecretStore,
    private readonly remote?: RemoteSecretStore,
    private readonly realtime?: RealtimeFanout,
  ) {
    super();
    for (const store of remote ? [encrypted, remote] : [encrypted])
      this.subscriptions.push(store.onChange((ref) => this.changed(ref)));
  }
  describe() {
    return (this.remote ?? this.encrypted).describe();
  }
  start(): Promise<void> {
    this.starting ??= this.startOnce();
    return this.starting;
  }
  private async startOnce(): Promise<void> {
    await this.encrypted.start();
    await this.remote?.start();
    if (this.closed) return;
    if (this.realtime)
      this.unsubscribe = await this.realtime.subscribe("secret-store-change", (payload) => {
        try {
          const event = JSON.parse(payload);
          if (event.origin !== this.origin && typeof event.ref === "string") {
            if (this.remote && event.ref.startsWith(remotePrefix(this.remote)))
              this.remote.invalidate(event.ref);
            else this.changed(event.ref);
          }
        } catch {
          /* Ignore malformed notifications. */
        }
      });
  }
  private async publish(ref: string): Promise<void> {
    try {
      await this.realtime?.publish(
        "secret-store-change",
        JSON.stringify({ origin: this.origin, ref }),
      );
    } catch {
      getLogger().warn("Secret change notification failed");
    }
  }
  async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    const record = await (options.ephemeral || !this.remote ? this.encrypted : this.remote).put(
      value,
      context,
      options,
    );
    const held = heldNotifications.getStore();
    if (held) held.push(() => this.publish(record.ref));
    else await this.publish(record.ref);
    return record;
  }
  load(ref: string, context: SecretContext): Promise<string> {
    return (
      this.remote && ref.startsWith(remotePrefix(this.remote)) ? this.remote : this.encrypted
    ).load(ref, context);
  }
  async delete(ref: string, context: SecretContext): Promise<void> {
    try {
      await (this.remote && ref.startsWith(remotePrefix(this.remote))
        ? this.remote
        : this.encrypted
      ).delete(ref, context);
    } finally {
      await this.publish(ref);
    }
  }

  redact(_value: string): string {
    return "[redacted]";
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.remote?.close();
    for (const stop of this.subscriptions) stop();
    await this.starting?.catch(() => undefined);
    try {
      await this.unsubscribe?.();
    } catch {
      getLogger().warn("Secret notification shutdown failed");
    }
    this.unsubscribe = undefined;
    await this.encrypted.close();
    this.clearListeners();
  }
}

export function createSecretStore(
  encryptionKey: string,
  source: NodeJS.ProcessEnv = process.env,
  realtime?: RealtimeFanout,
): SecretStore {
  const options = secretStoreOptionsFromEnv(source);
  const azure = source.SECRET_STORE?.trim() === "azure-key-vault";
  const encrypted = new EncryptedSecretStore(encryptionKey);
  const remote = azure
    ? new AzureKeyVaultSecretStore({ vaultUrl: azureKeyVaultUrl(source.AZURE_KEY_VAULT_URL) })
    : options
      ? new InfisicalSecretStore(options)
      : undefined;
  return remote || realtime ? new ComposedSecretStore(encrypted, remote, realtime) : encrypted;
}

export async function deleteSecretBestEffort(
  store: Pick<SecretStore, "delete">,
  ref: string,
  context: SecretContext,
): Promise<void> {
  try {
    await store.delete(ref, context);
  } catch {
    getLogger().warn("Secret deletion failed; retry cleanup before removing provider access");
  }
}
