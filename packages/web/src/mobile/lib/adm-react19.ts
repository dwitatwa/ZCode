/**
 * antd-mobile v5 × React 19 兼容层（官方 v5-for-19 方案）。
 *
 * React 19 的 createRoot 只在 react-dom/client 导出；antd-mobile 的命令式组件
 * （Dialog.confirm / Toast.show / ActionSheet.show 等）经 rc-util 的 render 走
 * `require("react-dom")`，命名空间里没有 createRoot → 回退到已移除的
 * ReactDOM.render → 静默不渲染。这里用 unstableSetRender 注入 createRoot 实现。
 * 必须在任何命令式调用之前 import（main.tsx 顶部）。
 */
import { unstableSetRender } from "antd-mobile/es/utils/unstable-render";
import { createRoot, type Root } from "react-dom/client";

type ContainerWithRoot = Element & { __admRoot?: Root };

unstableSetRender((node, container: ContainerWithRoot) => {
  const root = container.__admRoot ?? createRoot(container);
  container.__admRoot = root;
  root.render(node);
  return () =>
    new Promise<null>((resolve) => {
      setTimeout(() => {
        root.unmount();
        delete container.__admRoot;
        resolve(null);
      }, 0);
    });
});
