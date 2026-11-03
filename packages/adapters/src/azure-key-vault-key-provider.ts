import { createHash, timingSafeEqual } from "node:crypto";
import type { KeyProvider, KeyWrapContext, WrappedDataKey } from "@rakazo/adapter-kit";
import { azureKeyVaultUrl } from "./azure-key-vault-secret-store.js";

const MASTER_KEY_PREFIX = "azure-key-vault:";
const ALGORITHM = "RSA-OAEP-256";
const KEY_PATH = /^\/keys\/([0-9a-zA-Z-]{1,127})\/([0-9a-f]{32})$/;
const BINDING_VERSION = 1;

/** The Key Vault wrap and unwrap operations the provider needs, by full key identifier. */
export interface KeyVaultCrypto {
  wrapKey(keyId: string, key: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  /** Also reports the key identifier that performed the operation. */
  unwrapKey(
    keyId: string,
    wrapped: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ key: Uint8Array; keyId?: string }>;
}

export interface AzureKeyVaultKeyProviderConfig {
  /** Full key identifier with version, https://<vault>/keys/<name>/<version>; never a bare name. */
  keyId: string;
}

export function azureKeyVaultConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AzureKeyVaultKeyProviderConfig {
  return { keyId: env.AZURE_KEY_VAULT_KEY_ID?.trim() ?? "" };
}

function parseKeyId(keyId: string) {
  let url: URL;
  try {
    url = new URL(azureKeyVaultUrl(keyId.split("/keys/")[0], "AZURE_KEY_VAULT_KEY_ID"));
  } catch {
    throw new Error(keyIdMessage);
  }
  const [, name, version] = KEY_PATH.exec(new URL(keyId).pathname) ?? [];
  if (!name || !version) throw new Error(keyIdMessage);
  return { origin: url.origin, name, version };
}
const keyIdMessage =
  "AZURE_KEY_VAULT_KEY_ID must be a key identifier with a version (https://<vault>.vault.azure.net/keys/<name>/<version>)";

/** The SDK loads on first use, so deployments without Key Vault never load it. */
export function sdkKeyCrypto(): KeyVaultCrypto {
  const connect = (() => {
    let loaded: Promise<[typeof import("@azure/identity"), typeof import("@azure/keyvault-keys")]>;
    const clients = new Map<string, import("@azure/keyvault-keys").CryptographyClient>();
    let credential: InstanceType<typeof import("@azure/identity").DefaultAzureCredential>;
    return async (keyId: string) => {
      loaded ??= Promise.all([import("@azure/identity"), import("@azure/keyvault-keys")]);
      const [identity, keys] = await loaded;
      credential ??= new identity.DefaultAzureCredential();
      let client = clients.get(keyId);
      if (!client) {
        client = new keys.CryptographyClient(keyId, credential);
        clients.set(keyId, client);
      }
      return client;
    };
  })();
  return {
    async wrapKey(keyId, key, signal) {
      const result = await (await connect(keyId)).wrapKey(ALGORITHM, key, { abortSignal: signal });
      return result.result;
    },
    async unwrapKey(keyId, wrapped, signal) {
      const result = await (await connect(keyId)).unwrapKey(ALGORITHM, wrapped, {
        abortSignal: signal,
      });
      return { key: result.result, keyId: result.keyID };
    },
  };
}

/**
 * Space keys wrapped by an RSA key in Azure Key Vault that never leaves the vault. RSA-OAEP
 * has no associated data, so the space and key version are wrapped together with the key and
 * checked on unwrap: a wrapped key moved to another space fails to unwrap.
 * Key Vault records every wrap and unwrap in its diagnostic logs.
 */
export class AzureKeyVaultKeyProvider implements KeyProvider {
  private readonly origin: string;
  private readonly masterKeyId: string;
  private readonly crypto: KeyVaultCrypto;

  constructor(
    private readonly config: AzureKeyVaultKeyProviderConfig,
    crypto?: KeyVaultCrypto,
  ) {
    const { origin, name, version } = parseKeyId(config.keyId);
    this.origin = origin;
    this.masterKeyId = `${MASTER_KEY_PREFIX}${name}/${version}`;
    this.crypto = crypto ?? sdkKeyCrypto();
  }

  describe() {
    return {
      id: "azure-key-vault",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { rotate: true },
    };
  }

  activeKeyId(): string {
    return this.masterKeyId;
  }

  async wrap(dataKey: Uint8Array, context: KeyWrapContext): Promise<WrappedDataKey> {
    const payload = Buffer.concat([binding(context), dataKey]);
    const wrapped = await this.crypto.wrapKey(this.config.keyId, payload);
    return {
      masterKeyId: this.masterKeyId,
      wrappedKey: Buffer.from(wrapped).toString("base64url"),
    };
  }

  /**
   * Keys wrapped by an earlier version of the key, or another key in the same vault, still
   * unwrap so `content-encryption rotate` can move them after AZURE_KEY_VAULT_KEY_ID changes.
   */
  async unwrap(wrapped: WrappedDataKey, context: KeyWrapContext): Promise<Uint8Array> {
    if (!wrapped.masterKeyId.startsWith(MASTER_KEY_PREFIX))
      throw new Error(`Master key ${wrapped.masterKeyId} is not configured`);
    const [name, version] = wrapped.masterKeyId.slice(MASTER_KEY_PREFIX.length).split("/");
    if (!name || !version || !KEY_PATH.test(`/keys/${name}/${version}`))
      throw new Error(`Master key ${wrapped.masterKeyId} is not configured`);
    const keyId = `${this.origin}/keys/${name}/${version}`;
    const { key, keyId: used } = await this.crypto
      .unwrapKey(keyId, Buffer.from(wrapped.wrappedKey, "base64url"))
      .catch((error: unknown) => {
        throw new Error(`Space key could not be unwrapped with master key ${wrapped.masterKeyId}`, {
          cause: error,
        });
      });
    if (used !== undefined && used.toLowerCase() !== keyId.toLowerCase())
      throw new Error(
        `Azure Key Vault unwrapped a space key with a key other than ${wrapped.masterKeyId}`,
      );
    const expected = binding(context);
    if (
      key.length !== expected.length + 32 ||
      !timingSafeEqual(key.subarray(0, expected.length), expected)
    )
      throw new Error("Azure Key Vault returned a space key bound to another space");
    return key.subarray(expected.length);
  }
}

function binding(context: KeyWrapContext): Buffer {
  return Buffer.concat([
    Buffer.from([BINDING_VERSION]),
    createHash("sha256")
      .update(JSON.stringify(["space-key/v1", context.spaceId, String(context.version)]))
      .digest(),
  ]);
}
