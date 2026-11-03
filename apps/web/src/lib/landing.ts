/** Where a signed-in user starts: Today, once per sign-in, unless a link already named a place. */
export const TODAY_PATH = "/app/today";

let pending = true;

/** True once per sign-in for the first plain `/app` visit; later visits (a Back link) stay put. */
export function takeLanding(): boolean {
  const landing = pending;
  pending = false;
  return landing;
}

/** A deep link, a settings overlay or onboarding already chose the destination. */
export function settleLanding(): void {
  pending = false;
}

/** Signing out means the next sign-in starts at Today again. */
export function resetLanding(): void {
  pending = true;
}

const NO_USER_PATHS = ["/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password"];

/** Whether a route a signed-in user is on has already chosen their destination. */
export function routeSettlesLanding(pathname: string, search: string): boolean {
  if (NO_USER_PATHS.includes(pathname)) return false;
  return pathname !== "/app" || search !== "";
}
