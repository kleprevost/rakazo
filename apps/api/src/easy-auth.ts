import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MiddlewareHandler } from "hono";
import { clientIpHeaders, requestClientIp } from "./client-ip.js";

type EasyAuthPass = (
  headers: Headers,
  options: { create: boolean },
) => Promise<{ cookie: string | undefined; setCookies: string[]; outcome?: string }>;

const ID_TOKEN_HEADER = "x-ms-token-aad-id-token";
const SIGN_OUT_PATH = "/api/auth/sign-out";

/**
 * The earliest seam for sessions: every later session read (RPC, streams, HTTP routes and the auth
 * handler itself) sees the request this leaves behind. A request with a verified Easy Auth identity
 * gets a Rakazo session; one whose session was bound to Easy Auth but no longer carries a verified
 * identity loses it. The pass reads only headers, so it costs nothing for requests that carry
 * neither the platform's token nor a cookie.
 */
export function easyAuthMiddleware(pass: EasyAuthPass | undefined): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!pass || (!raw.headers.has(ID_TOKEN_HEADER) && !raw.headers.get("cookie"))) return next();
    // Better Auth reads the caller's address from one header that only the API may set.
    // Headers only: building a Request here would move the body out of `raw` and leave later
    // handlers an already-read body.
    const headers = clientIpHeaders(raw.headers, requestClientIp(c));
    const result = await runAsSystem("authentication", () =>
      pass(headers, { create: new URL(c.req.url).pathname !== SIGN_OUT_PATH }),
    );
    // Routine outcomes stay quiet; anything that hides, ends or skips a session is worth a line.
    if (result.outcome && result.outcome !== "kept" && result.outcome !== "kept-native")
      getLogger().info("auth.easy_auth", { "easy_auth.outcome": result.outcome });
    if (result.cookie !== undefined) {
      const rewritten = new Headers(raw.headers);
      if (result.cookie) rewritten.set("cookie", result.cookie);
      else rewritten.delete("cookie");
      c.req.raw = new Request(raw, { headers: rewritten });
    }
    await next();
    for (const cookie of result.setCookies) c.header("set-cookie", cookie, { append: true });
  };
}
