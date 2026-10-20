# THEME-AUDIT.md — Full-App Theme-Leak Sweep (AUD-001, Round 24)

Method: static grep of every renderer JS (`src/renderer/js/**`) for color
literals (`#hex`, `rgb(`, `rgba(`, `hsl(`) + inline style color assignments,
plus a visual sweep of every surface in BOTH themes. Rule (§3.4): colors only
through CSS variables / `Theme.c()` / settings keys; every fixed color is
either fixed (row below) or listed as a documented exception.

Result: **zero unresolved hardcoded chrome colors** — every hit is either
re-wired to a token (fix table) or a documented exception (exception table).

## Fixed in this round (violations → token)

| # | File:line (before) | Surface | Direction | Fix |
|---|---|---|---|---|
| 1 | `css/app.css #ctx-toolbar` | drawing quick-action floating toolbar | dark-in-light (BUG-009) | `background: var(--panel)`; icons already `currentColor`; light shadow override added (`body.theme-light #ctx-toolbar, #fav-float`) |
| 2 | `css/app.css #fav-float` | favorites floating toolbar | dark-in-light | `background: var(--panel)` + light shadow override |
| 3 | `css/app.css #replay-bar` | replay controls bar | dark-in-light | `background: var(--panel)` |
| 4 | `css/app.css .pl-txt` | "Loading data…" chip | dark-in-light | `background: var(--panel)` |
| 5 | `css/app.css .tv-typing` | typed-interval badge | dark-in-light | `background: var(--panel)` |
| 6 | `js/chart/toolbar.js` (alert search) | alert dialog symbol-search input (inline dark cssText) | dark-in-light (BUG-009 surface #2) | `.al-search` class styled by `--panel2/--border/--text/--text-dim` |
| 7 | `js/drawing/ui.js` width/style popups | line-preview strokes hardcoded `#d1d4dc` | light-invisible-in-light | `U.th('text', …)` (Theme token) |
| 8 | `js/drawing/settings.js` (2×) | line-style/width previews `#d1d4dc` | same | `U.th('text', …)` |
| 9 | `js/drawing/engine.js` period separators | dashed separator stroke `rgba(120,123,134,.42)` | fixed gray both themes | new token `Theme.c('periodSep')` (dark `rgba(120,123,134,.42)` / light `rgba(90,96,110,.45)`) via `this._th()` |
| 10 | `js/drawing/tools.js` (info-line chip bg) | canvas chip `#1e222d` | fixed dark chip in light | `Theme.c('chipBg')` |

Support: `U.th(key, fallback)` helper added (`js/core/util.js`) — the ONE way
JS reads a theme token with a fallback; `Theme.c()` remains the canvas funnel.

## Documented exceptions (kept, justified)

| Surface | Files | Colors | Why it is NOT a leak |
|---|---|---|---|
| Market-semantic colors (up/down, sparklines, change value) | `manager.js`, `watchlist.js`, `toolbar.js` snapshot | `#089981` / `#f23645` | identical meaning in both themes (TV parity); also user-configurable via Settings |
| Drawing-tool CONTENT defaults | `core/state.js defaultOpts`, `drawing/tools*.js`, `drawing/settings.js`, `drawing/ui.js` swatch fallbacks | `#2962ff`, `#d1d4dc` text default, palette hexes | these are the color a NEW drawing receives (content, not chrome); TV uses the same defaults in both themes; user overrides persist per drawing |
| Color-picker palette + SV/Hue gradient stops | `chart/toolbar.js` (palette rows, picker gradients) | palette hexes, `#000/#fff` gradient stops | picker CONTENT — the swatches themselves must not change with theme |
| Symbol badge colors | `panels/watchlist.js LOGO_COLORS` | curated asset hexes | deterministic brand badge (like TV's asset logos); theme-independent by design |
| Compare-series palette | `chart/compare.js` | 5 hexes | series content colors |
| Crosshair label background | `manager.js` `labelBackgroundColor: '#363a45'` | dark bubble both themes | TV parity — crosshair time/price bubbles keep a dark plate in light mode too |
| Validation error borders | `toolbar.js` (`#f23645`) | red | semantic error color, both themes |
| Settings fallbacks (`S.x \|\| default`) | `manager.js`, `chart/settings.js` | dark factory defaults | Settings.conf is ALWAYS migrated to the active theme's factory value by `Theme.apply()` (round 19); the literal is only a boot-time fallback |
| Theme token definition sites | `core/theme.js` (CHART_DEFAULTS, UI) | all | the token source itself |
| Color parse fallback | `core/util.js` `#000000` | parse guard | never rendered as chrome |
| Vendor file | `vendor/…` | many | locked 4.2.3, out of scope per §3.4 |
| Snapshot compositor palette | `chart/toolbar.js` `SNAP_BG` etc. | fixed dark | **fixed under BUG-008** in this same round — the compositor now derives its whole palette from `Manager.getSnapshotPalette(theme)` (see BUG-008 section of CHANGELOG) |

## Verification
- `tests/unit/test_aud001_bug009.py` — **8/8 PASS**: dark → light → dark round-trip
  asserts `#ctx-toolbar` / `#fav-float` computed background equals the ACTIVE
  theme's `--panel` token and icon ink flips (`#d1d4dc` ↔ `#131722`); alert
  search input class verified; zero console errors.
- Screenshots: `download/aud001-dark.png`, `download/aud001-light.png`.
