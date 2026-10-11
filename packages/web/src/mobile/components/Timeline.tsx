/**
 * 活动流渲染：把 timeline 投影结果画成移动端原生的纵向时间线。
 *
 * 设计取舍（相对旧版的聊天气泡）：
 * - 助手正文不再包气泡，直接排在时间线上；手机上气泡只是白占左右边距。
 * - 工具调用不再是 "⚙ tool #3"，而是一行等宽摘要（真名 + 命令/文件 + 状态符），
 *   点开就地展开 input/output/error。
 * - 思考折叠成一行摘要，展开看全文；正文被裁剪时给出补拉入口。
 * - 用户输入保留一条细边引用块，用来在长流里快速定位提问点。
 */
import { memo, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import {
  dividerTone,
  formatToolPayload,
  toolDisplayName,
  toolResultPreview,
  toolStatusTone,
  toolSummary,
  TOOL_STATUS_GLYPH,
  type TimelineItem,
  type TimelineTurn,
} from "../lib/timeline.js";
import { Markdownish } from "./Markdownish.js";

/** 摘要行截断长度：够看清在干什么，又不撑破一行。 */
const SUMMARY_MAX = 96;

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > SUMMARY_MAX ? `${single.slice(0, SUMMARY_MAX)}…` : single;
}

/** turn.key 里只有 id-xxx 形式能安全进 DOM id；synthetic/msg-N 用下划线替换。 */
export function turnAnchorId(turnKey: string): string {
  return `tl-${turnKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function ToolCallItem({
  item,
  isLive,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  isLive: boolean;
}) {
  const [open, setOpen] = useState(false);
  // item.live 是投影给出的"仍在进行"事实；isLive 只是"最后一行且在跑"的兜底，
  // 供旧快照路径使用。两者取或，避免运行中的工具因后面已跟正文而被判成 neutral。
  const tone = toolStatusTone(item.tool, item.live === true || (isLive && !item.tool?.status));
  const name = toolDisplayName(item.tool, item.unresolvedIndex ?? 0);
  const summary = useMemo(() => toolSummary(item.tool), [item.tool]);
  const result = useMemo(() => toolResultPreview(item.tool), [item.tool]);

  const inputText = useMemo(
    () => (item.tool ? formatToolPayload(item.tool.input) : ""),
    [item.tool],
  );
  const outputText = useMemo(() => formatToolPayload(item.tool?.output), [item.tool]);
  const hasDetail = Boolean(inputText || outputText || item.tool?.error);

  // 快照窗口没覆盖这条工具：不伪造下标，明确说明要去桌面端看。
  if (!item.tool) {
    return (
      <div className="tl-tool tone-neutral">
        <div className="tl-tool-head as-static">
          <span className="tl-tool-glyph">·</span>
          <span className="tl-tool-summary">
            Tool call not in this snapshot{isLive ? " yet" : ""}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`tl-tool tone-${tone}${open ? " open" : ""}`}>
      <button
        className="tl-tool-head"
        onClick={() => hasDetail && setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <span className="tl-tool-glyph">{TOOL_STATUS_GLYPH[tone]}</span>
        <span className="tl-tool-name">{clip(name)}</span>
        {summary ? <span className="tl-tool-summary">{clip(summary)}</span> : null}
        {hasDetail ? (
          <ChevronRight size={13} className={`tl-tool-chev${open ? " open" : ""}`} />
        ) : null}
      </button>

      {open ? (
        <div className="tl-tool-detail">
          {item.tool?.error ? (
            <div className="tl-tool-error">
              <AlertTriangle size={12} /> {item.tool.error}
            </div>
          ) : null}
          {inputText ? (
            <div className="tl-tool-field">
              <div className="tl-tool-field-label">input</div>
              <pre>{inputText}</pre>
            </div>
          ) : null}
          {outputText ? (
            <div className="tl-tool-field">
              <div className="tl-tool-field-label">output</div>
              <pre>{clipLong(outputText)}</pre>
            </div>
          ) : null}
          {!inputText && !outputText && !item.tool?.error ? (
            <div className="tl-tool-field">
              <div className="tl-tool-field-label">no payload captured</div>
            </div>
          ) : null}
        </div>
      ) : result && tone === "failed" ? (
        <div className="tl-tool-fail-line">{clip(result)}</div>
      ) : null}
    </div>
  );
}

/** 详情面板里也做个上限，避免一条 5 万行的命令输出把页面撑死。 */
const DETAIL_MAX = 12_000;

function clipLong(text: string): string {
  return text.length > DETAIL_MAX
    ? `${text.slice(0, DETAIL_MAX)}\n\n… truncated (${text.length - DETAIL_MAX} more chars)`
    : text;
}

function ThinkingItem({
  item,
  onLoadFull,
}: {
  item: Extract<TimelineItem, { kind: "thinking" }>;
  onLoadFull?: (refId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const preview = clip(item.text);

  return (
    <div className={`tl-think${open ? " open" : ""}`}>
      <button className="tl-think-head" onClick={() => setOpen((value) => !value)}>
        <span className="tl-think-mark">✳</span>
        <span className="tl-think-label">thinking</span>
        {!open ? <span className="tl-think-preview">{preview}</span> : null}
        <ChevronRight size={13} className={`tl-tool-chev${open ? " open" : ""}`} />
      </button>
      {open ? (
        <div className="tl-think-body">
            <Markdownish text={item.text} />
          {item.bodyRefId && onLoadFull ? (
            <button className="tl-inline-action" onClick={() => onLoadFull(item.bodyRefId as string)}>
              Show full thinking
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Turn({
  turn,
  isLast,
  isGenerating,
  onLoadBodyRef,
}: {
  turn: TimelineTurn;
  isLast: boolean;
  isGenerating: boolean;
  onLoadBodyRef?: (refId: string) => void;
}) {
  return (
    <div className="tl-turn" id={turnAnchorId(turn.key)}>
      {turn.turnIndex !== null ? (
        <div className="tl-turn-rail" aria-hidden="true">
          <span className="tl-turn-mark">{turn.turnIndex + 1}</span>
        </div>
      ) : null}
      <div className="tl-turn-body">
        {turn.items.map((item, index) => {
          const itemIsLast = isLast && index === turn.items.length - 1;
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="tl-user">
                  <div className="tl-user-text">{item.text}</div>
                </div>
              );
            case "assistant-text":
              return (
                <div key={item.id} className="tl-text">
                  <Markdownish text={item.text} />
                </div>
              );
            case "thinking":
              return <ThinkingItem key={item.id} item={item} onLoadFull={onLoadBodyRef} />;
            case "tool":
              return <ToolCallItem key={item.id} item={item} isLive={isGenerating && itemIsLast} />;
            case "tool-slice-notice":
              return (
                <div key={item.id} className="tl-slice-notice">
                  Showing {item.shown} / {item.total} tool calls
                </div>
              );
            case "divider":
              return (
                <div key={item.id} className={`tl-divider tone-${dividerTone(item.meta)}`}>
                  <span>{item.label}</span>
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

export const Timeline = memo(function Timeline({
  turns,
  isGenerating,
  onLoadBodyRef,
}: {
  turns: readonly TimelineTurn[];
  isGenerating: boolean;
  onLoadBodyRef?: (refId: string) => void;
}) {
  return (
    <div className="tl">
      {turns.map((turn, index) => (
        <Turn
          key={turn.key}
          turn={turn}
          isLast={index === turns.length - 1}
          isGenerating={isGenerating}
          onLoadBodyRef={onLoadBodyRef}
        />
      ))}
    </div>
  );
});
