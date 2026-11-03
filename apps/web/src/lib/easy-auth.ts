/** Platform sign-in and sign-out for deployments behind built-in authentication ("Easy Auth"). */
export const easyAuthLoginUrl = (next: string) =>
  `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(next)}`;

export const easyAuthLogoutUrl = (next: string) =>
  `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(next)}`;

/** Easy Auth's stored ID token lasts about an hour; refresh it well before then. */
const REFRESH_EVERY_MS = 30 * 60_000;

/**
 * Keeps the platform's ID token fresh so the API keeps seeing a valid identity instead of
 * ending the session hourly. Needs `offline_access` in the provider's login scopes.
 */
export function keepEasyAuthFresh(
  refresh: () => Promise<unknown> = () =>
    fetch("/.auth/refresh", { credentials: "same-origin", cache: "no-store" }),
  target: Pick<Window, "addEventListener" | "setInterval"> = window,
  now: () => number = Date.now,
): void {
  let last = now();
  const run = () => {
    last = now();
    void refresh().catch(() => undefined);
  };
  target.setInterval(run, REFRESH_EVERY_MS);
  // Timers stall in background tabs; catch up when the user comes back.
  target.addEventListener("focus", () => {
    if (now() - last >= REFRESH_EVERY_MS) run();
  });
}
