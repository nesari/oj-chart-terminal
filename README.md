# MT5 Chart Terminal

TradingView-style charting desktop app (Electron) powered by MetaTrader 5 data — or a built-in simulated demo feed.

## Requirements

- Windows 10/11 (primary target — real MT5 trading requires the Windows-only MetaTrader5 Python package)
- macOS / Linux is supported for **demo mode** via `run.sh` (see below); real MT5 data still needs Windows because the `MetaTrader5` pip package is Windows-only.
- Node.js LTS (https://nodejs.org)
- Python 3.8+  (`python`/`python3` must be available in PATH)
- For real MT5 data: MetaTrader 5 terminal installed + `pip install MetaTrader5 websockets`
- For demo mode only: `pip install websockets`

## Run (development / from source)

1. Extract this folder anywhere (e.g. `C:\Users\Farzad\Desktop\mt5-chart-app`).
2. **Windows:** double-click **run-demo.bat** (simulated data, any account) or **run-mt5.bat** (real MT5).
   **macOS/Linux:** run `./run.sh` (demo mode) or `./run.sh mt5` (real MT5 — Windows only in practice, see above).
   - First run downloads Electron automatically (uses npmmirror mirror; needs internet) and verifies the download against the official Electron checksum before launching (`scripts/verify-electron.js`).
3. On the login screen:
   - **Demo Server** — instant simulated market, no credentials.
   - **MetaTrader 5** — enter Login (account number), Password, Server name (e.g. `MetaQuotes-Demo`), optional terminal path if you have several installations.

## Features

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
- **Save Layout** (TradingView logic): the toolbar icon next to the layout picker opens the TV-style menu — Save layout (`Ctrl+S`), Autosave toggle, Make a copy…, Rename…, Download chart data… (CSV of the active chart), Create new layout…, RECENTLY USED and Open layout…. Saving keeps the complete personal setup (layout + splitters, every chart's symbol/interval/style, chart settings, sync toggles, timezone, favorites, watchlist and all drawings) under a name; saved layouts are listed for one-click load or delete. The app also reopens your last charts on relaunch (turn Autosave off to keep only explicitly saved layouts).
- Free chart panning: with Auto Scale off, dragging the chart moves it freely both horizontally and vertically (TradingView behaviour); wheel over the price scale or dragging the price scale zooms it vertically (double-click the scale to reset). In multi-chart layouts every chart has a maximize/restore button (top-right of the chart, Esc also restores). The tool settings dialog is a floating window — drag it by its title bar anywhere over the chart.
- Timeframe keyboard switcher: type digits (e.g. `15`) then `Enter`; seconds intervals use lowercase `s` (1s, 5s, 15s, 30s).
- Watchlist (add/remove/click to load symbol), Price Alerts (5 conditions, notifications + sound), Data Window, Bar Replay, and the provider's economic **News calendar** (impact/currency filters, locate-on-chart).
- **Trading** (live MT5 or the built-in demo engine): unified order ticket with SL/TP and risk modes, one-click trading, positions/pending orders dock (partial close, SL/TP modify, cancel), strategy tester and replay trading — see `src/renderer/js/trade/`, `src/renderer/js/panels/tester.js` and `src/renderer/js/panels/replay.js`.
- Timezone picker at the bottom-right of the chart — the full TradingView timezone list; applies to the time axis, crosshair and Data Window.

## Building a real installer

This ships with an `electron-builder` configuration (see `package.json` → `build`), so instead of handing out this raw source folder you can build a signed, installable package:

```
npm install
npm run dist:win     # -> dist/OJ Chart Terminal Setup <version>.exe  (NSIS installer)
npm run dist:mac     # -> dist/OJ Chart Terminal.dmg
npm run dist:linux   # -> dist/OJ Chart Terminal.AppImage
```

Note: the Windows/macOS builds are **unsigned** by default (no code-signing certificate is included in this repo). Unsigned installers will trigger a Windows SmartScreen / macOS Gatekeeper warning on first run. For real end-user distribution, obtain a code-signing certificate and pass it to electron-builder (`CSC_LINK` / `CSC_KEY_PASSWORD` env vars) before running the commands above.

## Troubleshooting

- If the window opens but cannot connect: make sure `pip install websockets` worked and no other app occupies port **8777**.
- Provider crash log: `%TEMP%\mt5_provider_crash.log`.
- Drawing data / favorites / alerts / saved layouts / Pine scripts are stored locally in the app's `localStorage`
  (keys like `mt5_drawings`, `mt5_watchlist`, `mt5_settings`, `mt5_tool_tpl`, `mt5_pine_scripts`, ...) — plain JSON,
  scoped to the app's own origin by CSP, never sent anywhere. "Remove all drawings" (trash icon) clears them per symbol.
  **Account credentials are never part of this** — MT5 login/password are handled by a separate path (`accounts-save`
  IPC channel in `main.js`) and encrypted at rest via `safeStorage`/DPAPI before touching disk; see the Security section below.

## Notes

- Built-in indicators + a fully local **Pine Script v6 engine and editor** (round 74): write/edit `.pine` scripts in the bottom Pine Editor panel, "Add to chart", TV-style sub-panes, script-owned boxes/lines/labels — see `docs/PINE-ENGINE-PLAN.md`. Chat remains excluded.
- Trading is included: the same UI drives a real MT5 account or the built-in demo engine (see the **Trading** bullet above).

## Diagnostics, Logs & Security (round 28)

- **Diagnostics panel**: right rail → info icon. Live log view with level/category/text filters, expandable context rows, session stats, one-click **Export** (`.log`/`.json`), and a **Self-test** (✓) that verifies logger, error system, scrubbing, storage, IPC and feed health.
- **File logs**: `<userData>/logs/app-YYYY-MM-DD.log` (JSONL, auto-rotation ~2MB, 7-day pruning). On Windows: `%APPDATA%/mt5-chart-terminal/logs/`. Attach a file (or use Export) when reporting a bug.
- **Unexpected errors** are captured globally, logged, and surfaced with a rate-limited toast — no more silent failures.
- **Security**: strict CSP, sandboxed renderer, every IPC payload validated, saved passwords encrypted via OS safeStorage (DPAPI), log contexts auto-redacted (`password/token/...` never reach the log).
- Details: `docs/FEATURE-ROUND28.md` + `CHANGELOG.md`.

## Architecture (v1.9.212 — Phase 3, platform-agnostic core)

- **`src/core/`** — the platform-agnostic layer (10 top-level modules: env, util,
  logger, errors, indicators, state, timezone, feed, demo-math, session-math —
  plus the Pine engine in `src/core/pine/`). Zero `window` / `document` /
  `electronAPI` references (enforced by tests); the only host seam is
  `core/env.js` (ENV + storage). It runs unchanged in Node, any browser and
  the Electron renderer — proven by `scripts/test_phase3_core.py`
  (including a plain-Node import + behavior smoke test).
- **`src/platform/electron/loghost.js`** — the Electron host adapter: wires
  the batched IPC file-log transport, the global crash net and the
  beforeunload flush onto the core logger. A phase-4 web shell will ship its
  own adapter with the same contract.
- **`src/renderer/`** — the DOM app: vendor + css + `js/` (chart, drawing,
  panels, ui) with the single module entry `js/app.js`; `js/core/util.js` is
  now a thin facade (pure helpers re-exported from the core + DOM helpers).

- The renderer is a **static ES-module graph** with a single entry point
  (`js/app.js`); there are **no `window.*` module globals** anymore — every
  cross-file reference is a named `import`/`export`. Each module carries a
  JSDoc `@module` header.
- Intentional `window` surfaces: `electronAPI` (preload bridge),
  `LightweightCharts` (vendor UMD), and `window.__app` — the test/debug
  facade exposing the module handles.
- Phase 2 (ES-module graph, no `window.*` globals) remains the base layer;
  details in `docs/PHASE2-ESMODULES.md`, phase 3 in `docs/PHASE3-CORE.md`.
- Dev checks: `python3 scripts/test_phase2_modules.py`,
  `python3 scripts/test_phase3_core.py`.
