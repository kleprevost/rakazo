import { readFileSync } from "node:fs";
import { evaluateComputerImage, parsePolicy } from "@rakazo/core";

type Policy = ReturnType<typeof parsePolicy>;

/**
 * The central policy file the API and worker also load. The supervisor reads it from the same
 * mounted path rather than trusting an image list in a request, so a request cannot widen what it
 * is allowed to ask for. An unreadable or invalid file stops the supervisor, as it stops the API.
 */
export function loadSupervisorPolicy(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Policy | undefined {
  const path = env.RAKAZO_POLICY_FILE?.trim();
  if (!path) return undefined;
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new Error(
      `RAKAZO_POLICY_FILE could not be read: ${(error as NodeJS.ErrnoException).code ?? "read error"}`,
    );
  }
  return parsePolicy(text, "RAKAZO_POLICY_FILE");
}

/** Whether a computer may start from the image a request names. With no list, none is approved. */
export function requestedImageApproved(
  policy: Policy | undefined,
  image: { ref: string; digest: string },
): boolean {
  return evaluateComputerImage(policy, image).allowed;
}
