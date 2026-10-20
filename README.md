# MT5 Chart Terminal

A lightweight TradingView-style charting terminal for Windows, built with Electron and a Python WebSocket provider. It charts live MetaTrader 5 data or a fully local simulated demo feed, and includes drawing tools, Pine Script v6, alerts, news, replay and a complete trading stack (order ticket, one-click, positions/orders, strategy tester).

## Requirements

- Windows 10/11 (primary target — real MT5 trading requires the Windows-only `MetaTrader5` Python package)
- macOS / Linux is supported for **demo mode** via `run.sh`; real MT5 data still needs Windows because the `MetaTrader5` pip package is Windows-only.
- macOS keeps the native traffic-light window controls (`titleBarStyle: 'hiddenInset'`); Windows and Linux use the frameless shell whose minimize/maximize/close buttons live at the right end of the tab strip.
- Node.js LTS (https://nodejs.org)
- Python 3.8+ (`python`/`python3` must be available in PATH)
- For real MT5 data: MetaTrader 5 terminal installed + `pip install MetaTrader5 websockets`
- For demo mode only: `pip install websockets`

## Run (development / from source)

1. Extract this folder anywhere (e.g. `C:\Users\Farzad\Desktop\mt5-chart-app`).
2. **Windows:** double-click **run-demo.bat** (simulated data, any account) or **run-mt5.bat** (real MT5).
   **macOS/Linux:** run `./run.sh` (demo mode) or `./run.sh mt5` (real MT5 — Windows only in practice, see above).
   - **Linux sandbox note:** on distributions where Chromium's SUID sandbox is blocked (some Ubuntu 22.04+/24.04 AppArmor setups, Docker, WSL), launch with `./run.sh --no-sandbox`. Extra flags are forwarded to Electron; only use this on machines you trust, since it disables Chromium's sandbox.
   - First run downloads Electron automatically (uses the npmmirror mirror; needs internet) and verifies the download against the official Electron checksum before launching (`scripts/verify-electron.js`).
3. On the login screen:
   - **Demo Server** — instant simulated market, no credentials.
   - **MetaTrader 5** — enter Login (account number), Password, Server name (e.g. `MetaQuotes-Demo`), optional terminal path if you have several installations.

## Features

### Charting

- Seconds timeframes (1S / 5S / 15S / 30S) up to 12M — labels show unit: S=seconds, m=minutes, H=hours, D/W/M.
- Tick-driven realtime updates, TradingView look & feel.
- Multi-chart layouts: the full TradingView set — 1 to 16 charts (55 variants: grids, big-pane combos, L-shapes).
  Every pane is individually resizable (drag the dividers, double-click a divider to reset).
- Chart style per chart: candles, hollow, Heikin Ashi, bars, high-low, line, line with markers, step, area, baseline, Renko —
  each chart in a multi-chart layout keeps its own style (mini toolbar on the chart, or the top-bar style menu).
- Layout picker (top toolbar): choose any layout variant and toggle **Sync in Layout** —
  Symbol, Interval, Crosshair, Time (scroll together) and Date range (zoom together).
- Chart snapshot: camera button in the top toolbar (or `Ctrl+Alt+S` / `Ctrl+Shift+S`) —
  in a single-chart layout it captures that chart; in a multi-chart layout it captures the whole
  layout with every open chart. Download as a PNG image or copy it to the clipboard.
- Free chart panning: with Auto Scale off, dragging the chart moves it freely both horizontally and vertically (TradingView behaviour); wheel over the price scale or dragging the price scale zooms it vertically (double-click the scale to reset). In multi-chart layouts every chart has a maximize/restore button (top-right of the chart, Esc also restores). The tool settings dialog is a floating window — drag it by its title bar anywhere over the chart.
- Timeframe keyboard switcher: type digits (e.g. `15`) then `Enter`; seconds intervals use lowercase `s` (1s, 5s, 15s, 30s).
- Timezone picker at the bottom-right of the chart — the full TradingView timezone list; applies to the time axis, crosshair and Data Window.
- **Save Layout** (TradingView logic): the toolbar icon next to the layout picker opens the TV-style menu — Save layout (`Ctrl+S`), Autosave toggle, Make a copy…, Rename…, Download chart data… (CSV of the active chart), Create new layout…, RECENTLY USED and Open layout…. Saving keeps the complete personal setup (layout + splitters, every chart's symbol/interval/style, chart settings, sync toggles, timezone, favorites, watchlist and all drawings) under a name; saved layouts are listed for one-click load or delete. The app also reopens your last charts on relaunch (turn Autosave off to keep only explicitly saved layouts).

### Drawing

- Full drawing toolbar with TradingView behaviour:
  - Trend Line, Ray, Extended Line, Parallel Channel, Arrow
  - Horizontal Line, Horizontal Ray, Vertical Line, Cross Line
  - Rectangle (8 resize handles: 4 corners + 4 edge midpoints, extendable left/right, middle line), Ellipse (8 handles), Triangle
  - Fibonacci & Gann flyout, exactly like TradingView — FIBONACCI: Fib Retracement, Trend-Based Fib
    Extension, Fib Channel, Fib Time Zone, Fib Speed Resistance Fan, Trend-Based Fib Time, Fib Circles,
    Fib Spiral, Fib Speed Resistance Arcs, Fib Wedge, Pitchfan — GANN: Gann Box, Gann Square Fixed,
    Gann Square, Gann Fan — PITCHFORKS: Pitchfork, Schiff, Modified Schiff, Inside
  - Text, Note, Measure, Zoom In
  - Magnet (snap to OHLC — click cycles Off / Weak / Strong; Weak snaps only within a few pixels, hold Alt to bypass), Lock all, Hide all, Remove all
- Drawings are anchored to price + time coordinates: they never shift on their own and survive timeframe switching.
- Star (favorite) any tool or timeframe — favorites appear on a floating toolbar over the chart (draggable, toggle it with the star button at the bottom of the left toolbar).
- Select any drawing to get its floating action bar (colors, width, style, extend, fill, … settings, lock, clone, delete) — the **…** button (or double-click on the drawing, or double-click its row in the Object Tree) opens the TradingView-style tool settings dialog:
  - **Style / Text / Coordinates / Visibility** tabs, exactly like TradingView (live-apply, Cancel reverts, Template footer with Default / saved templates / Save As… per tool).
  - Trend Line: Extend (4 modes), Middle point handle, Price labels, INFO stats (Stats / Stats position / Always show stats).
  - Rectangle / Ellipse / Triangle / Parallel Channel: Background color + opacity, extend.
  - Fib Retracement: per-level eye / ratio / color / remove + **Add level**, background bands, ratios & price labels, extend — saved customizations apply to future drawings too (last-used settings are remembered per tool).
  - Text: font size, color, bold/italic, alignment, background.
  - Coordinates tab edits each point's time (chart timezone) and price; Visibility tab shows the drawing only on enabled interval ranges (Ticks…Ranges, TV-style).

### Data, alerts & news

- Watchlist (add/remove/click to load symbol), Price Alerts (5 conditions, notifications + sound), Data Window, Bar Replay.
- Economic **News calendar** from the provider (impact/currency filters, locate-on-chart).
- **Pine Script v6** engine and editor (round 74): write/edit `.pine` scripts in the bottom Pine Editor panel, "Add to chart", TV-style sub-panes, script-owned boxes/lines/labels — see `docs/PINE-ENGINE-PLAN.md`. Chat remains excluded.

### Trading

- **Live MT5 or the built-in demo engine:** unified order ticket with SL/TP and risk modes, one-click trading, positions/pending orders dock (partial close, SL/TP modify, cancel), strategy tester and replay trading.
- The same UI drives both accounts; switch between them from the account menu. See `src/renderer/js/trade/`, `src/renderer/js/panels/tester.js` and `src/renderer/js/panels/replay.js`.

## Architecture

Current version: **1.9.212** (`package.json`).

- **`src/core/`** — the platform-agnostic layer (10 top-level modules: env, util,
  logger, errors, indicators, state, timezone, feed, demo-math, session-math —
  plus the Pine engine in `src/core/pine/`). Zero `window` / `document` /
  `electronAPI` references (enforced by tests); the only host seam is
  `core/env.js` (ENV + storage). It runs unchanged in Node, any browser and
  the Electron renderer — proven by `tests/unit/test_phase3_core.py`
  (including a plain-Node import + behavior smoke test).
- **`src/platform/electron/loghost.js`** — the Electron host adapter: wires
  the batched IPC file-log transport, the global crash net and the
  beforeunload flush onto the core logger. A future web shell ships its
  own adapter with the same contract.
- **`src/renderer/`** — the DOM app: vendor + css + `js/` (chart, drawing,
  panels, ui) with the single module entry `js/app.js`; `js/core/util.js` is
  a thin facade (pure helpers re-exported from the core + DOM helpers).
- The renderer is a **static ES-module graph** with a single entry point
  (`js/app.js`); there are **no `window.*` module globals** — every
  cross-file reference is a named `import`/`export`. Each module carries a
  JSDoc `@module` header.
- Intentional `window` surfaces: `electronAPI` (preload bridge),
  `LightweightCharts` (vendor UMD), and `window.__app` — the test/debug
  facade exposing the module handles.
- Data flow: `provider/*.py` (WebSocket) → `src/core/feed.js` → `src/core/state.js` → chart panes in
  `src/renderer/js/chart/`. Details: `docs/PHASE2-ESMODULES.md`, `docs/PHASE3-CORE.md`.

## Testing & CI

`npm run verify` (same as `npm test`) is the quality gate and runs four checks:

1. **`check:syntax`** — parses every `.js`/`.mjs` file as an ES module.
2. **`check:imports`** — resolves every relative `import`/`export ... from`/dynamic `import()` to a real file.
3. **`check:py`** — byte-compiles all `provider/*.py` with the first available interpreter (`python`, `python3`, `py -3`).
4. **`smoke`** — starts `provider/demo.py` on `ws://127.0.0.1:8899`, serves `src/` on `http://127.0.0.1:8888`, logs in to the demo server inside a hidden **offscreen Electron** window (`scripts/checks/smoke-electron.cjs`) and asserts: `#app` visible, login hidden, bars loaded, `canvas` present, zero console errors, zero failed requests. The screenshot lands in `docs/_smoke.png` (git-ignored).

Ports can be overridden with `SMOKE_WEB_PORT` / `SMOKE_WS_PORT`; `SMOKE_TIMEOUT_MS` changes the harness timeout.
CI (`.github/workflows/ci.yml`) runs the full gate on Windows and the two static gates on Linux.
The older phase scripts (`python3 tests/unit/test_phase2_modules.py`, `python3 tests/unit/test_phase3_core.py`) still run standalone.

## Troubleshooting

- If the window opens but cannot connect: make sure `pip install websockets` worked and no other app occupies port **8777**.
- Provider crash log: `%TEMP%\mt5_provider_crash.log`.
- Drawing data / favorites / alerts / saved layouts / Pine scripts are stored locally in the app's `localStorage`
  (keys like `mt5_drawings`, `mt5_watchlist`, `mt5_settings`, `mt5_tool_tpl`, `mt5_pine_scripts`, ...) — plain JSON,
  scoped to the app's own origin by CSP, never sent anywhere. "Remove all drawings" (trash icon) clears them per symbol.
- For a blank/failed boot run `npm run verify` first: it separates syntax/import/provider failures from UI failures.

## Security

- **Credentials are never part of localStorage.** MT5 login/password use a separate path (`accounts-save` IPC in `main.js`) and are encrypted at rest via OS `safeStorage` (DPAPI on Windows).
- Strict CSP, sandboxed renderer, and every IPC payload is validated.
- All web permissions are denied (`setPermissionRequestHandler` / `setPermissionCheckHandler`); the app only uses its own IPC for notifications.
- Log contexts are auto-redacted (`password`/`token`/... never reach the log).
- Details: `docs/SECURITY-ROUND81.md` and `docs/archive/rounds/FEATURE-ROUND28.md`.

## Diagnostics & logs

- **Diagnostics panel**: right rail → info icon. Live log view with level/category/text filters, expandable context rows, session stats, one-click **Export** (`.log`/`.json`), and a **Self-test** (✓) that verifies logger, error system, scrubbing, storage, IPC and feed health.
- **File logs**: `<userData>/logs/app-YYYY-MM-DD.log` (JSONL, auto-rotation ~2MB, 7-day pruning). On Windows: `%APPDATA%/mt5-chart-terminal/logs/`. Attach a file (or use Export) when reporting a bug.
- **Unexpected errors** (renderer crashes, uncaught exceptions, unhandled rejections) are captured globally, logged, and surfaced with a rate-limited toast.

## Building a real installer

This ships with an `electron-builder` configuration (see `package.json` → `build`), so instead of handing out this raw source folder you can build an installable package:

```
npm install
npm run dist:win     # -> dist/OJ Chart Terminal Setup <version>.exe  (NSIS installer)
npm run dist:mac     # -> dist/OJ Chart Terminal.dmg
npm run dist:linux   # -> dist/OJ Chart Terminal.AppImage
```

Note: the Windows/macOS builds are **unsigned** by default (no code-signing certificate is included in this repo). Unsigned installers will trigger a Windows SmartScreen / macOS Gatekeeper warning on first run. For real end-user distribution, obtain a code-signing certificate and pass it to electron-builder (`CSC_LINK` / `CSC_KEY_PASSWORD` env vars) before running the commands above.
