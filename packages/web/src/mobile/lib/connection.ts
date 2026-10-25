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

/**
 * WS 地址。
 *
 * `?workspace=<identity>` 指定要接入哪个 workspace:省略即窗口本地服务,带上远端
 * identity 时服务端会把它解析成对应的 remote scope。一个 attachment 只能绑定一个
 * scope,所以切换 workspace 是重连而不是复用同一条连接。
 */
export function buildWsUrl(workspaceIdentity?: string): string {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (workspaceIdentity) params.set("workspace", workspaceIdentity);
  const query = params.toString();
  return `${wsProtocol}//${window.location.host}/ws${query ? `?${query}` : ""}`;
}

export const wsUrl = buildWsUrl();

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

/**
 * 连接指定 workspace 的 runtime;省略 identity 即窗口本地服务。
 *
 * `onClose` 只在连接落定之后断开时才触发。为什么需要它:connectViaWebSocket 只在
 * open 之前断开时 reject,而桌面端会按空闲回收远端会话,「连上之后很快被关掉」是
 * 真实情况。没有这个回调,手机会停在 ready 状态拿着一个死连接,任务列表静默失败,
 * 界面看起来就像这个项目本来就没有任务。
 */
export function connectMobile(
  workspaceIdentity?: string,
  onClose?: (event: { code: number; reason: string }) => void,
): Promise<IServiceAccessor> {
  return connectViaWebSocket(
    buildWsUrl(workspaceIdentity),
    onClose
      ? { onClose: (event) => onClose({ code: event.code, reason: event.reason }) }
      : undefined,
  );
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
