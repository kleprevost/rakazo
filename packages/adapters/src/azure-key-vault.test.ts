import { randomBytes } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { fakeKeyVaultCrypto, fakeKeyVaultSecrets } from "./azure-key-vault-fake.js";
import {
  AzureKeyVaultKeyProvider,
  azureKeyVaultConfigFromEnv,
} from "./azure-key-vault-key-provider.js";
import {
  AZURE_KEY_VAULT_REF_PREFIX,
  AzureKeyVaultSecretStore,
  azureKeyVaultUrl,
} from "./azure-key-vault-secret-store.js";
import { contentKeyProviderFromEnv } from "./key-provider-factory.js";
import { createSecretStore } from "./secret-store-factory.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};

describe("Azure Key Vault secret store", () => {
  it("writes names Key Vault accepts, one per put, bound to the record", async () => {
    const fake = fakeKeyVaultSecrets();
    const store = new AzureKeyVaultSecretStore(fake.options);
    const a = await store.put("fake-a", context, { recordId: "row-a" });
    const b = await store.put("fake-b", context, { recordId: "row-a" });
    const c = await store.put("fake-c", context, { recordId: "row-b" });
    expect(a.ref.startsWith(AZURE_KEY_VAULT_REF_PREFIX)).toBe(true);
    expect(new Set([a.ref, b.ref, c.ref]).size).toBe(3);
    expect(
      [...fake.active.keys()].every((name) => /^rakazo-[a-f0-9]{24}-[a-f0-9-]{36}$/.test(name)),
    ).toBe(true);
    await expect(store.load(a.ref, "row-b")).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(store.load("azure-key-vault:v1:rakazo-x", "row-a")).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
  });

  it("purges on delete so nothing is left soft-deleted, and tolerates purge protection", async () => {
    const fake = fakeKeyVaultSecrets();
    const store = new AzureKeyVaultSecretStore(fake.options);
    const first = await store.put("fake", context, { recordId: "row" });
    await store.delete(first.ref, "row");
    expect(fake.active.size + fake.deleted.size).toBe(0);
    await expect(store.load(first.ref, "row")).rejects.toBeInstanceOf(SecretNotFoundError);
    fake.state.purgeStatus = 403;
    const second = await store.put("fake", context, { recordId: "row" });
    await store.delete(second.ref, "row");
    expect(fake.deleted.size).toBe(1);
    // A deleted name still blocks the vault, but new writes use fresh names.
    await expect(store.put("again", context, { recordId: "row" })).resolves.toBeDefined();
  });

  it("caches reads, and reports an unavailable vault without leaking its response", async () => {
    const fake = fakeKeyVaultSecrets();
    const store = new AzureKeyVaultSecretStore(fake.options);
    const record = await store.put("fake", context, { recordId: "row" });
    fake.state.calls.length = 0;
    await store.load(record.ref, "row");
    expect(fake.state.calls).toEqual([]);
    store.invalidate(record.ref);
    fake.state.down = true;
    const error = await store.load(record.ref, "row").catch((e) => e);
    expect(error).toBeInstanceOf(SecretStoreUnavailableError);
    expect(error.status).toBe(503);
    expect(String(error.message)).not.toContain("private");
    expect(store.describe().capabilities.degraded).toBe(true);
  });

  it("selects the store by SECRET_STORE and validates the vault URL", () => {
    expect(azureKeyVaultUrl("https://v.vault.azure.net/")).toBe("https://v.vault.azure.net");
    expect(() => azureKeyVaultUrl("http://v.vault.azure.net")).toThrow("https");
    expect(() => azureKeyVaultUrl(undefined)).toThrow("AZURE_KEY_VAULT_URL");
    expect(() => createSecretStore("test-key", { SECRET_STORE: "azure-key-vault" })).toThrow(
      "AZURE_KEY_VAULT_URL",
    );
    const store = createSecretStore("test-key", {
      SECRET_STORE: "azure-key-vault",
      AZURE_KEY_VAULT_URL: "https://v.vault.azure.net",
    });
    expect(store.describe().id).toBe("azure-key-vault");
  });
});

const KEY = "https://rakazo-test.vault.azure.net/keys/rakazo/0123456789abcdef0123456789abcdef";
const NEXT = "https://rakazo-test.vault.azure.net/keys/rakazo/fedcba9876543210fedcba9876543210";

describe("Azure Key Vault key provider", () => {
  const { crypto, state } = fakeKeyVaultCrypto([KEY, NEXT]);
  const context = { spaceId: "space-a", version: 1 };

  it("names the pinned key version and requires one", () => {
    expect(new AzureKeyVaultKeyProvider({ keyId: KEY }, crypto).activeKeyId()).toBe(
      "azure-key-vault:rakazo/0123456789abcdef0123456789abcdef",
    );
    for (const keyId of [
      "",
      "https://rakazo-test.vault.azure.net/keys/rakazo",
      "http://rakazo-test.vault.azure.net/keys/rakazo/0123456789abcdef0123456789abcdef",
    ])
      expect(() => new AzureKeyVaultKeyProvider({ keyId }, crypto)).toThrow(
        "AZURE_KEY_VAULT_KEY_ID",
      );
    expect(azureKeyVaultConfigFromEnv({ AZURE_KEY_VAULT_KEY_ID: ` ${KEY} ` })).toEqual({
      keyId: KEY,
    });
  });

  it("moves keys from a replaced key version to the new one", async () => {
    const old = new AzureKeyVaultKeyProvider({ keyId: KEY }, crypto);
    const next = new AzureKeyVaultKeyProvider({ keyId: NEXT }, crypto);
    const dataKey = randomBytes(32);
    const wrapped = await old.wrap(dataKey, context);
    const moved = await next.wrap(await next.unwrap(wrapped, context), context);
    expect(moved.masterKeyId).toBe("azure-key-vault:rakazo/fedcba9876543210fedcba9876543210");
    expect(Buffer.from(await next.unwrap(moved, context))).toEqual(dataKey);
    // Naming a different key than the one that wrapped fails inside the vault.
    await expect(
      next.unwrap({ ...wrapped, masterKeyId: moved.masterKeyId }, context),
    ).rejects.toThrow();
  });

  it("names the master key and keeps the cause when Key Vault is unavailable", async () => {
    const provider = new AzureKeyVaultKeyProvider({ keyId: KEY }, crypto);
    const wrapped = await provider.wrap(randomBytes(32), context);
    state.down = true;
    try {
      const error = await provider.unwrap(wrapped, context).catch((e) => e);
      expect(error.message).toBe(
        "Space key could not be unwrapped with master key azure-key-vault:rakazo/0123456789abcdef0123456789abcdef",
      );
      expect(error.cause).toBeDefined();
    } finally {
      state.down = false;
    }
  });

  it("is selected by MASTER_KEY_PROVIDER, failing at startup on bad configuration", () => {
    expect(() => contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "azure-key-vault" })).toThrow(
      "AZURE_KEY_VAULT_KEY_ID",
    );
    const provider = contentKeyProviderFromEnv({
      MASTER_KEY_PROVIDER: "azure-key-vault",
      AZURE_KEY_VAULT_KEY_ID: KEY,
      ENCRYPTION_KEY: "fake-encryption-key-for-tests-0000000000000000000000000000",
    });
    expect(provider?.activeKeyId()).toBe("azure-key-vault:rakazo/0123456789abcdef0123456789abcdef");
  });
});
