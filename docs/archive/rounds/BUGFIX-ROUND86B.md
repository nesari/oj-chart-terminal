# BUGFIX ROUND86B — Go to Date / Custom Session / Replay demo-trading on the REAL MT5 server

**Version:** 1.9.41 → 1.9.42
**Trigger (user, after testing v1.9.41 on a real broker account):**
«هیچ کدوم از موارد رو انجام ندادی» — (1) demo-account trading in Replay must work on the REAL
MetaTrader server, (2) Custom Session must be runnable on the real server **inside the Go to Date
section**, (3) the Go to Date section itself does not work.

The v1.9.41 build was verified end-to-end in a browser — but only against the **demo provider**,
whose data model hides exactly the failure modes a real MT5 terminal has. Reproducing the user's
steps with live probes found **five real defects**; all are fixed in this round and each now has a
permanent regression test.

---

## Root causes (probe-verified)

### 1. The historical view snapped back to "now" within one tick
`fetchAround` replaced the series with a window **ending at the chosen day** but kept the pane
wired to the live tick stream. The next tick hit the old-tail series → `bt2 - last.time ≥ max(300,
tf.sec*10)` → `scheduleStaleReload` → `loadBars` re-fetched the present. The jump destroyed itself
in ~1 tick. The old e2e missed it because its `until(...)` assertion only had to hold **once**
(the 120 ms poll raced the 30 ms reload timer).

**Fix** (`panels/gotodate.js`): a Go-to-Date fetched view is a *historical view* —
`pane.replay = {}` blocks the live stream (the exact guard Custom Session already uses),
`pane._gdView` marks it, and a floating **"Return to live" chip** (`.gd-chip` over the charts)
restores the stream on demand (`Replay.stop` → `SessionRange.clear` → `loadBars` per pane).
Any natural reload (TF switch, symbol switch, layout change, reconnect, stale heal) clears the
state through a wrapper on `Manager.loadBars` installed in `GoToDate.init` (chains over the
existing compare.js wrapper — zero changes inside manager.js).

### 2. The year picker only offered the years of the loaded history
`yLo..yHi` were derived from `pane.barTimes` — on a real broker the loaded window is short, so the
dropdown contained (e.g.) only 2026 and **most dates could not even be selected**. The demo
provider's deep synthetic history masked this.

**Fix:** the pickers always span `min(loadedYear, now−25) … max(loadedYear, now+1)`; the loaded
range stays visible as a hint only.

### 3. Real terminals answer the FIRST old-date request with an empty payload
While the terminal downloads the archive, `copy_rates_range` returns `None` → the provider
responds `bars: []`. `Manager.loadBars` already polls for this exact cold-sync case (documented in
round 26), but every Go-to-Date / Custom Session fetch treated one empty payload as "no history"
→ "nothing happened" on the real server.

**Fix:** `retryBars()` polls **4 attempts × 1.5 s** (gotodate) and `fetchChunk()` polls
**3 attempts × 1.2 s** (session) before giving up. A date genuinely beyond the archive now fails
*loudly* with an explanatory toast («the broker archive may not reach that far — try a higher
timeframe or a nearer date») instead of silently doing nothing.

### 4. Backward paging never reached the requested date
`fetchWindow` paged with `per = COUNT_FOR[tf]` (e.g. 5000). The demo provider regenerates its
archive **ending at now** on every call, so page 2+ returned empty and the window collapsed to the
recent tail (replay anchored ~8 days after the requested date). Real MT5 caps requests at 25k bars
too.

**Fix:** ask for the **full 25,000-bar cap in one shot** and page again only while the provider
keeps returning full pages. Verified: a replay-from-date window of 16.6k bars lands exactly on the
chosen day.

### 5. The Custom Session dialog could NEVER apply (round-86 bug)
`readInfo` divided `Date.getTime()` (**milliseconds**) by `DAY` (**86400 seconds**), inflating
every range ~1000×: `dTo − dFrom > 400` → **"range too long"** on every Apply. The round-86 e2e
only called `SessionRange.apply()` programmatically with correct day numbers, so the dialog path
was never exercised — the user hit it immediately.

**Fix:** `getTime() / 1000 / DAY`. Apply now works from the dialog.

---

## User-facing changes

### Custom Session now lives INSIDE Go to Date (user request)
The Go-to-Date dialog is now two tabs — **"Go to date" | "Custom Session"** — one dialog, one
entry point. The top-bar clock button opens the same dialog on the session tab
(`SessionRange.openDialog` is re-pointed in `GoToDate.init`; late-bound, no import cycle). All
field IDs (`#cs-hfrom`, `#cs-hto`, `#cs-dfrom`, `#cs-dto`, `#cs-info`, `#cs-apply`, `#cs-clear`)
are preserved.

### "Start Bar Replay there" — replay on REAL broker history
The date tab gained a mode radio:
- **View that date** (default) — as before, window ending at the day.
- **Start Bar Replay there** — fetches a window **FROM the selected day through the present** on
  every chart (multi-chart: each pane fetches its own symbol/TF window), anchors the replay cursor
  there and auto-opens the **Replay Trading** panel — so the demo account (custom deposit /
  leverage / spread / stop-out) trades on the broker's real archive, not just the last few loaded
  days. If the archive starts later than the chosen date, the replay anchors at the earliest
  available bar and a toast says so. Composes with Custom Session (anchors inside the stitched
  data).

### Custom Session on the real server
- **Base availability ladder**: when the budget-picked base (e.g. M1) has NO data in the range
  (fine-TF archives are shallow / terminal not synced), it falls back M5 → M15 → H1 and announces
  the substitution. Per-chunk polling included.
- **Coverage reporting**: when the archive starts inside the requested range, the user is told
  explicitly («M1 archive starts YYYY-MM-DD — showing Y of Z day(s)») instead of silently seeing
  fewer days.
- A fully-out-of-archive range (e.g. the future) lands on a clean empty state with a toast — no
  crash, no phantom data.

---

## Files changed

| File | Change |
|---|---|
| `src/renderer/js/panels/gotodate.js` | rework: retryBars/fetchWindow, historical-view state + chip + loadBars wrapper, decade-wide picker, merged two-tab dialog, `jumpReplayFrom` (multi-chart), graceful empty |
| `src/renderer/js/panels/session.js` | fetchChunk polling, base availability ladder, coverage toasts, dialog removed (merged), `SessionRange.pickBase` exposed |
| `src/renderer/css/replaytrade.css` | `.gd-tabs/.gd-tab/.gd-modes/.gd-mode/#gd-mode-info` + `.gd-chip` styles |
| `package.json` / `CHANGELOG.md` | 1.9.42 entry (fa) |
| `docs/archive/rounds/BUGFIX-ROUND86B.md` | this document |
| `scripts/test_round86b_e2e_browser.py` | NEW e2e (31 checks) |

Everything else — manager.js, replay.js, the real trade bridge, providers — is **untouched**
(scope discipline maintained; the Manager.loadBars wrapper is installed from gotodate.js).

---

## Verification

- **NEW** `scripts/test_round86b_e2e_browser.py` — **31/31**: decade-wide year picker (2001..2027,
  a date two years back selectable), out-of-range fetch ending at the day, **view STAYS at the
  historical date under 6 s of live ticks** (the root-cause regression), Return-to-live chip +
  restore, deep date → chart unchanged + explanatory toast, dialog replay mode (coverage info
  line, replay starts at the date, window runs to the present n=16.6k, Replay Trading panel
  auto-opens, demo BUY accepted, engine LIVE, position survives steps), multi-chart both panes
  replay from the day, session applied THROUGH the dialog, day gaps, base ladder (M5 for a
  30–40-day-back range), future range → graceful empty, **zero page errors**.
- Full regression green: `test_round86_e2e_browser.py` (46), `test_round86_math.mjs` (63),
  `test_trade_e2e_browser.py` (58), `test_trade_math.mjs` (21), `test_trade_rpc.py` (28),
  `round84_harness.mjs` (135 indicator + 392,000 anchor checks), `node --check` on every JS file,
  `py_compile` on all providers.
