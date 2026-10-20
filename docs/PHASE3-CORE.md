# Phase 3 — Platform-Agnostic Core (v1.6.0)

> Roadmap: Phase 1 = logging/monitoring + errors + security (v1.4.0) →
> Phase 2 = ES Modules + JSDoc (v1.5.0) → **Phase 3 = this document (v1.6.0)**
> → Phase 4 = Web shell + Capacitor mobile (Android/iOS).

## What changed

The **platform-agnostic core** now lives in its own tree, `src/core/`, and
contains **zero host-global references** — no `window`, no `document`, no
`electronAPI`, no direct `localStorage`. Platform-specific behavior moved
behind two seams:

| Seam | File | Role |
|---|---|---|
| environment | `src/core/env.js` (`ENV`) | the ONE place allowed to sniff host globals (navigator/UA/DPR/timezone/electron) + the JSON **storage seam** used by all core persistence |
| host adapter | `src/platform/electron/loghost.js` | Electron renderer glue: batched IPC file-log transport, global crash net (`error`/`unhandledrejection`), rate-limited toast, `beforeunload` flush |

The renderer DOM app stays in `src/renderer/` unchanged in behavior:
`index.html`, `css/`, `assets/`, `vendor/` and `js/` (chart, drawing,
panels, ui). `js/app.js` imports the host adapter **first**, so the crash
net is active before any other module evaluates — the same timing the
round-28 logger had.

## New source layout (33 JS modules)

```
src/
  core/                    ← platform-agnostic (runs in Node/browser/Electron)
    env.js                 ← NEW  host seam: ENV probes + storage (get/set JSON)
    util.js                ← NEW  pure math/time/geometry helpers (named exports)
    logger.js              ← moved + transport-injectable (Log.setTransport)
    errors.js              ← moved (AppError + open catalog, unchanged)
    indicators.js          ← moved (27-indicator pure-math registry)
    state.js               ← moved (persistence now via ENV.storage)
    timezone.js            ← moved (Intl funnel, unchanged)
    feed.js                ← moved + injectable URL: new Feed(url)
  platform/
    electron/loghost.js    ← NEW  renderer host adapter (self-installing)
  renderer/
    index.html, css/, assets/, vendor/
    js/
      core/util.js         ← rewritten as facade: pure helpers re-exported
                             from core + DOM helpers ($, el, toHex, fitPopup)
      core/theme.js, core/undo.js        ← stay (DOM-bound)
      app.js               ← entry; first import = loghost
      chart/ drawing/ panels/ ui/        ← unchanged (import paths rewritten)
```

## Logger refactor (the important one)

`Log` keeps its entire public API (levels, `entries`, `onEntry`, `stats`,
`exportText/Json`, `setPaused`, `flushNow`, scrubbing, ring, batching) and
gains exactly one method:

```js
Log.setTransport(fn)   // fn(batch) — attach/detach the outbound sink
```

* The batching logic (1.5 s window / 60 early / 400 cap) stays in the core
  and is now unit-testable in plain Node.
* `Log.stats().ipc` still reports the file-sink state (`!!transport`) —
  the Diagnostics panel "file on/off" chip works unchanged.
* Without a transport everything degrades exactly like the old headless
  path: ring keeps entries, `dropped` counts what never left.
* The crash net + toast are host code now (loghost.js) — same listeners,
  same rate limit, same messages.

`src/core/logger.js` also exports `scrub` and `flushNow` for tooling/tests.

## Moved modules — call-site rule

All cross-module call sites are identical; only import specifiers changed
(43 imports across 20 files, rewritten mechanically and verified by the
resolution audit). Public export names did not change:

| Module | Exports consumed by the renderer |
|---|---|
| `core/logger.js` | `Log` (+ `scrub`, `flushNow` for tools) |
| `core/errors.js` | `AppErr` |
| `core/indicators.js` | `Indicators` |
| `core/state.js` | `App` (+ catalogs `TF`, `STYLES`, `LAYOUTS`, …) |
| `core/timezone.js` | `TZ` |
| `core/feed.js` | `Feed`, `priceDigits` |
| `core/util.js` | pure helpers (`clamp`, `timeToLogical`, …) |
| `core/env.js` | `ENV` (core-internal) |

`src/renderer/js/core/util.js` re-exports the pure helpers inside `U`, so
the renderer's ~150 `U.x` call sites needed **no edits**.

## Verification (all green)

| Suite | Result |
|---|---|
| `scripts/check_esm.sh` (syntax, 33 modules) | 33/33 |
| `test_round25.py` (regression) | 30/30 |
| `test_round26.py` (regression) | 12/12 |
| `test_round27_features.py` (features) | 11/11 |
| `test_round28_diag.py` (logging/errors/security) | 10/10 |
| `test_phase2_modules.py` (modularity guard) | 5/5 |
| `test_phase3_core.py` (NEW — core purity, 31 checks) | 31/31 |
| real Electron 33 boot (`loadFile` + `file:` + `sandbox:true`) | PASS, 0 errors |

`test_phase3_core.py` proves the portability claim concretely:

* **T1 — plain-Node smoke (24 checks):** every core module imports and
  behaves in Node without any DOM: logger ring/scrub/transport/export,
  error catalog + `register()`/`raise()`/`wrap()`, all 27 indicators
  (SMA/RSI math sanity), timezone funnel, state catalogs, feed URL
  injection + digit fallbacks, ENV.storage graceful degradation.
* **T2 — static purity (3 checks):** no `window.` / `document.` /
  `electronAPI` / `localStorage` token anywhere in `src/core` except
  `env.js`; every relative import in `src/` resolves to a real file.
* **T3 — browser boot (4 checks):** the new layout boots over http with
  zero console errors, demo login + 5000 bars land, `__app` facade intact.

## Notes for Phase 4 (Web shell + Capacitor)

* The web shell serves `src/` statically and imports the same core; it
  only needs its own host adapter (transport: no-op/IndexedDB, crash net:
  same window listeners, storage: localStorage — already the default).
* `Feed(url)` takes the provider endpoint — the web shell will point it at
  the same local provider (`ws://127.0.0.1:8777`) or a remote relay; no
  core change required.
* Mobile (Capacitor): the web shell bundles as-is; ENV.storage can be
  swapped for Capacitor Preferences by re-assigning `ENV.storage` before
  any core module persists.
* Credentials via **OS safeStorage** remain a planned main-process upgrade
  (user decision) — the renderer never sees them, the core never stores
  them; it slots into the login flow without touching `src/core`.

## For developers

1. **Core rules:** `src/core/*` must stay host-global-free — the phase-3
   test fails the build otherwise. Sniffing goes in `env.js`; persistence
   goes through `ENV.storage`.
2. Import core as `../../../core/<name>.js` from `js/<area>/` (the audit
   recomputes and verifies every specifier).
3. Run the safety net after any change:
   `bash scripts/check_esm.sh && python3 scripts/audit_imports.py && python3 scripts/test_phase3_core.py`
   plus the round suites for behavior.
