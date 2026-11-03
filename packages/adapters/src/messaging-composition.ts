import type { JobPublisher, MessagingSurface, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { InstalledMessagingSurface } from "./installed-messaging-surface.js";
import { MessagingInstallations } from "./messaging-installations.js";
import { PolicyMessagingSurface } from "./policy-capabilities.js";
import { SlackInstallProvider } from "./slack-install-provider.js";

function policyBound(surface: MessagingSurface | undefined) {
  return surface && new PolicyMessagingSurface(surface);
}

export function installedMessaging(
  prisma: PrismaClient,
  secrets: SecretStore,
  config: {
    slackClientId?: string;
    slackClientSecret?: string;
    slackSigningSecret?: string;
    apiUrl?: string;
  },
  fallback?: MessagingSurface,
  cleanupJobs?: Pick<JobPublisher, "enqueue">,
): { messaging: MessagingSurface | undefined; installations: MessagingInstallations | undefined } {
  if (
    (config.slackClientId || config.slackClientSecret) &&
    (!config.slackClientId ||
      !config.slackClientSecret ||
      !config.slackSigningSecret ||
      !config.apiUrl)
  )
    throw new Error(
      "Slack workspace installs require client ID, client secret, signing secret and API_URL",
    );
  if (
    !config.slackClientId ||
    !config.slackClientSecret ||
    !config.slackSigningSecret ||
    !config.apiUrl
  )
    return { messaging: policyBound(fallback), installations: undefined };
  const provider = new SlackInstallProvider({
    clientId: config.slackClientId,
    clientSecret: config.slackClientSecret,
    signingSecret: config.slackSigningSecret,
    redirectUri: new URL("/api/v1/messaging/install/slack/callback", config.apiUrl).toString(),
  });
  const installations = new MessagingInstallations(prisma, secrets, provider, cleanupJobs);
  return {
    messaging: policyBound(new InstalledMessagingSurface(installations, provider, fallback)),
    installations,
  };
}
