import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { openScreenCapability, sealScreenCapability } from "@rakazo/core/node/screen-capability";
import {
  mintSupervisorProxyCapability,
  supervisorProxyAuthorization,
} from "@rakazo/core/node/supervisor-proxy-capability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProxyUpstream } from "./screen-proxy.js";
import {
  attachSupervisorProxy,
  authorizeProxyRequest,
  isSupervisorProxyPath,
} from "./screen-proxy.js";

const token = "supervisor-token-at-least-32-characters";
const PORT = 6080;
const allowedPorts = new Set([PORT]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function capability(
  grant: Partial<Parameters<typeof mintSupervisorProxyCapability>[1]> = {},
  at = Date.now(),
  key = token,
) {
  return supervisorProxyAuthorization(
    mintSupervisorProxyCapability(
      key,
      { computerId: "abc123", port: PORT, purpose: "screen", ...grant },
      at,
    ),
  );
}

describe("authorizeProxyRequest", () => {
  const options = { token, allowedPorts };
  const authorize = (url: string, authorization = capability(), method = "GET") =>
    authorizeProxyRequest(method, url, authorization, options);

  it("routes only /computers/<id>/screen|terminal/ paths", () => {
    expect(isSupervisorProxyPath("/computers/abc123/screen/embed.html")).toBe(true);
    expect(isSupervisorProxyPath("/computers/abc123/terminal/websockify?token=x")).toBe(true);
    expect(isSupervisorProxyPath("/computers/abc123/screen")).toBe(false);
    expect(isSupervisorProxyPath("/computers/abc123/exec/x")).toBe(false);
    expect(isSupervisorProxyPath("/health")).toBe(false);
  });

  it("maps the route to the computer's own path and query", () => {
    expect(
      authorize("/computers/abc123/screen/embed.html?path=websockify%3Ftoken%3Dt"),
    ).toMatchObject({ ok: true, upstreamPath: "/embed.html?path=websockify%3Ftoken%3Dt" });
    expect(authorize("/computers/abc123/screen/core/rfb.js")).toMatchObject({
      upstreamPath: "/core/rfb.js",
    });
    expect(authorize("/computers/abc123/screen/")).toMatchObject({ upstreamPath: "/" });
  });

  it("refuses a missing, foreign, expired or tampered capability", () => {
    const url = "/computers/abc123/screen/embed.html";
    expect(authorize(url, "")).toMatchObject({ ok: false, status: 401 });
    expect(authorize(url, `Bearer ${token}`)).toMatchObject({ ok: false, status: 401 });
    expect(authorize(url, capability({}, Date.now(), `${token}-other`))).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorize(url, capability({}, Date.now() - 3 * 60 * 60_000))).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorize(url, `${capability()}x`)).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses another computer, another purpose and a port that is not a screen port", () => {
    expect(authorize("/computers/other/screen/embed.html")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(authorize("/computers/abc123/terminal/embed.html")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      authorize("/computers/abc123/screen/embed.html", capability({ port: 7070 })),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses paths that climb or smuggle separators, and methods other than GET", () => {
    for (const url of [
      "/computers/abc123/screen/../terminal/x",
      "/computers/abc123/screen/%2e%2e/x",
      "/computers/abc123/screen/a%2Fb",
      "/computers/abc123/screen/a%5cb",
      "/computers/abc123/screen//x",
      "/computers/abc123/screen/a\\b",
    ]) {
      expect(authorize(url)).toMatchObject({ ok: false, status: 400 });
    }
    expect(authorize("/computers/abc123/screen/x", capability(), "POST")).toMatchObject({
      ok: false,
      status: 405,
    });
    expect(authorize("/computers/abc123/screen/x", capability(), "HEAD")).toMatchObject({
      ok: true,
    });
    expect(
      authorizeProxyRequest("HEAD", "/computers/abc123/screen/x", capability(), options, true),
    ).toMatchObject({ ok: false, status: 405 });
  });
});

interface Upstream {
  server: Server;
  port: number;
  seen: Array<{ url?: string; headers: IncomingHttpHeaders }>;
  sockets: Socket[];
  closed: number;
}

function startUpstream(): Promise<Upstream> {
  return new Promise((resolve) => {
    const upstream: Upstream = { seen: [], sockets: [], closed: 0 } as unknown as Upstream;
    upstream.seen = [];
    upstream.sockets = [];
    upstream.closed = 0;
    upstream.server = createServer((req, res) => {
      upstream.seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "upstream=secret",
        "x-computer": "yes",
      });
      res.end(`page ${req.url}`);
    });
    // A minimal websockify stand-in: complete the handshake, then echo every byte.
    upstream.server.on("upgrade", (req, socket) => {
      upstream.seen.push({ url: req.url, headers: req.headers });
      const accept = createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}${WS_GUID}`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      upstream.sockets.push(socket as Socket);
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
      // Like websockify, answer the peer's goodbye by closing too.
      socket.on("end", () => socket.end());
      socket.on("close", () => {
        upstream.closed += 1;
      });
      socket.on("error", () => undefined);
    });
    upstream.server.listen(0, "127.0.0.1", () => {
      upstream.port = (upstream.server.address() as AddressInfo).port;
      resolve(upstream);
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Open a WebSocket handshake by hand and resolve with the live socket and the response head. */
function upgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ socket: Socket; head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buffered = Buffer.alloc(0);
    socket.on("data", function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({
        socket,
        head: buffered.subarray(0, end).toString(),
        rest: buffered.subarray(end + 4),
      });
    });
    socket.on("error", reject);
    socket.on("close", () => resolve({ socket, head: buffered.toString(), rest: Buffer.alloc(0) }));
  });
}

function nextData(socket: Socket, minimum = 1): Promise<string> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= minimum) {
        socket.off("data", onData);
        resolve(received.toString());
      }
    };
    socket.on("data", onData);
  });
}

describe("supervisor stream proxy", () => {
  let upstream: Upstream;
  let proxy: Server;
  let proxyPort: number;
  let resolved: Array<{ computerId: string; port: number }>;
  let managed = true;
  const open: Socket[] = [];

  beforeEach(async () => {
    managed = true;
    resolved = [];
    upstream = await startUpstream();
    proxy = createServer((_req, res) => {
      res.writeHead(200);
      res.end("supervisor api");
    });
    attachSupervisorProxy(proxy, {
      token,
      allowedPorts,
      resolveUpstream: async (claims): Promise<ProxyUpstream | null> => {
        resolved.push({ computerId: claims.computerId, port: claims.port });
        return managed ? { host: "127.0.0.1", port: upstream.port } : null;
      },
      responseTimeoutMs: 500,
    });
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.destroy();
    for (const socket of upstream.sockets) socket.destroy();
    proxy.closeAllConnections();
    upstream.server.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.server.close(resolve));
  });

  it("leaves the supervisor's own routes alone", async () => {
    expect(await get(proxyPort, "/computers/abc123/screen")).toMatchObject({
      status: 200,
      body: "supervisor api",
    });
  });

  it("forwards a page from the computer and keeps credentials on this side", async () => {
    const response = await get(proxyPort, "/computers/abc123/screen/embed.html?path=websockify", {
      authorization: capability(),
      cookie: "session=browser",
      "accept-language": "en",
    });
    expect(response).toMatchObject({ status: 200, body: "page /embed.html?path=websockify" });
    expect(response.headers["x-computer"]).toBe("yes");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(upstream.seen[0]?.headers.authorization).toBeUndefined();
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined();
    expect(upstream.seen[0]?.headers["accept-language"]).toBe("en");
    expect(resolved).toEqual([{ computerId: "abc123", port: PORT }]);
  });

  it("never contacts the computer for a refused request", async () => {
    const refused = [
      await get(proxyPort, "/computers/abc123/screen/embed.html"),
      await get(proxyPort, "/computers/abc123/screen/embed.html", {
        authorization: `Bearer ${token}`,
      }),
      await get(proxyPort, "/computers/other/screen/embed.html", { authorization: capability() }),
      await get(proxyPort, "/computers/abc123/screen/../x", { authorization: capability() }),
      await get(proxyPort, "/computers/abc123/screen/x", { authorization: capability() }, "DELETE"),
    ];
    expect(refused.map((response) => response.status)).toEqual([401, 401, 403, 400, 405]);
    expect(upstream.seen).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("answers 404 for a computer that is not a running managed one", async () => {
    managed = false;
    const response = await get(proxyPort, "/computers/abc123/screen/embed.html", {
      authorization: capability(),
    });
    expect(response.status).toBe(404);
    expect(upstream.seen).toEqual([]);
  });

  it("carries a websocket both ways and drops the capability", async () => {
    const { socket, head } = await upgrade(
      proxyPort,
      "/computers/abc123/screen/websockify?token=socket-token",
      { authorization: capability(), Origin: "http://web.example", Cookie: "a=b" },
    );
    open.push(socket);
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
    expect(upstream.seen[0]?.url).toBe("/websockify?token=socket-token");
    expect(upstream.seen[0]?.headers.authorization).toBeUndefined();
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined();
    expect(upstream.seen[0]?.headers.origin).toBe(`http://127.0.0.1:${upstream.port}`);
    const reply = nextData(socket, "echo:hello".length);
    socket.write("hello");
    expect(await reply).toBe("echo:hello");
    // A large payload crosses intact, so backpressure does not drop or reorder bytes.
    const big = Buffer.alloc(512 * 1024, "x");
    const echoed = nextData(socket, big.length + 5);
    socket.write(big);
    expect((await echoed).length).toBeGreaterThanOrEqual(big.length + 5);
  });

  it("closes the computer's side when the viewer leaves, and the viewer's when the computer does", async () => {
    const first = await upgrade(proxyPort, "/computers/abc123/screen/websockify", {
      authorization: capability(),
    });
    first.socket.end();
    await vi_waitFor(() => upstream.closed === 1);

    const second = await upgrade(proxyPort, "/computers/abc123/screen/websockify", {
      authorization: capability(),
    });
    const closed = new Promise<void>((resolve) => second.socket.once("close", () => resolve()));
    for (const socket of upstream.sockets) socket.destroy();
    await closed;
  });

  it("refuses a websocket without a valid capability, for another computer or off the allowed path", async () => {
    const attempts = [
      await upgrade(proxyPort, "/computers/abc123/screen/websockify", {}),
      await upgrade(proxyPort, "/computers/other/screen/websockify", {
        authorization: capability(),
      }),
      await upgrade(proxyPort, "/computers/abc123/terminal/websockify", {
        authorization: capability(),
      }),
      await upgrade(proxyPort, "/computers/abc123/screen/websockify", {
        authorization: capability({ port: 7070 }),
      }),
    ];
    expect(attempts.map((attempt) => attempt.head.split(" ")[1])).toEqual([
      "401",
      "403",
      "403",
      "403",
    ]);
    expect(upstream.seen).toEqual([]);
  });

  it("ignores an upgrade outside the proxy routes", async () => {
    const attempt = await upgrade(proxyPort, "/computers/abc123/exec", {
      authorization: `Bearer ${token}`,
    });
    expect(attempt.head).toBe("");
    expect(upstream.seen).toEqual([]);
  });

  it("serves the browser path end to end: seal in the app, forward by the web process, proxy here", async () => {
    // The adapter's URL and header, sealed as the API does for the web origin.
    const streamUrl = `http://127.0.0.1:${proxyPort}/computers/abc123/screen/embed.html?path=websockify%3Ftoken%3Dsocket-token`;
    const headers = { authorization: capability() };
    const sealed = new URL(
      sealScreenCapability(
        streamUrl,
        "screen-proxy-secret-at-least-32-characters",
        "https://app.example",
        {
          botId: "bot",
          computerId: "computer",
          botGeneration: 1,
          computerGeneration: 1,
          controlLeaseId: null,
        },
        Date.now(),
        headers,
      ),
    );
    expect(sealed.toString()).not.toContain("rsc1");
    const socketPath = sealed.searchParams.get("path");
    expect(socketPath).toBe("websockify");

    // The browser asks for the page, a script beside it and the socket; the web process opens
    // each sealed capability and requests the target it names, with the sealed header.
    const prefix = sealed.pathname.slice(0, sealed.pathname.indexOf("/computers/"));
    for (const [browserPath, upstreamPath] of [
      [sealed.pathname + sealed.search, "/embed.html?path=websockify%3Ftoken%3Dsocket-token"],
      [`${prefix}/computers/abc123/screen/core/rfb.js`, "/core/rfb.js"],
    ] as const) {
      const opened = openScreenCapability(
        browserPath,
        "screen-proxy-secret-at-least-32-characters",
      );
      expect(opened?.target.hostname).toBe("127.0.0.1");
      expect(opened?.target.port).toBe(proxyPort);
      const response = await get(proxyPort, opened!.target.path, opened!.target.headers);
      expect(response.status).toBe(200);
      expect(response.body).toContain(upstreamPath.split("?")[0]);
    }

    const socketTarget = openScreenCapability(
      `${prefix}/computers/abc123/screen/websockify`,
      "screen-proxy-secret-at-least-32-characters",
    )!.target;
    expect(socketTarget.path).toBe("/computers/abc123/screen/websockify?token=socket-token");
    const { socket, head } = await upgrade(proxyPort, socketTarget.path, socketTarget.headers!);
    open.push(socket);
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
    const reply = nextData(socket, "echo:frame".length);
    socket.write("frame");
    expect(await reply).toBe("echo:frame");
    expect(upstream.seen.at(-1)?.url).toBe("/websockify?token=socket-token");
  });
});

async function vi_waitFor(condition: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
