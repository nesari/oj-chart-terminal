# BUGFIX ROUND86C — "Request timeout: bars_req": Go to Date dead on the REAL MT5 server

**Version:** 1.9.42 → 1.9.43
**Trigger (user, after testing v1.9.42 on a real broker):**
«بخش go to Date رو چک کن هیچ کدوم از قسمت هاش کار نمیکنه . روی بروکر واقعی دارم تست میکنم .
توی بخش دیباگ هم مینویسه Request timeout : bars-req»
(= none of the Go to Date parts work on the real broker; the debug log shows `request timeout: bars_req`).

ROUND86B fixed the *client-side* handling of the real-server data model (empty first payloads,
decade-wide year picker, tick-blocked historical view, the fatal ms/sec dialog bug). This round
root-causes the **provider-side** failure the debug message points at: the `bars_req` reply never
reaches the client at all. Five real defects were found and fixed; each is pinned by a permanent
regression test.

---

## Root causes (probe-verified)

### 1. THE FREEZE — `get_bars` ran ON the asyncio event loop (the primary bug)
`provider_common.py`'s ws handler called `self.get_bars(...)` **synchronously inside the
`async def handler`**. The MetaTrader5 package calls are **blocking C calls**, and for history the
terminal has not downloaded yet a real broker triggers an **archive sync inside
`copy_rates_range`** — seconds to minutes of a hard freeze. During that window:

- the `bars` reply is never composed → the client times out → `request timeout: bars_req` in the
  debug panel;
- ticks stop, the ws library cannot run its heartbeat, every other request queues behind the
  frozen loop — the provider looks dead;
- the renderer's ROUND86B retry poll (4 attempts) stacks **more** `bars_req` messages behind the
  same frozen loop, compounding the outage. Net effect: *none of the Go to Date parts work* —
  exactly the user's report.

**Fix** (`provider/provider_common.py`): a dedicated **single-thread executor**
(`Broker._data_exec`, `thread_name_prefix='mt5data'`) created in `Broker.__init__` and a
`_run_data()` helper. The `bars_req` hook and `tick_loop`'s `next_tick` both run through it:

- the event loop never blocks → replies, ticks broadcasts, protocol heartbeat, `trade` RPC and
  every other op stay alive while an archive sync chews in the worker;
- ONE worker = all `mt5.*` calls stay serialized — the package is never entered from two threads
  concurrently (concurrency there risks native crashes; ticks *pausing* during a sync is the same
  net behaviour the old code had, minus the total freeze).

### 2. THE SILENT DROP — a raising `get_bars` never sent a reply
The handler's outer `try/except` swallowed any exception from `get_bars` and **sent nothing**
(violating the round-36 "always answer" rule that `symbol_search`/`trade` already follow). The
client then waited for its full timeout even when the failure was instant.

**Fix:** the `bars_req` branch wraps `get_bars` in its own `try/except` and **always** sends the
`bars` reply; an error degrades to an empty payload, which every caller already polls
(`retryBars`, `fetchChunk`, `Manager.loadBars`).

### 3. THE OVERFLOW — MN1-family timeframes guaranteed a timeout
`mt5.native_bars` computed the copy window as `TF_SEC[tf] * max(4, count*3)` **unclamped**:
`datetime.fromtimestamp` 2026 minus `2592000 s × 75000` ≈ **6162 years** → below `datetime.min`
→ `OverflowError: date value out of range` — raised **outside** the `try` → defect 2's silence →
every Go to Date / Custom Session / older-page request on MN1/MN3/MN6/MN12 timed out even on a
warm terminal.

**Fix** (`provider/mt5.py`): `MAX_RANGE_SPAN = 40 * 365 * 86400` clamps the span (~40 years —
far beyond any real archive; `copy_rates_range` simply answers with whatever exists inside it).

### 4. THE MISROUTED TIMEOUT — bars died at 20 s instead of the intended 45 s
`feed.js` selected the history timeout with `obj.type === 'bars'`, but the request type is
**`bars_req`** — the 45 s branch never matched and every bars request (chart load, Go to Date,
Custom Session, older-pages) died at the generic **20 s** while the real terminal was still
syncing. A provider that would have answered at 25–40 s was killed by its own client.

**Fix** (`src/core/feed.js`): `'bars' || 'bars_req'` → 45 s (as the original comment intended).

### 5. THE SLIDING PAGES — backward paging walked ONE bar per page
`gotodate.fetchWindow` / `session.loadBaseBars` read the page's oldest bar as
`bars[bars.length-1]`, but the providers answer **ascending** — that index is the *newest* bar.
Consequences on a real broker with a deep archive:

- every "next page" request slid back by exactly **one bar** instead of jumping to the window
  start → the 12-page guard burned 12 × page-size bars (up to **300 k bars ≈ 27 MB JSON**) per
  fetch, serialized on the provider → guaranteed `bars_req` timeouts;
- combined with defect 1 this is why *every* part (View that date, Start Bar Replay there,
  Custom Session) failed at once.

ROUND86B's browser e2e never caught it because the blind 25k first page usually returned fewer
bars than requested (`dry` break) on the demo archive, so paging never actually ran there.

**Fix:** `oldest = Math.min(bars[0].time, bars[bars.length-1].time)` (correct for either answer
order) in both modules.

### Bonus aggravator removed: blind over-requests
Both fetchers asked for the **full cap (25k / 20k bars)** on the first page no matter how small
the window. The provider derives its copy window as `TF_SEC × count × 3` — i.e. ~52 days of M1
archive synced for a 1-day view, maximizing the cold-sync block behind defect 1. Pages are now
**right-sized to the remaining window** (`ceil(span/tfSec) + 200` slack, still capped by
`MAX_FETCH_BARS`/`CHUNK`): a 1-day view asks for ~1.6k bars, the user's 2-day Custom Session for
~3.1k instead of 20k.

---

## Tests

- `scripts/test_round86c_provider.py` (new, **14/14**): the overflow math reproduced + clamped for
  every timeframe; in-process real-socket server proves the loop answers a second connection
  **during** a 2.5 s blocking `get_bars`, ticks resume after, the slow reply arrives (~2.5 s);
  a raising `get_bars` still answers `[]` immediately and the handler survives; the real demo
  provider over the wire answers live-tail, `to`-pages and the MN1 25k-page overflow case.
- `scripts/test_round86c_paging.mjs` (new, **19/19**): imports the REAL shipped
  `gotodate.js`/`session.js` (import-stripped, stubbed) and pins right-sized pages (1640 / 3080 /
  225 — not 25k/20k), single-page fills, cap truncation keeping the newest bars, cold-terminal
  polling, dry-archive stops, and the sliding-pages fix (distinct bars across pages).
- Provider smoke on the real port: `python3 provider/demo.py` + live ws probe — login, live-tail
  bars, `to`-page bars and the MN1 25k-page all answered in <0.15 s.
- Regression: `round84_harness.mjs` OK (135 indicator checks + 392,000 bucket anchors);
  `node --check` passes on every JS file; `py_compile` passes on all three providers.

## Files touched

| File | Change |
|---|---|
| `provider/provider_common.py` | single-thread data executor; `bars_req` off-loop + always replies; `next_tick` off-loop (hardened) |
| `provider/mt5.py` | `MAX_RANGE_SPAN` clamp in `native_bars` |
| `src/core/feed.js` | `bars_req` → 45 s timeout |
| `src/renderer/js/panels/gotodate.js` | right-sized pages; oldest-bar fix in `fetchWindow` |
| `src/renderer/js/panels/session.js` | right-sized pages; oldest-bar fix in `loadBaseBars` |
| `scripts/test_round86c_provider.py`, `scripts/test_round86c_paging.mjs` | new regression suites |
