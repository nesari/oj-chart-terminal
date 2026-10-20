# FEATURE-ROUND133 — Pine v6 Engine: 5 Real TradingView Indicators E2E

**Goal:** the user's actual TV indicators run end-to-end (compile → runtime → chart render).

## Corpus (all green)
| Script | Source | Status |
|---|---|---|
| Smart Money Concepts [LuxAlgo] | user .txt (v5, 850 lines) | compile ✓ run ✓ chart render ✓ (boxes/lines/labels) |
| Squeeze Momentum [LazyBear] | user .txt (v2/v4 legacy) | compile ✓ run ✓ (plots=2) |
| Supertrend | user .txt | compile ✓ run ✓ (plots=3) |
| CM_MacD_Ult_MTF | user .txt (request.security MTF) | compile ✓ run ✓ (plots=4) |
| sqzmom-v6 | hand-ported v6 | run ✓ |

## Engine fixes this round
1. **`ta.highest/lowest(len)` one-arg form** — `ta.highest(50)` was treating 50 as
   *source* + default len 14. TV parity: one-arg form defaults source to high/low
   (`stdlib/ta.js`). ROOT CAUSE of "SMC detects nothing".
2. **`last_bar_time` ms frame** — returned raw feed seconds; now scaled
   `(t - serverOffSec) * timeScale` like `time` (interpreter L1444).
3. **`chart.point` full support** — `chart.point.new(time,index,price)` factory;
   `line/box/label.new` accept point objects in any positional slot
   (`unpackPointArgs` + `_nsObjNew` unpack); point-setter methods:
   `line.set_first_point/set_second_point`, `box.set_top_left_point/
   set_bottom_right_point`, `label.set_point`.
4. **`plotcandle`/`plotbar`** — per-bar record in `out.candles`, rendered by
   `pine-render-adapter.js` (colored synthetic candles, SMC trend coloring).
5. **`request.security`** — same-symbol higher-TF resampling, fully offline
   (`stdlib/request-security.js`): bars grouped into HTF buckets by shifted
   time; lower-TF rejected; lookahead/gaps handled; series/expr args run in
   the HTF frame (`_htfOverride`). CM_MacD_Ult_MTF unblocked.
6. box/line/label `new()` with na coords (`_optNum`) — TV creates-then-moves
   pattern (`var b = box.new(na,...)` + setters).
7. bare v4 style word `line` (plot style=), `box.set_*` missing setters.

## Test infra
- `tests/unit/verify_pine133.mjs` — user corpus (4 compile + 4 run + 6 regression) = **14/14**
- `scripts/verify_pine74/78/80.mjs` — 53/53, 29/29, 16/16 (no regressions)
- `tests/e2e/e2e_round133_pine_v6.py` — Playwright E2E on the real app+demo feed:
  compile via app entry, SMC added through Pine editor → objects on the live
  chart, zero page errors. Screenshot: docs/shots-round133/.
- `tests/e2e/e2e_round133b_tv_templates.py` — fresh-profile seed: the 5 TV
  indicators appear in the Pine editor dropdown and each compiles (9+ scripts).
- `provider_common.py` PORT from `MT5_WS_PORT` env (E2E isolation).
- CSP `connect-src` widened to `ws://127.0.0.1:*` (test ports).
- `Feed(url)` + `?ws=host:port` query override (web-shell tests).
- `PineUI.debugRtDump()` — test facade over the private RT map.

## TV templates in the editor (user-facing)
The 5 real indicators ship as files in `src/renderer/assets/pine-samples/`
and are seeded ONCE into the Pine editor on first open (marked `tv: true`,
alongside the 4 built-in EMA/RSI/MACD/Bollinger samples). Users open the
`{ }` Pine editor → pick from the dropdown → "Add to chart". No manual
copy-paste needed.

## Known limits (by design, deferred)
- `request.security` with a DIFFERENT symbol → needs the provider extension
  (WS endpoint) — phase 2, per user decision.
- strategy.* still out of scope (indicators only).
