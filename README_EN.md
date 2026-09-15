# dsh-sidebar-ratio

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-DSH%20web-4c8bf5.svg)

**English** | [中文](README.md)

Two things for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) web UI:

1. **Sidebar widths as a ratio of the window** — the left sidebar defaults to 14%, the right panel is optional; drag the native handles or use hotkeys, and the ratios are remembered in the browser.
2. **One shared right-side panel across a parent session group** — the file/preview panel you opened in the parent agent follows you into its subagents, grandchild agents and sibling subagents, with the same tab.

> **No deepseek-harness source file is modified.** Widths are applied to inline styles at runtime in the browser; panel inheritance uses only the official public client API.

---

## Why

**Sidebar widths are hard-coded pixels.** DSH's left sidebar has a fixed pixel width and a drag range of only
264–420px (`SIDEBAR_MIN`/`SIDEBAR_MAX` in
[`columns.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/columns.ts)),
so "narrower than native" is impossible; the right panel opens at a flat 45% of the window. The wider the
window, the smaller that fixed width becomes as a share of the screen.

**The right panel's state is isolated per session.** Each session owns its own panel state, created collapsed
and tab-less, so a file panel opened in the parent agent disappears the moment you switch to a subagent
session. That is by design rather than a bug — but it is awkward for the "parent delegates, subagents
execute" workflow.

This plugin addresses both with two different mechanisms.

---

## Features

### 1. Sidebar widths as a window ratio

| Action | Effect |
| --- | --- |
| Drag a native handle | Sets that column's ratio directly (left and right), no longer clamped to 264–420px |
| `Alt` + `←` / `→` | Left sidebar −1% / +1% |
| `Alt` + `Shift` + `←` / `→` | Right panel −1% / +1% |
| `Alt` + `0` | Master switch: off returns to fully native behaviour |

- Ratios live in browser `localStorage` (key `dsh.sidebar-ratio.v1`), survive reloads, and **write no files to disk**.
- Left: 200px floor, 45% ceiling by default. Right: 300px floor, 70% ceiling — clamped by pixels *and* ratio,
  so the centre column can never be squeezed away.
- Dragging works by **hijacking the native handle**, so it feels identical to native while reaching below 264px.

### 2. One shared right panel per parent session group

Grouping: walk the session lineage up to the top. **One parent session (the top-level session itself plus every subagent below it at any depth) forms one group**, and the group shares a single panel baseline.

- Parent → direct child, parent → grandchild, and **sibling subagents** all behave the same; different parent sessions never affect each other.
- Only sessions that are **currently collapsed** are touched — if the target session already has a panel open, the plugin leaves it alone.
- Who may write the group baseline (`inheritFromParent`, default `false`):
  - `false`: **unified within the group**. Whoever opens a panel defines the baseline; the parent opening a panel naturally becomes it.
  - `true`: **strictly parent-driven**. Only the parent session writes the baseline; subagents are read-only.
- A panel counts as "closed by the user" only when **the same session transitions from expanded to collapsed**, so a fresh session that never opened a panel is never mistaken for a deliberate close.

---

## Install

### From GitHub (recommended)

```powershell
dsh plugin --profile web add github:masknull/dsh-sidebar-ratio
```

To pin a version instead of tracking the default branch:

```powershell
dsh plugin --profile web add github:masknull/dsh-sidebar-ratio#v0.2.0
```

The CLI appends the package name to the profile's `dsh.profile.bundles` and applies this package's
`cordis.patch.yml` at startup. A git / path / tarball spec on the command line is first materialized by
pnpm into a real dependency and then reconciled **by its true package name**
(`apps/cli/src/plugin.ts:59-91`), so both forms above register correctly as `dsh-sidebar-ratio`.

### From a local directory (development)

```powershell
dsh plugin --profile web add <absolute path, e.g. E:\AI\dsh-sidebar-ratio>
```

A relative path works too — the CLI anchors it to the directory you invoke it from
(`apps/cli/src/plugin.ts:104-112`), so this is valid from the repository root:

```powershell
dsh plugin --profile web add .
```

### One restart is required after installing

New bundle layers are composed at startup only, so:

1. Restart `dsh web`
2. Reload the page (F5)

### What needs a restart after editing

| Changed | Takes effect via |
| --- | --- |
| `lib/dom.js` (width logic) | **F5 only** — the host half re-reads this file on every index.html render |
| `lib/client.js` (panel inheritance) | **Restart `dsh web`** — the client bundle load graph is composed at startup |
| `lib/index.js`, `cordis.patch.yml` | **Restart** — `apply` runs once at startup |

The package is **plain JavaScript with no build step**: installing it from GitHub runs as-is, with no `pnpm build`.

---

## Configuration

Set these in `config` of `cordis.patch.yml` (restart required):

| Key | Default | Meaning |
| --- | --- | --- |
| `left` | `0.14` | Left sidebar share; `null` = do not manage the left sidebar |
| `right` | `null` | Right panel share; `null` = do not manage the right panel |
| `minLeft` | `200` | Left pixel floor (native is 264) |
| `minRight` | `300` | Right pixel floor (native `RIGHTBAR_MIN` is 300) |
| `enabled` | `true` | Default for the width master switch |
| `inherit` | `true` | Enable "shared right panel across a parent session group" |
| `inheritAll` | `false` | `true` = ignore grouping and inherit across any session switch |
| `inheritFromParent` | `false` | Baseline rule, see Feature 2 |

## Console API

```js
// widths
dshSidebarRatio.get()          // state; leftBlocked / rightBlocked explain "set but not effective right now"
dshSidebarRatio.set(0.12)      // left sidebar 12% (12 also means 12%)
dshSidebarRatio.right(0.26)    // right panel 26%
dshSidebarRatio.enabled(false) // temporarily hand both sides back to native
dshSidebarRatio.native()       // same, without touching the switch
dshSidebarRatio.reset()        // clear localStorage and fall back to the configured defaults

// diagnostics
dshSidebarRatio.debug(true)    // live logging
dshSidebarRatio.trace()        // last 40 internal events (what triggered, what was written)
dshSidebarRatio.probe()        // re-solve against the current DOM now, returning before/after signatures

// panel inheritance
dshSidebarInherit.get()        // per-group baselines and which group the current session belongs to
dshSidebarInherit.enabled(false)
dshSidebarInherit.all(true)    // ignore grouping
dshSidebarInherit.rootOf(id)   // which parent session group a session belongs to
dshSidebarInherit.verbose(true)
```

---

## How it works

### Widths: taking over DSH's own inline styles while keeping straight who wrote them

The plugin edits React-managed inline styles (the frame's `grid-template-columns`, the left content's `width`,
both handles' `left`, the right panel's `width`). The hard part is not writing them but **not fighting React for
the steering wheel**, which needs three rules:

1. **Know who wrote it.** Before every write, settle accounts: if the current DOM value differs from what we last
   wrote, React wrote it — record it as the *native* value. Restoring writes back that latest native value instead
   of the snapshot taken when the plugin first took over.
2. **Rewrite before paint.** A `MutationObserver` callback is a microtask that runs before paint, so a hit is
   corrected **synchronously**, not via `requestAnimationFrame` — deferring to rAF costs a whole frame, and that
   frame is exactly the visible "official width flashes for an instant".
3. **The observer's allow-list is a fast path, not the only path.** The callback only reacts to the frame, the two
   column containers and the nodes the plugin manages (the centre conversation column is deliberately excluded —
   streaming output produces a flood of style/class changes). Structural changes inside the column containers that
   the allow-list cannot name (React swapping an intermediate wrapper or rebuilding the panel) are caught by a
   **signature check on the next frame**, with a **400ms signature comparison** as the outer net (reading five
   inline style strings only — pure CSSOM reads, no layout), plus a `ResizeObserver` for "the frame changed size
   without a window resize". **The worst-case convergence time is bounded and does not depend on guessing which
   mutation might be missed.**

### Panel inheritance: remember the intent, replay it through the official API

The only publicly writable cross-session entry points are `ctx.sidebarRight.openTabIn(sessionId, kind, options)` /
`openResourceIn(sessionId, address, options)`, and `openContent` forces `setExpanded(true)` — opening a tab
necessarily expands that session's right column. Conversely, **no public API can read another session's tab set**
(`active()`/`mounted()` only read the mounted session), so the plugin remembers "which tab the on-screen session
has open" (kind + contentId) as the group baseline and replays it when switching to a collapsed session in the
same group.

Worth noting: the sidebar terminal added in DSH `v0.1.6-alpha.1` uses
`ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: … })` for its own cross-session replay
([`ui-sidebar-terminal`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar-terminal/src/client/index.ts)) —
this plugin builds on exactly the same official path.

---

## Known limits

These are not omissions — the public surface has no such capability, or the behaviour is native:

| Limit | Why |
| --- | --- |
| Only the **active tab** can be inherited | `active()` returns just the active tab; no public API lists another session's tabs |
| Cannot inherit co-existing tabs, splits, floating panes or `mode` | Same as above; the readable `TabRecord` carries only `{id, kind, contentId, title}` |
| Cannot inherit in-tab scroll position or other `params` | Navigation params are not part of the public read surface. Concretely, for the sidebar **terminal**: the official recovery flow passes its own `params: { terminalId }` to `openTabIn`; the plugin cannot read those params, so a subagent session opens a **fresh terminal** instead of attaching to the parent's |
| Cannot "expand without opening a tab" | There is no `setExpandedIn(sessionId, bool)` |
| Left ratio is inactive while the sidebar is **collapsed** or the frame is **<1024px** | The collapsed rail is 56px and should not be widened (native `SIDEBAR_AUTO_COLLAPSE`) |
| Right ratio is inactive when the right panel has **no track of its own** | Below 768px the panel derives auto-fullscreen (native behaviour) and there is no handle to drag |
| Takeover ranges differ from native | The 200px floor / 45% ceiling on the left are this plugin's own policy; `Alt+0` returns to the native 264–420 |

The readout chip and `dshSidebarRatio.get()`'s `leftBlocked` / `rightBlocked` state explicitly when a setting is
not effective and why — it never pretends to have applied something.

## Troubleshooting

| Symptom | Look at |
| --- | --- |
| Width not following the ratio | `dshSidebarRatio.get()` for `leftBlocked` / `rightBlocked`, then `debug(true)` for live logs |
| Width flashes when switching sessions | `dshSidebarRatio.trace()`: normally you see `观察器命中` (synchronous, invisible). Frequent `签名不一致` entries mean a structural change was not recognised — the trace names the target shape that was missed |
| Not sure which build the page loaded | `typeof dshSidebarRatio.trace` — a function means the current build |
| Panel inheritance not working | `dshSidebarInherit.get()` for `groups` / `currentRoot`, plus `verbose(true)` for capture/replay logs |

---

## Compatibility and maintenance anchors

Verified against a DSH source tree with cordis `4.0.2` and react-dom `18.3.1`, and additionally
**checked byte-for-byte against `dsh-v0.1.6-alpha.1`** (git blob SHA comparison, not a visual diff):
**9 of the 13 anchor files this plugin depends on are byte-identical** to that release, and the other four differ
**only by additions on the release side** — every method, DOM marker and attribute this plugin relies on is
untouched, so there are **no breaking changes**.

All paths below are relative to the deepseek-harness repository root (links point at the tag used for
verification); if something breaks after a DSH upgrade, check these first:

| What the plugin depends on | Where |
| --- | --- |
| The three-column inline grid, the frame's `data-*` attributes, the `[data-side]` handles | [`ui-layout/…/AppFrame.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/AppFrame.tsx) |
| Boundary constants `SIDEBAR_MIN/MAX`, `RIGHTBAR_MIN`, `CENTER_MIN`, `RIGHTBAR_MAX_RATIO` | [`ui-layout/…/columns.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/columns.ts) |
| Track transition, `.handle`, both columns' overflow | [`ui-layout/…/AppFrame.module.css`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-layout/src/client/AppFrame.module.css) |
| The left content's own inline `width` | [`ui-sidebar/…/SidebarRoot.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar/src/client/SidebarRoot.tsx) |
| The right panel's `data-sidebar-right-panel` + inline `width` | [`ui-sidebar-right/…/shell/SidebarRight.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx) |
| The public cross-session tab entry points `openTabIn` / `openResourceIn` | [`ui-sidebar-right/…/service.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-sidebar-right/src/client/service.ts) |
| The readable `TabRecord` shape | [`ui-dockkit/…/contract/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/ui-dockkit/src/contract/types.ts) |
| Session lineage field `SessionSummary.parentId` and the session-switch signal | [`session-controller/…/sessions/service.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/api/session-controller/src/client/sessions/service.ts) |
| The structured injection-row protocol (`global` / `script`; script text must not contain the closing-tag literal) | [`webserver/src/injections.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/host/webserver/src/injections.ts) |
| The client bundle discovery contract (`exports["./client"]`, `dsh.client.platform`) | [`client/modules/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/client/modules/src/index.ts) |

Logic was verified during development with a **zero-dependency stub-DOM regression harness**
(**that harness is not shipped in this repository**; this only describes how thoroughly it was checked):
a fabricated AppFrame structure (including intermediate wrappers and panel replacement, matching the real DOM
hierarchy), controllable timers, and manually fed mutation records, covering takeover, same-microtask correction,
restoring the latest native value, per-side restore, blocked-state reporting and drag interception — plus
mutation-style negative checks proving the assertions are not vacuous (deliberately breaking the implementation
must be caught).

## Uninstall

```powershell
dsh plugin --profile web remove dsh-sidebar-ratio
```

Then restart `dsh web` and reload. The only browser-side residue is the `dsh.sidebar-ratio.v1` localStorage key,
which `dshSidebarRatio.reset()` clears.

## License

[MIT](LICENSE)
