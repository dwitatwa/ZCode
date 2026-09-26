/**
 * 选择器 / 确认框：基于 antd-mobile 重建。
 * - OptionSheet（扁平选项，带选中标记）→ adm ActionSheet
 * - GroupedOptionSheet（分组选项，模型选择器用）→ adm Popup
 * - confirmAction（危险操作确认）→ adm Dialog.confirm
 */
import { ActionSheet, Dialog, Popup } from "antd-mobile";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

export interface SheetOption {
  value: string;
  label: string;
  sub?: string;
  danger?: boolean;
  selected?: boolean;
}

export interface SheetOptionGroup {
  label?: string;
  options: SheetOption[];
}

function optionLabel(option: SheetOption): ReactNode {
  const main = (
    <span className="picker-option-main">
      <span className="picker-option-label">{option.label}</span>
      {option.sub ? <span className="picker-option-sub">{option.sub}</span> : null}
    </span>
  );
  if (option.danger) {
    return <span style={{ color: "var(--danger)" }}>{main}</span>;
  }
  return main;
}

export function OptionSheet({
  title,
  groups,
  onPick,
  onClose,
}: {
  title: string;
  groups: SheetOptionGroup[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  // ActionSheet 是扁平的；调用方传入多组时退化为顺序拼接（组名并入 sub）。
  const actions = groups.flatMap((group) =>
    group.options.map((option) => ({
      key: option.value,
      text: optionLabel(option),
      description: group.label && groups.length > 1 ? group.label : undefined,
    })),
  );
  return (
    <ActionSheet
      visible
      actions={actions}
      extra={title}
      cancelText="Cancel"
      closeOnAction
      onAction={(action) => onPick(String(action.key))}
      onClose={onClose}
    />
  );
}

export function GroupedOptionSheet({
  title,
  groups,
  onPick,
  onClose,
}: {
  title: string;
  groups: SheetOptionGroup[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Popup visible onMaskClick={onClose} bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "70vh", overflowY: "auto", background: "var(--surface)" }}>
      <div className="picker-title">{title}</div>
      {groups.map((group, groupIndex) => (
        <div key={group.label ?? groupIndex}>
          {group.label ? <div className="picker-group">{group.label}</div> : null}
          {group.options.map((option) => (
            <button
              key={option.value}
              className={`picker-option${option.selected ? " selected" : ""}`}
              onClick={() => onPick(option.value)}
            >
              {optionLabel(option)}
              {option.selected ? <Check size={16} /> : null}
            </button>
          ))}
        </div>
      ))}
      <div className="picker-tail" />
    </Popup>
  );
}

export function confirmAction(options: {
  title: string;
  message?: string;
  confirmLabel: string;
  onConfirm: () => void;
}): void {
  void Dialog.confirm({
    title: options.title,
    content: options.message,
    confirmText: options.confirmLabel,
    cancelText: "Cancel",
    onConfirm: () => options.onConfirm(),
  });
}
