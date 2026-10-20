# Phase 2 — ES Modules + JSDoc Modularization (v1.5.0)

> ⬆ delivered & superseded by Phase 3 (platform-agnostic core) — see `docs/PHASE3-CORE.md`.

> Roadmap: Phase 1 = logging/monitoring + errors + security (v1.4.0) →
> **Phase 2 = this document (v1.5.0)** → Phase 3 = platform-agnostic core
> extraction → Phase 4 = Web shell + Capacitor mobile.

## What changed

The renderer was rewritten from **28 classic IIFE scripts communicating
through ~29 `window.*` globals** to a **static ES-module graph with one
entry point**. Behavior is unchanged; the module boundaries are now explicit
and the dependency direction is visible in every file.

| Before (v1.4.0) | After (v1.5.0) |
|---|---|
| 28 `<script>` tags, load order = semantics | 1 vendor classic script + `<script type="module" src="js/app.js">` |
| ~29 `window.*` globals (`window.Manager`, `window.Settings`, …) | named `import`/`export` per module; **zero** module globals on `window` |
| Late-binding defensive guards (`typeof Manager !== 'undefined'`) | static imports — the graph is deterministic |
| Load-order accidents possible on every new file | cycles allowed only where runtime-only (audited, see below) |
| Test access: scattered `window.X` | one sanctioned facade `window.__app` (26 keys) |

Every module now carries a JSDoc header (`@module …`) and every public
export is documented.

## Module map (30 files)

```
js/app.js                     ← entry point: composition root + boot()
js/ui/rightpanel.js           ← NEW (extracted from app.js)
js/core/    util.js           ← ZERO-dependency leaf (DOM + misc helpers)
            logger.js         ← leaf: structured logging + crash net
            errors.js         ← AppError + open catalog (imports Log)
            timezone.js, theme.js, state.js, undo.js, feed.js
js/chart/   settings.js, manager.js (hub), indicators.js (pure math, 0 deps),
            indicators-ui.js, compare.js, toolbar.js
js/drawing/ settings.js, tools.js, tools2.js, engine.js, ui.js
js/panels/  watchlist.js, timesales.js, alerts.js, datawindow.js,
            objects.js, diagnostics.js, replay.js
```

Sanctioned non-module surfaces (documented, intentional):

* `window.electronAPI` — preload `contextBridge` (security boundary).
* `window.LightweightCharts` — vendor UMD build, kept as a classic script so
  it executes **before** the deferred module graph.
* `window.__app` — test/debug facade (26 module handles), set in `boot()`.

## Moved APIs (call-site changes, all internal)

| Old | New | Why |
|---|---|---|
| `U.priceDigits(sym)` | `priceDigits(sym)` exported from **core/feed.js** | util must stay dependency-free (it reads the live feed's digits map) |
| `U.th(key, fb)` | `Theme.th(key, fb)` in **core/theme.js** | same layering rule |
| `window.RightPanel` | **ui/rightpanel.js** module (extracted from app.js) | breaks the app↔panels cycle cleanly |
| `Manager.recomputeIndicators` stub overwritten by indicators-ui | manager **imports + delegates** (`indRecompute`, `indTickRecompute`, `indUpdateRows`) | no cross-module mutation at evaluation time (TDZ) |
| `Manager.getSnapshotPalette` defined in toolbar.js | lives in **manager.js** (toolbar only calls it) | same TDZ rule |

## ES-module cycle rules (the important lesson)

Cycles in the graph (manager ↔ toolbar ↔ ui ↔ settings ↔ theme …) are safe
**only** when every cross-reference sits inside a function body (runtime).
Top-level evaluation-time writes/reads into a not-yet-initialized binding
throw `ReferenceError: Cannot access … before initialization` (TDZ). Two
real cases were found and restructured (indicator hooks, snapshot palette);
the audit script `scripts/audit_imports.py` recomputes every module's needed
imports with template-interpolation-aware stripping and can auto-patch
missing named imports:

```bash
python3 scripts/audit_imports.py          # dry audit
python3 scripts/audit_imports.py --apply  # patch missing imports
bash    scripts/check_esm.sh              # node --check all 30 modules
```

## Verification (all green)

| Suite | Result |
|---|---|
| `scripts/check_esm.sh` (syntax, 30 modules) | 30/30 |
| `test_round25.py` (regression) | 30/30 |
| `test_round26.py` (regression) | 12/12 |
| `test_round27_features.py` (features) | 11/11 |
| `test_round28_diag.py` (logging/errors/security) | 10/10 |
| `test_phase2_modules.py` (NEW — modularity guard) | 5/5 |
| real Electron 33 boot: `loadFile` + `file:` + `sandbox:true` | PASS (0 errors) |

`test_phase2_modules.py` **fails if any converted global reappears on
`window`** — the guard for future rounds.

## Notes for Phase 3 (platform-agnostic core)

* `core/util.js`, `core/logger.js`, `core/errors.js`, `chart/indicators.js`
  are already DOM-free or nearly DOM-free — first candidates for the
  platform-agnostic package.
* `feed.js` only needs a WebSocket + the `electronAPI` log sink abstracted.
* `window.__app` will be replaced by explicit composition in the web shell;
  the facade stays for the Electron app.

## For developers: adding a new module

1. Create `js/<area>/<name>.js` with a JSDoc `@module` header.
2. `import` what you need from siblings — never write `window.X = …`.
3. Export your public API; register new error codes via
   `AppErr.register()`; log with free-form categories via `Log`.
4. If the module is test-relevant, add it to the `__app` facade in `app.js`.
5. Run `bash scripts/check_esm.sh` + the E2E suites.
