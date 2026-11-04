/** The directory entry an account maps to. The email is the sign-in email, the same key SSO uses. */
export interface DirectorySubject {
  userId: string;
  email: string;
}

export type DirectoryClaimsResult =
  /** The person's current group values, in the same form the sign-in claim carries. */
  | { status: "found"; values: string[]; truncated?: boolean }
  /** The directory has no such person. */
  | { status: "missing" };

/**
 * Reads a person's current groups straight from the directory, so a membership removed there
 * stops conferring access without waiting for a sign-in. Implementations throw when the answer
 * is unknown (unreachable, throttled, ambiguous); callers then treat the stored claims as stale.
 */
export interface DirectoryClaimsSource {
  claimsFor(subject: DirectorySubject, signal?: AbortSignal): Promise<DirectoryClaimsResult>;
}
