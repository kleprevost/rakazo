import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import type {
  SupervisorProxyClaims,
  SupervisorProxyPurpose,
} from "@rakazo/core/node/supervisor-proxy-capability";
import {
  supervisorProxyCapabilityFromAuthorization,
  verifySupervisorProxyCapability,
} from "@rakazo/core/node/supervisor-proxy-capability";

/**
 * Reverse proxy for a computer's screen and terminal streams, for deployments where the web
 * process cannot reach the computers' Docker network (the app and the supervisor are on different
 * hosts). Routes: `/computers/<id>/screen/...` and `/computers/<id>/terminal/...`, served on the
 * supervisor's own port.
 *
 * The caller presents a capability (see `supervisor-proxy-capability.ts`), not the supervisor
 * token. The upstream address is never taken from the request: the supervisor resolves it from the
 * Docker state of the computer the capability names, and only for the ports it allows.
 */

export interface ProxyUpstream {
  host: string;
  port: number;
}

export interface SupervisorProxyOptions {
  /** `SANDBOX_SUPERVISOR_TOKEN`; the capability key is derived from it. */
  token: string;
  /** Container ports a capability may name. */
  allowedPorts: ReadonlySet<number>;
  /** Where the computer's port is reachable from the supervisor; null when it is not a managed, running computer. */
  resolveUpstream(claims: SupervisorProxyClaims): Promise<ProxyUpstream | null>;
  now?: () => number;
  /** Reasons only: never a URL, which carries a socket token. */
  log?: (message: string, details: Record<string, string | number>) => void;
  maxStreams?: number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export type ProxyRefusal = { ok: false; status: 400 | 401 | 403 | 404 | 405 };
export type ProxyRoute = {
  ok: true;
  claims: SupervisorProxyClaims;
  /** Path and query to request from the computer. */
  upstreamPath: string;
};

const ROUTE = /^\/computers\/([^/?#]+)\/(screen|terminal)\//;
const MAX_URL_LENGTH = 4096;
const DEFAULT_MAX_STREAMS = 512;
const KEEPALIVE_MS = 30_000;

/** Whether the URL belongs to the proxy. `/computers/<id>/screen` with no trailing path stays the API's. */
export function isSupervisorProxyPath(url: string | undefined) {
  return !!url && ROUTE.test(url);
}

const FORWARDED_HTTP_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "pragma",
  "range",
  "user-agent",
]);

const FORWARDED_UPGRADE_HEADERS = new Set([
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "user-agent",
]);

const HOP_BY_HOP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Decide whether this request may be proxied, and where on the computer it goes. */
export function authorizeProxyRequest(
  method: string | undefined,
  url: string | undefined,
  authorization: string | undefined,
  options: Pick<SupervisorProxyOptions, "token" | "allowedPorts" | "now">,
  websocket = false,
): ProxyRoute | ProxyRefusal {
  const match = url && url.length <= MAX_URL_LENGTH ? ROUTE.exec(url) : null;
  if (!url || !match) return { ok: false, status: 404 };
  const [prefix, computerId, purpose] = match as unknown as [
    string,
    string,
    SupervisorProxyPurpose,
  ];
  const queryAt = url.indexOf("?");
  const path = queryAt < 0 ? url : url.slice(0, queryAt);
  // Nothing may climb out of the computer's own stream route or smuggle a separator.
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(path) || /[^\x21-\x7e]/.test(url)) {
    return { ok: false, status: 400 };
  }
  if (method !== "GET" && (websocket || method !== "HEAD")) return { ok: false, status: 405 };
  const claims = verifySupervisorProxyCapability(
    options.token,
    supervisorProxyCapabilityFromAuthorization(authorization),
    options.now?.(),
  );
  if (!claims) return { ok: false, status: 401 };
  if (
    claims.computerId !== computerId ||
    claims.purpose !== purpose ||
    !options.allowedPorts.has(claims.port)
  ) {
    return { ok: false, status: 403 };
  }
  const rest = path.slice(prefix.length - 1);
  return { ok: true, claims, upstreamPath: `${rest}${queryAt < 0 ? "" : url.slice(queryAt)}` };
}

function pick(headers: IncomingHttpHeaders, allowed: Set<string>) {
  const picked: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && allowed.has(name)) picked[name] = value;
  }
  return picked;
}

const REFUSAL_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
} as const;

function refuseHttp(res: ServerResponse, status: keyof typeof REFUSAL_TEXT) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end(REFUSAL_TEXT[status]);
}

function refuseUpgrade(socket: Duplex, status: keyof typeof REFUSAL_TEXT) {
  if (socket.writable) {
    socket.end(
      `HTTP/1.1 ${status} ${REFUSAL_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

/**
 * Put the proxy in front of an existing supervisor server: its routes are answered here, and every
 * other request still reaches the listeners that were already attached.
 */
export function attachSupervisorProxy(server: Server, options: SupervisorProxyOptions) {
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const responseTimeoutMs = options.responseTimeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  let streams = 0;

  /** A stream ends with its capability, as well as with either side. */
  const track = (claims: SupervisorProxyClaims, close: () => void) => {
    streams += 1;
    const timer = setTimeout(close, Math.min(Math.max(0, claims.expiresAt - now()), 2 ** 31 - 1));
    timer.unref();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      streams -= 1;
      clearTimeout(timer);
    };
  };

  const log = (message: string, claims: SupervisorProxyClaims, extra = {}) =>
    options.log?.(message, {
      "computer.id": claims.computerId,
      "screen.purpose": claims.purpose,
      ...extra,
    });

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const route = authorizeProxyRequest(req.method, req.url, req.headers.authorization, options);
    if (!route.ok) return refuseHttp(res, route.status);
    if (streams >= maxStreams) return refuseHttp(res, 503);
    let upstream: ProxyUpstream | null;
    try {
      upstream = await options.resolveUpstream(route.claims);
    } catch {
      log("supervisor.proxy.resolve_failed", route.claims);
      return refuseHttp(res, 502);
    }
    if (!upstream) return refuseHttp(res, 404);
    if (res.destroyed) return;
    const outgoing = httpRequest({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: route.upstreamPath,
      headers: {
        ...pick(req.headers, FORWARDED_HTTP_HEADERS),
        host: `${upstream.host}:${upstream.port}`,
      },
    });
    const release = track(route.claims, () => {
      outgoing.destroy();
      res.destroy();
    });
    res.once("close", () => {
      release();
      outgoing.destroy();
    });
    outgoing.setTimeout(responseTimeoutMs, () => {
      log("supervisor.proxy.upstream_timeout", route.claims);
      refuseHttp(res, 504);
      outgoing.destroy();
    });
    outgoing.once("response", (incoming) => {
      // Past the headers a slow body is the viewer's concern, not a stall.
      outgoing.setTimeout(0);
      const headers = Object.fromEntries(
        Object.entries(incoming.headers).filter(
          ([name, value]) => value !== undefined && !HOP_BY_HOP_RESPONSE.has(name),
        ),
      );
      res.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, headers);
      pipeline(incoming, res, () => undefined);
    });
    outgoing.once("error", () => {
      log("supervisor.proxy.upstream_error", route.claims);
      refuseHttp(res, 502);
    });
    outgoing.end();
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const route = authorizeProxyRequest(
      req.method,
      req.url,
      req.headers.authorization,
      options,
      true,
    );
    if (!route.ok) return refuseUpgrade(socket, route.status);
    if (req.headers.upgrade?.toLowerCase() !== "websocket") return refuseUpgrade(socket, 400);
    if (streams >= maxStreams) return refuseUpgrade(socket, 503);
    let upstream: ProxyUpstream | null;
    try {
      upstream = await options.resolveUpstream(route.claims);
    } catch {
      log("supervisor.proxy.resolve_failed", route.claims);
      return refuseUpgrade(socket, 502);
    }
    if (!upstream) return refuseUpgrade(socket, 404);
    if (socket.destroyed) return;
    const peer = connect({ host: upstream.host, port: upstream.port });
    const release = track(route.claims, () => {
      socket.destroy();
      peer.destroy();
    });
    // Either side closing, or erroring, ends both: no half-open stream outlives its peer.
    const close = () => {
      release();
      socket.destroy();
      peer.destroy();
    };
    socket.once("close", close);
    peer.once("close", close);
    // A FIN is a goodbye on a WebSocket: pass it on, then do not wait on a peer that stays half-open.
    for (const [from, to] of [
      [socket, peer],
      [peer, socket],
    ] as const) {
      from.once("end", () => {
        to.end();
        setTimeout(close, 1_000).unref();
      });
    }
    peer.on("error", () => {
      log("supervisor.proxy.upstream_error", route.claims);
      if (!peer.connecting && peer.bytesRead > 0) return close();
      refuseUpgrade(socket, 502);
    });
    peer.setTimeout(connectTimeoutMs, () => {
      // Armed for the connect only; the stream may then idle as long as its protocol's pings allow.
      log("supervisor.proxy.upstream_timeout", route.claims);
      refuseUpgrade(socket, 504);
      peer.destroy();
    });
    peer.once("connect", () => {
      peer.setTimeout(0);
      peer.setKeepAlive(true, KEEPALIVE_MS);
      peer.setNoDelay(true);
      if ("setKeepAlive" in socket) (socket as typeof peer).setKeepAlive(true, KEEPALIVE_MS);
      const lines = [
        `GET ${route.upstreamPath} HTTP/1.1`,
        `Host: ${upstream.host}:${upstream.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
      ];
      for (const [name, value] of Object.entries(pick(req.headers, FORWARDED_UPGRADE_HEADERS))) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      // websockify checks Origin against its own address, as the web proxy's own hop does.
      if (req.headers.origin) lines.push(`Origin: http://${upstream.host}:${upstream.port}`);
      peer.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) peer.write(head);
      // Plain pipes carry backpressure and half-close in both directions.
      socket.pipe(peer);
      peer.pipe(socket);
    });
  }

  const existing = server.listeners("request") as Array<
    (req: IncomingMessage, res: ServerResponse) => void
  >;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (isSupervisorProxyPath(req.url)) {
      void handleHttp(req, res).catch(() => refuseHttp(res, 502));
      return;
    }
    for (const listener of existing) listener.call(server, req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    if (!isSupervisorProxyPath(req.url)) {
      socket.destroy();
      return;
    }
    void handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
}
