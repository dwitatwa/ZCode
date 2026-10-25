/**
 * 会话屏（Column 外壳 + 桌面渲染器）的守卫。
 *
 * 1. 纯函数：头部用的格式化（项目名、轮数）。这些值出现在标题下方那一行里，
 *    写歪了不会报错，只会显示成错误的项目名。
 * 2. 作用域：与主屏同一个理由 —— 新 token 必须挂在 .cs 下。一旦有人把 --cs-* 或
 *    --bg/--fg 写回 :root，任务信息和浮层会跟着变色，而类型检查看不出来。
 * 3. 接线：正文必须是桌面那棵渲染器，且必须**懒加载**。这条是硬约束：
 *    静态引入会把 streamdown + shiki + katex 拉回首屏（实测 226KB → 1.6MB gzip）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { folderName, turnCountLabel } from "../src/mobile/lib/chatFormat.js";

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const chatCssRaw = readSource("../src/mobile/chatScreen.css");
const chatCss = chatCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const chatSource = readSource("../src/mobile/screens/ChatScreen.tsx");
const bodySource = readSource("../src/mobile/components/DesktopConversationBody.tsx");
const mobileCss = readSource("../src/mobile/mobile.css");
const mainSource = readSource("../src/mobile/main.tsx");
const platformSource = readSource("../src/mobile/lib/platform.ts");
const hostProvidersSource = readSource("../../ui/src/v4/ConversationHostProviders.tsx");

describe("header meta values", () => {
  it("uses the last path segment as the project name", () => {
    expect(folderName("/home/dev/ZCode")).toBe("ZCode");
  });

  it("handles Windows paths", () => {
    expect(folderName("C:\\Users\\dev\\ZCode")).toBe("ZCode");
  });

  it("ignores a trailing separator", () => {
    expect(folderName("/home/dev/ZCode/")).toBe("ZCode");
  });

  it("falls back to the whole path when there is nothing to split", () => {
    expect(folderName("/")).toBe("/");
  });

  it("pluralises the turn count", () => {
    expect(turnCountLabel(1)).toBe("1 turn");
    expect(turnCountLabel(0)).toBe("0 turns");
    expect(turnCountLabel(3)).toBe("3 turns");
  });
});

describe("chat screen design system scope", () => {
  it("does not redefine the global theme tokens", () => {
    expect(chatCss).not.toMatch(/^:root\s*\{/m);
  });

  it("keeps every design token under the chat screen scope", () => {
    // 每个 --cs-* 声明都必须出现在以 .cs 开头的选择器块里。
    // 不能用 split("}") 切块：值里会出现 `calc(...)`、`env(...)`，括号内的 `}`
    // 不在声明值里，但用朴素切分会把选择器与块错配。这里按行跟踪当前选择器。
    const declarations = chatCssRaw.match(/--cs-[a-z0-9-]+\s*:/g) ?? [];
    expect(declarations.length).toBeGreaterThan(10);
    let currentSelector = "";
    for (const line of chatCssRaw.split("\n")) {
      if (line.includes("{")) {
        currentSelector = line.slice(0, line.indexOf("{")).trim();
      }
      if (!/--cs-[a-z0-9-]+\s*:/.test(line)) continue;
      expect(currentSelector.startsWith(".cs")).toBe(true);
    }
  });

  it("never selects :root or bare element selectors", () => {
    const selectors = chatCss
      .split("\n")
      .filter((line) => line.includes("{"))
      .map((line) => line.slice(0, line.indexOf("{")).trim());
    for (const selector of selectors) {
      if (!selector || selector.startsWith("@") || selector.startsWith("/*")) continue;
      expect(selector).not.toContain(":root");
      // 裸元素选择器（如 `button {`）会泄漏到浮层与其它屏。
      expect(/^[a-z]/.test(selector)).toBe(false);
    }
  });

  it("does not reset buttons with a descendant selector", () => {
    // 主屏踩过这个坑：`.cs button` 的强度高于浮层的 `.option-row`，
    // 会把面板每行 padding 清成 0。要连选择器列表一起挡。
    expect(chatCss).not.toMatch(/\.cs\s+button\b/);
  });
});

describe("conversation body wiring", () => {
  it("renders the desktop conversation renderer, not a phone-local timeline", () => {
    expect(chatSource).toContain("DesktopConversationBody");
    expect(chatSource).not.toContain("components/Timeline.js");
  });

  it("loads the desktop renderer lazily", () => {
    // 静态 import 会把整棵 markdown 栈拉回首屏，首屏 gzip 从 226KB 涨到 1.6MB。
    // 断言要钉住"只有动态 import 这一个来源"：只要出现对同一模块的静态 import，
    // 打包器就会把它拉回入口，懒加载失效 —— 而 `lazy(` 字样仍然在，光查它抓不到。
    expect(bodySource).toContain('await import("@zcode/ui/conversation-timeline")');
    expect(bodySource).toContain("lazy(async () =>");
    expect(bodySource).toContain("Suspense");
    // 同一模块不得有静态值导入。
    expect(bodySource).not.toMatch(
      /^import\s+(?!type\b)[^;]*from\s+"@zcode\/ui\/conversation-timeline"/m,
    );
  });

  it("never imports from the @zcode/ui root barrel", () => {
    // 根 barrel 会带出整个桌面 app shell（工作台、会话面板、全部 shiki 语法包），
    // 实测多付约 1MB gzip。只允许窄子路径。
    expect(bodySource).not.toMatch(/from\s+"@zcode\/ui"/);
  });

  it("mounts the provider stack the renderer reads from context", () => {
    // 渲染器是从桌面 Root 那棵树里长出来的，向上取 Service / Platform / Store /
    // TabStore / Intl / Tooltip。缺一层就在渲染期抛错，整屏白掉 —— 实测报
    // "useServices 必须在 ServiceProvider 内使用"，所以这几层要一起钉住。
    expect(bodySource).toContain("@zcode/ui/conversation-host-providers");
    expect(bodySource).toContain("LazyHostProviders");
    // provider 栈本身必须真的铺了这几层（在 ui 侧断言，避免手机侧抄漏）。
    expect(hostProvidersSource).toContain("ServiceProvider");
    expect(hostProvidersSource).toContain("PlatformProvider");
    expect(hostProvidersSource).toContain("StoreProvider");
    expect(hostProvidersSource).toContain("TabStoreProvider");
    expect(hostProvidersSource).toContain("ZCodeIntlProvider");
    expect(hostProvidersSource).toContain("TooltipProvider");
  });

  it("passes the phone's service accessor into the renderer", () => {
    // 渲染器要的是整个 accessor（fileService 等），不只是 task service。
    // accessor 由入口传进会话屏，再由会话屏交给正文。
    expect(mainSource).toContain("accessor={accessor}");
    expect(chatSource).toContain("services={accessor}");
  });

  it("supplies a platform that refuses desktop-only abilities", () => {
    // 渲染器读 platform 决定是否显示"在文件管理器中打开"这类入口。
    // 手机做不到就明确回答 false，而不是假装能做。
    expect(platformSource).toContain("createMobilePlatform");
    expect(platformSource).toContain("canSelectFilePath: false");
    expect(platformSource).toContain("openInFileManager: () => unsupported(");
  });

  it("does not pass desktop-only callbacks", () => {
    // 手机没有 fork/edit/feedback/retry 的命令通路；传了只会出现点了没反应的按钮。
    expect(bodySource).not.toContain("onFork");
    expect(bodySource).not.toContain("onEdit");
    expect(bodySource).not.toContain("onFeedbackChange");
  });

  it("lets the renderer own scrolling", () => {
    // 两个滚动所有者会互相抢滚动位置，并让 sticky-to-bottom 失效。
    expect(chatSource).not.toContain('className="cs-scroll"');
  });

  it("gives the renderer a bounded flex parent", () => {
    // 渲染器靠 `flex-1 + min-h-0` 从父层取高度，再把溢出交给自己的 overflow-y-auto。
    // 父层若是普通 block，`flex-1` 没有参照，渲染器高度退回内容高度、滚动区永不溢出 ——
    // 表现就是「会话页滚不动」。这条规则曾在删旧时间线样式时被一起删掉，
    // 而类型检查与类名断言都发现不了：类名还在，只是没有规则。
    const rule = chatCss.match(/\.cs-body-wrap\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? "";
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-height:\s*0/);
    // 每个用到的容器类都必须真的有一条规则，否则它只是个没有样式的字符串。
    for (const cls of ["cs-body-wrap", "cs-empty", "cs-loading"]) {
      expect(chatCss).toContain(`.${cls}`);
      expect(chatCss).toMatch(new RegExp(`\\.${cls}\\s*[,{]`));
    }
  });
});

describe("desktop stylesheet containment", () => {
  it("keeps the page background opaque", () => {
    // @zcode/ui/styles.css 带 `html,body,#root{background:0 0!important}`
    // （Electron vibrancy 用）。手机不是 Electron，不压过它整页会透出白底。
    expect(mobileCss).toMatch(
      /html,\s*body,\s*#root\s*\{[^}]*background:\s*var\(--bg\)\s*!important/,
    );
  });

  it("applies the desktop theme before the first render", () => {
    // 行渲染器读 Tailwind 色板变量，它们挂在 .dark / .theme-zai-dark 上。
    expect(mainSource).toContain("applyTheme");
    const themeAt = mainSource.indexOf("applyTheme(");
    const renderAt = mainSource.indexOf("createRoot(");
    expect(themeAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(-1);
    expect(themeAt).toBeLessThan(renderAt);
  });
});
