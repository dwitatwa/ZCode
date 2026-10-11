import { z } from "zod";

/**
 * 直连移动远控 —— Desktop Main 进程内起一个 loopback/Tailnet 可达的
 * HTTP + WebSocket 监听,把手机浏览器 attachment 到「当前窗口」已有 Host 的
 * local services 上(复用会话运行时,不新起 Agent / Local Host)。
 *
 * 与 Bot 渠道、独立 @zcode/server 的区别:
 * - Bot 渠道把外部消息桥进 Host,UI 在聊天软件里;
 * - 独立 server 会 createLocalServices 建一套全新 runtime,看不到桌面已开项目;
 * - 直连把手机浏览器直接接到桌面窗口的 activeServices,项目/任务/会话完全一致。
 */

/** 监听绑定模式。loopback 仅本机可见;tailnet 绑定 Tailscale 接口地址,仅 tailnet 内可达。 */
export const mobileDirectBindModes = ["loopback", "tailnet"] as const;
export type MobileDirectBindMode = (typeof mobileDirectBindModes)[number];

export const mobileDirectConnectionStateSchema = z.enum(["stopped", "starting", "running", "error"]);
export type MobileDirectConnectionState = z.infer<typeof mobileDirectConnectionStateSchema>;

export const startMobileDirectConnectionRequestSchema = z
  .object({
    bindMode: z.enum(mobileDirectBindModes).default("loopback"),
    /** 显式覆盖监听端口;省略时由系统分配空闲端口。 */
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();
export type StartMobileDirectConnectionRequest = z.infer<
  typeof startMobileDirectConnectionRequestSchema
>;

/**
 * 返回给 renderer 的配对信息。url 已携带一次性 token,渲染成二维码即可用手机扫码打开。
 * token 只在本次监听生命周期内有效,停止后立即失效。
 */
export const mobileDirectConnectionStatusSchema = z.object({
  state: mobileDirectConnectionStateSchema,
  bindMode: z.enum(mobileDirectBindModes),
  /** 监听地址(不含 token);二维码/复制链接请用 pairingUrl。 */
  baseUrl: z.string().optional(),
  /** 携带 token 的完整打开链接。 */
  pairingUrl: z.string().optional(),
  /** token 原文;用于「重新生成」时前端展示,以及让手机端手动输入。 */
  token: z.string().optional(),
  /** 已连入的移动客户端数量。 */
  connectedClients: z.number().int().min(0),
  /** state=error 时的可读错误。 */
  error: z.string().optional(),
});
export type MobileDirectConnectionStatus = z.infer<typeof mobileDirectConnectionStatusSchema>;

export function createStoppedMobileDirectConnectionStatus(
  bindMode: MobileDirectBindMode = "loopback",
): MobileDirectConnectionStatus {
  return { state: "stopped", bindMode, connectedClients: 0 };
}