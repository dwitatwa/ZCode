/**
 * antd-mobile 未公开类型：v5-for-19 兼容入口（官方指南使用同名深路径）。
 * 包本身不带该深路径的 d.ts，这里补声明。
 */
declare module "antd-mobile/es/utils/unstable-render" {
  type RenderFn = (node: React.ReactNode, container: Element) => () => Promise<unknown>;
  export function unstableSetRender(render?: RenderFn): RenderFn;
}
