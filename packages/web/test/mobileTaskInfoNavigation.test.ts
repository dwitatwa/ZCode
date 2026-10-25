/**
 * 移动端导航结构守卫：Info 是任务级视图，不是全局 tab。
 *
 * 这里用源码/字符串断言而不是渲染断言 —— main.tsx 在模块顶层直接
 * createRoot(...).render(...)，jsdom 里导入即挂载，且整条 RPC 链路需要真实
 * host 才能就绪。导航形状本身是结构性事实（哪个 pane 由什么条件决定显示），
 * 用源码守卫既稳定又直接对应缺陷成因。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/mobile/main.tsx");
const chatSource = readSource("../src/mobile/screens/ChatScreen.tsx");
const infoSource = readSource("../src/mobile/screens/InfoScreen.tsx");
const css = readSource("../src/mobile/mobile.css");

describe("mobile task info navigation", () => {
  it("offers no Info tab in the bottom navigation", () => {
    expect(mainSource).not.toContain("tabbar");
    expect(mainSource).not.toContain('key: "info"');
    expect(mainSource).not.toContain("pendingCount");
    expect(mainSource).not.toContain("setTab(");
  });

  it("removes the bottom navigation styles with the element", () => {
    expect(css).not.toContain(".tabbar");
    expect(css).not.toContain(".tab-dot");
    expect(css).not.toContain(".tab-icon");
  });

  it("gates both task panes on an open task", () => {
    // 每个 pane 的 display 都必须同时受 activeTask 约束，
    // 否则「已挂载但不可见」的 pane 会盖住任务列表吃掉点击。
    const paneDisplays = [...mainSource.matchAll(/style=\{\{ display: ([^}]+) \}\}/g)].map(
      (match) => match[1]!,
    );
    expect(paneDisplays.length).toBe(3);
    for (const condition of paneDisplays) {
      const needsTask = condition.includes("taskView") || condition.includes("activeTask");
      expect(needsTask).toBe(true);
    }
    expect(paneDisplays.filter((c) => c.includes("taskView")).length).toBe(2);
  });

  it("opens info from inside the chat top bar", () => {
    expect(chatSource).toContain("onOpenInfo");
    expect(chatSource).toContain('aria-label="Task info"');
    // 会话屏改用 .cs 作用域后按钮类名是 cs-info；守卫跟着改，但要求它仍在头部里，
    // 否则「任务信息」入口会被挪到正文某个角落而不被测试发现。
    expect(chatSource).toContain('className="cs-info"');
    const header = chatSource.match(/<header className="cs-head">([\s\S]*?)<\/header>/);
    expect(header).not.toBeNull();
    expect(header![1]).toContain('aria-label="Task info"');
  });

  it("returns from info with a back control", () => {
    expect(infoSource).toContain("onBack");
    expect(infoSource).toContain("topbar-back");
    expect(infoSource).toContain('aria-label="Back"');
  });

  it("resets the task view when the open task changes", () => {
    expect(mainSource).toContain("setTaskView(\"chat\")");
    expect(mainSource).toContain("}, [activeTask?.taskId]);");
  });
});
