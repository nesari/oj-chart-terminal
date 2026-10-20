# ROUND 40 — right-panel resize restored · uniform time-axis & grid spacing · crosshair lines share one style again

Date: 2026-09-08 · Version: 1.8.1 · Scope: STRICTLY the three user reports — nothing else touched.

---

## Report 1 — "The right panel's width used to be adjustable — you disabled it"

No width-resize affordance existed in the shipped code of rounds 30–39 (verified against every
delivered zip), so it was (re-)built to match the expectation:

- `#right-panel` gains a **5px drag splitter** (`#rp-split`) on the panel's left edge —
  col-resize cursor, blue grip line on hover/active, `double-click` resets to the 290px default.
- Width persists in `localStorage` (`mt5_rp_width`, clamped 230–480px) and is re-applied by the
  same `RightPanel.initResize()` that runs at boot; the splitter hides/shows together with the
  panel (RightPanelShow/Close toggle it).
- The charts area relayouts live while dragging (existing ResizeObserver pipeline) — verified
  down to the 720px round-39 floor.

## Report 2 — "Time-axis label spacing is not uniform across zooms/timeframes; the grid lines aren't evenly spaced either — they're probably related" (screenshot: XAUUSD, H1, multi-week view)

They were related — both came from the same tick engine, and both are fixed by one redesign:

**Root cause.** The engine picked a nice TIME cadence (every 2h, snapped to :00 boundaries) and
then quantized ticks that fell inside session breaks/weekends onto the next real bar. Two
boundaries separated by the same calendar step therefore contained DIFFERENT bar counts
(Fri→Thu spans six calendar days but only ~4 trading days), so both the label spacing AND the
vertical grid looked irregular — exactly the user's screenshot (`Fri 07 Aug → Thu 13 Aug` wide,
`Mon 17 Aug → Wed 19 Aug` narrow).

**Fix (TradingView parity).** `Engine._updateTaxExt` now spaces the axis by **BAR COUNT**:
- stride `N` = the smallest nice step (1,2,3,5,10,15,20,30,40,50,75,100,…) with `N × barSpacing ≥ 46px`;
- one tick every Nth bar counted back from the live bar (so the future margin keeps the same
  grid), each labelled with its OWN bar time — `hh:mm` intraday, date text at day rollovers,
  `Sep`/`2026` collapses on D/W/M — the previous labelling rules kept;
- the vertical grid rides the exact same positions (grid ⇒ labels, one source);
- the pixel spacing is now `N × barSpacing` EVERYWHERE — weekends and session holes included
  (a hole is simply skipped in index space; no more snap/quantize/dedup machinery).
- Label behaviour details preserved: day-rollover text takes one wider cell via the overlap
  guard (TV does the same), the live candle's label still wins its slot (round 23), edge labels
  are never clipped.

Measured after the fix (test suite U1–U4): grid gaps `54,54,54…` / `50,51,51…` / `47,47,47…`
across five zoom depths on M1 and on M15/H1 across weekends — spread ≤ 1px everywhere.

## Report 3 — "The Cross-mode dotted lines changed: the vertical is one style, the horizontal another — put it back"

**Root cause.** The Settings→LWC style map was wrong on two entries:
`{solid:0, dotted:3, dashed:2, largedashed:4}` against the real lightweight-charts enum
(`Solid=0, Dotted=1, Dashed=2, LargeDashed=3, SparseDotted=4`). With the default `largedashed`
the NATIVE horizontal line rendered as **SparseDotted (sparse dots)** while the engine-painted
vertical rendered its `[12,7]` long dashes — visibly two different styles. The bug predates
round 39 (present in the round-37 zip too); the user spotted it now.

**Fix.** Both copies of the map (manager.js chart options + settings.js applyPane) corrected to
`{solid:0, dotted:1, dashed:2, largedashed:3}`. Verified per setting: `largedashed → horz
style 3 / vert [12,7]`, `dotted → 1 / [1.5,3]`, `dashed → 2 / [7,5]` — one style on both lines,
and the round-39 Arrow→Cross tool cycle no longer disturbs the horizontal style.

---

## Verification

New suite `tests/unit/test_round40_axis_resize_cross.py` — **14/14 PASS**:
- P1–P5: splitter drag widens + persists, restore path re-applies the saved width, splitter
  hides with the panel and returns on reopen, double-click resets to 290, chart relayouts live.
- U1–U4: grid **and** label spacing uniform (spread ≤ 1px) at five zoom depths on M1 (deep
  history incl. weekends), on M15, and on H1 across weekends — the user's exact scenario.
- X1–X4: crosshair style parity for largedashed/dotted/dashed + stability across the
  Arrow→Cross cycle.
- Z1: zero page errors.

Full regression — **all 16 suites green**: round39 33/33 · round38 28/28 · round37 30/30 ·
round36 20/20 · round35-ui 34/34 · round35-mt5 7/7 · round33 18/18 · round32 25/25 ·
round31 20/20 · phase3 31/31 · phase2 5/5 · round25 30/30 · round26 12/12 · round27 11/11 ·
round28 10/10 · round29 10/10.

Visual gallery: `download/round40-screenshots/` — the H1 multi-week axis (uniform even across
weekends), M1 deep zoom, matching crosshair styles, panel resized wider.

## Files

- **Modified**: `src/renderer/js/drawing/engine.js` (index-stride axis ticks),
  `src/renderer/js/chart/manager.js` + `src/renderer/js/chart/settings.js` (one line each —
  LWC style enum map), `src/renderer/js/ui/rightpanel.js` (resize + splitter visibility),
  `src/renderer/index.html` (splitter element), `src/renderer/css/app.css` (splitter styles),
  `src/renderer/js/app.js` (initResize call), `CHANGELOG.md`, `package.json` → 1.8.1
- **Added**: `docs/archive/rounds/BUGFIX-ROUND40.md`, `tests/unit/test_round40_axis_resize_cross.py`
