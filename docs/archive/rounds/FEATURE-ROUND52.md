# FEATURE — ROUND 52 (v1.9.3): TradingView trend-line flyout parity

## User request
Two comparison screenshots (TradingView vs our app) of the trend-line tools flyout.
The tools present in TradingView's flyout but missing from ours must be researched
(what they do, how they are drawn, what their settings contain) and then added to
our flyout **in the exact same order** — nothing else touched, nothing removed.

## Research result (TradingView behaviour)
TradingView's flyout has three labelled sections:

| Section | Tools (TV order) | Was in our app? |
|---|---|---|
| LINES | Trendline, Ray, Info line, Extended line, **Trend angle**, Horizontal line, Horizontal ray, Vertical line, Crossline | all except Trend Angle |
| CHANNELS | Parallel channel, Regression trend, **Flat top/bottom**, **Disjoint channel** | all except Flat Top/Bottom + Disjoint Channel |
| PITCHFORKS | Pitchfork, Schiff pitchfork, Modified Schiff pitchfork, Inside pitchfork | existed only in the Gann & Fibonacci flyout |

- **Trend Angle** — click 1 sets the anchor, moving the mouse aims the line, click 2
  finishes. TV shows the angle in degrees next to the far point (screen-space, so the
  value is zoom-dependent). Settings: Line (color/width/style), Extend left, Extend right.
- **Regression Trend** — drag across a range; a least-squares median line is drawn with
  deviation bands. Settings: median line, Background fill, Extend.
- **Flat Top/Bottom** — the first two clicks draw the sloped border, the third click sets
  the price of the flat (horizontal) border; the third handle edits the price only.
  Channel is filled by default. Settings: Line, Background, Extend left/right.
- **Disjoint Channel** — first line from two clicks; the third click carries a second
  line that stays parallel to the first but is shifted BOTH perpendicular and along the
  line direction. Line 2 has its own color/width/style. The background fills only where
  the two lines overlap in time. Settings: Line 1, Line 2, Background, Extend left/right.
- **Pitchforks** — already implemented (tool ids `pitchfork`, `pitchfork_s`,
  `pitchfork_ms`, `pitchfork_i`); they only needed to appear in this flyout too, with the
  TV menu name ("Pitchfork" instead of "Andrews' Pitchfork").

## Implementation (5 src files)
1. `src/renderer/js/drawing/tools.js` — `TOOLS.trendangle` (pts 2, degrees chip,
   extend via `segWithExtend`), `TOOLS.flattop` (pts 3, third handle price-only,
   TV-default fill), `TOOLS.disjoint` (pts 3, `_geo`/`disjGeo` computes direction shift
   + perpendicular offset, Line-2 stroke uses `color2/width2/style2` with fallbacks,
   overlap-only fill).
2. `src/renderer/js/ui/icons.js` — new stroke icons `trendangle`, `flattop`, `disjoint`.
3. `src/renderer/js/drawing/ui.js` — the `lines` group is now three TV-ordered
   sections (LINES / CHANNELS / PITCHFORKS); our Arrow stays at the end of LINES
   (nothing removed); the pitchforks remain in the fibs flyout as well. `activateTool`
   takes an optional source group so only the picked group's toolbar button follows.
4. `src/renderer/js/drawing/settings.js` — Style-tab schemas `trendangle`
   (line + extend L/R + angle label), `flattop` (line + background + extend L/R),
   `disjoint` (Line 1 / Line 2 / background / extend L/R), `regression`
   (line + background + extend).
5. `src/renderer/js/drawing/tools2.js` — Regression Trend background fill between the
   outer deviation bands (default OFF — existing drawings unchanged); fill helpers
   (`fillAlphaOf`/`fillColorOf`); FACTORY defaults for the three new tools (TV look:
   filled channels at 0.12 alpha); pitchfork renamed to TV's menu name.

## Explicitly untouched
Every other tool, the engine, alerts, notifications, separators, themes, favorites,
object tree, shortcuts, and all previous round behaviour.

## Verification
`tests/e2e/verify_round52.py` — flyout structure (3 sections, exact TV order, 18 entries,
Arrow still present), live drawing of Trend Angle / Flat Top/Bottom / Disjoint Channel /
Regression Trend / Pitchfork on the canvas, store + render checks, settings dialog fields,
dark + light screenshots, zero page errors; plus the full regression suite of previous rounds.
