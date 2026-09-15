/*
 * dsh-sidebar-ratio —— 前端 DOM hook（由本包 lib/index.js 作为 script 行注入 index.html）
 * 只在浏览器运行时改 DOM 内联样式；不写任何 DSH 文件，不改 DSH 源码。
 *
 * 接管目标（选择器全部用 DSH 自己公开的标记，逐条对应源码，路径为仓库相对路径）：
 * - packages/client/ui-layout/src/client/AppFrame.tsx:203-215
 *     frame 内联 grid-template-columns = `<sidebar>px minmax(0, 1fr) <rightbar>px`
 *     其子节点 data-shell-overlay（:230）用来反查 frame（比类名稳，类名是 CSS Module 哈希）
 * - AppFrame.tsx:210-214
 *     data-sidebar-collapsed / data-rightbar-collapsed / data-rightbar-fullscreen /
 *     data-rightbar-instant / data-dragging
 * - AppFrame.tsx:105-118   原生把手 .handle[data-side=sidebar|rightbar]（内联 left）
 * - packages/client/ui-sidebar/src/client/SidebarRoot.tsx:173
 *     左栏内容自带内联 width；收起且已 settled 时该行 style 为 undefined，此时不接管左栏
 * - packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx:297-298
 *     右侧面板 data-sidebar-right-panel（'push' | 'fullscreen'）+ 内联 width（fullscreen 时是 '100%'）
 *
 * 为什么要顺手接管把手拖拽：原生值被 columns.ts 的 SIDEBAR_MIN=264 / SIDEBAR_MAX=420 夹死
 * （stores.ts:102-105 写入时也夹），光覆盖样式会让「拖动」看起来失效；把 pointerdown 截下来
 * 换算成比例，手感保持原生，而且能窄到 264 以下。
 *
 * 与 React 的相处方式（这是本文件最要紧的一段）：
 *   插件改的全是 React 托管的内联样式。React 的 style diff 是 key 级的，只在 vdom 里该 key
 *   的值变化时才会写回。所以：
 *   1) 谁改的必须分得清 —— 每次写入前先「认账」：如果 DOM 现值 != 我们上次写的值，说明是 React
 *      刚写的，把它记为「原生值」。这样还原时写回的是最新原生值，不会出现「还原成上一个窗口
 *      尺寸」的过期快照。
 *   2) 重写必须赶在绘制前 —— React 写完之后我们只剩一个微任务的机会。MutationObserver 的回调
 *      本身就是微任务，在浏览器绘制之前执行，因此这里**同步**重写（不排 requestAnimationFrame）。
 *      排 rAF 会慢整整一帧，那一帧就是肉眼看到的「官方宽度闪一下」。
 *   3) 观察范围要准 —— subtree 观察会在会话流式输出时被大量 style/class 变更淹没，所以回调里用
 *      「目标是否是我们关心的那几个节点」做过滤，命中才重写（不做无谓的布局读取）。
 *      但**白名单不是唯一路径**：线上出现过「切会话要 2s+ 才纠正」的回归，根因就是命中不了时
 *      只剩兜底，而兜底当时写的是「每 3 秒跑一次 apply」。现在兜底是**签名比对**：每 400ms 只读
 *      5 个内联样式串（纯 CSSOM 读、不触发排版），只有变化才 apply；frame 被整块替换时重挂观察器；
 *      并用 ResizeObserver 覆盖「框体尺寸变了但没有 window resize」的情况。最坏收敛 ≤400ms，
 *      且不依赖「哪条 mutation 会被漏掉」的任何假设。
 *      排查用：window.dshSidebarRatio.debug(true) 开日志；trace() 看最近 40 条内部事件；probe() 手动重解。
 *
 * 用法：
 *   拖原生把手                = 直接改那一列的比例（左/右都可以）
 *   Alt + ←/→                 = 左侧栏 -1% / +1%
 *   Alt + Shift + ←/→         = 右侧栏 -1% / +1%
 *   Alt + 0                   = 总开关（关掉即完全回到 DSH 原生行为）
 *   window.dshSidebarRatio    = 控制台 API：get / set / right / enabled / native / reset / debug / trace / probe
 * 数值存 localStorage（浏览器状态，不落盘任何文件），刷新后保持。
 */
(function () {
  'use strict'
  if (globalThis.__DSH_SB_RATIO_BOOTED__) return
  globalThis.__DSH_SB_RATIO_BOOTED__ = true

  var KEY = 'dsh.sidebar-ratio.v1'
  var CONF = globalThis.__DSH_SIDEBAR_RATIO__ || {}
  // 与 packages/client/ui-layout/src/client/columns.ts 对齐的边界（该文件若改动需同步）
  var CENTER_MIN = 400
  var RIGHTBAR_MIN = 300
  var RIGHTBAR_MAX_RATIO = 0.7
  var MIN_LEFT = typeof CONF.minLeft === 'number' ? CONF.minLeft : 200
  var MIN_RIGHT = typeof CONF.minRight === 'number' ? CONF.minRight : RIGHTBAR_MIN
  var MAX_LEFT_RATIO = 0.45
  var DEF_LEFT = typeof CONF.left === 'number' ? CONF.left : 0.14
  var DEF_RIGHT = typeof CONF.right === 'number' ? CONF.right : null

  var state = load()
  var written = null // 上一次我们自己写进 frame 的 grid 串；DOM 现值与它不同 = React 刚写过
  var shell = { left: null, mid: null, right: null }
  var nodes = {
    frame: null, sidebarCol: null, sidebarWidth: null,
    sidebarHandle: null, panel: null, rightbarCol: null, rightbarHandle: null
  }
  var mine = { dragging: false, pointerId: null }
  var chip = null
  var chipTimer = null

  /* ---------------- 状态 ---------------- */

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

  function ratioOf(value, fallback) {
    if (value === null) return null
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) return fallback
    var r = value > 1 ? value / 100 : value
    return clamp(r, 0.02, 0.9)
  }

  function load() {
    var saved = null
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null') } catch (e) { saved = null }
    var s = {
      enabled: saved && typeof saved.enabled === 'boolean'
        ? saved.enabled
        : (typeof CONF.enabled === 'boolean' ? CONF.enabled : true),
      left: null,
      right: null
    }
    s.left = ratioOf(saved && Object.prototype.hasOwnProperty.call(saved, 'left') ? saved.left : DEF_LEFT, DEF_LEFT)
    s.right = ratioOf(saved && Object.prototype.hasOwnProperty.call(saved, 'right') ? saved.right : DEF_RIGHT, DEF_RIGHT)
    return s
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) { /* 无痕模式写不进就算了 */ }
  }

  /* ---------------- 内联样式的「所有权账本」 ----------------
   * 每个 (元素, 属性) 记三个值：
   *   owned  当前是不是我们在接管
   *   wrote  我们上次写进去的值（用来分辨「这个现值是谁写的」）
   *   native 最近一次观测到的 DSH 原生值（还原时写回它，而不是写回过期快照）
   */
  var book = new WeakMap()

  function slot(el, prop) {
    var record = book.get(el)
    if (record === undefined) { record = Object.create(null); book.set(el, record) }
    var one = record[prop]
    if (one === undefined) { one = { owned: false, wrote: null, native: '', hasNative: false }; record[prop] = one }
    return one
  }

  /** 写入/还原之前先认账：现值不是我们写的，就说明它是 React 写的，记为原生值。 */
  function sync(el, prop) {
    if (!el || !el.style) return null
    var one = slot(el, prop)
    var current = el.style[prop]
    if (one.owned) {
      if (one.wrote !== current) { one.native = current; one.hasNative = true }
    } else {
      one.native = current
      one.hasNative = true
    }
    return one
  }

  function write(el, prop, value) {
    if (!el || !el.style) return
    var one = sync(el, prop)
    one.owned = true
    one.wrote = value
    if (el.style[prop] !== value) el.style[prop] = value
  }

  /** 交还所有权，并把该属性写回最近一次观测到的原生值。 */
  function restore(el, prop) {
    if (!el || !el.style) return
    var one = sync(el, prop)
    if (!one.owned) return
    one.owned = false
    one.wrote = null
    var value = one.hasNative ? one.native : ''
    if (el.style[prop] !== value) el.style[prop] = value
  }

  /** 放弃所有权但不写回（用于收起态：让 React 自己的收起动画照常走）。 */
  function dropOwned(el, prop) {
    if (!el || !el.style) return
    var one = sync(el, prop)
    one.owned = false
    one.wrote = null
  }

  /* ---------------- 定位 ---------------- */

  function findFrame() {
    var overlay = document.querySelector('[data-shell-overlay]')
    var node = overlay ? overlay.parentElement : null
    if (node === null || node === undefined || !node.style) return null
    if (String(node.style.gridTemplateColumns || '') === '') return null
    return node
  }

  function splitTracks(value) {
    var out = []
    var depth = 0
    var cur = ''
    for (var i = 0; i < value.length; i += 1) {
      var ch = value.charAt(i)
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      if (ch === ' ' && depth === 0) { if (cur !== '') { out.push(cur); cur = '' } continue }
      cur += ch
    }
    if (cur !== '') out.push(cur)
    return out
  }

  function pxOf(track, fallback) {
    if (typeof track !== 'string') return fallback
    var m = /^(-?[\d.]+)px$/.exec(track.trim())
    return m === null ? fallback : Number.parseFloat(m[1])
  }

  /**
   * 左栏内容节点：SidebarRoot.tsx:173 的根元素，带内联 width。
   * 不用 `[style*="width"]` 反查 —— 那个属性选择器会连 min-width / max-width / border-width
   * 一起匹配，sidebar 子树里任何带内联宽度的节点都可能被误命中。这里按 CSSOM 精确判定
   * style.width 非空，并优先复用上次解析到的节点（带 isConnected 校验）。
   */
  function resolveSidebarWidth(frame) {
    var root = frame.firstElementChild
    var cached = nodes.sidebarWidth
    if (cached !== null && cached.isConnected && cached.style && cached.style.width !== ''
      && (root === null || root === undefined || root === cached || root.contains(cached))) return cached
    if (root === null || root === undefined) return null
    if (root.style && root.style.width !== '') return root
    var list = root.querySelectorAll('*')
    for (var i = 0; i < list.length; i += 1) {
      var el = list[i]
      if (el.style && el.style.width !== '') return el
    }
    return null
  }

  function resolveNodes(frame) {
    nodes.frame = frame
    // AppFrame 的子元素顺序：DocumentTitle（渲染 null）→ div.sidebarCol → main/rightbar → overlay。
    // 所以 firstElementChild 就是左栏列容器。
    nodes.sidebarCol = frame.firstElementChild
    nodes.sidebarWidth = resolveSidebarWidth(frame)
    nodes.sidebarHandle = frame.querySelector('[data-side="sidebar"]')
    // 面板在 frame 子树内（AppFrame.tsx:226-228 的 rightbarCol）；优先限定范围避免多面板时取错，
    // 万一将来被挪出 frame 子树，退回全局查询（旧行为），不至于直接失效
    nodes.panel = frame.querySelector('[data-sidebar-right-panel]') || document.querySelector('[data-sidebar-right-panel]')
    nodes.rightbarHandle = frame.querySelector('[data-side="rightbar"]')
    // 右栏列容器：从面板往上走到 frame 的直接子元素。React 整块换掉面板时，
    // mutation 的 target 是它，所以要把它也纳入"关注集"。
    var parent = nodes.panel === null ? null : nodes.panel.parentElement
    while (parent !== null && parent !== undefined && parent !== frame) {
      if (parent.parentElement === frame) break
      parent = parent.parentElement
    }
    nodes.rightbarCol = parent !== null && parent !== undefined && parent !== frame ? parent : null
  }

  function isFullscreenPanel(panel) {
    return panel !== null && panel.getAttribute('data-sidebar-right-panel') === 'fullscreen'
  }

  /* ---------------- 求解 + 落地 ---------------- */

  function solve() {
    var frame = findFrame()
    if (frame === null) return null
    var current = String(frame.style.gridTemplateColumns || '')
    var tracks = splitTracks(current)
    if (tracks.length < 3) return null
    // 现值不是我们上次写的 => 是 React 刚写的，认账为原生轨道
    if (current !== written) {
      shell.left = tracks[0]
      shell.mid = tracks[1]
      shell.right = tracks[2]
    }
    resolveNodes(frame)
    var box = frame.getBoundingClientRect()
    var width = box.width > 0 ? box.width : window.innerWidth
    var nativeLeft = pxOf(shell.left, 0)
    var nativeRight = pxOf(shell.right, 0)
    var collapsed = frame.hasAttribute('data-sidebar-collapsed')

    var left = null
    if (state.enabled && state.left !== null && !collapsed) {
      left = clamp(Math.round(width * state.left), MIN_LEFT, Math.round(width * MAX_LEFT_RATIO))
    }
    var right = null
    if (state.enabled && state.right !== null && nativeRight > 0) {
      var room = width - CENTER_MIN - (left === null ? nativeLeft : left) - 8
      var hi = clamp(Math.round(width * RIGHTBAR_MAX_RATIO), RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, room))
      right = clamp(Math.round(width * state.right), MIN_RIGHT, hi)
    }
    return {
      frame: frame,
      width: width,
      left: left,
      right: right,
      nativeLeft: nativeLeft,
      nativeRight: nativeRight,
      collapsed: collapsed,
      // 给读数 / API 用的「为什么没生效」
      leftBlocked: state.enabled && state.left !== null && collapsed ? 'sidebar-collapsed' : null,
      rightBlocked: state.enabled && state.right !== null && nativeRight <= 0 ? 'no-rightbar-track' : null
    }
  }

  function apply() {
    var r = solve()
    if (r === null) return false
    var frame = r.frame
    // DSH 自己在拖（不是我们接管的那次）时不抢，避免和它的过渡打架
    if (frame.hasAttribute('data-dragging') && !mine.dragging) return true

    // 1) 网格轨道：两侧各自决定「写比例」还是「还原原生轨道」（左右互不牵连）
    var t0 = r.left === null ? shell.left : (r.left + 'px')
    var t2 = r.right === null ? shell.right : (r.right + 'px')
    write(frame, 'gridTemplateColumns', t0 + ' ' + shell.mid + ' ' + t2)
    written = String(frame.style.gridTemplateColumns)

    // 2) 左栏：内容内联 width + 左把手 left。收起态不碰内容宽度 ——
    //    SidebarRoot 收起动画期间要把内容冻结在展开宽度上再裁切，写窄了会看到重排。
    if (r.left !== null) {
      write(nodes.sidebarWidth, 'width', r.left + 'px')
      write(nodes.sidebarHandle, 'left', r.left + 'px')
    } else {
      if (r.collapsed) dropOwned(nodes.sidebarWidth, 'width')
      else restore(nodes.sidebarWidth, 'width')
      restore(nodes.sidebarHandle, 'left')
    }

    // 3) 右栏：面板内联 width + 右把手 left（fullscreen 时面板是 100%，不动它）
    if (r.right !== null) {
      if (!isFullscreenPanel(nodes.panel)) write(nodes.panel, 'width', r.right + 'px')
      write(nodes.rightbarHandle, 'left', (r.width - r.right) + 'px')
    } else {
      if (!isFullscreenPanel(nodes.panel)) restore(nodes.panel, 'width')
      restore(nodes.rightbarHandle, 'left')
    }

    hijackHandles(frame)
    return true
  }

  /* ---------------- 重写时机：微任务内同步，赶在同一帧绘制前 ---------------- */

  var scheduled = false

  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(function () {
      scheduled = false
      applyNow('rAF')
    })
  }

  /** MutationObserver 回调里用：同步 apply，不排 rAF（排 rAF 会慢一帧 = 闪一下）。 */
  function applyNow(reason) {
    var before = sigOf()
    try {
      apply()
    } catch (e) {
      note('apply 抛错被吞：' + e)
      return
    }
    var after = sigOf()
    lastSig = after
    if (before !== after) note((reason === undefined ? '' : reason + ' ') + '已修正 → ' + after)
  }

  function isTracked(target) {
    return target === nodes.frame
      || target === nodes.sidebarCol
      || target === nodes.sidebarWidth
      || target === nodes.sidebarHandle
      || target === nodes.panel
      || target === nodes.rightbarCol
      || target === nodes.rightbarHandle
  }

  /** 目标是否落在两个列容器内部（中央会话列与 overlay 层刻意排除）。 */
  function insideColumns(target) {
    if (target === null || target === undefined) return false
    if (nodes.sidebarCol !== null && nodes.sidebarCol !== undefined && nodes.sidebarCol.contains(target)) return true
    if (nodes.rightbarCol !== null && nodes.rightbarCol !== undefined && nodes.rightbarCol.contains(target)) return true
    return false
  }

  function describeNode(node) {
    if (node === null || node === undefined) return '?'
    var tag = typeof node.tagName === 'string' ? node.tagName : '?'
    var cls = ''
    try {
      if (typeof node.className === 'string' && node.className !== '') cls = '.' + node.className.split(' ')[0]
    } catch (e) { /* 忽略 */ }
    var mark = ''
    try { if (node.getAttribute && node.getAttribute('data-sidebar-right-panel') !== null) mark = '[panel]' } catch (e) { /* 忽略 */ }
    return tag + cls + mark
  }

  /**
   * 变更分诊：能认出目标的 → 同步 apply（同一微任务，绘制前）；
   * 认不出的但落在列容器内部（React 换了中间 wrapper / 重建了面板等）→ 下一帧核对签名。
   * 只对「我们关心的那几个节点 + 两个列容器内部」做出反应，中央会话列的流式输出仍然被挡在门外。
   */
  function onMutations(records) {
    var sync = false
    var deferred = false
    for (var i = 0; i < records.length; i += 1) {
      var rec = records[i]
      var target = rec.target
      if (isTracked(target)) { sync = true; continue }
      if (!insideColumns(target)) continue
      // 记录"被漏掉的那条"的形态，兜底触发时一并打进 trace，便于一次定位
      lastMissed = (rec.type === 'childList' ? 'childList' : 'attr:' + String(rec.attributeName)) + '@' + describeNode(target)
      deferred = true
    }
    if (sync) { applyNow('观察器命中'); return }
    if (deferred) scheduleCheck()
  }

  /* ---------------- 变更检测：观察器快路径 + 签名比对兜底 ----------------
   * 教训（线上回归）：只靠 MutationObserver 的"目标白名单"是不可靠的 —— 命中不了就只剩兜底，
   * 而兜底原来写的是"每 3 秒跑一次 apply"，于是切会话要 2s+ 才纠正回来。
   * 现在兜底改成**签名比对**：每 400ms 只读 5 个内联样式字符串（纯 CSSOM 读，不触发排版），
   * 只有和上次不一致才真正 apply。这样无论 React 是怎么写的、写在哪一层、甚至把 frame 换掉，
   * 最坏也在 400ms 内收敛，而且不依赖任何"哪个 mutation 会被漏掉"的假设。
   */

  var observedFrame = null
  var observer = null
  var lastSig = ''
  var trace = []
  var debugOn = false
  var lastMissed = ''
  var checkQueued = false

  function note(entry) {
    var line = new Date().toISOString().slice(11, 23) + ' ' + entry
    trace.push(line)
    if (trace.length > 40) trace.shift()
    if (debugOn) { try { console.log('[dsh-sidebar-ratio] ' + line) } catch (e) { /* 忽略 */ } }
  }

  function inlineOf(el, prop) {
    if (el === null || el === undefined || !el.style) return '-'
    var v = el.style[prop]
    return typeof v === 'string' ? v : '-'
  }

  /** 我们关心的 5 个内联样式串。纯 CSSOM 读，不触发 style/layout 计算。 */
  function sigOf() {
    return [
      inlineOf(nodes.frame, 'gridTemplateColumns'),
      inlineOf(nodes.sidebarWidth, 'width'),
      inlineOf(nodes.sidebarHandle, 'left'),
      inlineOf(nodes.panel, 'width'),
      inlineOf(nodes.rightbarHandle, 'left')
    ].join('|')
  }

  function observe(frame) {
    if (observedFrame === frame) return
    if (observer !== null) { try { observer.disconnect() } catch (e) { /* 忽略 */ } }
    observer = new MutationObserver(onMutations)
    observer.observe(frame, {
      attributes: true,
      attributeFilter: [
        'style', 'class',
        'data-sidebar-collapsed', 'data-rightbar-collapsed',
        'data-rightbar-fullscreen', 'data-rightbar-instant', 'data-dragging'
      ],
      childList: true,
      subtree: true
    })
    observedFrame = frame
    note('挂上观察器')
  }

  var POLL_MS = 400

  /** 核对一次签名；不一致才 apply。reason 会进 trace。 */
  function checkNow(reason) {
    var frame = findFrame()
    if (frame === null) return
    if (frame !== observedFrame) {
      // frame 被整块换过 → 旧观察器挂在脱离文档的节点上，必须重挂
      resolveNodes(frame)
      observe(frame)
      applyNow('frame 被替换')
      return
    }
    resolveNodes(frame)
    if (sigOf() !== lastSig) {
      applyNow(reason + (lastMissed === '' ? '' : '（上次忽略：' + lastMissed + '）'))
      lastMissed = ''
    }
  }

  /**
   * 下一帧核对（rAF）：用于"观察器收到了记录、但目标不是我们接管的节点"的情况
   * ——典型就是 React 换了中间 wrapper 或重建了面板。1 帧 ≈ 16ms，肉眼不可见，
   * 比等 400ms 兜底好得多；而且只读 CSSOM 比对，不做无谓写入。
   */
  function scheduleCheck() {
    if (checkQueued) return
    checkQueued = true
    requestAnimationFrame(function () {
      checkQueued = false
      checkNow('观察器漏了结构变化')
    })
  }

  function pollTick() {
    checkNow('签名不一致')
  }

  /* ---------------- 把手：原生拖拽换算成比例 ---------------- */

  function beginDrag(handle, axis, event) {
    var r = solve()
    if (r === null) return
    var frame = r.frame
    var width = r.width
    var box = frame.getBoundingClientRect()
    var pointerId = event.pointerId
    mine.dragging = true
    mine.pointerId = pointerId
    frame.classList.add('dsh-sb-nofx')

    var move = function (ev) {
      if (ev.pointerId !== pointerId) return
      var px = axis === 'left' ? ev.clientX - box.left : box.right - ev.clientX
      var ratio = clamp(px / width, 0.02, 0.9)
      if (axis === 'left') state.left = clamp(ratio, MIN_LEFT / width, MAX_LEFT_RATIO)
      else state.right = ratio
      schedule()
      readout(axis === 'left' ? '左侧栏' : '右侧栏', axis === 'left' ? state.left : state.right, width)
    }
    var end = function (ev) {
      if (ev !== undefined && ev.pointerId !== undefined && ev.pointerId !== pointerId) return
      mine.dragging = false
      mine.pointerId = null
      frame.classList.remove('dsh-sb-nofx')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      persist()
      applyNow('拖拽结束') // 末帧同步落地，避免 rAF 被取消后最后一次拖动丢失
    }
    try { handle.setPointerCapture(pointerId) } catch (e) { /* 没有这个 API 也能靠 window 监听拖完 */ }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    move(event)
  }

  function hijack(handle, axis) {
    if (handle === null || handle === undefined || handle.__dshSbRatio) return
    handle.__dshSbRatio = true
    // capture + stopPropagation：React 的委托监听挂在根容器 #root 上，handle 是其后代，
    // 这里的捕获阶段先于根容器的冒泡监听执行，截断后 DSH 自己的 264~420 夹取不会再参与。
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || !state.enabled) return
      if (mine.dragging) return // 已有一次拖拽在手，忽略第二根手指/笔
      e.preventDefault()
      e.stopPropagation()
      beginDrag(handle, axis, e)
    }, true)
  }

  function hijackHandles(frame) {
    hijack(nodes.sidebarHandle, 'left')
    hijack(nodes.rightbarHandle, 'right')
  }

  /* ---------------- 读数气泡 / 快捷键 / 控制台 API ---------------- */

  function blockedNote(reason) {
    if (reason === 'sidebar-collapsed') return '（侧栏已收起，比例暂不生效）'
    if (reason === 'no-rightbar-track') return '（右栏当前没有独立轨道，比例暂不生效）'
    return ''
  }

  function show(text) {
    if (chip === null || !chip.isConnected) {
      chip = document.createElement('div')
      chip.className = 'dsh-sb-chip'
      document.body.appendChild(chip)
    }
    chip.textContent = text
    chip.setAttribute('data-show', '1')
    if (chipTimer !== null) clearTimeout(chipTimer)
    chipTimer = setTimeout(function () { if (chip !== null) chip.removeAttribute('data-show') }, 1400)
  }

  function readout(label, ratio, widthHint, note) {
    if (ratio === null) { show(label + (note === undefined ? '' : note)); return }
    var width = widthHint
    if (typeof width !== 'number') {
      var r = solve()
      width = r === null ? 0 : r.width
    }
    show(label + ' ' + (Math.round(ratio * 1000) / 10) + '%'
      + (width > 0 ? ' ≈ ' + Math.round(width * ratio) + 'px' : '')
      + (note === undefined ? '' : note))
  }

  function solveBlocked(side) {
    var r = solve()
    if (r === null) return null
    return side === 'left' ? r.leftBlocked : r.rightBlocked
  }

  window.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === '0') {
      if (e.repeat) return
      state.enabled = !state.enabled
      e.preventDefault()
      persist()
      schedule()
      show(state.enabled ? '侧栏比例接管：开' : '侧栏比例接管：关（回到原生行为）')
      return
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    var r = solve()
    if (r === null) return
    var dir = e.key === 'ArrowLeft' ? -1 : 1
    if (e.shiftKey) {
      var baseR = state.right === null ? (r.nativeRight > 0 ? r.nativeRight / r.width : 0.45) : state.right
      state.right = clamp(baseR + dir * 0.01, RIGHTBAR_MIN / r.width, RIGHTBAR_MAX_RATIO)
      e.preventDefault()
      persist()
      schedule()
      readout('右侧栏', state.right, r.width, blockedNote(r.rightBlocked))
    } else {
      var baseL = state.left === null ? (r.nativeLeft > 0 ? r.nativeLeft / r.width : DEF_LEFT) : state.left
      state.left = clamp(baseL + dir * 0.01, MIN_LEFT / r.width, MAX_LEFT_RATIO)
      e.preventDefault()
      persist()
      schedule()
      readout('左侧栏', state.left, r.width, blockedNote(r.leftBlocked))
    }
  })

  globalThis.dshSidebarRatio = {
    get: function () {
      var r = solve()
      return {
        enabled: state.enabled,
        left: state.left,
        right: state.right,
        minLeft: MIN_LEFT,
        nativeLeft: r ? r.nativeLeft : null,
        nativeRight: r ? r.nativeRight : null,
        appliedLeftPx: r ? r.left : null,
        appliedRightPx: r ? r.right : null,
        leftBlocked: r ? r.leftBlocked : 'no-frame',
        rightBlocked: r ? r.rightBlocked : 'no-frame'
      }
    },
    set: function (ratio) {
      state.left = ratioOf(ratio, null)
      persist()
      schedule()
      readout('左侧栏', state.left, undefined, blockedNote(state.left === null ? null : solveBlocked('left')))
      return state.left
    },
    right: function (ratio) {
      state.right = ratioOf(ratio, null)
      persist()
      schedule()
      readout('右侧栏', state.right, undefined, blockedNote(state.right === null ? null : solveBlocked('right')))
      return state.right
    },
    enabled: function (flag) { state.enabled = flag !== false; persist(); schedule(); return state.enabled },
    native: function () { state.left = null; state.right = null; persist(); schedule(); return true },
    /** 打开详细日志（每次修正都会 console.log 一行）。 */
    debug: function (flag) { debugOn = flag === true; return debugOn },
    /** 最近 40 条内部事件（观察器命中 / 签名不一致 / 修正结果），排查"为什么慢"用。 */
    trace: function () { return trace.slice() },
    /** 立刻按当前 DOM 重解一次，返回前后签名，用于确认兜底是否工作。 */
    probe: function () {
      var before = sigOf()
      applyNow('手动 probe')
      return { before: before, after: sigOf(), observedFrameIsLive: observedFrame !== null && observedFrame.isConnected }
    },
    reset: function () {
      try { localStorage.removeItem(KEY) } catch (e) { /* 读不到就直接用默认值 */ }
      state = load()
      persist()
      schedule()
      return state
    }
  }

  /* ---------------- 启动 ---------------- */

  function injectStyle() {
    var style = document.createElement('style')
    style.textContent = [
      // 拖拽期间关掉 frame 的轨道过渡：选择器第一部分 .dsh-sb-nofx 命中的就是 frame 自己
      // （AppFrame.module.css:10 的 .frame{transition:grid-template-columns ...} 会被它压过）
      '.dsh-sb-nofx, .dsh-sb-nofx [data-side]{transition:none !important}',
      '.dsh-sb-chip{position:fixed;top:10px;left:50%;transform:translateX(-50%) translateY(-6px);z-index:9999;',
      'pointer-events:none;opacity:0;transition:opacity 120ms ease,transform 120ms ease;',
      'padding:4px 10px;border-radius:8px;font:12px/18px ui-sans-serif,system-ui,sans-serif;white-space:nowrap;',
      'color:var(--dsw-alias-label-primary,#333);background:var(--dsw-alias-bg-overlay,#fff);',
      'border:0.5px solid var(--dsw-alias-border-l2,#ddd);box-shadow:0 2px 8px rgba(0,0,0,.12)}',
      '.dsh-sb-chip[data-show]{opacity:1;transform:translateX(-50%) translateY(0)}'
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  function watch(frame) {
    // subtree 是必须的：React 重写的是「后代」（左栏内容 width、把手 left、面板 width），
    // 只观察 frame 自己的话这些要等兜底，那就是肉眼可见的错位。
    // 回调里用 isTracked 过滤：只认 frame / 两个列容器 / 我们接管的那几个节点。
    // 中央会话列被**刻意排除**——那里在流式输出时会产生海量 childList/style 变更，
    // 全都会变成一次 getBoundingClientRect 强制布局，必须挡在门外。
    // 注意：这只是**快路径**，不是唯一路径 —— 漏命中由下面的签名轮询兜住（≤400ms）。
    observe(frame)
    resolveNodes(frame)
    lastSig = sigOf()
    setInterval(pollTick, POLL_MS)
    // 框体尺寸变化（不只是 window resize）也要重解：DSH 自己就用 ResizeObserver 量 frame
    try {
      if (typeof ResizeObserver === 'function') new ResizeObserver(function () { schedule() }).observe(frame)
    } catch (e) { /* 没有这个 API 就靠 window resize */ }
    window.addEventListener('resize', schedule)
    note('接管完成：观察器 + ' + POLL_MS + 'ms 签名兜底 + ResizeObserver')
  }

  function boot() {
    injectStyle()
    var settled = false
    var timer = setInterval(function () {
      var ok = false
      try { ok = apply() } catch (e) { ok = false }
      if (!ok || settled) return
      settled = true
      clearInterval(timer)
      var frame = findFrame()
      if (frame !== null) watch(frame)
      console.log('[dsh-sidebar-ratio] 已接管侧边栏宽度。拖把手或 Alt+←/→ 改左栏，Alt+Shift+←/→ 改右栏，Alt+0 回原生；window.dshSidebarRatio.get() =', globalThis.dshSidebarRatio.get())
    }, 50)
    window.addEventListener('resize', schedule)
  }

  boot()
})()
