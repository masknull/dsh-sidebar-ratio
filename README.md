# dsh-sidebar-ratio

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-DSH%20web-4c8bf5.svg)

[English](README_EN.md) | **中文**

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 网页版的两件事：

1. **侧边栏按窗口比例打开** —— 左栏默认 14%，右栏可选；拖原生把手或快捷键直接调，比例记在浏览器里。
2. **同一个父总会话组内共享右侧栏面板** —— 父代理开着的文件/预览面板，切到它的子代理、孙代理、同级子代理时自动带上同一个标签。

> **不修改 deepseek-harness 任何源码文件。** 宽度靠浏览器运行时改内联样式；面板继承只用官方公开的客户端 API。

---

## 为什么需要它

**侧边栏宽度是写死的像素值。** DSH 原生左栏宽度是固定像素、拖动区间只有 264~420px
（[`columns.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/columns.ts) 的 `SIDEBAR_MIN/SIDEBAR_MAX`），
所以"想比原生更窄"做不到；右侧栏首次打开固定为窗口的 45%。窗口越宽，固定像素占比越小。

**右侧栏面板是按会话隔离的。** 每个会话各有一份面板状态，新建即"收起、无标签"，
所以父代理打开的文件面板，一切到子代理会话就没了 —— 这是原生设计而非缺陷，但对
"父代理指挥、子代理执行"的用法很不顺手。

本插件针对这两点分别用两种手段解决。

---

## 功能

### 一、侧边栏按窗口比例

| 操作 | 效果 |
| --- | --- |
| 拖动原生把手 | 直接改那一列的比例（左、右都可以），不再被 264~420px 夹住 |
| `Alt` + `←` / `→` | 左侧栏 −1% / +1% |
| `Alt` + `Shift` + `←` / `→` | 右侧栏 −1% / +1% |
| `Alt` + `0` | 总开关：关掉即完全回到 DSH 原生行为 |

- 比例存浏览器 `localStorage`（key `dsh.sidebar-ratio.v1`），刷新后保持，**不落任何磁盘文件**。
- 左栏下限默认 200px、上限 45%；右栏下限默认 300px、上限 70% —— 像素与比例双重夹取，保证中央会话区不被挤没。
- 拖动是**接管原生把手**实现的，手感与原生一致，而且能拖到 264px 以下。

### 二、父总会话组内共享右侧栏面板

分组规则：沿会话谱系上溯到顶层，**同一个父总会话（顶层会话本身 + 它下面所有层级的子代理）算一组**，组内共用一个面板基准。

- 父 → 直接子、父 → 孙、**同级子代理之间**，行为一致；不同父总会话之间互不影响。
- 只对**当前收起**的会话生效 —— 目标会话自己已经开着面板时，插件一律不打扰。
- 组基准由谁定（`inheritFromParent`，默认 `false`）：
  - `false`：**组内统一**。谁开面板谁成为该组基准，父会话开面板自然成为基准。
  - `true`：**严格依据父**。只有父总会话能写基准，子代理只读。
- "关掉"只在观测到**同一个会话从展开变收起**时才认定，所以不会把"新会话本来就没开过"误判成用户关闭。

---

## 安装

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile web add github:masknull/dsh-sidebar-ratio
```

想固定版本（避免跟随主分支变动）：

```powershell
dsh plugin --profile web add github:masknull/dsh-sidebar-ratio#v0.2.0
```

CLI 会把包名追加进 profile 的 `dsh.profile.bundles`，并在启动时应用本包自带的 `cordis.patch.yml`。
命令行的 git / 路径 / tarball 规格会由 pnpm 先落成真实依赖名，再按**真实包名**登记到 bundles
（`apps/cli/src/plugin.ts:59-91`），所以上面这两种写法都会正确登记为 `dsh-sidebar-ratio`。

### 从本地目录安装（开发用）

```powershell
dsh plugin --profile web add <绝对路径，例如 E:\AI\dsh-sidebar-ratio>
```

相对路径也可以 —— CLI 会把它锚定到你**当前所在的目录**（`apps/cli/src/plugin.ts:104-112`），
所以在本仓库根目录直接执行下面这行同样有效：

```powershell
dsh plugin --profile web add .
```

### 装完必须重启一次

新增 bundle 层只在启动时组合，所以：

1. 重启 `dsh web`
2. 浏览器 F5

### 之后改代码，什么时候需要重启

| 改了什么 | 生效方式 |
| --- | --- |
| `lib/dom.js`（宽度逻辑） | **只需 F5**（宿主半边每次渲染 index.html 都重新读这个文件） |
| `lib/client.js`（面板继承逻辑） | 需要**重启 `dsh web`**（客户端 bundle 的装载图在启动时组合） |
| `lib/index.js`、`cordis.patch.yml` | 需要**重启**（`apply` 只在启动时执行一次） |

本包是**纯 JavaScript，没有任何构建步骤**：从 GitHub 装下来即可运行，不需要 `pnpm build`。

---

## 配置

在 `cordis.patch.yml` 的 `config` 里改（改完需要重启）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `left` | `0.14` | 左侧栏占比；`null` = 不接管左栏 |
| `right` | `null` | 右侧栏占比；`null` = 不接管右栏 |
| `minLeft` | `200` | 左栏像素下限（原生是 264） |
| `minRight` | `300` | 右栏像素下限（原生 `RIGHTBAR_MIN` 是 300） |
| `enabled` | `true` | 宽度接管总开关的默认值 |
| `inherit` | `true` | 是否启用「父总会话组内共享右侧栏」 |
| `inheritAll` | `false` | `true` = 忽略分组，任意会话切换都继承 |
| `inheritFromParent` | `false` | 组基准规则，见「功能二」 |

## 控制台 API

```js
// 宽度
dshSidebarRatio.get()          // 当前状态；leftBlocked / rightBlocked 会说明"设了但当前不生效"的原因
dshSidebarRatio.set(0.12)      // 左栏 12%（写 12 也表示 12%）
dshSidebarRatio.right(0.26)    // 右栏 26%
dshSidebarRatio.enabled(false) // 临时交还原生行为
dshSidebarRatio.native()       // 两侧都交还原生
dshSidebarRatio.reset()        // 清掉 localStorage 记录，回到配置默认值

// 排查
dshSidebarRatio.debug(true)    // 打开实时日志
dshSidebarRatio.trace()        // 最近 40 条内部事件（谁触发、改成了什么）
dshSidebarRatio.probe()        // 立刻按当前 DOM 重解一次，返回前后签名

// 面板继承
dshSidebarInherit.get()        // 各父总会话组的当前基准、当前会话属于哪一组
dshSidebarInherit.enabled(false)
dshSidebarInherit.all(true)    // 忽略分组
dshSidebarInherit.rootOf(id)   // 某个会话属于哪个父总会话组
dshSidebarInherit.verbose(true)
```

---

## 工作原理

### 宽度：接管 DSH 自己的内联样式，但和 React 讲清楚"谁写的"

插件改的是 React 托管的内联样式（frame 的 `grid-template-columns`、左栏内容的 `width`、
两个把手的 `left`、右侧面板的 `width`）。难点不在"改"，而在**和 React 抢方向盘时不打架**，所以有三条规则：

1. **谁改的必须分得清**：每次写入前先"认账" —— DOM 现值不等于我们上次写过的值，说明是 React 刚写的，
   记为"原生值"。还原时写回这个最新原生值，而不是第一次接管时的过期快照。
2. **重写必须赶在绘制前**：`MutationObserver` 回调本身就是微任务、在绘制之前执行，所以命中时**同步**重写，
   不排 `requestAnimationFrame` —— 排 rAF 会慢整整一帧，那一帧就是肉眼看到的"官方宽度闪一下"。
3. **观察白名单只是快路径，不是唯一路径**：回调只认 frame、两个列容器和插件接管的那几个节点
   （中央会话列被刻意排除 —— 流式输出会产生海量 style/class 变更）。白名单认不出、但落在列容器内部的
   结构变化（React 换掉中间 wrapper、重建面板）走**下一帧核对签名**；再兜一层**每 400ms 的签名比对**
   （只读 5 个内联样式串，纯 CSSOM 读、不触发排版），外加 `ResizeObserver` 覆盖"框体尺寸变了但没 window resize"。
   **最坏收敛时间有硬上限，不依赖"哪条 mutation 会被漏掉"的假设。**

### 面板继承：只记"意图"，再借官方 API 重放

官方公开面里唯一能跨会话写的入口是 `ctx.sidebarRight.openTabIn(sessionId, kind, options)` /
`openResourceIn(sessionId, address, options)`，且 `openContent` 会强制 `setExpanded(true)` ——
即"打开标签"必然把该会话的右列展开。反过来，**没有任何公开 API 能读另一个会话的标签集**
（`active()`/`mounted()` 只读上屏会话），所以插件自己记住"当前上屏会话开着哪个标签"
（kind + contentId）作为组基准，切到组内收起状态的会话时重放。

值得一提的是：DSH `v0.1.6-alpha.1` 新增的侧边栏终端，官方自己就是用
`ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: … })` 做跨会话重放的
（[`ui-sidebar-terminal`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar-terminal/src/client/index.ts)）——
本插件用的正是同一条官方路径。

---

## 已知边界

这些不是"没做"，而是官方公开面里没有对应能力，或属于原生行为：

| 边界 | 说明 |
| --- | --- |
| 只能继承**当前激活的那个标签** | `active()` 只给当前激活标签；没有公开 API 能列出别的会话的标签集 |
| 继承不了并存的多个标签、分栏、浮窗、`mode` | 同上；可读的 `TabRecord` 只有 `{id, kind, contentId, title}` |
| 继承不了标签内的滚动位置等 `params` | 导航 params 不在公开读取面内。具体到侧边栏**终端**：官方恢复流程自带 `params: { terminalId }` 调 `openTabIn`，插件读不到那串参数，因此子会话会**新开一个终端**，而不是接续父会话的那一个 |
| 无法"只展开、不开标签" | 官方没有 `setExpandedIn(sessionId, bool)` |
| 左栏比例在**侧栏收起**或帧宽 **<1024px** 时不生效 | 收起态是 56px 导轨，不该被拉宽（原生 `SIDEBAR_AUTO_COLLAPSE`） |
| 右栏比例在**右栏没有独立轨道**时不生效 | 帧宽 <768px 会派生自动全屏（原生行为）；该状态下也没有把手可拖 |
| 接管期间的宽度范围与原生不同 | 左栏 200px 下限 / 45% 上限是本插件自造口径；`Alt+0` 关掉后回到原生 264~420 |

读数气泡与 `dshSidebarRatio.get()` 的 `leftBlocked` / `rightBlocked` 会明确标注"设了但当前不生效"及其原因，
不会假装生效。

## 排查

| 现象 | 先看什么 |
| --- | --- |
| 宽度没按比例 | `dshSidebarRatio.get()` 看 `leftBlocked` / `rightBlocked`；再 `debug(true)` 看实时日志 |
| 切会话时闪一下宽度 | `dshSidebarRatio.trace()`：正常应看到「观察器命中」（同步、肉眼不可见）；若频繁出现「签名不一致」，trace 里会写明漏掉的 target 形态 |
| 不确定页面加载的是哪个版本 | `typeof dshSidebarRatio.trace` —— 是函数即新版 |
| 面板继承没生效 | `dshSidebarInherit.get()` 看 `groups` 与 `currentRoot`；`verbose(true)` 看捕获/重放日志 |

---

## 兼容性与维护锚点

开发期已在 cordis `4.0.2`、react-dom `18.3.1` 的 DSH 源码树上逐条核对，并**对照 `dsh-v0.1.6-alpha.1`
做过逐字节核验**（用 git blob SHA 对撞，而非肉眼比对）：本插件依赖的 13 个锚点文件中
**9 个与该版本逐字节相同**，另 4 个的差异**全部是 tag 侧新增能力**，本插件依赖的方法、DOM 标记与属性一律未动，
**无破坏性改动**。

下表的路径均相对于 deepseek-harness 仓库根目录（链接指向核验所用的 tag）；DSH 升级后若出现异常，优先核对这几处：

| 依赖的东西 | 位置 |
| --- | --- |
| 三列网格内联样式、frame 上的 `data-*`、把手 `[data-side]` | [`ui-layout/…/AppFrame.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/AppFrame.tsx) |
| 边界常量 `SIDEBAR_MIN/MAX`、`RIGHTBAR_MIN`、`CENTER_MIN`、`RIGHTBAR_MAX_RATIO` | [`ui-layout/…/columns.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/columns.ts) |
| 轨道过渡、`.handle`、两列 overflow | [`ui-layout/…/AppFrame.module.css`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/AppFrame.module.css) |
| 左栏内容自带内联 `width` | [`ui-sidebar/…/SidebarRoot.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar/src/client/SidebarRoot.tsx) |
| 右侧面板 `data-sidebar-right-panel` + 内联 `width` | [`ui-sidebar-right/…/shell/SidebarRight.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx) |
| 跨会话打开标签的公开入口 `openTabIn` / `openResourceIn` | [`ui-sidebar-right/…/service.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar-right/src/client/service.ts) |
| 可读的 `TabRecord` 结构 | [`ui-dockkit/…/contract/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-dockkit/src/contract/types.ts) |
| 会话谱系字段 `SessionSummary.parentId`、会话切换信号 | [`session-controller/…/sessions/service.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/api/session-controller/src/client/sessions/service.ts) |
| 结构化注入行协议（`global` / `script`；script 正文不得含结束标签字面量） | [`webserver/src/injections.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/host/webserver/src/injections.ts) |
| 客户端 bundle 发现契约（`exports["./client"]`、`dsh.client.platform`） | [`client/modules/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/modules/src/index.ts) |

开发期的逻辑验证方式是**零依赖的桩 DOM 回归**（**该脚手架不随仓库提供**，此处仅说明验证强度）：伪造 AppFrame 结构
（含中间 wrapper、面板替换等真实层级）+ 可控计时器 + 手动喂 mutation record，覆盖接管、微任务内同步纠正、
还原最新原生值、单侧还原、阻塞态读数、拖拽拦截等场景；另用变异体反向证明断言不是空转
（把实现改坏必须能被测出来）。

## 卸载

```powershell
dsh plugin --profile web remove dsh-sidebar-ratio
```

然后重启 `dsh web` + F5。浏览器侧残留只有 `localStorage` 的 key `dsh.sidebar-ratio.v1`，
可用 `dshSidebarRatio.reset()` 清除。

## 许可

[MIT](LICENSE)
