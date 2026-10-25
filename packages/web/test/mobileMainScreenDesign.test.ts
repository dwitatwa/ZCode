/**
 * 主屏设计系统的两条硬约束。
 *
 * 1. 主屏换配色不得影响其它屏。聊天屏、任务信息、composer、浮层都还是旧视觉,
 *    所以新 token 必须挂在 .ms 作用域里;一旦有人把 --ms-* 或 --bg/--fg 写回
 *    :root,那些屏会跟着变色,而单元测试和类型检查都不会发现。
 * 2. 标题左侧不得出现圆点/竖条/图标。这是用户明确否掉的形态,靠人眼守不住,
 *    所以在这里锁住:行内第一个子元素必须是标题本身。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainScreenCssRaw = readSource("../src/mobile/mainScreen.css");
/** 注释里会提到 :root、button 这些词,检查作用域前先剥掉,否则测的是注释而不是规则。 */
const mainScreenCss = mainScreenCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const legacyCss = readSource("../src/mobile/mobile.css");
const explorerSource = readSource("../src/mobile/screens/ExplorerScreen.tsx");
const pickerSource = readSource("../src/mobile/components/WorkspacePicker.tsx");

describe("main screen design system scope", () => {
  it("does not redefine the global theme tokens", () => {
    // 旧视觉的 token 仍然由 mobile.css 的 :root 提供,主屏不得覆盖它们。
    for (const token of ["--bg:", "--fg:", "--accent:", "--danger:", "--surface:"]) {
      expect(mainScreenCss).not.toContain(token);
    }
  });

  it("keeps every design token under a main-screen scope", () => {
    // 所有自定义属性都必须出现在 .ms / .ms-sheet 这类主屏作用域块里。
    // 浮层由 Sheet 渲染在 .ms 之外,所以它有自己的一组 --ms-sheet-* token;
    // 但同样不许落到 :root 或裸元素上,否则其它屏会跟着变色。
    const declared = [...mainScreenCss.matchAll(/(--ms-[a-z-]+):/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10);

    for (const token of declared) {
      const declaration = `${token}:`;
      const blockStarts = [...mainScreenCss.matchAll(/(^|\n)([^{}\n][^{}]*)\{/g)].map((m) => ({
        selector: m[2]!.trim(),
        bodyStart: m.index! + m[0].length,
      }));
      const block = blockStarts.find((candidate) => {
        const rest = mainScreenCss.slice(candidate.bodyStart);
        const bodyEnd = rest.indexOf("\n}");
        return bodyEnd !== -1 && rest.slice(0, bodyEnd).includes(declaration);
      });
      expect(block, `${token} is declared outside a scoped block`).toBeDefined();
      expect(block!.selector.startsWith(".ms"), `${token} leaked into ${block!.selector}`).toBe(true);
    }
  });

  it("never selects :root or bare element selectors", () => {
    // 裸元素选择器(如 button {})会作用到整个应用,不只是主屏。
    expect(mainScreenCss).not.toContain(":root");
    const selectors = mainScreenCss
      .split("\n")
      .filter((line) => /^[a-z]/.test(line.trim()) && line.includes("{"));
    expect(selectors).toEqual([]);
  });

  it("scopes the legacy remote tag styling to the main screen", () => {
    // ws-remote-tag 仍被选择器浮层使用,主屏只在 .ms 里覆盖它的颜色。
    expect(mainScreenCss).toContain(".ms .ws-remote-tag");
    expect(mainScreenCss).toContain(".ms .ws-offline-tag");
  });
});

describe("main screen row markup", () => {
  it("starts every row with the title, with no marker before it", () => {
    // 行内结构固定为 标题 → 右槽 → 菜单。标题前出现任何元素都算回归。
    // 只取行容器开标签之后的内容,否则会匹配到容器自己的 <div。
    // 用 \r? 兼容 CRLF:检出时行尾会变,规则不该因此失效。
    const rowMatch = explorerSource.match(
      /<div className=\{`ms-row[\s\S]*?<\/div>\r?\n  \);/,
    );
    expect(rowMatch).not.toBeNull();
    const row = rowMatch![0];
    const bodyStart = row.indexOf(">") + 1;
    const titleIndex = row.indexOf('className="ms-title"');
    expect(titleIndex).toBeGreaterThan(bodyStart);
    // 标题之前不能再有子元素。
    const beforeTitle = row.slice(bodyStart, titleIndex);
    expect(beforeTitle).not.toContain("<span");
    expect(beforeTitle).not.toContain("<div");
    expect(beforeTitle).not.toContain("size={");
  });

  it("puts the status word in the single right slot", () => {
    expect(explorerSource).toContain("taskRightSlot(task.status, relativeTime(task.updatedAt))");
    expect(explorerSource).toContain('<span className={`ms-slot ${slot.tone}`}>{slot.text}</span>');
  });

  it("does not reintroduce a per-row status dot or cursor", () => {
    // run-cursor 是旧版的闪烁方块;它属于被否掉的「标题左侧标记」形态。
    expect(explorerSource).not.toContain("run-cursor");
    expect(explorerSource).not.toContain("task-status");
    expect(legacyCss).not.toContain(".run-cursor");
  });

  it("keeps the archived section collapsible at the bottom of the list", () => {
    expect(explorerSource).toContain("ms-archived-toggle");
    expect(explorerSource).toContain('aria-expanded={archivedOpen}');
  });

  it("attaches the picker chevron to the workspace name", () => {
    // 缺陷背景:名字用了 flex:1 伸展,把箭头推到行尾;箭头又是 10px 的 ▾ 文字字符,
    // 结果是名字和 "+" 之间飘着一个看不清的小符号,没人能看出它属于名字。
    // 现在:名字按内容宽度,箭头紧跟其后,并且是真实图标而不是字符。
    expect(explorerSource).toContain('<ChevronDown className="ms-name-chev" size={16}');
    expect(explorerSource).not.toContain("&#9662;");
    // .ms-name 不得再伸展,否则箭头又被推走。
    const nameRule = mainScreenCss.match(/\.ms-name\s*\{([^}]*)\}/);
    expect(nameRule).not.toBeNull();
    expect(nameRule![1]).not.toMatch(/\bflex:\s*1/);
  });
});

describe("workspace picker", () => {
  it("never renders an unavailable workspace as a selectable row", () => {
    // 缺陷背景:不可用项曾经是可点的 button,点中后整屏换成错误页。
    // 现在它们只渲染成 div + aria-disabled,并且不带 onClick。
    const unavailableBlock = pickerSource.match(/picker\.unavailable\.map\(([\s\S]*?)\n          \)\)\}/);
    expect(unavailableBlock).not.toBeNull();
    const block = unavailableBlock![1]!;
    expect(block).toContain('aria-disabled="true"');
    expect(block).not.toContain("onClick");
    expect(block).not.toContain("<button");
  });

  it("keeps unavailable entries out of the clickable list", () => {
    // 可用列表只能来自 picker.available;直接遍历 workspaces 会把死项放回可点区。
    expect(pickerSource).toContain("picker.available.map(");
    expect(pickerSource).not.toMatch(/workspaces\.map\(/);
  });

  it("explains why an entry cannot be used", () => {
    // 只说 offline 不够:用户要的是「接下来做什么」。
    expect(pickerSource).toContain("unavailableNote(picker.unavailable[0]!.item.unavailableCode)");
  });

  it("states the reason once instead of repeating it per row", () => {
    // 六行同样的整句会把列表拉长一倍,而用户并没有多知道任何事。
    expect(pickerSource).toContain('className="ms-sheet-note"');
    expect(pickerSource).not.toContain("ms-sheet-reason");
  });

  it("does not crowd the project name with two inline tags", () => {
    // remote + offline 并排会把名字挤到只剩几十像素,所以不可用项只留 remote 标记,
    // offline 改由分组标题和原因行表达。
    expect(pickerSource).not.toContain("ws-offline-tag");
  });

  it("does not let the main-screen button reset flatten the sheet rows", () => {
    // .ms button 的选择器强度高于 .option-row,曾把浮层每行 padding 清成 0。
    expect(mainScreenCss).not.toMatch(/\.ms\s+button\s*\{/);
    expect(mainScreenCss).toContain(".ms .ms-row-menu,");
  });
});
