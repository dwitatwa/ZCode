/**
 * Chat（Main）屏：快照轮询的会话视图 + 带三个选择器的 composer。
 * antd-mobile NavBar/TextArea/DotLoading/ActionSheet + lucide 图标。
 * Access / Model / Thinking 全部来自快照 configOptions 的服务端投影；
 * 草稿随 sendPrompt 提交（modelSelection.options.reasoningLevel + mode），不落任务配置。
 */
import { useEffect, useRef, useState } from "react";
import { ActionSheet, DotLoading, NavBar, TextArea, Toast } from "antd-mobile";
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Cpu,
  Square,
} from "lucide-react";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodePersistedMessage, ZCodeTaskMeta } from "@zcode/shared";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import {
  ACCESS_MODES,
  accessModeLabel,
  findConfigOption,
  groupModels,
  modelEntries,
  thoughtLabel,
} from "../lib/catalog.js";
import type { ComposerDraft, MobileTaskSnapshot } from "../lib/types.js";
import { newTraceId } from "../lib/connection.js";
import { GroupedOptionSheet } from "../components/Sheet.js";

const SUBMITTABLE_MODES = ["build", "edit", "plan", "yolo"] as const;

type SubmittableMode = (typeof SUBMITTABLE_MODES)[number];

function normalizeMode(value: string | null | undefined): SubmittableMode {
  return SUBMITTABLE_MODES.find((mode) => mode === value) ?? "build";
}

function MessageBubble({ message }: { message: ZCodePersistedMessage }) {
  const isUser = message.role === "user";
  const parts = Array.isArray(message.parts) ? message.parts : null;

  const body =
    parts && parts.length > 0 ? (
      parts.map((part, index) => {
        if (part.type === "thought") {
          return (
            <details key={index} className="thought">
              <summary>thought</summary>
              <div className="thought-body">{part.content}</div>
            </details>
          );
        }
        if (part.type === "tool-call") {
          return (
            <div key={index} className="tool-line">
              ⚙ tool #{part.toolIndex}
            </div>
          );
        }
        return <p key={index}>{part.content}</p>;
      })
    ) : (
      <p>{message.content}</p>
    );

  return (
    <div className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className={`bubble ${isUser ? "bubble-user" : "bubble-assistant"}`}>{body}</div>
    </div>
  );
}

export function ChatScreen({
  service,
  meta,
  snapshot,
  draft,
  onDraftChange,
  onBack,
}: {
  service: IZCodeTaskService;
  meta: ZCodeTaskMeta;
  snapshot: MobileTaskSnapshot | null;
  draft: ComposerDraft;
  onDraftChange: (next: ComposerDraft) => void;
  onBack: () => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sheet, setSheet] = useState<null | "mode" | "model" | "thought">(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const configOptions = snapshot?.configOptions;
  const modelOption = findConfigOption(configOptions, "model");
  const thoughtOption = findConfigOption(configOptions, "thought_level");
  const effectiveModelValue = draft.modelValue ?? String(modelOption?.currentValue ?? "");
  const effectiveModel = modelEntries(modelOption).find(
    (entry) => entry.rawValue === effectiveModelValue,
  );
  const effectiveThought = draft.thought ?? String(thoughtOption?.currentValue ?? "");
  const rawMode = normalizeMode(draft.mode ?? meta.mode);

  const generating = meta.status === "running";
  const pendingPermissions = snapshot?.runtime?.pendingPermissions ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [snapshot]);

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setInput("");
    try {
      let modelSelection = undefined;
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
      await service.sendPrompt({
        taskId: meta.taskId,
        traceId: newTraceId(),
        content,
        clientMode: "web-remote-replayable",
        clientLabel: "zcode-mobile",
        ...(modelSelection ? { modelSelection } : {}),
        mode: rawMode,
      });
      stickToBottomRef.current = true;
    } catch (error) {
      Toast.show({
        icon: "fail",
        content: `Send failed: ${error instanceof Error ? error.message : String(error)}`,
        duration: 4000,
      });
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    try {
      await service.stopGeneration({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
    } catch {
      // 静默
    }
  };

  const modelGroups = groupModels(modelEntries(modelOption));
  const thoughtLevels =
    draft.modelValue && effectiveModel
      ? effectiveModel.thoughtLevels
      : (thoughtOption?.options ?? []).map((entry) => entry.value);

  return (
    <>
      <NavBar
        onBack={onBack}
        backArrow
        right={generating ? <DotLoading color="primary" /> : null}
        style={{ ["--background-color" as string]: "var(--surface)" }}
      >
        <span className="title-text">{meta.title}</span>
      </NavBar>

      {pendingPermissions.length > 0 && (
        <div className="perm-banner">
          {pendingPermissions.length} permission request(s) pending — approve in the desktop app
        </div>
      )}

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {(snapshot?.messages ?? []).length === 0 && (
          <div className="empty">Loading conversation…</div>
        )}
        {(snapshot?.messages ?? []).map((message, index) => (
          <MessageBubble key={message.id ?? index} message={message} />
        ))}
        {generating && (
          <div className="bubble-row assistant">
            <div className="bubble bubble-assistant typing">
              <DotLoading />
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-chips">
          <button className="chip" onClick={() => setSheet("mode")}>
            {accessModeLabel(rawMode)} <ChevronDown size={11} />
          </button>
          {modelOption && (
            <button className="chip" onClick={() => setSheet("model")}>
              <Cpu size={12} />
              <span className="chip-ellipsis">
                {effectiveModel?.name ?? (effectiveModelValue || "Model")}
              </span>
              <ChevronDown size={11} />
            </button>
          )}
          {thoughtLevels.length > 0 && (
            <button className="chip" onClick={() => setSheet("thought")}>
              <Brain size={12} />
              {effectiveThought.length > 0 ? thoughtLabel(effectiveThought) : "Thinking"}
              <ChevronDown size={11} />
            </button>
          )}
        </div>
        <div className="composer-input-row">
          <TextArea
            value={input}
            placeholder={generating ? "Generating… you can queue a message" : "Ask for changes…"}
            autoSize={{ minRows: 1, maxRows: 4 }}
            onChange={(value) => setInput(value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button className="send-btn stop" onClick={() => void stop()} aria-label="Stop generation">
            <Square size={15} fill="currentColor" />
          </button>
          <button
            className="send-btn"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            aria-label="Send"
          >
            <ArrowUp size={18} strokeWidth={2.6} />
          </button>
        </div>
      </div>

      {sheet === "mode" && (
        <ActionSheet
          visible
          extra="Access mode"
          cancelText="Cancel"
          closeOnAction
          actions={ACCESS_MODES.map((mode) => ({
            key: mode.value,
            text: `${mode.label}${mode.value === rawMode ? " ✓" : ""}`,
            description: mode.description,
          }))}
          onAction={(action) => {
            onDraftChange({ ...draft, mode: String(action.key) });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === "model" && (
        <GroupedOptionSheet
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
            const thoughtForModel =
              picked && draft.thought && !picked.thoughtLevels.includes(draft.thought)
                ? (picked.defaultThoughtLevel ?? null)
                : draft.thought;
            onDraftChange({ ...draft, modelValue: value, thought: thoughtForModel });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === "thought" && (
        <ActionSheet
          visible
          extra="Thinking"
          cancelText="Cancel"
          closeOnAction
          actions={thoughtLevels.map((level) => ({
            key: level,
            text: `${thoughtLabel(level)}${level === effectiveThought ? " ✓" : ""}`,
            description: level !== thoughtLabel(level) ? level : undefined,
          }))}
          onAction={(action) => {
            onDraftChange({ ...draft, thought: String(action.key) });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}
