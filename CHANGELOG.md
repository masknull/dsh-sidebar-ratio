# Changelog

本文件记录本插件的所有值得注意的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-15

首个公开发布版本。

### 新增

- **侧边栏按窗口比例**：左栏默认 14%、右栏可选；拖动原生把手或 `Alt` 快捷键调整；比例存浏览器 `localStorage`（key `dsh.sidebar-ratio.v1`），不落任何磁盘文件。
- **父总会话组内共享右侧栏面板**：沿会话谱系上溯分组，父 → 直接子、父 → 孙、同级子代理之间带回同一个标签；`inheritFromParent` 可切换「组内统一」与「严格依据父」两种基准规则。
- **双面结构**：宿主半边（`lib/index.js`，注入 + 注入安全守卫 + mtime 缓存）与客户端半边（`lib/client.js`，走官方 `ctx.sidebarRight` / `ctx.sessions` 公开 API）。
- **控制台 API**：`dshSidebarRatio`（`get` / `set` / `right` / `enabled` / `native` / `reset` / `debug` / `trace` / `probe`）与 `dshSidebarInherit`（`get` / `enabled` / `all` / `verbose` / `rootOf` / `capture` / `replay`）。
- **读数气泡与阻塞态可观测**：设置未生效时明确说明原因（侧栏收起、右栏无独立轨道等），不谎报生效。

### 设计要点

- **不修改 deepseek-harness 任何源码文件**：宽度靠运行时改内联样式，面板继承只用官方公开客户端 API。
- **与 React 共存的"所有权账本"**：每次写入前记录 DOM 现值，以此区分"谁写的"，还原时写回最新原生值而非接管时的过期快照。
- **绘制前修正**：`MutationObserver` 回调内**同步**重写，不排 `requestAnimationFrame`，避免肉眼可见的"官方宽度闪一下"。
- **有硬上限的兜底**：观察白名单失效时，用"每 400ms 只读 5 个内联样式串"的签名比对收敛，最坏延迟有上限，且不依赖"哪条 mutation 会被漏掉"的假设。

### 兼容性

- 已在 cordis `4.0.2` / react-dom `18.3.1` 的 DSH 源码树上逐条核对。
- 已对照 DSH [`dsh-v0.1.6-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1) 用 git blob SHA 做逐字节核验：本插件依赖的 13 个锚点文件中 9 个与该版本逐字节相同，另 4 个差异均为 tag 侧新增能力，无破坏性改动。

[0.2.0]: https://github.com/masknull/dsh-sidebar-ratio/releases/tag/v0.2.0
