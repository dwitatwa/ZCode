/**
 * 非桌面宿主的 provider 装配层。
 *
 * 桌面 app 的 Root 在挂载任何 UI 之前先铺一长串 provider（Service / Platform /
 * Store / TabStore / DiffsWorkerPool / Intl / Tooltip）。会话行渲染器是从那棵树里
 * 长出来的，它按需向上取这些 context —— 缺一个就在渲染时抛错，整屏白掉。
 *
 * 手机、回放页这类宿主没有 Root，所以必须自己铺同样的那几层。这里把「行渲染器
 * 真正会读到」的那几层收成一个组件，避免每个宿主各抄一遍、也避免抄漏。
 *
 * 只要行渲染器还会向下取新的 context，这个文件就要跟着补 —— 判据不是"桌面 Root
 * 里有什么"，而是"渲染时真的会调用哪个 hook"。
 */
import { type ReactNode, useContext, useLayoutEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreContext, StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { applyTheme } from "@/useTheme.js";
import type { Locale } from "@zcode/shared";

/**
 * 把主题钉在深色。
 *
 * StoreProvider 创建 store 时会读 localStorage 里的 `zcode-theme` 并立刻 applyTheme。
 * 手机页与 web 端同源，同一份 localStorage —— 用户在 web 端选了浅色，手机打开会话
 * 时正文就会变成浅色，而手机外壳（头部、composer）是写死的深色，整屏半浅半深。
 *
 * 这里只覆盖 DOM 上的主题类，不调用 setTheme：setTheme 会写回 localStorage，
 * 那会把用户 web 端的偏好改掉。
 *
 * 用 layout effect 而不是 effect：要在首帧绘制前改掉，否则用户会看到一帧浅色。
 */
function PinDarkTheme() {
  const store = useContext(StoreContext);
  useLayoutEffect(() => {
    if (store) applyTheme("zai-dark");
  }, [store]);
  return null;
}

export interface ConversationHostProvidersProps {
  /** 宿主自己的服务面；手机是远端 WS 的 accessor。 */
  services: IServiceAccessor;
  /**
   * 宿主平台能力。手机传一个「都做不到」的实现：行渲染器读它来决定是否显示
   * 打开文件管理器、用编辑器打开这类入口，传了空实现这些入口自然不出现。
   */
  platform: IPlatformService;
  children: ReactNode;
  /** 文案语言；手机固定 en-US。 */
  initialLocale?: Locale;
}

/**
 * 会话渲染所需的最小 provider 栈。
 *
 * 顺序与桌面 Root 保持一致（Tooltip → Service → Platform → Store → TabStore →
 * DiffsWorkerPool），因为下层 provider 自己也可能用到上层的 context。
 */
export function ConversationHostProviders({
  services,
  platform,
  children,
  initialLocale = "en-US",
}: ConversationHostProvidersProps) {
  return (
    <TooltipProvider delayDuration={0}>
      <ServiceProvider services={services}>
        <PlatformProvider platform={platform}>
          {/* Store 里的 theme / codePreviewSettings 会喂给代码高亮与行渲染，
              所以它不能省；broadcastService 只是跨窗口同步，单页宿主直接复用
              accessor 上那个。 */}
          <StoreProvider broadcastService={services.broadcastService}>
            <PinDarkTheme />
            <TabStoreProvider>
              <DiffsWorkerPoolProvider>
                <AssistantCodeCommentFeatureProvider>
                  <ZCodeIntlProvider initialLocale={initialLocale}>{children}</ZCodeIntlProvider>
                </AssistantCodeCommentFeatureProvider>
              </DiffsWorkerPoolProvider>
            </TabStoreProvider>
          </StoreProvider>
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  );
}
