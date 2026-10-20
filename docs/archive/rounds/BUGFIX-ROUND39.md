# ROUND 39 — Economic News panel + chart marks · Alerts: right-click price & time alerts with two-sided management · Arrow-cursor TV parity · Narrow windows

Date: 2026-09-08 · Version: 1.8.0 · Scope: the four user items — nothing else touched.

---

## Item 1 — Economic News (right rail + chart marks)

**New right-rail tab `news` ("Economic News", English as requested).**

- **Data (provider/provider_common.py).** A deterministic economic-calendar
  generator shared by the demo AND mt5 providers (no external network — the
  app CSP only allows the local provider anyway). Real release rhythm: NFP on
  the first Friday, CPI mid-month, weekly claims/inventories, ~6-weekly
  central-bank rate cycles (FOMC/ECB/BOE/BOJ/BOC/RBA/RBNZ/SNB), speeches and
  flash PMIs as low impact. Events carry `{time, currency, impact
  high|med|low, name, forecast, previous, actual?}` (actual only for released
  events; speeches carry no numbers). Times are shifted by the provider's
  server offset so marks line up with the chart's bar stamps exactly like
  ticks/history. New ws request `news` always answers (round-36 rule).
- **Panel (src/renderer/js/panels/news.js — new).** Master **"Show on chart"**
  switch; **Impact** section (High/Medium/Low) and **Currency** section
  (USD/EUR/GBP/JPY/CAD/AUD/NZD/CHF/CNY) with one tickable chip per category —
  untick anything and it disappears from the chart and the list; right-click a
  section = tick-all/clear-all; footer counter `N/M shown`; refresh button;
  5-minute auto-refresh; everything persists in `localStorage` (`mt5_news_cfg`).
  The list is day-grouped (Today · Tue 08 Sep …) with time, currency chip,
  ForexFactory-style impact bars, name and A/F values; clicking a row centres
  every pane on that moment.
- **Chart marks.** `Engine.render()` gained a generic
  `App.overlayMarkPainters` pass — painters draw under the FULL-STACK clip
  (span the price pane and every indicator sub-pane, like the cross/vline) and
  repaint every animation frame, so pan/zoom/ticks never leave stale marks.
  News events draw a colour-coded dashed vertical (high=red, med=amber,
  low=gray) + a `USD 13:30`-style flag chip that lane-stacks when crowded.

## Item 2 — Alerts: audit + right-click price & TIME alerts on the chart

- **Audit result.** Existing machinery verified intact: toolbar-bell dialog,
  5 price conditions, per-alert chart lines (Settings ▸ Alert lines), fired
  re-arm, drawing/zone alerts, panel toggle/delete — all covered by the new
  suite (A1, A8, A11).
- **Right-click the chart** → the context menu now offers
  **"Add alert at 1.10581…"** (price under the cursor Y) and
  **"Add time alert at 13:33…"** (bar under the cursor X), above the
  existing items. Right-clicking exactly ON an existing alert mark
  (±6/±7 px) shows **"Manage alert…"** instead.
- **Time-based alerts (new kind).** `{kind:'time', time}` in the same store;
  fire when the symbol's tick clock (server time, works in bar replay too)
  reaches the target: toast + OS notification + beep, auto-disarm, re-armable.
  A NEW time alert cannot be placed in the past (TV behaviour — it would fire
  instantly); editing an existing one to a past moment is allowed and fires
  immediately (honest semantics).
- **Chart rendering.** Price alerts keep their horizontal lines
  (`applyPriceLines` now skips time alerts); time alerts paint a full-height
  amber dashed mark + `ALERT HH:MM` chip through the same painter pass as the
  news marks (lane bookkeeping is shared so chips never collide).
- **Management from both sides.** The manage dialog (`Alerts.openManageDialog`)
  edits condition/price or datetime, Active on/off, Delete — opened from the
  chart context menu or the new pencil button on every Alerts-panel row; the
  panel rows also gained time formatting for the new kind.

## Item 3 — Arrow cursor, TradingView parity

The check found THREE real deviations, all fixed:

1. After switching to Arrow the **painted crosshair lingered** until the next
   mouse move — `activateTool` now resets the cross state on every pane
   immediately.
2. Since round 31 the cross state is the RAW cursor tracker and was set on
   every move regardless of tool, so the **vertical crosshair line kept
   painting with Arrow** — the raw-tracker now stays off for bare cursor
   tools, and the render pass gates the line the same way.
3. The **native horizontal crosshair line** (LWC) kept following the mouse —
   `activateTool` now toggles `crosshair.horzLine.visible` per pane (hidden for
   Arrow/Dot, restored otherwise, still respecting the Settings crosshair
   switch). `TOOLS.cross` gained an explicit `crosshair: true` flag — it is the
   only cursor tool that keeps the lines (TV). Arrow still pans, selects
   drawings, and shows pointer/move cursors over objects (C4).

## Item 4 — Narrow windows

- **Electron `minWidth` 1180 → 720** (main.js). minHeight unchanged (680).
- Top bar: the round-22 TV chevrons already scroll `#tb-left` when it
  overflows — now reachable at 720px (verified: chevrons appear, scroll,
  hide at the far end).
- Left toolbar: the overflow chevron invariant (nothing ever clipped) holds
  at the smaller size.
- Right rail: `overflow-y: auto` (scrollbar hidden) so all 7 icons stay
  reachable on short windows.

## Verification

New suite `scripts/test_round39_news_alerts.py` — **33/33 PASS** (N1-N7 news
panel/filters/marks/persistence with colour-pixel probes — the marks can sit
exactly on a bar-grid column, so counts alone lie; A1-A12 alerts end-to-end
incl. past-time rejection and firing; C1-C4 arrow parity with a cross-colour
pixel probe (504 px with Cross → 0 px with Arrow); W1-W6 narrow window;
X1 round-38 flyout canary; X2 zero page errors).

Full regression — **all green**: round38 28/28 · round37 30/30 · round36 20/20 ·
round35-ui 34/34 · round35-mt5 7/7 · round33 18/18 · round32 25/25 ·
round31 20/20 · phase3 31/31 · phase2 5/5 · round25 30/30 · round26 12/12 ·
round27 11/11 · round28 10/10 · round29 10/10.

Visual gallery (dark + light): `download/round39-screenshots/` — news panel +
chart marks, alerts panel + armed price line + amber time mark, context menu
with the alert items, arrow cursor, 720px window.

## Files

- **Added**: `src/renderer/js/panels/news.js`, `docs/archive/rounds/BUGFIX-ROUND39.md`,
  `scripts/test_round39_news_alerts.py`, screenshot gallery
- **Modified**: `provider/provider_common.py` (calendar + `news` handler),
  `src/core/feed.js` (`news()`), `src/renderer/index.html` (rail tab + panel),
  `src/renderer/js/ui/icons.js` (news icon), `src/renderer/js/app.js` (wire-up
  + facade), `src/renderer/js/drawing/engine.js` (painter pass + context-menu
  info + bare-cursor gating), `src/renderer/js/panels/alerts.js` (time alerts,
  manage dialog, painter), `src/renderer/js/drawing/ui.js` (menu items +
  activateTool cursor/crosshair/horzLine parity), `src/renderer/js/chart/
  toolbar.js` (alert dialog price preset), `src/renderer/js/chart/manager.js`
  (price lines skip time alerts), `src/renderer/css/app.css` (rail scroll),
  `src/renderer/css/panels.css` (news + alert styles), `main.js` (minWidth),
  `CHANGELOG.md`, `package.json` → 1.8.0
