/**
 * 轻量 Markdown 渲染：只覆盖终端 agent 回复里真正会出现的语法。
 *
 * 为什么不直接用 streamdown/marked：那套东西会连带把 shiki、katex、mermaid
 * 拉进移动端包体（桌面包已经在用，体积以 MB 计）。手机经 Tailscale 加载，
 * 首屏体积是硬约束。这里手写一个够用的子集：
 *   围栏代码块 / 行内代码 / 粗体 / 斜体 / 标题 / 无序有序列表 / 引用 / 链接
 * 不做表格、数学、图表 —— 这些在手机上本来也读不了。
 */
import { Fragment, memo, type ReactNode } from "react";

interface Block {
  type: "code" | "heading" | "ul" | "ol" | "quote" | "p";
  level?: number;
  lang?: string;
  lines: string[];
}

function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    // 围栏代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // 跳过闭合围栏
      blocks.push({ type: "code", lang, lines: body });
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length, lines: [heading[2] ?? ""] });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        body.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", lines: body });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? "")) {
        body.push((lines[index] ?? "").replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ul", lines: body });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] ?? "")) {
        body.push((lines[index] ?? "").replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ol", lines: body });
      continue;
    }

    const body: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^\s*```/.test(lines[index] ?? "") &&
      !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[index] ?? "")
    ) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "p", lines: body });
  }

  return blocks;
}

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g;

/** 行内语法：代码 / 粗体 / 斜体 / 链接。链接在手机上没有好用去处，只渲染成文本。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;

  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="md-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      nodes.push(
        <span key={key} className="md-link" title={link?.[2]}>
          {link?.[1] ?? token}
        </span>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export const Markdownish = memo(function Markdownish({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, blockIndex) => {
        const key = `b-${blockIndex}`;
        switch (block.type) {
          case "code":
            return (
              <pre key={key} className="md-pre">
                {block.lang ? <span className="md-lang">{block.lang}</span> : null}
                <code>{block.lines.join("\n")}</code>
              </pre>
            );
          case "heading":
            return (
              <div key={key} className={`md-h md-h${Math.min(block.level ?? 1, 3)}`}>
                {renderInline(block.lines.join(" "), key)}
              </div>
            );
          case "ul":
            return (
              <ul key={key} className="md-ul">
                {block.lines.map((line, lineIndex) => (
                  <li key={`${key}-${lineIndex}`}>{renderInline(line, `${key}-${lineIndex}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="md-ol">
                {block.lines.map((line, lineIndex) => (
                  <li key={`${key}-${lineIndex}`}>{renderInline(line, `${key}-${lineIndex}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key} className="md-quote">
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={`${key}-${lineIndex}`}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInline(line, `${key}-${lineIndex}`)}
                  </Fragment>
                ))}
              </blockquote>
            );
          default:
            return (
              <p key={key} className="md-p">
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={`${key}-${lineIndex}`}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInline(line, `${key}-${lineIndex}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
});
