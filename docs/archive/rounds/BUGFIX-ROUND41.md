# ROUND 41 — vertical grid moved UNDER the candles · TV-style day-start labels on the time axis (no more blank day cells)

Date: 2026-09-08 · Version: 1.8.2 · Scope: STRICTLY the two user reports (with three TradingView
reference screenshots: H1 / 15M / 5M) — nothing else touched.

---

## Report 1 — "The grid lines must not come over the candles — they belong UNDER them"

**Root cause.** The vertical grid is engine-painted (BUG-002 design: the native vertical grid is
off because LWC's index-based ticks don't match the uniform axis cadence). It was painted on the
drawing OVERLAY canvas (`.pane-overlay`, z-index 10) — the same canvas that carries the period
separators, the drawings and the crosshair. That canvas sits ABOVE the chart canvas
(`.sub-pane > .tv-lightweight-charts`, z-index 1), so every vertical grid line ran across the
candle bodies and wicks. The native HORIZONTAL grid was always behind the series (LWC paints it
under the series internally) — only the verticals were wrong.

**Fix (3 files, grid painter only).**

- `manager.js` (`createPane`): a new dedicated underlay canvas `pane.gridCv`
  (`.pane-grid-underlay`) is created inside the chart host, right after the watermark layer —
  **z-index 0**: above the watermark (later in the DOM, same z), BELOW the chart canvas (z 1).
- `app.css`: `.pane-grid-underlay { position:absolute; inset:0; z-index:0; pointer-events:none; }`
  — same geometry as the overlay, never intercepts the mouse.
- `engine.js` (`render`): the underlay is DPR-sized and CLEARED every frame at the top of the
  render pass (before any early return, so a data switch or a vGrid toggle never leaves stale
  lines), and the vertical-grid painter now draws `this._taxGrid` on the underlay context instead
  of the overlay context. Same cadence, same color, same `vGrid` toggle, same full-stack extent
  (0 → `v.ph`, so indicator sub-panes keep their grid too — their LWC canvases are transparent,
  the grid shows through from behind). The overlay canvas keeps everything it owned before:
  period separators, drawings, news/alert marks, the crosshair.

Layer order now: host background → watermark (z 0) → **vertical grid (z 0, after wm in DOM)** →
chart canvas with candles (z 1) → overlay with separators/drawings/crosshair (z 10) → axis DOM.

**Verified.** Underlay painted (`getImageData` count > 0) while the overlay is pixel-CLEAN at
every mid-day grid column; computed z-order `0 < 1` with the canvas before the chart element in
DOM; a composited screenshot probe sampled a candle body exactly on a grid-line x and returned
the candle green `#089981`, not the grid color — the candle really paints OVER the line.

## Report 2 — "The time axis leaves the day start/end BLANK because the full date doesn't fit" (3 TradingView screenshots)

**Root cause.** At every day-rollover tick the engine wrote the FULL date ("Wed 02 Sep") — about
70–78 px wide — into a cadence cell that is only ~46–55 px wide at normal zoom. The overlap guard
therefore DROPPED the label entirely and the axis was left with a blank gap at every day start
(the user's report). TradingView never leaves the cell empty: zoomed IN it writes the full date;
zoomed OUT it degrades to the day NUMBER, the month name at a month rollover and the year at a
year rollover.

**Fix (`engine.js`, `_updateTaxExt` only).**

- `labelFor(t, prevT)` now returns `{ full, short }`:
  - intraday day rollover: `full` = the same date label as before (`TZ.tickLabel(..., 2, dowOn)`,
    dow per the "Day of week on labels" setting); `short` = plain day number without the leading
    zero (`"2"`, `"26"`), or the month name (`"Sep"`) when the month rolls over, or the year when
    the year rolls over — exactly the ladder visible in the user's TV screenshots
    (`26 | 12:30 | 27 | … | Sep | 12:30 | 2`).
  - D/W/M: unchanged full forms; regular day ticks degrade to the day number.
- The placement loop tries `full` first (zoomed in → the whole date fits and wins, TV parity);
  when the cell is too narrow or the label would collide with its neighbour, it places `short`
  instead. The cell is never blank any more, and the vertical grid line at that tick is
  unaffected (grid positions are recorded before the label filters, as before).

**Cross mode (already correct, re-verified — no change).** The `.tax-live` pill keeps showing the
FULL date + time while the mouse moves (`TZ.crossLabel`, round 34): e.g. `Mon 07 Sep '26  05:00`,
continuously tracking the raw cursor including the future margin — the third part of the user's
report. Screenshot-verified; untouched.

**Verified.** Zoomed-out H1 axis reads
`17:00 | 28 | 23:00 | 29 | Sun 30 08 | Mon 31 08 | Sep | 17:00 | 2 | 23:00 | 3 | …` — day
numbers + month name fill the previously blank cells, full dates appear wherever the stride is
wide enough. Zoomed to ~30 bars around a day boundary the axis writes the full date at the day
start (`Tue 08 09` in broker tz — the month prints numerically in broker time, `Sep` in named
zones; that formatter is pre-existing app-wide behaviour and was deliberately NOT touched).

---

## Test round41

`tests/e2e/verify_round41.py` (10/10): z-order/pointer-events of the underlay, underlay painted +
overlay clean at mid-day grid columns, composited candle-over-grid pixel probe, day-number +
month-name labels zoomed out, full date zoomed in, cross pill full date+time, zero page errors.

## Regression

Full existing suites against the changed build — all green:
ROUND40 14/14 · ROUND31 20/20 · ROUND32 25/25 · ROUND33 18/18 · ROUND35 34/34 · ROUND37 30/30 ·
ROUND25 30/30 · ROUND26 12/12 · PHASE3 31/31.
ROUND39 reports 30/33 on this build — the three news-mark pixel probes (N4/N5/N6) fail
IDENTICALLY on the pristine ROUND40 baseline (the demo news calendar generates no high-impact
event inside the loaded window on today's date, so the red-pixel probe falls back to a
low-impact event). Pre-existing, data-dependent, unrelated to this round.
