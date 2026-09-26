/**
 * Composer 配置面：把 getTaskSnapshot().configOptions 投影成三个选择器的数据。
 * 模型分组 / thinking 档位 / 协作模式全部来自服务端投影，移动端不维护自己的词表；
 * 与桌面共用的 provider/model 解析走 @zcode/shared/model-selection。
 */
import type { ZCodeConfigOption } from "@zcode/shared";
import { parseModelPickerValue } from "@zcode/shared/model-selection";

export interface MobileModelEntry {
  /** configOptions 里的原值（providerId/modelId，可能带 $level 后缀） */
  rawValue: string;
  name: string;
  providerId: string;
  providerName: string;
  modelId: string;
  /** 该模型支持的 reasoning 档位；空数组 = 已知没有档位 */
  thoughtLevels: string[];
  defaultThoughtLevel?: string;
}

export interface MobileModelGroup {
  providerId: string;
  providerName: string;
  models: MobileModelEntry[];
}

export interface MobileAccessMode {
  value: string;
  label: string;
  description?: string;
}

/** 与 getZCodeAgentAvailableModes 的四个用户可选档一致。 */
export const ACCESS_MODES: MobileAccessMode[] = [
  { value: "build", label: "Ask first", description: "Ask before each file change" },
  { value: "edit", label: "Auto edit", description: "Edit files automatically" },
  { value: "plan", label: "Plan", description: "Plan before editing" },
  { value: "yolo", label: "Full access", description: "Fewer confirmations" },
];

const THOUGHT_LABELS: Record<string, string> = {
  off: "Off",
  disabled: "Off",
  false: "Off",
  no: "Off",
  none: "Off",
  nothink: "Off",
  "no-think": "Off",
  no_think: "Off",
  on: "On",
  enable: "On",
  enabled: "On",
  true: "On",
  low: "Low",
  minimal: "Minimal",
  medium: "Medium",
  high: "High",
  "extra-high": "X-High",
  extra_high: "X-High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
};

export function thoughtLabel(value: string): string {
  return THOUGHT_LABELS[value.trim().toLowerCase()] ?? value;
}

export function findConfigOption(
  configOptions: ZCodeConfigOption[] | undefined,
  id: string,
): ZCodeConfigOption | undefined {
  return configOptions?.find((option) => option.id === id && option.type === "select");
}

export function modelEntries(modelOption: ZCodeConfigOption | undefined): MobileModelEntry[] {
  if (!modelOption?.options) return [];
  const entries: MobileModelEntry[] = [];
  for (const entry of modelOption.options) {
    let modelId = entry.value;
    try {
      modelId = parseModelPickerValue(entry.value).modelId;
    } catch {
      // 解析失败仍展示原值；发送端会再次尝试并兜底为不带 modelSelection。
    }
    entries.push({
      rawValue: entry.value,
      name: entry.name || modelId,
      providerId: entry.modelProviderId ?? "",
      providerName: entry.modelProviderName ?? entry.modelProviderId ?? "Other",
      modelId,
      thoughtLevels: entry.modelThoughtLevels ?? [],
      defaultThoughtLevel: entry.modelDefaultThoughtLevel,
    });
  }
  return entries;
}

export function groupModels(entries: MobileModelEntry[]): MobileModelGroup[] {
  const groups = new Map<string, MobileModelGroup>();
  for (const entry of entries) {
    const key = entry.providerId || "_";
    let group = groups.get(key);
    if (!group) {
      group = { providerId: entry.providerId, providerName: entry.providerName, models: [] };
      groups.set(key, group);
    }
    group.models.push(entry);
  }
  return [...groups.values()];
}

export function currentModelEntry(
  modelOption: ZCodeConfigOption | undefined,
): MobileModelEntry | undefined {
  if (!modelOption) return undefined;
  return modelEntries(modelOption).find((entry) => entry.rawValue === String(modelOption.currentValue));
}

export function accessModeLabel(value: string | null | undefined): string {
  if (!value) return "Access";
  return ACCESS_MODES.find((mode) => mode.value === value)?.label ?? value;
}

/** token 数 → 紧凑展示（1.2k / 3.4M）。 */
export function formatTokens(count: number | undefined | null): string {
  if (count === undefined || count === null || Number.isNaN(count)) return "—";
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
