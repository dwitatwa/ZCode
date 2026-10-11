/**
 * 连接层：token 解析、WS 地址与 server-info 获取。
 * token 来源：URL ?token=（顺手种进 sessionStorage）→ sessionStorage；两者皆无时
 * 依赖此前 token 链接种下的 HttpOnly cookie。
 */
import { connectViaWebSocket } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";
import type { ServerRemoteWorkspaceInfo } from "@zcode/shared";

export type MobileWorkspaceInfo = ServerRemoteWorkspaceInfo;

interface MobileServerInfo {
  workspaces?: MobileWorkspaceInfo[];
}

const TOKEN_STORAGE_KEY = "zcode-m-token";

function resolveToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export const token = resolveToken();

const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
export const wsUrl = `${wsProtocol}//${window.location.host}/ws${
  token ? `?token=${encodeURIComponent(token)}` : ""
}`;

export async function fetchServerInfo(): Promise<MobileServerInfo> {
  // /api/* 是受 token 保护的路径。只靠 URL 里的 ?token 种 HttpOnly cookie 再等下一次
  // 请求带上是不够的:首次加载时 cookie 还没种下,这个请求会直接 401,导致 workspace
  // 列表为空并显示 "No workspace configured on the server."。这里显式带上 token,
  // 既保证首次就成功,也让服务端顺手把 cookie 种下供后续 WS 复用。
  const url = token
    ? `/api/server-info?token=${encodeURIComponent(token)}`
    : "/api/server-info";
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`server-info HTTP ${res.status}`);
  }
  return (await res.json()) as MobileServerInfo;
}

export function connectMobile(): Promise<IServiceAccessor> {
  return connectViaWebSocket(wsUrl);
}

/**
 * crypto.randomUUID 只在 secure context（https / localhost）存在；
 * 手机经 http://<tailscale-ip>:3030 访问时不是 secure context，必须兜底。
 */
export function newTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const rand = (Math.random() * 16) | 0;
    const value = ch === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}
