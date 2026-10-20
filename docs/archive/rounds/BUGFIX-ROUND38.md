# BUGFIX ROUND 38 — Left toolbar: Gann & Risk/Reward groups were EMPTY (tools missing app-wide)

Date: 2026-09-08 · Version: 1.7.9 · Scope: STRICTLY the user report — nothing else touched.

---

## Report — "Some items on the left toolbar have no icon and their tools don't open at all — like the Gann section and the Risk/Reward section"

**User meaning.** In the left drawing toolbar, the **Gann** button opened a flyout with only the
section headers (GANN / ELLIOTT / PATTERN) and **zero tool rows**, and the **Risk/Reward** button
(Long/Short Position group) opened **nothing at all**. No icons/rows, empty tooltips, and the
tools were unusable everywhere.

## Root cause — a missing module import, not missing tools

`src/renderer/js/drawing/tools2.js` ("batch 2", 34 tools: Gann Box/Square/Fixed/Fan, Elliott ×5,
harmonic Patterns ×6, Long/Short Position (R:R), Regression Trend, Volume Profile, Fib Channel/
Circles, Andrews/Schiff/Modified-Schiff/Inside Pitchfork, Info Line, Callout, Arrow Marks ×4,
Flag Mark, Brush/Highlighter) registers everything as **module-evaluation side effects** onto the
shared registries:

- `TOOLS[id] = …` — the drawing-tool registry imported from `drawing/tools.js`
- `App.registerFactoryOpts(type, opts)` — factory default options (state.js hook)
- freehand helpers (`brush`, `highlighter`) likewise

After the phase-2 ES-module migration, `app.js` is the single module entry and the docs say
"every renderer module is reached through static imports" — but the static import of
`drawing/tools2.js` **was never re-added**. No other module imports it either (verified by grep:
zero importers) and there are no dynamic `import()` calls in the codebase. The HTTP fetch log of
a live session proved it: the browser requested `tools.js` but **never requested `tools2.js`**.

Consequences at runtime (reproduced before the fix):

| Surface | Symptom |
|---|---|
| `gannelliott` flyout | sections GANN/ELLIOTT/PATTERN render, **0 rows** (`if (!def) continue` skipped every tool) |
| `forecast` flyout (Risk/Reward) | **0 rows, 0 sections** — completely empty |
| `fibs` flyout | only 2/8 (Fib Channel, Fib Circles, Pitchfork ×4 missing) |
| `shapes` flyout | only 5/13 (Brush, Highlighter, Callout, Arrow Marks ×4, Flag Mark missing) |
| `lines` flyout | Info Line missing (9/10) |
| tooltips | `b.title = TOOLS[tid] ? name : ''` → **empty tooltip** on Gann / Risk-Reward buttons |
| icons | any code path doing `TOOLS[tid] || {icon:'x'}` / `icon(tid)` fell back to the X glyph |
| drawing / settings | the tools could not be created; settings schemas/defaults never registered |

## Fix — one line

`src/renderer/js/app.js`:

```js
import './drawing/tools2.js';
```

(side-effect import, placed with the other drawing imports). This restores all 34 tools, their
factory defaults, and every downstream surface in one shot. **No other file was touched** —
`tools2.js` itself, the toolbar, the engine, icons, CSS: all unchanged.

## Verification

New suite `tests/unit/test_round38_toolbar_tools.py` — **28/28 PASS**:

- **A. buttons**: all 8 group buttons have an SVG icon, **no X-fallback glyph anywhere**, and the
  previously empty tooltips now read `Gann Box` / `Long Position` (asserted live).
- **B. flyouts — exact row counts**: `gannelliott` = 15 rows under sections
  `[Gann, Elliott, Pattern]` (Gann Box / Gann Square / Gann Square Fixed / Gann Fan; Elliott ×5;
  XABCD/ABCD/Cypher/Triangle/Three Drives/Head-and-Shoulders); `forecast` = exactly
  `[Long Position, Short Position, Regression Trend, Volume Profile]`; `fibs` = 8 (incl. Fib
  Channel, Fib Circles, Pitchfork ×4); `shapes` = 13 (incl. Brush, Highlighter, Callout, Arrow
  Marks ×4, Flag Mark); `lines` = 10 (incl. Info Line); `cursor` = 3; `measure`/`zoom` still
  activate directly (single-tool groups, no flyout — unchanged semantics).
- **C. Gann Box end-to-end**: armed via the flyout (`App.tool === 'gannbox'`), drawn with two
  clicks → drawing persisted with 2 points; **factory defaults applied** (`diagColor #2962ff`,
  `diag2Color #f23645` — proves `registerFactoryOpts` ran); overlay pixel probe shows the grid +
  diagonals rendered (11 453 ink pixels in the drawn rect); the draw-settings dialog opens
  without error.
- **D. Risk/Reward end-to-end**: armed via the flyout (`App.tool === 'positionl'`), drawn →
  drawing persisted with 2 points; the TV `afterFinish` R:R logic computed a numeric
  `opts.target` (1:1 default); overlay pixel probe shows the win/loss boxes + entry/stop/target
  lines (46 278 ink pixels); the draw-settings dialog opens without error; cleanup leaves zero
  drawings.
- **F.** zero page errors during the whole run.

Full regression battery — **all green**:
round37 30/30 · round36 20/20 · round35-ui 34/34 · round35-mt5-search 7/7 · round31 20/20 ·
round32 25/25 · round33 18/18 · phase3 31/31 · phase2 5/5 · round25 30/30 · round26 12/12 ·
round27 11/11 · round28 10/10 · round29 10/10.

Visual gallery (dark **and** light): `download/round38-screenshots/` — Gann flyout, Risk/Reward
flyout, fibs flyout, drawn Gann Box, drawn Long Position.

## Files

- **Modified**: `src/renderer/js/app.js` (one side-effect import + comment)
- **Added**: `docs/archive/rounds/BUGFIX-ROUND38.md`, `tests/unit/test_round38_toolbar_tools.py`, screenshot gallery
- **Version**: `package.json` → 1.7.9, `CHANGELOG.md` entry (Persian)
