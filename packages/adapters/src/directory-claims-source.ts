import type { DirectoryClaimsSource } from "@rakazo/adapter-kit";
import { isGraphIssuer } from "./graph-directory-claims.js";

export interface DirectoryConnection {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** Whether a directory source exists for the sign-in issuer, so a bad setting fails at startup. */
export function directoryClaimsSupported(issuer: string): boolean {
  return isGraphIssuer(issuer);
}

/**
 * The directory source for the sign-in connection, loaded only when group sync is configured.
 * Vendor translation lives in the adapter module; callers see `DirectoryClaimsSource`.
 */
export async function createDirectoryClaimsSource(
  connection: DirectoryConnection,
): Promise<DirectoryClaimsSource> {
  if (!directoryClaimsSupported(connection.issuer))
    throw new Error("Group sync does not support this sign-in issuer");
  const { createGraphDirectoryClaims } = await import("./graph-directory-claims.js");
  return createGraphDirectoryClaims(connection);
}
