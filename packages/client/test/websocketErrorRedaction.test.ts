/**
 * 连接失败信息不得泄漏 token。
 *
 * 直连 URL 形如 ws://host:port/ws?token=<secret>,而这条错误信息会被手机原样显示
 * 在屏幕上(也会进日志与截图)。之前把整个 URL 拼进错误信息,等于把凭据写进 UI。
 */
import { describe, expect, it, vi } from "vitest";

// websocket.ts 在模块顶层不读浏览器全局,但连接过程需要 WebSocket;这里只测拒绝信息,
// 用一个必然失败的地址即可,不需要真实 socket 行为。
import { connectViaWebSocket } from "../../client/src/websocket.js";

describe("websocket error message", () => {
  it("does not include the token from the query string", async () => {
    const secret = "super-secret-token-value";
    // 端口 1 必然连不上,用来拿到真实的拒绝信息。
    const url = `ws://127.0.0.1:1/ws?token=${encodeURIComponent(secret)}&workspace=remote%3Awsl%3AU%3Au%3A%2Fp`;

    let message = "";
    try {
      await connectViaWebSocket(url);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(secret);
    // 主机与路径保留,便于定位问题。
    expect(message).toContain("127.0.0.1:1/ws");
  });

  it("does not fire onClose for a connection that never opened", async () => {
    // 握手失败时浏览器也会发 close(1006)。若 onClose 也触发,调用方会先收到一个
    // 没有信息量的 1006,把真正的失败原因覆盖掉 —— 手机端就表现为
    // 「Connection closed (1006)」而不是实际错误。
    const onClose = vi.fn();
    await expect(
      connectViaWebSocket(`ws://127.0.0.1:1/ws?token=x`, { onClose }),
    ).rejects.toThrow();
    expect(onClose).not.toHaveBeenCalled();
  });
});
