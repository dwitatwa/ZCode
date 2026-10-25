/**
 * 直连移动远控:「workspace 列出来了但连不上」的运行时验证。
 *
 * 复现的缺陷:桌面端把断连的 WSL 项目列给手机,手机点它时服务端在 onOpen 里
 * close(4004)。但此时 WebSocket 握手已经完成,浏览器侧 open 已触发,
 * connectViaWebSocket 的 promise 已经 resolve —— 手机把连接当成可用,之后的
 * close 只剩一个没人读的 reason,界面表现为「这个项目没有任务」。
 *
 * 本脚本锁住三件事:
 * 1. /api/server-info 为不可用的远端条目带上 unavailableCode,可用条目不带;
 * 2. 对不可用 workspace 的连接在握手之前被拒(客户端收不到 open);
 * 3. 真实客户端(connectViaWebSocket)在拒绝时 reject,而不是 resolve。
 *
 * 运行:pnpm exec tsx packages/desktop/scripts/verify-mobile-direct-unavailable.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ISocket } from "@zcode/rpc";
import type { ServerRemoteWorkspaceInfo } from "@zcode/shared";

const offlineIdentity = "remote:wsl:Ubuntu:me:/home/me/offline-proj";
const onlineIdentity = "remote:wsl:Ubuntu:me:/home/me/online-proj";
const localPath = "/home/me/local-proj";

async function main(): Promise<void> {
  const { startMobileDirectServer } = await import("../src/main/mobileDirectServer.ts");

  const distRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-unavailable-"));
  await writeFile(join(distRoot, "mobile.html"), "<!doctype html><title>mobile</title>");

  // 三个条目:本地(恒可用)、已连接的远端、断连的远端。
  const workspaces: ServerRemoteWorkspaceInfo[] = [
    { path: localPath, label: "local-proj" },
    { path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\online-proj", label: "online-proj", workspaceIdentity: onlineIdentity },
    {
      path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\offline-proj",
      label: "offline-proj",
      workspaceIdentity: offlineIdentity,
      unavailableCode: "REMOTE_SESSION_MISSING",
    },
  ];

  const handle = await startMobileDirectServer({
    staticRoot: distRoot,
    bindMode: "loopback",
    resolveWorkspaces: () => workspaces,
    resolveSocketScope: (identity) => {
      if (!identity) return { ok: true as const, scope: { kind: "local" as const } };
      if (identity === onlineIdentity) {
        return {
          ok: true as const,
          scope: {
            kind: "remote" as const,
            remoteSessionId: "session-online",
            workspacePath: workspaces[1]!.path,
            workspaceIdentity: onlineIdentity,
          },
        };
      }
      return { ok: false as const, message: "远程 workspace 没有可用的连接,请在桌面端重新连接该 workspace。" };
    },
    onSocket: (_socket: ISocket) => () => undefined,
    logger: { info() {}, warn() {} },
  });

  try {
    /* ---------- 1) server-info 的可用性标记 ---------- */

    const infoRes = await fetch(
      `http://127.0.0.1:${handle.port}/api/server-info?token=${encodeURIComponent(handle.token)}`,
    );
    assert.equal(infoRes.status, 200, "带 token 的 server-info 应 200");
    const info = (await infoRes.json()) as { workspaces?: ServerRemoteWorkspaceInfo[] };
    const published = info.workspaces ?? [];
    assert.equal(published.length, 3, "三个条目都应发布给手机");

    assert.equal(published[0]?.unavailableCode, undefined, "本地条目不应带不可用标记");
    assert.equal(published[1]?.unavailableCode, undefined, "已连接的远端条目不应带不可用标记");
    assert.equal(
      published[2]?.unavailableCode,
      "REMOTE_SESSION_MISSING",
      "断连的远端条目应带上不可用原因,手机才能在选择器里标出来",
    );
    assert.equal(
      published[2]?.workspaceIdentity,
      offlineIdentity,
      "不可用条目仍要保留 identity —— 手机重试时还要用它",
    );

    /* ---------- 2) 拒绝发生在握手之前 ---------- */

    const offlineEvents: string[] = [];
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}&workspace=${encodeURIComponent(offlineIdentity)}`,
      );
      ws.on("open", () => offlineEvents.push("open"));
      ws.on("close", (code) => {
        offlineEvents.push(`close:${code}`);
        resolve();
      });
      ws.on("error", () => {
        // 握手被拒时 ws 客户端只发 error(不带 open)。
        offlineEvents.push("error");
      });
      setTimeout(() => {
        offlineEvents.push("timeout");
        resolve();
      }, 3000);
    });
    assert.ok(
      !offlineEvents.includes("open"),
      `不可用 workspace 不应握手成功(实际事件:${JSON.stringify(offlineEvents)})`,
    );

    /* ---------- 3) 真实客户端必须 reject ---------- */

    const { connectViaWebSocket } = await import("../../client/src/websocket.ts");
    await assert.rejects(
      () =>
        connectViaWebSocket(
          `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}&workspace=${encodeURIComponent(offlineIdentity)}`,
        ),
      "真实客户端在握手被拒时应 reject,而不是把连接当成可用",
    );

    /* ---------- 4) 可用路径不受影响 ---------- */

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}&workspace=${encodeURIComponent(onlineIdentity)}`,
      );
      const timer = setTimeout(() => reject(new Error("已连接 workspace 的 WS 应能 open")), 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const openSockets: WebSocket[] = [];
    const localAccessor = await connectViaWebSocket(
      `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}`,
      { onOpenSocket: (socket) => openSockets.push(socket) },
    );
    assert.ok(localAccessor.zcodeTaskService, "本地 workspace 仍应能建立连接并拿到服务");

    /* ---------- 5) 报错信息不得带 token ---------- */

    let rejectedMessage = "";
    try {
      await connectViaWebSocket(
        `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(handle.token)}&workspace=${encodeURIComponent(offlineIdentity)}`,
      );
    } catch (error) {
      rejectedMessage = error instanceof Error ? error.message : String(error);
    }
    assert.ok(rejectedMessage.length > 0, "拒绝应带错误信息");
    assert.ok(
      !rejectedMessage.includes(handle.token),
      `错误信息不得包含 token(实际:${rejectedMessage})`,
    );

    // 收尾:先断开仍然活着的客户端连接,否则 server.close() 会等它们。
    for (const socket of openSockets) socket.close();

    console.log("mobile-direct unavailable workspace: OK");
  } finally {
    await handle.close();
    await rm(distRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
