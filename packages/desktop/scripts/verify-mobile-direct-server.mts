/**
 * 直连移动远控 HTTP/WS 监听的运行时冒烟验证。
 *
 * 覆盖:静态资源(mobile.html)、token 鉴权(/api/server-info 与 /ws 401)、
 * 带 token 放行并种 cookie、WS 升级后 onSocket 被调用且能收到 socket 字节。
 *
 * 运行:pnpm exec tsx packages/desktop/scripts/verify-mobile-direct-server.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ISocket } from "@zcode/rpc";

async function main(): Promise<void> {
  const { startMobileDirectServer } = await import("../src/main/mobileDirectServer.ts");

  const distRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-direct-"));
  await writeFile(join(distRoot, "mobile.html"), "<!doctype html><title>mobile</title>");

  const received: Uint8Array[] = [];
  // 多个 workspace:回归「手机端只看到一个项目」——窗口开了多个仓库时必须全部返回。
  const workspacePaths = ["/tmp/workspace-demo", "/tmp/workspace-second", "/tmp/workspace-third"];
  let workspaceCalls = 0;
  const handle = await startMobileDirectServer({
    staticRoot: distRoot,
    bindMode: "loopback",
    resolveWorkspaces: () => {
      workspaceCalls += 1;
      return workspacePaths.map((path) => ({ path, label: path.split("/").pop() ?? path }));
    },
    serverName: "ZCode Desktop",
    onSocket: (socket: ISocket) => {
      socket.onData((buf) => received.push(buf.buffer.slice()));
      return () => undefined;
    },
    logger: { info() {}, warn() {} },
  });

  try {
    assert.ok(handle.port > 0, "应拿到实际监听端口");
    assert.ok(handle.pairingUrl.includes("?token="), "pairingUrl 应带 token");

    // 静态资源:无 token 也可读 mobile.html(非受保护路径)。
    const staticRes = await fetch(`http://127.0.0.1:${handle.port}/mobile.html`);
    assert.equal(staticRes.status, 200, "mobile.html 应可公开访问");
    assert.match(await staticRes.text(), /mobile/, "mobile.html 内容应正确");

    // /api/server-info 无 token → 401。
    const unauth = await fetch(`http://127.0.0.1:${handle.port}/api/server-info`);
    assert.equal(unauth.status, 401, "无 token 访问 /api 应 401");

    // 带 token → 200,且返回当前 workspace。
    const authed = await fetch(
      `http://127.0.0.1:${handle.port}/api/server-info?token=${encodeURIComponent(handle.token)}`,
    );
    assert.equal(authed.status, 200, "带 token 访问 /api 应 200");
    const info = (await authed.json()) as {
      workspaces?: Array<{ path: string; label?: string }>;
    };
    assert.deepEqual(
      info.workspaces?.map((workspace) => workspace.path),
      workspacePaths,
      "server-info 应返回该窗口打开的全部 workspace,而不是只取第一个",
    );
    assert.equal(info.workspaces?.[0]?.label, "workspace-demo", "每个 workspace 应带出可读 label");
    assert.equal(workspaceCalls, 1, "server-info 每次请求应现取一次 workspace 列表");
    assert.ok(
      authed.headers.get("set-cookie")?.includes("zcode_lite_token"),
      "带 token 访问应种下鉴权 cookie",
    );

    // 二次请求:验证 resolveWorkspaces 是现取而非启动时快照 —— 监听启动后新开的
    // 项目,手机刷新 server-info 就能看到,不需要重启监听。
    const later = await fetch(
      `http://127.0.0.1:${handle.port}/api/server-info?token=${encodeURIComponent(handle.token)}`,
    );
    const laterInfo = (await later.json()) as { workspaces?: Array<{ path: string }> };
    assert.deepEqual(
      laterInfo.workspaces?.map((workspace) => workspace.path),
      workspacePaths,
      "二次请求应再次现取 workspace 列表",
    );
    assert.equal(workspaceCalls, 2, "workspace 列表应每次请求都重新解析");

    // WS 无 token → 连接应被拒(握手非 101)。
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
          ws.on("open", () => {
            ws.close();
            resolve();
          });
          ws.on("error", (err) => reject(err));
        }),
      "无 token 的 /ws 应被拒绝",
    );

    // WS 带 token → 升级成功,onSocket 拿到 socket,能收到手机侧字节。
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}`,
      );
      const timer = setTimeout(() => reject(new Error("WS onSocket 超时")), 3000);
      ws.on("open", () => {
        ws.send(Buffer.from("ping-bytes"));
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      const poll = setInterval(() => {
        if (received.length > 0) {
          clearInterval(poll);
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      }, 20);
    });
    assert.equal(new TextDecoder().decode(received[0]), "ping-bytes", "onSocket 应收到手机字节");
  } finally {
    await handle.close();
    await rm(distRoot, { recursive: true, force: true });
  }

  console.log("mobile-direct server runtime smoke: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
