# BUGFIX ROUND 37 — Symbol-Search category tabs (TradingView parity) + vertical line through indicator panes

Date: 2026-09-07 · Version: 1.7.8 · Scope: STRICTLY the two user reports — nothing else touched.

---

## Report 1 — "The symbol search used to be split into TABS, exactly like TradingView — you deleted it, bring it back"

**User meaning.** The Symbol Search dialog must show the TradingView-style category pill row
(All / Stocks / Futures / Forex / Crypto / … in TV; here: **All / Forex / Metals / Energies /
Indices / Crypto / Stocks**) between the search input and the results list. Round 36 rebuilt the
dialog with grouped results + the exact footer count, but had no tabs; the user wanted the tab
strip back.

**Implementation (src/renderer/js/chart/toolbar.js).**
- New `SYM_TABS` definition — `[label, category]` pairs; the `Stocks` pill maps to the
  classifier category `Stocks & Others`; `All` keeps the round-36 grouped view.
- The dialog markup gains `<div id="sym-tabs">` between the input and `#sym-results`.
- The last provider answer is cached locally (`last = {symbols, total}`); clicking a pill only
  flips `activeCat` and re-renders from the cache — **no refetch** on tab switches.
- Render rules:
  - `All` → previous behavior: non-empty category groups (Forex / Metals / Energies / Indices /
    Crypto / Stocks & Others), 40-row per-group cap with `+N more…`, footer = provider `total`.
  - a category pill → that category only, rendered FLAT (no redundant group header), **no row
    cap** (the results box scrolls; wire cap 400 still applies), footer = exact count inside the
    category.
  - a typed query keeps respecting the active pill (TV behavior), still case-insensitive
    (rounds 35/36 untouched); `No matching symbol` + `0 symbols` on garbage.
  - Enter applies the first VISIBLE row of the active tab.

**Styling (src/renderer/css/app.css).** `#sym-tabs` = flex-wrap pill row (gap 6px);
`.sym-tab` = 12px/600 pill on `var(--panel2)`; active pill = `background: var(--white);
color: var(--bg)`. Those two tokens flip per theme, so the active pill reads **white-on-dark in
the dark theme and dark-on-light in the light theme — exactly like the TV dialog** (verified by
computed-style assertions in both themes).

## Report 2 — "A vertical line must also come down through the indicator window, fully to the bottom, exactly like the mouse cross"

**Root cause.** `TOOLS.vline.draw` already drew 0 → `v.ph` (the full overlay stack), but the
engine's round-32 render pass clips EVERY drawing to the price pane only
(`rect(0, 0, v.pw, v.mainH)`) so price-anchored drawings can never bleed into indicator
sub-panes. The mouse cross works because it is painted separately with a full-height clip.

**Fix (src/renderer/js/drawing/engine.js).** `clipPlot(fullStack)` — the drawings loop passes
`d.type === 'vline'` and the creation-preview path passes `this.temp.type === 'vline'`; those
clip to `(0, 0, v.pw, v.ph)` instead, so the vertical line spans the price pane, crosses the
pane separators and runs to the very bottom of every indicator sub-pane (stopping at the time
axis, like the crosshair). The selection handle (mid-stack) becomes visible too. With NO
sub-panes the clip is pixel-identical to before (`mainH === ph`), and all other drawing types
keep the price-pane clip — untouched behavior.

---

## Tests

New suite `scripts/test_round37_tabs_vline.py` — **30/30 PASS**:
- A: 7 pills in TV order, only `All` active on open, grouped view intact (6 heads), exact
  `33 symbols` footer, no `+N more` on the demo catalog, dark pill colors
  (active `rgb(255,255,255)`, inactive `rgb(42,46,57)`).
- B: Forex tab → 12 fiat rows flat + `12 symbols`; lowercase `eur` inside the tab →
  `[EURUSD, EURGBP, EURJPY]` + `3 symbols`; Metals/Crypto/Energies/Indices/Stocks counts
  (2/2/3/7/7); back to All restores groups + total; garbage query → placeholder + `0 symbols`;
  Enter applies the first row of the active tab (XAUUSD).
- C: light theme pill colors (active `rgb(19,23,34)`, inactive `rgb(224,227,235)`).
- D (pixel probes on the overlay canvas): clean-column baseline empty below `mainH`; after
  `drawings.add(vline)` the line is present in the price pane AND through the whole RSI
  sub-pane region, down to its bottom edge; after removal both regions are empty again
  (control). RSI sub-pane geometry via `pane._subRects`.
- Z: zero page errors across the whole run.

Visual gallery: `scripts/shots37/` (01 dialog tabs dark, 02 Forex tab, 03 dialog tabs light,
04 vline through RSI) — copied to `download/round37-screenshots/`.

## Full regression (all green)

round36 20/20 · round35-ui 34/34 · round35-mt5-search 7/7 · round31 20/20 · round32 25/25 ·
round33 18/18 · phase3 31/31 · phase2 5/5 · round25 30/30 (one live-tick BTCUSD flake on the
first run — price moved between sampling the watchlist cell and the expectation; clean re-run
green) · round26 12/12 · round27 11/11 · round29 10/10.

## Files

- Modified: `src/renderer/js/chart/toolbar.js`, `src/renderer/js/drawing/engine.js`,
  `src/renderer/css/app.css`, `CHANGELOG.md`, `package.json`
- Added: `docs/archive/rounds/BUGFIX-ROUND37.md`, `scripts/test_round37_tabs_vline.py`
