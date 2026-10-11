/**
 * 手绘浮层：底部面板（Sheet）与轻提示（Toast）。
 *
 * 取代 antd-mobile 的原因：一是它的视觉意见太强（白色分隔线、半透明黑底、
 * 固定内边距），跟本项目的暖灰 + 琥珀终端风格持续打架；二是 v5 × React 19
 * 需要 unstableSetRender 兼容层才能让命令式组件真正渲染。自己实现后这两件事
 * 都消失，包体也更小。
 *
 * 交互约定：面板 = 遮罩点击关闭 + 底部圆角 + 可选"取消"行；
 * Toast = 无遮罩、自动消失、屏幕底部安全区上方。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

/* ---------------------------------- Sheet --------------------------------- */

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

/** 底部面板。开合由调用方用条件渲染控制，这里只负责视觉与关闭行为。 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title?: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Esc 关闭，桌面浏览器调试时也顺手。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true">
      <button className="sheet-mask" aria-label="Close" onClick={onClose} />
      <div className="sheet-panel">
        {(title || subtitle) && (
          <div className="sheet-head">
            <div className="sheet-head-text">
              {title ? <div className="sheet-title">{title}</div> : null}
              {subtitle ? <div className="sheet-subtitle">{subtitle}</div> : null}
            </div>
            <button className="sheet-close" aria-label="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-footer">{footer}</div> : null}
        <button className="sheet-cancel" onClick={onClose}>
          Cancel
        </button>
        <div className="sheet-safe-area" />
      </div>
    </div>
  );
}

/** 扁平/分组选项面板：模型、思考档位、协作模式共用。 */
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
      {groups.map((group, groupIndex) => (
        <div key={group.label ?? groupIndex} className="option-group">
          {group.label && groups.length > 1 ? (
            <div className="option-group-label">{group.label}</div>
          ) : null}
          {group.options.map((option) => (
            <button
              key={option.value}
              className={`option-row${option.selected ? " selected" : ""}${
                option.danger ? " danger" : ""
              }`}
              onClick={() => onPick(option.value)}
            >
              <span className="option-row-main">
                <span className="option-row-label">{option.label}</span>
                {option.sub ? <span className="option-row-sub">{option.sub}</span> : null}
              </span>
              {option.selected ? <span className="option-check">✓</span> : null}
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}

/** 危险操作确认面板。 */
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
    <Sheet title={title} subtitle={message} onClose={onClose}>
      <button
        className="option-row danger"
        onClick={() => {
          onClose();
          onConfirm();
        }}
      >
        <span className="option-row-main">
          <span className="option-row-label">{confirmLabel}</span>
        </span>
      </button>
    </Sheet>
  );
}

/* ---------------------------------- Toast --------------------------------- */

type ToastTone = "info" | "ok" | "fail";

interface ToastEntry {
  id: number;
  text: string;
  tone: ToastTone;
  duration: number;
}

interface ToastApi {
  show: (text: string, options?: { tone?: ToastTone; duration?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (text, options) => {
      const id = nextId.current;
      nextId.current += 1;
      const duration = options?.duration ?? 2600;
      setEntries((current) => [...current.slice(-2), { id, text, tone: options?.tone ?? "info", duration }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  // 卸载时清掉所有计时器，避免 StrictMode 双挂载后残留。
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-layer" role="status" aria-live="polite">
        {entries.map((entry) => (
          <div key={entry.id} className={`toast toast-${entry.tone}`} onClick={() => dismiss(entry.id)}>
            {entry.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  // Provider 永远在 App 根部，缺失说明装配错误；静默降级为 console。
  return api ?? { show: (text) => console.warn("[toast]", text) };
}
