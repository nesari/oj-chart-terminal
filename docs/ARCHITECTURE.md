# Architecture

Current version: **1.9.212** (`package.json`).

This document describes the real module boundaries and data flow of the app. It is intentionally
implementation-level: every path below exists in the repository.

## 1. Process & layer map

```
┌─────────────────────────────┐        JSON over ws://127.0.0.1:8777        ┌──────────────────────────────┐
│ Electron main (main.js)     │  spawns / supervises                        │ Python provider              │
│ · windows, menus, security  │ ──────────────────────────────────────────► │ · provider_common.py (server)│
│ · provider lifecycle        │                                             │ · demo.py / mt5.py (backend) │
│ · fs, logs, accounts        │ ◄────────────── provider-log IPC ────────── │ · chart_cache.py (bars cache)│
└──────────────┬──────────────┘                                             └──────────────────────────────┘
               │ IPC (contextBridge whitelist)
┌──────────────▼──────────────┐
│ preload.js                  │  window.electronAPI / mt5Tabs / mt5Win
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────────────────────────┐
│ Renderer (src/renderer/)                                                                    │
│  app.js (single ES-module entry) ── chart/ · drawing/ · panels/ · trade/ · ui/ · core/      │
│         │                                                                                   │
│         └── imports src/core/* (platform-agnostic) ◄──── src/core/feed.js (WebSocket)       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

There is no framework and no bundler. The renderer is a static ES-module graph loaded from
`src/renderer/index.html`; Electron loads it from disk, while the smoke test serves `src/` over HTTP.

## 2. Directory contract

| Path | Responsibility | May depend on |
|---|---|---|
| `main.js` | Electron main process: window creation/hardening, provider spawn & health, IPC handlers (validation + file I/O + safeStorage), log files | Node, Electron |
| `preload.js` | Minimal, explicit `contextBridge` surface. No Node objects reach the page. | Electron |
| `provider/provider_common.py` | Shared WebSocket server, timeframe bucketing/aggregation, news calendar, request loop | Python stdlib + `websockets` |
| `provider/demo.py` | Deterministic simulated market (bars, ticks, symbols, demo account/orders) | `provider_common.py` |
| `provider/mt5.py` | MetaTrader 5 bridge (Windows-only `MetaTrader5` package) | `provider_common.py` |
| `provider/chart_cache.py` | On-disk bar cache used by the live provider | Python stdlib |
| `src/core/` | Platform-agnostic domain: feed client, state/persistence seam, indicators, timezone, logging, errors, math, Pine engine (`src/core/pine/`) | nothing from `src/renderer` or `src/platform` |
| `src/platform/electron/loghost.js` | Host adapter that injects the Electron log transport/crash net into the core logger | `src/core`, `window.electronAPI` |
| `src/renderer/` | DOM UI: chart panes, drawings, panels, trading, login/window chrome | `src/core`, vendor lib |

### Layer rules

1. **Core has no DOM and no Electron.** Only `src/core/env.js` touches host globals (`window`,
   `localStorage`) and it degrades safely when they are absent. Tests and the future web shell reuse
   the same modules unchanged.
2. **The renderer never imports Node or Electron directly.** All privileged operations go through
   the three preload bridges (`electronAPI`, `mt5Tabs`, `mt5Win`).
3. **The main process owns side effects**: process spawning, filesystem writes, dialogs, credentials,
   log files. Renderer requests are payload-validated per channel.
4. **The provider is the only data source.** The renderer reaches it exclusively via
   `src/core/feed.js`; no module opens its own socket.
5. **Static module graph.** Every cross-file reference is a named `import`/`export`; the import gate
   (`scripts/checks/check-imports.mjs`) enforces resolvable paths.

## 3. Renderer module map

| Folder | Modules (non-exhaustive) | Role |
|---|---|---|
| `js/chart/` | `manager.js`, `tabs.js`, `toolbar.js`, `compare.js`, `settings.js`, `indicators-ui.js`, `pine-ui.js`, `pine-editor`-adjacent | Pane creation/layout, data loading, series & price scale, top toolbar, tabs, Pine UI |
| `js/drawing/` | `engine.js`, `tools.js`, `tools2.js`, `settings.js`, `ui.js` | Drawing primitives, tools, selection/undo hooks, style dialogs, toolbox |
| `js/panels/` | `watchlist.js`, `alerts.js`, `news.js`, `replay.js`, `tester.js`, `datawindow.js`, `diagnostics.js`, `objects.js`, `gotodate.js`, `session.js`, `stratdock.js`, `timesales.js`, `pine-editor.js`, `pine-scripts-store.js` | Right-rail and bottom panels |
| `js/trade/` | `dock.js`, `ticket.js`, `oneclick.js`, `overlay.js`, `modify.js`, `history.js`, `route.js`, `state.js`, `replaytrade.js`, `alerts.js` | Order ticket, chart trade lines, positions/orders dock, history, demo/live routing |
| `js/ui/` | `login.js`, `icons.js`, `rightpanel.js`, `wincontrols.js` | Login/boot, inline SVG icon set, right rail, frameless window buttons |
| `js/core/` | `theme.js`, `undo.js`, `util.js` | Renderer-only helpers; `util.js` is a facade over `src/core/util.js` plus DOM helpers |

## 4. Data flow

1. **Boot.** `src/renderer/js/app.js` installs the Electron host (`src/platform/electron/loghost.js`),
   builds `App`, and wires `App.feed = new Feed(...)`. In tests/browser mode the socket URL can be
   injected with `?ws=host:port`.
2. **Provider start.** On “Connect”, `ui/login.js` calls `electronAPI.startProvider(...)` (Electron)
   and `main.js` spawns `provider/demo.py` or `provider/mt5.py` on port 8777. In browser/smoke mode no
   provider is spawned; the harness starts it separately.
3. **Login.** `Feed.login(mode, creds)` sends `{type:'login'}`. The provider answers with account
   info, symbol list and the broker server-time offset (`off`).
4. **History.** `chart/manager.js → loadBars(pane)` calls `Feed.bars(symbol, tf, count)`
   (`bars_req`), sanitizes the rows (`sanitizeBars`), stores them on `pane.bars`/`pane.barTimes`, and
   calls the chart series `setData`. Indicators and Pine scripts are recomputed from those bars.
5. **Live ticks.** `Feed.subscribe(symbol)`/`unsubscribe` manage a refcounted subscription set; the
   provider pushes ticks at the requested refresh rate. `core/feed.js` fans them out through
   `App.onTickHooks` and per-pane handlers: chart last-bar update, watchlist prices, price alerts,
   trade overlay and the positions dock.
6. **Persistence.** UI state (drawings, watchlist, settings, layouts, Pine scripts, alerts, tool
   templates) goes through `ENV.storage` → `localStorage`, keyed `mt5_*`. Account credentials never
   enter this path: `accounts-save`/`accounts-load` IPC validates and encrypts them with
   `safeStorage`.

## 5. Provider protocol (WebSocket JSON)

Every message is `{type, req_id?, ...}`; responses echo `req_id` where applicable.

| Client → provider | Provider → client | Purpose |
|---|---|---|
| `ping` | `pong` | Liveness |
| `refresh_rate` | `ok` | Adaptive tick cadence |
| `servers`, `servers_ping` | `servers` | MT5 server discovery |
| `login` | `login_ok` / `login_error` | Account + broker offset + symbol list |
| `bars_req` | `bars` | OHLCV history (`symbol`, `tf`, `count`, optional `to`) |
| `subscribe`, `unsubscribe` | `tick` | Live price stream (refcounted) |
| `symbol_search` | `symbols` | Symbol lookup for chart/watchlist/compare |
| `news` | `news` | Economic calendar |
| `trade` | `trade_ok` / `trade_error` | Orders, positions, history, account actions |
| `echo` | `echo` | Diagnostics round-trip |

## 6. IPC contract

All renderer access is through `preload.js`; `main.js` validates every payload before acting.

| Channel | Direction | Bridge | Notes |
|---|---|---|---|
| `start-provider`, `stop-provider`, `provider-identity` | renderer → main (invoke/send) | `electronAPI` | Spawn/supervise the Python provider |
| `provider-log` | main → renderer (event) | `electronAPI.onProviderLog` | Provider stderr/stdout lines |
| `notify` | renderer → main (send) | `electronAPI.notify` | OS notifications |
| `save-data-url`, `save-text-file`, `copy-image` | renderer → main (invoke) | `electronAPI` | Screenshot/CSV/log export |
| `accounts-load`, `accounts-save` | renderer → main (invoke) | `electronAPI` | Validated; encrypted via `safeStorage` |
| `log-batch` | renderer → main (send) | `electronAPI.logBatch` | Batched JSONL log entries |
| `logs-export`, `diag-ping` | renderer → main (invoke) | `electronAPI` | Diagnostics panel |
| `tabs:undock`, `tabs:claim`, `tabs:dockback`, `tabs:dock-ack` | renderer ↔ main | `mt5Tabs` | Detachable chart tabs |
| `tabs:dock-request`, `tabs:dock-ack` | main → renderer (events) | `mt5Tabs.onDockRequest/onDockAck` | Dock handshake |
| `win:minimize`, `win:maximize`, `win:close`, `win:is-max`, `win:max-state` | renderer ↔ main | `mt5Win` | Frameless window controls |

## 7. Logging, security, packaging

- **Logging.** `src/core/logger.js` keeps a ring buffer and an injectable transport.
  `src/platform/electron/loghost.js` injects a batched IPC transport; `main.js` writes
  `<userData>/logs/app-YYYY-MM-DD.log` (JSONL, rotation + pruning) and redacts secret-looking
  context keys.
- **Security.** `contextIsolation` + `sandbox` + `nodeIntegration:false`, strict CSP in
  `src/renderer/index.html`, all permission requests/checks denied, navigation and `window.open`
  blocked, IPC payload size/type validation, credentials encrypted at rest.
- **Packaging.** `package.json → build.files` ships `main.js`, `preload.js`, `src/**`, `provider/**`
  and `assets/**`; `scripts/**`, `docs/**` and `provider/__pycache__/**` are excluded.
- **Quality gate.** `npm run verify` = syntax → import graph → Python compile → offscreen Electron
  boot smoke (see README). CI runs the full gate on Windows and the static gates on Linux.

## 8. Deliberate constraints

- Real MT5 data is Windows-only (`MetaTrader5` pip package). Demo mode is cross-platform.
- One provider instance per app (port 8777); the smoke test deliberately uses 8899.
- `src/renderer/vendor/lightweight-charts.standalone.production.js` is a vendored UMD build and is
  excluded from the syntax/import gates.
- Pine execution is local; no script is fetched from a remote origin.
