/** Platform sign-in and sign-out for deployments behind built-in authentication ("Easy Auth"). */
export const easyAuthLoginUrl = (next: string) =>
  `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(next)}`;

export const easyAuthLogoutUrl = (next: string) =>
  `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(next)}`;
