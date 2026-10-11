/**
 * Composer：底部单行输入栏 + 三个配置入口（Access / Model / Thinking）。
 *
 * 旧版把三个选择器 chip 常驻在输入框上方，手机竖屏下经常占掉 80px 以上。
 * 现在把它们收进左侧一个"配置"按钮，点开才是面板；主输入区只留输入框和发送。
 * 运行态时发送键就地变成停止键，不额外占位。
 *
 * 配置语义与桌面草稿一致：只存"用户显式覆盖"，随 sendPrompt 提交，不落任务配置。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Sliders, Square } from "lucide-react";
import type { ModelSelection, ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import {
  ACCESS_MODES,
  accessModeLabel,
  findConfigOption,
  groupModels,
  modelEntries,
  thoughtLabel,
} from "../lib/catalog.js";
import type { ComposerDraft } from "../lib/types.js";
import { OptionSheet, Sheet } from "./Overlays.js";

const SUBMITTABLE_MODES = ["build", "edit", "plan", "yolo"] as const;
export type SubmittableMode = (typeof SUBMITTABLE_MODES)[number];

function normalizeMode(value: string | null | undefined): SubmittableMode {
  return SUBMITTABLE_MODES.find((mode) => mode === value) ?? "build";
}

/** 输入框随内容增高，但有上限；超过后内部滚动。 */
const MAX_INPUT_HEIGHT = 132;

/** 触屏设备上 Enter 是换行，不该当提交用。 */
function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

export function Composer({
  meta,
  configOptions,
  draft,
  onDraftChange,
  generating,
  sending,
  onSend,
  onStop,
}: {
  meta: ZCodeTaskMeta;
  configOptions: ZCodeConfigOption[] | undefined;
  draft: ComposerDraft;
  onDraftChange: (next: ComposerDraft) => void;
  generating: boolean;
  sending: boolean;
  onSend: (content: string, modelSelection: ModelSelection | undefined, mode: SubmittableMode) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [sheet, setSheet] = useState<null | "config" | "mode" | "model" | "thought">(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const modelOption = findConfigOption(configOptions, "model");
  const thoughtOption = findConfigOption(configOptions, "thought_level");
  const effectiveModelValue = draft.modelValue ?? String(modelOption?.currentValue ?? "");
  const effectiveModel = modelEntries(modelOption).find(
    (entry) => entry.rawValue === effectiveModelValue,
  );
  const effectiveThought = draft.thought ?? String(thoughtOption?.currentValue ?? "");
  const rawMode = normalizeMode(draft.mode ?? meta.mode);
  const modelGroups = groupModels(modelEntries(modelOption));
  const thoughtLevels =
    draft.modelValue && effectiveModel
      ? effectiveModel.thoughtLevels
      : (thoughtOption?.options ?? []).map((entry) => entry.value);

  // 自适应高度：先归零再取 scrollHeight，否则删字时不会回缩。
  //
  // 必须补上上下边框：全局 box-sizing 是 border-box，而 scrollHeight 只含 padding
  // 不含 border。直接 height = scrollHeight 会让内容区比一行文字矮约 2px，浏览器判定
  // 溢出并画出输入框右侧那根多余的滚动条（手机截图里"输入框旁边莫名其妙一条竖线"）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const borderY = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borderY, MAX_INPUT_HEIGHT)}px`;
  }, [input]);

  const submit = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setInput("");
    let modelSelection: ModelSelection | undefined;
    if (effectiveModelValue) {
      try {
        const parsed = parseModelPickerValue(effectiveModelValue);
        // 档位随提交发送（与桌面草稿语义一致）：优先用户选择/服务端当前档，
        // 再退到原值自带档位与目录默认档。剥掉档位会让强制要求 reasoning
        // level 的模型（如 GLM-5.3 会员源）在 model_creation 阶段直接报错。
        const reasoning =
          (effectiveThought.length > 0 ? effectiveThought : null) ??
          parsed.options?.reasoningLevel ??
          effectiveModel?.defaultThoughtLevel;
        modelSelection = {
          ...parsed,
          ...(reasoning ? { options: { reasoningLevel: reasoning } } : {}),
        };
      } catch {
        // 原值解析失败则不带 modelSelection，与旧行为一致。
      }
    }
    await onSend(content, modelSelection, rawMode);
  };

  return (
    <>
      <div className="composer">
        <button className="composer-config" onClick={() => setSheet("config")} aria-label="Session settings">
          <Sliders size={16} />
        </button>

        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={input}
          placeholder={generating ? "Queue a message…" : "Ask for changes…"}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // 手机软键盘 Enter 通常是换行意图；只在非触屏（鼠标/桌面调试）上提交。
            if (event.key === "Enter" && !event.shiftKey && !isTouchDevice()) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        {generating ? (
          <button
            className="composer-btn stop"
            onClick={() => void onStop()}
            aria-label="Stop generation"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : null}

        <button
          className="composer-btn send"
          onClick={() => void submit()}
          disabled={sending || input.trim().length === 0}
          aria-label="Send"
        >
          <ArrowUp size={17} strokeWidth={2.6} />
        </button>
      </div>

      {/* 汇总配置面板：一次看到当前档位，点进去改单项。 */}
      {sheet === "config" ? (
        <Sheet title="Session settings" onClose={() => setSheet(null)}>
          <button className="config-row" onClick={() => setSheet("mode")}>
            <span className="config-key">Access</span>
            <span className="config-value">{accessModeLabel(rawMode)}</span>
          </button>
          {modelOption ? (
            <button className="config-row" onClick={() => setSheet("model")}>
              <span className="config-key">Model</span>
              <span className="config-value">
                {effectiveModel?.name ?? (effectiveModelValue || "—")}
              </span>
            </button>
          ) : null}
          {thoughtLevels.length > 0 ? (
            <button className="config-row" onClick={() => setSheet("thought")}>
              <span className="config-key">Thinking</span>
              <span className="config-value">
                {effectiveThought.length > 0 ? thoughtLabel(effectiveThought) : "—"}
              </span>
            </button>
          ) : null}
        </Sheet>
      ) : null}

      {sheet === "mode" ? (
        <OptionSheet
          title="Access mode"
          groups={[
            {
              options: ACCESS_MODES.map((mode) => ({
                value: mode.value,
                label: mode.label,
                sub: mode.description,
                selected: mode.value === rawMode,
              })),
            },
          ]}
          onPick={(value) => {
            onDraftChange({ ...draft, mode: value });
            setSheet("config");
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "model" ? (
        <OptionSheet
          title="Model"
          groups={modelGroups.map((group) => ({
            label: group.providerName,
            options: group.models.map((entry) => ({
              value: entry.rawValue,
              label: entry.name,
              sub: entry.modelId !== entry.name ? entry.modelId : undefined,
              selected: entry.rawValue === effectiveModelValue,
            })),
          }))}
          onPick={(value) => {
            const picked = modelGroups
              .flatMap((group) => group.models)
              .find((entry) => entry.rawValue === value);
            // 换模型后若旧档位不被新模型支持，退到新模型默认档，避免提交报错。
            const thoughtForModel =
              picked && draft.thought && !picked.thoughtLevels.includes(draft.thought)
                ? (picked.defaultThoughtLevel ?? null)
                : draft.thought;
            onDraftChange({ ...draft, modelValue: value, thought: thoughtForModel });
            setSheet("config");
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "thought" ? (
        <OptionSheet
          title="Thinking"
          groups={[
            {
              options: thoughtLevels.map((level) => ({
                value: level,
                label: thoughtLabel(level),
                sub: level !== thoughtLabel(level) ? level : undefined,
                selected: level === effectiveThought,
              })),
            },
          ]}
          onPick={(value) => {
            onDraftChange({ ...draft, thought: value });
            setSheet("config");
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}
