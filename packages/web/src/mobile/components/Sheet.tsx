/**
 * 底部弹层：选择器（支持分组）与确认框共用一个外壳。
 * 移动端 v1 不引入桌面组件库，全部轻量自绘。
 */
import { useEffect, type ReactNode } from "react";

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

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-title">{title}</div>
        {children}
      </div>
    </div>
  );
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
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="sheet-scroll">
        {groups.map((group, groupIndex) => (
          <div key={group.label ?? groupIndex}>
            {group.label ? <div className="sheet-group">{group.label}</div> : null}
            {group.options.map((option) => (
              <button
                key={option.value}
                className={`sheet-option${option.selected ? " selected" : ""}${option.danger ? " danger" : ""}`}
                onClick={() => onPick(option.value)}
              >
                <span className="sheet-option-main">
                  <span className="sheet-option-label">{option.label}</span>
                  {option.sub ? <span className="sheet-option-sub">{option.sub}</span> : null}
                </span>
                {option.selected ? <span className="sheet-check">✓</span> : null}
              </button>
            ))}
          </div>
        ))}
        <div className="sheet-tail-space" />
      </div>
    </Sheet>
  );
}

export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      {message ? <div className="confirm-message">{message}</div> : null}
      <div className="confirm-actions">
        <button className="confirm-btn cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          className="confirm-btn danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
      <div className="sheet-tail-space" />
    </Sheet>
  );
}
