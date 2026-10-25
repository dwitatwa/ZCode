/**
 * 手机端「workspace 列出来但连不上」的呈现。
 *
 * 缺陷背景:桌面端在 socket 已 open 之后才 close(4004),浏览器侧 open 先触发,
 * connectViaWebSocket 的 promise 已经 resolve —— 手机把连接当成可用,之后的 close
 * 只剩一个没人读的 reason,界面表现为「这个项目没有任务」。所以这里锁三件事:
 * - 已知不可用的 workspace 不发起连接,直接进 unavailable 态;
 * - 连接落定后断开要回到 error 态(否则停在 ready 拿着死连接);
 * - 不可用态给出重试与切换到其它项目两条路。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/mobile/main.tsx");
const connectionSource = readSource("../src/mobile/lib/connection.ts");
const pickerSource = readSource("../src/mobile/components/WorkspacePicker.tsx");

describe("mobile unavailable workspace", () => {
  it("does not attempt a connection for a workspace the desktop marked unavailable", () => {
    expect(mainSource).toContain("const unavailableCode = workspace?.unavailableCode");
    // 必须先判断再连:连了也只会拿到一个读不到响应体的握手失败。
    const guardIndex = mainSource.indexOf("if (unavailableCode) {");
    const connectIndex = mainSource.indexOf("connectMobile(remoteIdentity,");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(connectIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(connectIndex);
    expect(mainSource).toContain('setPhase("unavailable")');
  });

  it("returns to the error screen when a live connection closes", () => {
    // 没有 onClose 的话手机会停在 ready 拿着死连接,任务列表静默失败。
    expect(mainSource).toContain("connectMobile(remoteIdentity, (event) => {");
    expect(mainSource).toContain('setPhase("error")');
    expect(connectionSource).toContain("onClose: (event) => onClose(");
  });

  it("offers a retry and a way out of the unavailable state", () => {
    expect(mainSource).toContain("is unavailable.");
    expect(mainSource).toContain("setReloadTick((tick) => tick + 1)");
    expect(mainSource).toContain("nextAvailableWorkspaceIndex");
    expect(mainSource).toContain("Use {workspaceLabel(workspaces[alternativeIndex]!)}");
  });

  it("explains both unavailability reasons", () => {
    // 文案与判断细节由 lib/workspaces.ts 的行为测试覆盖;这里只锁它确实被接上。
    expect(mainSource).toContain("unavailableNote(unavailableCode)");
  });

  it("does not reconnect when a list refresh rebuilds the workspace object", () => {
    // 缺陷背景:连接副作用原先依赖 workspace 对象。打开选择器会刷新列表 -> 对象换了
    // 引用 -> 副作用重跑 -> phase 回到 connecting -> 整屏换成 "Connecting…" ->
    // 主屏连同选择器被卸载。用户看到的是"选择器刚点开就自己关了"。
    const connectEffect = mainSource.match(
      /if \(unavailableCode\) \{[\s\S]*?\}, \[([^\]]*)\]\);/,
    );
    expect(connectEffect).not.toBeNull();
    const deps = connectEffect![1]!;
    expect(deps).toContain("connectScope");
    // 依赖里不能再出现裸 workspace 标识符(workspace?.path 这类属性访问是允许的)。
    expect(deps).not.toMatch(/(^|,\s*)workspace(\s*,|\s*$)/);
  });

  it("keeps one live connection instead of reconnecting on every refresh", () => {
    // 早退分支必须存在:同一 scope 已连上就什么都不做,刷新列表不该打断连接。
    expect(mainSource).toContain("connectedScopeRef.current === connectScope");
    expect(mainSource).toContain("workspaceScope(workspace)");
  });

  it("keeps unavailable workspaces visible but unselectable in the picker", () => {
    // 否则用户会在选择器里挑中另一个同样连不上的项目,再撞一次同样的墙。
    // 现在它们仍然列出来(用户要知道项目还在),但不可点。
    expect(pickerSource).toContain("picker.unavailable.map(");
    expect(pickerSource).toContain('aria-disabled="true"');
    expect(pickerSource).toContain("unavailableNote(");
  });
});
