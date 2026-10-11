/**
 * 复现并验证「手机端拿不到 workspace」的问题。
 *
 * 关键路径:手机用 /mobile.html?token=... 打开,页面里的 fetchServerInfo() 调
 * /api/server-info。修复前该请求不带 token → 401 → workspace 列表为空 →
 * 手机显示 "No workspace configured on the server."。
 *
 * 运行:pnpm exec tsx packages/desktop/scripts/verify-mobile-direct-pairing.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ISocket } from "@zcode/rpc";

async function main(): Promise<void> {
  const { startMobileDirectServer } = await import("../src/main/mobileDirectServer.ts");

  const distRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-pairing-"));
  await writeFile(join(distRoot, "mobile.html"), "<!doctype html><html><body>mobile</body></html>");

  const workspacePath = "/home/me/projects/demo";
  const handle = await startMobileDirectServer({
    staticRoot: distRoot,
    bindMode: "loopback",
    resolveWorkspaces: () => [{ path: workspacePath, label: "demo" }],
    serverName: "ZCode Desktop",
    onSocket: (_socket: ISocket) => () => undefined,
    logger: { info() {}, warn() {} },
  });

  try {
    // 1) 手机首次打开 pairing URL(浏览器会自动保存 cookie)。
    const pageRes = await fetch(handle.pairingUrl);
    assert.equal(pageRes.status, 200, "pairing URL 应能打开 mobile.html");
    const setCookie = pageRes.headers.get("set-cookie");

    // 2) 修复后的 fetchServerInfo 会带上 ?token;模拟同样的请求。
    const withToken = await fetch(
      `http://127.0.0.1:${handle.port}/api/server-info?token=${encodeURIComponent(handle.token)}`,
    );
    assert.equal(withToken.status, 200, "带 token 的 server-info 应 200");
    const info = (await withToken.json()) as {
      workspaces?: Array<{ path: string }>;
    };
    assert.equal(info.workspaces?.length, 1, "应返回 1 个 workspace");
    assert.equal(info.workspaces?.[0]?.path, workspacePath, "workspace 路径应匹配当前窗口");

    // 3) 反向验证:不带 token 就是修复前手机的行为,确实 401(说明这个修复是必要的,
    //    而不是"其实服务端本来就放行")。
    const withoutToken = await fetch(`http://127.0.0.1:${handle.port}/api/server-info`);
    assert.equal(withoutToken.status, 401, "不带 token 的 server-info 应 401(修复前手机即此路径)");

    // 4) 走 cookie 的后续请求也应放行(WS 复用同一 cookie 种下的会话)。
    const cookieValue = setCookie?.match(/zcode_lite_token=([^;]+)/)?.[1];
    assert.ok(cookieValue, "pairing URL 首次访问应种下 zcode_lite_token cookie");
    const viaCookie = await fetch(`http://127.0.0.1:${handle.port}/api/server-info`, {
      headers: { cookie: `zcode_lite_token=${cookieValue}` },
    });
    assert.equal(viaCookie.status, 200, "带 cookie 的后续请求应 200");

    // 5) WS 也必须能通(手机主链路)。
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}`,
      );
      const timer = setTimeout(() => reject(new Error("WS 连接超时")), 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    console.log("mobile-direct pairing smoke: OK");
  } finally {
    await handle.close();
    await rm(distRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
