import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  SecretContext,
  SecretPutOptions,
  SecretRecord,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { SecretChanges } from "./secret-changes.js";

export const AZURE_KEY_VAULT_REF_PREFIX = "azure-key-vault:v1:";

/**
 * The few Key Vault secret operations the store needs. Failures carry the HTTP status
 * as `statusCode`, as the Azure SDK's RestError does.
 */
export interface KeyVaultSecretsApi {
  set(name: string, value: string, signal?: AbortSignal): Promise<void>;
  get(name: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Soft-deletes and waits until the secret is in the deleted state. */
  delete(name: string, signal?: AbortSignal): Promise<void>;
  purge(name: string, signal?: AbortSignal): Promise<void>;
}

export interface AzureKeyVaultSecretStoreOptions {
  vaultUrl: string;
  /** Defaults to the SDK client, loaded on first use with DefaultAzureCredential. */
  client?: KeyVaultSecretsApi;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

type CacheEntry = { value: string; expires: number };

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
};

/** Validates AZURE_KEY_VAULT_URL, e.g. https://name.vault.azure.net. */
export function azureKeyVaultUrl(value: string | undefined, name = "AZURE_KEY_VAULT_URL"): string {
  let url: URL;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new Error(`Missing or invalid ${name}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must be an https vault URL`);
  return url.origin;
}

/** The SDK loads on first use, so deployments without Key Vault never load it. */
export function sdkSecretsClient(vaultUrl: string): KeyVaultSecretsApi {
  const connect = (() => {
    let client: Promise<import("@azure/keyvault-secrets").SecretClient> | undefined;
    return () =>
      (client ??= Promise.all([import("@azure/identity"), import("@azure/keyvault-secrets")]).then(
        ([identity, secrets]) =>
          new secrets.SecretClient(vaultUrl, new identity.DefaultAzureCredential()),
      ));
  })();
  return {
    async set(name, value, signal) {
      await (await connect()).setSecret(name, value, { abortSignal: signal });
    },
    async get(name, signal) {
      return (await (await connect()).getSecret(name, { abortSignal: signal })).value;
    },
    async delete(name, signal) {
      const poller = await (await connect()).beginDeleteSecret(name, { abortSignal: signal });
      await poller.pollUntilDone();
    },
    async purge(name, signal) {
      await (await connect()).purgeDeletedSecret(name, { abortSignal: signal });
    },
  };
}

/**
 * Secrets live in one Key Vault. Each `put` writes a new unique name, so a soft-deleted
 * secret never blocks a later write; deletion purges where the vault allows it.
 * Credentials come from the Azure SDK (workload or managed identity), never from Rakazo settings.
 */
export class AzureKeyVaultSecretStore extends SecretChanges implements SecretStore {
  private readonly client: KeyVaultSecretsApi;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pendingReads = new Map<string, Promise<string>>();
  private readonly now: () => number;
  private degraded = false;
  private closed = false;
  constructor(private readonly options: AzureKeyVaultSecretStoreOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.client = options.client ?? sdkSecretsClient(options.vaultUrl);
    if (
      !Number.isSafeInteger(options.cacheMaxEntries ?? 256) ||
      (options.cacheMaxEntries ?? 256) < 1 ||
      !Number.isFinite(options.cacheTtlMs ?? 30_000) ||
      (options.cacheTtlMs ?? 30_000) < 1
    )
      throw new Error("Invalid secret cache limits");
  }
  describe() {
    return {
      id: "azure-key-vault",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { rotate: true, degraded: this.degraded },
    };
  }
  async start(): Promise<void> {
    try {
      // Reading an absent name proves authentication and read access without side effects.
      await this.client.get("rakazo-start-check");
    } catch (error) {
      if (statusOf(error) === 404) return;
      this.degraded = true;
      getLogger().warn("Azure Key Vault secret storage is unreachable or misconfigured", {
        status: statusOf(error),
      });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    this.clearListeners();
  }
  /** Used by the composing store for cross-process invalidation. */
  invalidate(ref: string): void {
    this.cache.delete(ref);
    this.changed(ref);
  }
  /** Names allow only letters, digits and hyphens: `rakazo-<record digest>-<uuid>`. */
  private name(ref: string, context: SecretContext): string {
    const recordId = typeof context === "string" ? context : context.recordId;
    const prefix = `rakazo-${credentialDigest(recordId).slice(0, 24)}-`;
    const name = ref.slice(AZURE_KEY_VAULT_REF_PREFIX.length);
    if (
      !ref.startsWith(AZURE_KEY_VAULT_REF_PREFIX) ||
      !name.startsWith(prefix) ||
      !/^rakazo-[a-f0-9]{24}-[a-f0-9-]{36}$/.test(name)
    )
      throw new SecretNotFoundError();
    return name;
  }
  private unavailable(error: unknown, signal?: AbortSignal): never {
    if (signal?.aborted) throw signal.reason;
    this.degraded = true;
    throw new SecretStoreUnavailableError(statusOf(error));
  }
  private remember(ref: string, value: string): void {
    if (this.closed) return;
    this.cache.delete(ref);
    while (this.cache.size >= (this.options.cacheMaxEntries ?? 256)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(ref, { value, expires: this.now() + (this.options.cacheTtlMs ?? 30_000) });
  }
  async put(
    plaintext: string,
    context: AdapterContext,
    options: SecretPutOptions = {},
  ): Promise<SecretRecord> {
    context.signal.throwIfAborted();
    if (options.ephemeral) throw new Error("Ephemeral secrets require local encrypted storage");
    const recordId = options.recordId ?? randomUUID();
    const name = `rakazo-${credentialDigest(recordId).slice(0, 24)}-${randomUUID()}`;
    const ref = AZURE_KEY_VAULT_REF_PREFIX + name;
    try {
      await this.client.set(name, plaintext, context.signal);
      this.degraded = false;
    } catch (error) {
      // The unique name may have been created before the response was lost.
      await this.client.delete(name, AbortSignal.timeout(2_000)).catch(() => {
        getLogger().warn("Secret cleanup after a failed write did not complete; a key may remain");
      });
      this.unavailable(error, context.signal);
    }
    this.remember(ref, plaintext);
    this.changed(ref);
    return { id: recordId, ref, ciphertext: ref };
  }
  async load(ref: string, context: SecretContext): Promise<string> {
    const name = this.name(ref, context);
    const signal = typeof context === "string" ? undefined : context.signal;
    signal?.throwIfAborted();
    if (this.closed) throw new SecretStoreUnavailableError();
    const cached = this.cache.get(ref);
    if (cached && cached.expires > this.now()) return cached.value;
    this.cache.delete(ref);
    let pending = this.pendingReads.get(ref);
    if (!pending) {
      pending = this.client.get(name).then(
        (value) => {
          if (typeof value !== "string") throw new SecretStoreUnavailableError();
          this.degraded = false;
          this.remember(ref, value);
          return value;
        },
        (error) => {
          if (statusOf(error) === 404) throw new SecretNotFoundError();
          return this.unavailable(error);
        },
      );
      this.pendingReads.set(ref, pending);
      const release = () => {
        if (this.pendingReads.get(ref) === pending) this.pendingReads.delete(ref);
      };
      void pending.then(release, release);
    }
    if (!signal) return pending;
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async delete(ref: string, context: SecretContext): Promise<void> {
    const name = this.name(ref, context);
    const signal = typeof context === "string" ? undefined : context.signal;
    try {
      await this.client.delete(name, signal);
      this.degraded = false;
      // Purging needs the purge permission and a vault without purge protection; otherwise
      // the deleted secret stays recoverable until retention ends, which is acceptable.
      await this.client.purge(name, signal).catch((error) => {
        getLogger().warn("Azure Key Vault secret purge did not complete", {
          status: statusOf(error),
        });
      });
    } catch (error) {
      if (statusOf(error) !== 404) this.unavailable(error, signal);
    } finally {
      this.invalidate(ref);
    }
  }
  redact(_value: string): string {
    return "[redacted]";
  }
}
