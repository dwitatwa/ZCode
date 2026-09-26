/**
 * 移动端共享类型：快照与 composer 草稿。
 */
import type { IZCodeTaskService } from "@zcode/services";

export type MobileTaskSnapshot = Awaited<ReturnType<IZCodeTaskService["getTaskSnapshot"]>>;

/**
 * Composer 草稿只存"用户显式覆盖"的值；null = 跟随服务端当前值
 * （configOptions 的 currentValue / meta.mode）。与桌面草稿语义一致：随提交发送，不落任务配置。
 */
export interface ComposerDraft {
  mode: string | null;
  modelValue: string | null;
  thought: string | null;
}

export function emptyDraft(): ComposerDraft {
  return { mode: null, modelValue: null, thought: null };
}
