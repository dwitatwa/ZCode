import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8");

describe("ConversationTimeline mask sync stability", () => {
  it("syncMessageLayerMask 的 dock 有无经 render 同步 ref 读取，依赖保持空", () => {
    // Bug 根因：bottomDock 是 SessionPane 每次渲染新建的 React 元素。若它直接进
    // syncMessageLayerMask 的 useCallback 依赖，该回调身份随每次投影更新变化，
    // 沿 syncTurnNavigatorViewport → scrollToBottom / restoreScrollMemory 连锁失稳，
    // 会话切换 effect（依赖 scrollToBottom）在每次渲染重跑并执行 virtualizer.measure()
    // —— 它清空 itemSizeCache，把已测得的行高全部打回 72px 估算值；RO 之后不会对
    // 尺寸未变的行再发通知，错位永久化（手机冷开长会话稳定复现「行重叠 +
    // sticky composer 沉到视口外」）。回读必须走 render 同步 ref。
    expect(source).toContain("bottomDockPresenceRef.current = bottomDock;");
    const callbackStart = source.indexOf("const syncMessageLayerMask = useCallback(");
    expect(callbackStart).toBeGreaterThan(-1);
    const callbackTail = source.indexOf("}, []);", callbackStart);
    expect(callbackTail).toBeGreaterThan(callbackStart);
    const callbackBody = source.slice(callbackStart, callbackTail);
    expect(callbackBody).toContain("bottomDockPresenceRef.current");
    // 依赖数组里不得再出现 bottomDock（哪怕是 [bottomDock]）。
    expect(callbackBody).not.toMatch(/\[\s*bottomDock\s*\]\s*\)/);
  });
});
