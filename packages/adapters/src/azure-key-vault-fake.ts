import { constants, generateKeyPairSync, privateDecrypt, publicEncrypt } from "node:crypto";
import type { KeyVaultCrypto } from "./azure-key-vault-key-provider.js";
import type { KeyVaultSecretsApi } from "./azure-key-vault-secret-store.js";

export const FAKE_VAULT = "https://rakazo-test.vault.azure.net";
const status = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/**
 * Offline Key Vault secrets with the service's soft-delete rules: a deleted name cannot be
 * set again until it is purged, purging an active secret fails, and purge protection or a
 * missing purge permission can be simulated.
 */
export function fakeKeyVaultSecrets() {
  const active = new Map<string, string>();
  const deleted = new Set<string>();
  const state = {
    down: false,
    purgeStatus: undefined as number | undefined,
    calls: [] as string[],
  };
  const gate = (op: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    state.calls.push(op);
    if (state.down) throw status(503, "private response value");
  };
  const client: KeyVaultSecretsApi = {
    async set(name, value, signal) {
      gate("set", signal);
      if (!/^[0-9a-zA-Z-]{1,127}$/.test(name)) throw status(400, "BadParameter");
      if (deleted.has(name)) throw status(409, "ObjectIsDeletedButRecoverable");
      active.set(name, value);
    },
    async get(name, signal) {
      gate("get", signal);
      const value = active.get(name);
      if (value === undefined) throw status(404, "SecretNotFound");
      return value;
    },
    async delete(name, signal) {
      gate("delete", signal);
      if (!active.delete(name)) throw status(404, "SecretNotFound");
      deleted.add(name);
    },
    async purge(name, signal) {
      gate("purge", signal);
      if (state.purgeStatus) throw status(state.purgeStatus, "Forbidden");
      if (!deleted.delete(name)) throw status(404, "DeletedSecretNotFound");
    },
  };
  return { client, active, deleted, state, options: { vaultUrl: FAKE_VAULT, client } };
}

/** Offline RSA-OAEP-256 wrap and unwrap under the key versions in `keys`. */
export function fakeKeyVaultCrypto(keys: string[]) {
  const pairs = new Map(
    keys.map((id) => [id, generateKeyPairSync("rsa", { modulusLength: 2048 })]),
  );
  const state = { down: false, requests: [] as string[] };
  const pair = (keyId: string) => {
    const found = pairs.get(keyId);
    if (!found) throw status(404, "KeyNotFound");
    return found;
  };
  const crypto: KeyVaultCrypto = {
    async wrapKey(keyId, key) {
      state.requests.push(keyId);
      if (state.down) throw status(503, "down");
      return publicEncrypt(
        {
          key: pair(keyId).publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        key,
      );
    },
    async unwrapKey(keyId, wrapped) {
      state.requests.push(keyId);
      if (state.down) throw status(503, "down");
      try {
        const key = privateDecrypt(
          {
            key: pair(keyId).privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          wrapped,
        );
        return { key, keyId };
      } catch (error) {
        throw status(400, error instanceof Error ? error.message : "BadParameter");
      }
    },
  };
  return { crypto, state };
}
