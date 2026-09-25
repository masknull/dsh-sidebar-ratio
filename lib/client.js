/**
 * dsh-sidebar-ratio —— 客户端半边（右侧栏「会话继承」）。
 *
 * 背景（源码证据，全部只读核对，未改 DSH 任何文件）：
 * 右侧栏的面板状态是**按会话隔离**的：
 * - packages/client/ui-sidebar-right/src/client/stores.ts:55-57   bySession: Record<sessionId, SurfaceState>
 * - packages/client/ui-dockkit/src/contract/types.ts:105-118      layout.{expanded,mode,tabs,...} 在 SurfaceState 里
 * - packages/client/ui-renderer/src/client/registry.ts:541-547     store 实例按会话 key 铸造
 * - packages/client/ui-session/src/client/session-provider.tsx:19  <Fragment key={sessionId}> → 切会话整棵 remount
 * - stores.ts:114-121 createSurface() 恒为「collapsed、单 pane、无 tab」，**没有任何播种/继承机制**
 * 所以父代理打开的右侧栏，切到子代理会话就没了 —— 这正是本文件要补的行为。
 *
 * 做法：官方公开 API 里唯一能跨会话写的入口是
 *   ctx.sidebarRight.openTabIn(sessionId, kind, options)   service.ts:283
 *   ctx.sidebarRight.openResourceIn(sessionId, address, { kind })  service.ts:270
 * 且 openContent 会强制 setExpanded(true)（stores.ts:305-308）—— 即"打开标签"必然把该会话的右列展开。
 * 反过来，**没有任何公开 API 能读另一个会话的标签集**（active()/mounted() 只读上屏会话，
 * adopted 是 private），所以"继承"只能靠本插件自己记住"刚才上屏会话开着什么"，再对目标会话重放。
 *
 * 诚实边界：
 * - 能一致：当前**激活的那个标签**（kind + contentId）——对资源类标签就是同一份内容（地址即内容身份）。
 * - 不能一致：同一会话里并存的其他标签、分栏、浮窗、mode，以及标签内的滚动/参数细节
 *   （TabRecord 只有 {id, kind, contentId, title}，导航 params 不在公开读取面内）。
 * - 官方没有 setExpandedIn(sessionId, bool)：无法在"不打开任何标签"的前提下展开别的会话。
 *
 * 触发策略（按「父总会话」分组，不打扰用户）：
 * - 分组：沿 parentOf 上溯到顶层，**同一个父总会话（父本身 + 它下面所有层级的子代理）算一组**，
 *   组内共用一个面板意图 —— 组内任意会话开着面板，切到组内另一个收起面板的会话就照它重放。
 *   所以父 → 直接子、父 → 孙、子 ↔ 同级子代理，全都在同一组里，行为一致。
 * - 组与组之间互不影响（换到另一个父总会话不会带过去）；配置 inheritAll 可放宽到任意切换。
 * - 目标会话当前已经开着面板时一律不动；只在它收起时才重放。
 * - 组基准：**组内统一**（谁开面板谁成为该组基准；父会话开面板自然成为基准），
 *   目标会话自己已经开着面板时永远不动它，所以不会把用户刚打开的东西顶掉。
 *   配置 inheritFromParent=true 收紧为"只有父总会话能写基准、组内所有会话都依据父"。
 *   "关掉"只在观测到**同一个会话从展开变收起**时才认定（避免把"新会话本来就没开过"误判成用户关闭）。
 * - kind 未注册等错误只记日志，绝不抛到 cordis 之外。
 *
 * 配置来自宿主半边注入的 global（lib/index.js 的 global 行）：
 *   __DSH_SIDEBAR_RATIO__ = { inherit: true, inheritAll: false, inheritFromParent: false, ... }
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-ratio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var CONF = globalThis.__DSH_SIDEBAR_RATIO__ || {}
    /**
     * 组基准的写入权限：
     *   false（默认）= 组内统一：组内任一会话开面板都成为该组基准（父会话开面板自然成为基准），
     *                  但**永远不会覆盖**目标会话自己已经开着的面板
     *   true         = 严格依据父：只有父总会话（顶层会话）能写基准，子代理只读
     */
    var PARENT_ONLY = CONF.inheritFromParent === true
    var RETRY_MS = [0, 150, 400, 800, 1500, 2500]
    var POLL_MS = 1000

    var state = {
      /** 是否启用「同一父总会话内共享右侧栏」 */
      inherit: CONF.inherit !== false,
      /** true = 忽略分组，任意会话切换都继承；false（默认）= 只在同一个父总会话组内继承 */
      inheritAll: CONF.inheritAll === true,
      verbose: false,
      /** 父总会话 id → 该组共用的面板意图 { kind, contentId, title } */
      groups: Object.create(null),
      /** 上一次的活跃会话 id */
      lastSession: null,
      /** 上一次观测到的上屏状态，用来分辨"用户关掉了"和"这个会话本来就没开过" */
      screen: { sessionId: null, expanded: false },
      /** sessionId → 父总会话 id 的缓存（只缓存真的上溯过的） */
      roots: Object.create(null),
      /** 尚未执行的重试定时器；卸载时必须全部取消，否则卸载后还会去动别的会话 */
      retryTimers: new Set(),
      /** 已卸载标记（apply 时会复位，兼容 cordis 热重载重新 apply） */
      disposed: false
    }

    function log(scope, message) {
      if (!state.verbose) return
      // 双写：console 之外再存一份页面内缓冲——DSH 客户端会 patch console，
      // 自动化诊断（CDP 读 window.__sbLogs）不能依赖它。
      try {
        if (typeof globalThis !== 'undefined') {
          globalThis.__sbLogs = globalThis.__sbLogs || []
          globalThis.__sbLogs.push('[' + scope + '] ' + message)
          if (globalThis.__sbLogs.length > 200) globalThis.__sbLogs.shift()
        }
      } catch (e) { /* 忽略 */ }
      try { console.log('[dsh-sidebar-ratio/' + scope + '] ' + message) } catch (e) { /* 忽略 */ }
    }

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * 当前活跃（上屏）会话 id；拿不到返回 null。
     *
     * DSH 0.1.7 改了数据形状：sessions.list 的快照只有 ids / byId / phase，
     * 不再有 current 字段——「谁在上屏」改由 sidebarRight 的 mounted 可观察值
     * 发布（seat 绑定时更新）。读序：mounted（0.1.7）→ 旧 shape 的 current → null。
     */
    function currentSession(ctx) {
      try {
        var mounted = ctx.sidebarRight.mounted
        if (mounted !== undefined && mounted !== null && typeof mounted.getSnapshot === 'function') {
          var m = mounted.getSnapshot()
          if (typeof m === 'string') return m
        }
      } catch (error) {
        log('session', 'mounted 读取失败：' + describe(error))
      }
      try {
        var snapshot = ctx.sessions.list.getSnapshot()
        if (snapshot === undefined || snapshot === null) return null
        var current = snapshot.current
        return typeof current === 'string' ? current : null
      } catch (error) {
        log('session', '读取当前会话失败：' + describe(error))
        return null
      }
    }

    /**
     * 某会话的直接父会话 id。两个来源都要认，因为两个类型的字段名不一样：
     *   sessions.subagentAddress(id)            目录里已发现的直接父地址
     *   list.byId[id] 是 SessionSummary        父字段叫 parentId
     *     （packages/api/session-controller/src/client/sessions/service.ts:46）
     *   SessionListEntry（扁平化后的行）        父字段叫 parentSessionId
     *     （.../sessions/lineage.ts:24）—— 这里顺带兼容，防止将来换了数据源
     */
    function parentOf(sessions, id) {
      try {
        var address = sessions.subagentAddress(id)
        if (address !== undefined && address !== null && typeof address.parentSessionId === 'string') {
          return address.parentSessionId
        }
      } catch (error) {
        log('session', 'subagentAddress 失败：' + describe(error))
      }
      try {
        var snapshot = sessions.list.getSnapshot()
        var row = snapshot !== undefined && snapshot !== null && snapshot.byId !== undefined
          ? snapshot.byId[id]
          : undefined
        if (row === undefined || row === null) return null
        if (typeof row.parentId === 'string') return row.parentId
        if (typeof row.parentSessionId === 'string') return row.parentSessionId
      } catch (error) {
        log('session', '列表 lineage 读取失败：' + describe(error))
      }
      return null
    }

    /**
     * 某会话所属的「父总会话」id：沿 parentOf 一直上溯到没有父为止。
     * 只缓存真的上溯过的结果 —— 上溯不到父时可能只是 lineage 还没到达客户端，
     * 那种情况每次重算，免得把"暂时查不到父"永久固化成"它自己就是根"。
     */
    function rootOf(sessions, id) {
      if (id === null) return null
      var cached = state.roots[id]
      if (typeof cached === 'string') return cached
      var current = id
      var seen = Object.create(null)
      var walked = 0
      while (walked < 32) {
        if (seen[current] === true) break // lineage 成环，停在原地（source 侧会拦，这里自保）
        seen[current] = true
        var parent = parentOf(sessions, current)
        if (parent === null || parent === current) break
        current = parent
        walked += 1
      }
      if (walked > 0) state.roots[id] = current
      return current
    }

    /**
     * 会话 seat 挂载时的默认“开始”面板是不是这个 tab。
     * 那不是用户意图：子代理一上屏右栏就开着它，既不能当组基准（会把父会话
     * 真实的面板覆盖掉），也不能当成“用户已经开了面板”（否则继承永不触发）。
     */
    function isDefaultGuide(tab) {
      if (tab === null || tab === undefined || typeof tab !== 'object') return false
      if (tab.kind === 'guide') return true
      if (typeof tab.contentId === 'string' && tab.contentId === 'sidebar://guide') return true
      return false
    }

    /**
     * 记录「当前上屏会话开着什么」。会话切换前调用才有效 —— 所以除了轮询，
     * 还在 document 的 pointerdown（捕获阶段）抓一次：用户点会话列表那一刻，
     * 上屏的还是父会话，此时读到的是父会话真实状态。
     */
    function capture(ctx) {
      var sidebarRight = ctx.sidebarRight
      var sessions = ctx.sessions
      var sessionId = currentSession(ctx)
      if (sessionId === null) return
      var expanded
      try {
        expanded = sidebarRight.isExpanded()
      } catch (error) {
        // seat 未上屏时会抛「no session surface is mounted」，属正常时序，不记日志
        return
      }
      var previous = state.screen
      state.screen = { sessionId: sessionId, expanded: expanded === true }
      var root = rootOf(sessions, sessionId)
      if (root === null) return

      if (expanded !== true) {
        // 只有「同一个会话从展开变收起」才算用户把面板关掉了。
        // 新会话本来就没开过（isExpanded() 也是 false），那种情况绝不能清掉组基准，
        // 否则父会话一开面板、切到子会话就被误清，继承直接失效。
        if (previous.sessionId === sessionId && previous.expanded === true && state.groups[root] !== undefined
          && (!PARENT_ONLY || sessionId === root)) {
          delete state.groups[root]
          log('capture', '组 ' + root + '：' + sessionId + ' 面板已收起 → 清除组基准')
        }
        return
      }
      var tab = sidebarRight.active()
      if (tab === undefined || tab === null || typeof tab.kind !== 'string') return
      // 默认“开始”guide 不是用户意图：跳过它，组基准保持上一个真实面板
      // （否则父开着任务管理、切到子代理再切回来，基准已被 guide 覆盖）
      if (isDefaultGuide(tab)) return
      // 组基准的写入口：默认组内统一（谁开谁成为基准，父会话开面板自然成为基准）；
      // inheritFromParent=true 时收紧为"只有父总会话能写、子代理只读"。
      if (PARENT_ONLY && sessionId !== root) {
        log('capture', sessionId + ' 不是组 ' + root + ' 的父会话 → 严格模式下只读基准，不改写')
        return
      }
      state.groups[root] = {
        kind: tab.kind,
        contentId: typeof tab.contentId === 'string' ? tab.contentId : '',
        title: typeof tab.title === 'string' ? tab.title : ''
      }
      log('capture', '组 ' + root + ' ← ' + sessionId + '：' + tab.kind + ' / ' + state.groups[root].contentId)
    }

    /** 把组基准里的标签在目标会话里重新打开（openContent 会顺带展开该会话的右列）。 */
    function replay(ctx, target, intent) {
      if (intent === null || intent === undefined) { log('replay', '无基准可重放'); return false }
      var sidebarRight = ctx.sidebarRight
      // 目标还没上屏（binding 未跟上）→ 交给重试
      var cur = currentSession(ctx)
      if (cur !== target) return false
      var expanded
      try {
        expanded = sidebarRight.isExpanded()
      } catch (error) {
        return false // seat 未 mount，稍后重试
      }
      if (expanded === true) {
        // 已展开也要看是不是默认 guide：子代理一挂载右栏就开着“开始”，
        // 那不是用户开的面板——照旧重放组基准，否则继承永远不发生。
        var currentTab = null
        try { currentTab = sidebarRight.active() } catch (error) { /* seat 掉了 → 交给重试 */ }
        if (currentTab !== null && currentTab !== undefined
          && typeof currentTab.kind === 'string' && !isDefaultGuide(currentTab)) {
          return true // 该会话真开着面板 → 不打扰
        }
      }
      try {
        if (intent.contentId.indexOf('dsh-resource://') === 0) {
          sidebarRight.openResourceIn(target, intent.contentId, { kind: intent.kind })
        } else {
          sidebarRight.openTabIn(target, intent.kind)
        }
        log('replay', target + ' ← ' + intent.kind + ' / ' + intent.contentId)
        return true
      } catch (error) {
        // kind 没注册、地址无人认领等：只记日志，不再重试（重试也不会成功）
        log('replay', '打开失败（放弃）：' + describe(error))
        return true
      }
    }

    /** 同组才继承：同一父总会话（父 + 其下所有层级子代理）共用一个基准。 */
    function shouldInherit(ctx, from, to) {
      if (from === null || from === to) return false
      if (state.inheritAll) return true
      var fromRoot = rootOf(ctx.sessions, from)
      var toRoot = rootOf(ctx.sessions, to)
      if (fromRoot === null || toRoot === null) return false
      return fromRoot === toRoot
    }

    function onSwitch(ctx, next) {
      // null 不是“切换到了无会话”，而是 seat 重绑的间隙（或全局面板接管）：
      // 此刻 mounted 短暂 undefined。把它当成一次切换会抹掉 lastSession，
      // 于是紧接着真正的那次 父→子 from 已经是 null，继承永远不成立。
      if (next === null) return
      var from = state.lastSession
      state.lastSession = next
      if (!state.inherit || from === null) return
      var attempt = 0
      var tick = function () {
        if (state.disposed || !state.inherit) return
        if (currentSession(ctx) !== next) return // 用户又切走了，放弃
        // 每次重试都**重算**分组与基准，不要在外面算一次就定死：
        // 子代理的 lineage（byId.parentId / subagentAddress）常常在上屏之后
        // 才投影到客户端——切换那一刻 rootOf(next) 还是它自己，算出来"不同组"
        // 就永久放弃，而几百毫秒后 lineage 到达时本该是同组的。
        if (!shouldInherit(ctx, from, next)) {
          attempt += 1
          if (attempt < RETRY_MS.length) later(tick, RETRY_MS[attempt])
          else log('switch', from + ' → ' + next + '：重试窗口内始终不同组，放弃')
          return
        }
        var intent = state.groups[rootOf(ctx.sessions, from)]
        if (intent === undefined) {
          attempt += 1
          if (attempt < RETRY_MS.length) later(tick, RETRY_MS[attempt])
          else log('switch', from + ' → ' + next + '：同组但窗口内没有基准，放弃')
          return
        }
        if (replay(ctx, next, intent)) return
        attempt += 1
        if (attempt < RETRY_MS.length) later(tick, RETRY_MS[attempt])
      }
      later(tick, RETRY_MS[0])
    }

    /** 可被卸载取消的 setTimeout：卸载后绝不留下会动会话的悬挂定时器。 */
    function later(fn, ms) {
      var id = setTimeout(function () {
        state.retryTimers.delete(id)
        fn()
      }, ms)
      state.retryTimers.add(id)
      return id
    }

    function cancelPending() {
      state.retryTimers.forEach((id) => { clearTimeout(id) })
      state.retryTimers.clear()
    }

    function apply(ctx) {
      var sessions = ctx.sessions
      ctx.effect(() => {
        // cordis 热重载会再次 apply 同一个模块实例，卸载标记必须复位
        state.disposed = false
        var stopList = () => {}
        var stopMounted = () => {}
        var checkSwitch = () => {
          try {
            var next = currentSession(ctx)
            if (next !== state.lastSession) onSwitch(ctx, next)
          } catch (error) {
            log('switch', describe(error))
          }
        }
        // sessions.list：列表/血缘变化的兜底信号
        try {
          stopList = sessions.list.subscribe(checkSwitch)
        } catch (error) {
          log('boot', '订阅会话列表失败：' + describe(error))
        }
        // sidebarRight.mounted：0.1.7 上「谁在上屏」的权威信号——切会话（父↔子代理）
        // 就是 seat 重绑、mounted 变；只订 list 的话切会话永远观测不到。
        try {
          var mountedStore = ctx.sidebarRight.mounted
          if (mountedStore !== undefined && mountedStore !== null && typeof mountedStore.subscribe === 'function') {
            stopMounted = mountedStore.subscribe(checkSwitch)
          }
        } catch (error) {
          log('boot', '订阅 mounted 失败：' + describe(error))
        }
        state.lastSession = currentSession(ctx)
        capture(ctx)

        // 会话切换前的那次点击：此刻上屏的还是父会话，抓到的才是父会话状态
        var onPointerDown = () => {
          try { capture(ctx) } catch (error) { log('capture', describe(error)) }
        }
        try { document.addEventListener('pointerdown', onPointerDown, true) } catch (error) { /* 非浏览器环境忽略 */ }

        var poll = setInterval(() => {
          try { capture(ctx) } catch (error) { log('capture', describe(error)) }
        }, POLL_MS)

        try {
          globalThis.dshSidebarInherit = {
            get: () => ({
              inherit: state.inherit,
              inheritAll: state.inheritAll,
              lastSession: state.lastSession,
              /** 父总会话 id → 该组当前基准 */
              groups: state.groups,
              /** 当前上屏会话所属的父总会话（便于确认分组是否符合预期） */
              currentRoot: rootOf(sessions, currentSession(ctx)),
              screen: state.screen
            }),
            enabled: (flag) => { state.inherit = flag !== false; return state.inherit },
            all: (flag) => { state.inheritAll = flag === true; return state.inheritAll },
            verbose: (flag) => { state.verbose = flag === true; return state.verbose },
            rootOf: (id) => rootOf(sessions, id === undefined ? currentSession(ctx) : id),
            capture: () => { capture(ctx); return state.groups },
            replay: () => {
              var target = currentSession(ctx)
              if (target === null) return false
              return replay(ctx, target, state.groups[rootOf(sessions, target)])
            }
          }
        } catch (error) { /* 非浏览器环境忽略 */ }

        return () => {
          state.disposed = true
          cancelPending() // 卸载后绝不能留下会替用户开标签的悬挂重试
          stopList()
          stopMounted()
          clearInterval(poll)
          try { document.removeEventListener('pointerdown', onPointerDown, true) } catch (error) { /* 忽略 */ }
        }
      }, 'dsh-sidebar-ratio: share the right sidebar across one parent session group')
    }

    exports.apply = apply
    exports.inject = ['sessions', 'sidebarRight']
    return module.exports
  }
})
