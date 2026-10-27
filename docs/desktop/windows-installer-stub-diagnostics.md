# Windows 打包故障排查记录（pend 缺失与 NSIS 桩挂起）

记录一次在本机 Windows 24H2 环境从零产出生产版安装包的完整排查过程。两个独立的缺陷先后挡住了产物：`app.asar` 缺少运行时依赖 `pend` 导致应用启动即崩，NSIS uninstaller 生成桩在仓库目录内执行时必然挂起导致安装包无法产出。两处均已修复并有产物验证。

## 现象

1. 安装后的应用（以及 `win-unpacked\ZCode.exe`）双击无窗口，或弹出主进程错误框：
   ```text
   A JavaScript error occurred in the main process
   Uncaught Exception:
   Error: Cannot find module 'pend'
   Require stack:
   - app.asar\node_modules\yauzl\fd-slicer.js
   - app.asar\node_modules\yauzl\index.js
   ```
2. `pnpm bundle:desktop` 在 NSIS 阶段失败：
   ```text
   ⨯ ...\dist\ZCode-3.15.1-win-x64.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
   ```
   手动运行该 282 KB 桩会弹出 NSIS 对话框 `Error writing temporary file. Make sure your temp folder is valid.` 并挂起，直到被杀掉（退出码表现为 `null` 或 `2`）。

## 排查中排除的假设（重要，避免重复走弯路）

以下每一项都用实验否定过，不是原因：

- **磁盘空间**：C 盘约 313 GB 可用。早期读到 0 是沙箱环境下 `Get-PSDrive` 返回 null 被误读。
- **Windows Defender / 第三方杀软**：关与开都复现；无第三方 EDR；ASR 规则为空；Controlled Folder Access 关闭。
- **TEMP 目录**：指向系统 Temp、新建干净目录、`C:\ZcodeBuildTemp` 都一样失败。
- **目录 ACL**：`dist` 上的 `Everyone:(DENY)(DC)` 与 `S-1-4-*` 授权是 DSH 沙箱的常规配置，`diagnose-windows-sandbox-acl` 诊断结论为 `NOT_THIS_CLASS`，`WRITE_DAC`/`WRITE_OWNER` 均可用。
- **NTFS 完整性标签**：仓库树上的 `Mandatory Label\Low Mandatory Level:(NW)` 同为沙箱常规配置，不影响 Medium 完整级进程写入。
- **文件夹"归属"**：`C:\Users\dwitatwa\ZcodeBuild`、`Documents\ZcodeBuild` 等自建目录权限完全正常（用户 FullControl），`mkdir`/写入对 PowerShell 与 node 均成功。

## 关键实验与真实机制

### 缺陷一：app.asar 缺 pend（根因明确）

- `packages/desktop/scripts/runtime-dependency-closure.mjs` 的闭包收集对 `["yauzl"]` 能完整解析出 `yauzl, buffer-crc32, pend`，`node_modules\pend` 也存在。
- 但 afterPack 的缺失扫描按**闭包根**逐项判断：根 `yauzl` 已在 asar 中，整条闭包被跳过，子依赖 `pend` 不会补齐。这正是 `electron-builder.config.js` 既有注释描述过的同类故障（`ms`、`asn1` 均以独立闭包根的方式修过）。
- 修复：在 `electron-builder.config.js` 的运行时闭包根数组中把 `"pend"` 单列为根，并按仓库惯例用中文注释写明原因。重建后 `asar list` 可见 `\node_modules\pend\` 5 个条目，应用正常启动。

### 缺陷二：NSIS 桩与"自身所在目录"绑定（根因未定位，已可靠规避）

定位到机制靠一组对照实验（同一 282 KB 桩文件）：

| 桩所在位置 | 结果 |
| --- | --- |
| 仓库内 `packages\desktop\dist` | 挂起，弹 `Error writing temporary file`，不产出 uninstaller |
| 复制到 `C:\ZcodeBuildTemp` | 退出码 0，正常把 `__uninstaller.exe` 写回 dist |
| 复制到 `%TEMP%\stubtest2` | 退出码 0，正常写回原 outDir |

- 桩的**工作目录**不是因素：exe 在仓库内时，把 cwd 换成 TEMP 或 profile 仍失败。
- TEMP、ACL、Defender、磁盘均不是因素（见上）。
- 结论：失败跟随**exe 文件自身的路径**，不跟随 cwd、TEMP 或写入目标。桩在仓库外执行时甚至能成功写回仓库内的 outDir。底层机制（疑似某个按路径生效的文件系统过滤/策略）仍未定位。
- electron-builder 的 `NsisTarget.computeScriptAndSignUninstaller` 用 `execWine(installerPath, ...)` 原地执行桩（`node_modules\app-builder-lib\out\targets\nsis\NsisTarget.js`），因此打包流程必然踩中。
- **最终安装器同样中招**：`dist` 里编译完成的 `ZCode-3.15.1-win-x64.exe`（159 MB）双击即弹 `NSIS Error — Error writing temporary file`。NSIS 启动时要把自身复制到临时实例目录，同样受路径限制。把安装器复制到仓库外（如 `C:\Users\dwitatwa\ZcodeInstall`）再双击，安装向导正常打开并完成安装。
- **由此得到使用者唯一需要记住的规则：不要在仓库目录内直接运行任何 ZCode 的 NSIS exe（桩或安装器）；先复制到仓库外再运行。** 应用目录 `win-unpacked` 不受影响，可直接运行。

### 修复：把桩复制到系统临时目录再执行

`node_modules\app-builder-lib\out\targets\nsis\NsisTarget.js` 中把

```js
await execWine(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
```

改为：`mkdtempSync` 建临时目录 → `copyFileSync` 桩过去 → 对副本执行 `execWine` → `finally` 中 `rmSync` 清理。产物不受影响（桩内烘焙的 `UNINSTALLER_OUT_FILE` 仍指向 outDir）。注意该文件用 `const fs = require("fs")`，不是 `fs-extra` 的 default 导出。

## 本机注意事项

- 运行 Electron 前清掉 `ELECTRON_RUN_AS_NODE=1`（DSH 环境会设置它，应用会静默当 Node 跑完退出）。
- 构建前必须关闭正在运行的 ZCode，否则 `EnsureEmptyDir` 报 `remove ...: Access is denied`；目录刚被删除重建的瞬间可能报 `mkdir ...: Access is denied`，稍后重试即可。
- 读进程弹窗文案用 UI Automation；Electron 对话框是 DirectUI，普通 `GetWindowText` 读不到子控件。
- `NSIS Error` 对话框会阻塞工具调用直到超时，长命令一律放后台任务。

## 遗留事项

- **`NsisTarget.js` 的补丁位于 `node_modules`，`pnpm install` 会冲掉。** 需要迁到 `package.json` 的 `patchedDependencies`（pnpm patch）才能持久。
- electron-builder 的 `app-builder.exe` 在**仓库外**创建输出目录时报 `mkdir <路径>\win-unpacked: Access is denied`（实测 `C:\ZcodeBuild`、`C:\Users\dwitatwa\ZcodeBuild`、`Documents\ZcodeBuild` 全部失败，`ZCODE_DESKTOP_DIST_DIR` 指向仓库外不可用）；同时 `dist` 内构建的应用打包阶段完全正常。与桩问题同向：仓库内可写打包、仓库外不可写，但 PowerShell/node 在同一外部路径 `mkdir`/写入 5 MB 文件均成功——被限制的只有 app-builder.exe 这类孙进程。不要尝试把构建输出指到仓库外，直接用默认 `dist`。
- 可选改进：在 bundle 收尾处把安装器自动复制到仓库外固定目录（如 `C:\Users\dwitatwa\ZcodeInstall`），免去手动复制；**已实现**——`bundle.mjs` 的 `copyNsisArtifactOutsideWorkspace`（仅 win32 NSIS 产物生效），目标目录可用 `ZCODE_INSTALLER_OUT_DIR` 覆盖，默认 `%USERPROFILE%\ZcodeInstall`。
- 桩的路径敏感问题底层机制未定位；若换机器或系统更新后行为变化，优先复查上表对照实验。
- 安装器产物已产出（`ZCode-3.15.1-win-x64.exe` 约 159 MB），卸载器未签名（无签名证书时的预期行为）；SmartScreen 首次运行可能提示。

## 快速复现/验证命令

```powershell
# 检查 asar 是否含 pend
pnpm exec asar list packages\desktop\dist4\win-unpacked\resources\app.asar | Select-String 'node_modules\\pend'
# 完整生产构建（默认输出 packages\desktop\dist）
$env:ZCODE_ENV="production"; pnpm bundle:desktop -- --os win --arch x64
```
