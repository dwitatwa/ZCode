/* eslint-disable max-lines -- 直连远控监听集中维护 HTTP 静态、鉴权与 WS 升级顺序,拆分会让安全边界更难审计。 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import { Emitter, VSBuffer, type ISocket } from "@zcode/rpc";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_VERSION,
  type MobileDirectBindMode,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
  type WindowHostAttachmentScope,
} from "@zcode/shared";

/**
 * 直连移动远控的 HTTP + WebSocket 监听。
 *
 * 刻意不复用 createHttpServer(packages/server):后者会 createLocalServices 起一套全新
 * runtime,手机就看不到桌面已打开的项目。这里只是一个「薄壳」——静态资源 + 鉴权 + WS 升级,
 * 业务全部由 attachment 到的窗口 Host 提供。
 */

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** 与 server 端同构:把 ws 包装成 RPC 的 ISocket(二进制帧)。 */
function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  root: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const resolvedRoot = resolve(root);
  const relativePath = decodeURIComponent(pathname).replace(/^\/+/u, "");
  let candidate = resolve(resolvedRoot, relativePath);
  if (!isInsideDirectory(resolvedRoot, candidate)) return null;

  try {
    const fileStat = await stat(candidate);
    if (fileStat.isFile()) return candidate;
    if (fileStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
  } catch {
    // 落入 SPA fallback
  }

  if (!spaFallback || isTokenProtectedPath(pathname)) return null;
  const indexFile = resolve(resolvedRoot, "mobile.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

export interface MobileDirectServerHandle {
  port: number;
  /** 监听地址(不含 token),形如 http://100.x.y.z:port。 */
  baseUrl: string;
  token: string;
  /** 携带 token 的打开链接。 */
  pairingUrl: string;
  close(): Promise<void>;
}

export interface StartMobileDirectServerOptions {
  staticRoot: string;
  bindMode: MobileDirectBindMode;
  port?: number;
  /**
   * 暴露给手机的 workspace 列表（每次 /api/server-info 现取）。
   *
   * 之前这里只有单个 workspacePath,导致手机端永远只看到一个项目 —— 桌面窗口
   * 同时开着多个仓库时,其余项目在手机上完全不可见。改为回调而非快照:监听启动后
   * 用户在桌面新开的项目,手机刷新一次 server-info 就能看到,不必重启监听。
   * 返回顺序即手机端选择器的展示顺序,第一项是默认选中项。
   */
  resolveWorkspaces: () => readonly ServerRemoteWorkspaceInfo[];
  /**
   * 把手机请求的 workspace identity 解析成 attachment scope。
   *
   * 手机只报 identity,不报 sessionId —— scope 由这里在窗口自己的会话表里解析,
   * 过期或伪造的 id 无法指向别的窗口。解析失败返回原因,连接被拒绝而不是回退到本地服务。
   * 省略 identity 表示请求本地窗口(默认)。
   */
  resolveSocketScope?: (workspaceIdentity: string | undefined) =>
    | { ok: true; scope: WindowHostAttachmentScope }
    | { ok: false; message: string };
  serverName?: string;
  /** 每个新接入的 WebSocket 交给 bridge。返回该客户端的 disposer。 */
  onSocket: (socket: ISocket, scope: WindowHostAttachmentScope) => () => void;
  logger: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

/**
 * 解析监听地址。
 *
 * loopback → 127.0.0.1(仅本机;适合先本地验证链路)。
 * tailnet  → 绑定 Tailscale 接口地址(100.64.0.0/10 CGNAT),只有 tailnet 成员可达;
 *            找不到 Tailscale 接口时 fail-closed,不回退 0.0.0.0,避免误把服务暴露到局域网。
 */
export function resolveMobileDirectBindAddress(bindMode: MobileDirectBindMode): {
  host: string;
  reachableHost: string;
} {
  if (bindMode === "loopback") {
    return { host: "127.0.0.1", reachableHost: "127.0.0.1" };
  }

  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // Tailscale 使用 CGNAT 段 100.64.0.0/10。
      const parts = address.address.split(".").map((part) => Number(part));
      const first = parts[0];
      const second = parts[1];
      if (first === 100 && second !== undefined && second >= 64 && second <= 127) {
        return { host: address.address, reachableHost: address.address };
      }
    }
  }

  throw new Error(
    "未检测到 Tailscale 网络地址(100.64.0.0/10)。请确认 Tailscale 已登录,或改用「仅本机」模式。",
  );
}

export async function startMobileDirectServer(
  options: StartMobileDirectServerOptions,
): Promise<MobileDirectServerHandle> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const token = randomBytes(24).toString("base64url");
  const { host, reachableHost } = resolveMobileDirectBindAddress(options.bindMode);

  // 与 server 端同款:token 可走 ?token=(种 HttpOnly cookie),或已种下的 cookie。
  // /ws 与 /api/* 一律强制校验,否则直接 401 —— Tailscale 的身份不能替代会话鉴权。
  //
  // 注意:静态入口(/mobile.html?token=...)不是受保护路径。若只在受保护路径种 cookie,
  // 手机首次打开二维码链接时 cookie 还没种下,紧随其后的 /api/server-info 就会 401,
  // 表现为 workspace 列表为空。这里改为「任意路径带合法 token 都顺手种 cookie」,
  // 只有真正的强制校验仍限定在受保护路径上。
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const fromQuery = url.searchParams.get("token");
    const hasValidQueryToken = Boolean(fromQuery && safeEqual(fromQuery, token));
    if (hasValidQueryToken) {
      c.header(
        "Set-Cookie",
        `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
      );
    }
    if (!isTokenProtectedPath(pathname)) {
      await next();
      return;
    }
    if (hasValidQueryToken) {
      await next();
      return;
    }
    const cookie = parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName);
    if (cookie && safeEqual(cookie, token)) {
      await next();
      return;
    }
    return c.json({ error: "Unauthorized" }, 401);
  });

  app.get("/api/server-info", (c) => {
    const info: ServerRemoteInfo = {
      serverId: "zcode-desktop-direct",
      ...(options.serverName ? { name: options.serverName } : {}),
      version: ZCODE_VERSION,
      protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
      authRequired: true,
      workspaces: options.resolveWorkspaces().map((workspace) => ({ ...workspace })),
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: false,
      },
    };
    return c.json(info);
  });

  app.get(
    "/ws",
    (c) => {
      // token middleware 已放行才可能走到这里。
      // ?workspace=<identity> 指定要接入的 workspace;省略即本地窗口。
      const requestedIdentity = c.req.query("workspace")?.trim() || undefined;
      const resolved = options.resolveSocketScope
        ? options.resolveSocketScope(requestedIdentity)
        : { ok: true as const, scope: { kind: "local" as const } };
      if (!resolved.ok) {
        // 必须在握手之前拒绝:先 upgrade 成功再 close 的话,浏览器侧 open 事件已经
        // 触发,connectViaWebSocket 的 promise 已经 resolve,手机就会把连接当成可用,
        // 之后的 close(4004) 只剩一个没人读的 reason —— 界面表现为「这个项目没有任务」。
        // 这里直接返回 HTTP 错误,握手不成立,客户端 promise reject。
        return c.text(resolved.message, 400);
      }
      const scope = resolved.scope;
      return upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          const detach = options.onSocket(wrapWebSocket(ws.raw as WebSocket), scope);
          ws.raw?.once?.("close", () => detach());
        },
      }))(c);
    },
  );

  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const filePath = await resolveStaticFile(options.staticRoot, pathname, true);
    if (!filePath) return c.notFound();
    return c.body(await readFile(filePath), 200, {
      "Cache-Control": filePath.endsWith(".html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      "Content-Type": staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    });
  });

  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolveFn) => {
    resolveListening = resolveFn;
  });

  const server = serve(
    { fetch: app.fetch, hostname: host, port: options.port ?? 0 },
    (info) => resolveListening({ port: info.port }),
  );
  injectWebSocket(server);
  const { port } = await listening;

  const baseUrl = `http://${reachableHost}:${port}`;
  const pairingUrl = `${baseUrl}/mobile.html?token=${encodeURIComponent(token)}`;

  options.logger.info("[mobile-direct] listening", { bindMode: options.bindMode, baseUrl });

  return {
    port,
    baseUrl,
    token,
    pairingUrl,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}