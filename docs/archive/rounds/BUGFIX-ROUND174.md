# BUGFIX ROUND174 — provider stall froze the app with the socket open

## Log (v1.9.126, real MT5, 93s session)

- `feed connected`, GBPUSD D1 history ok, `script added to chart` ("My script 2", 09:09:52)
- `trade timeout` ×2 (09:10:12, 09:10:33), `bars_req timeout` ×2 (09:10:37, 09:10:46)
- `ERROR [UNKNOWN] bars_req timeout` at loadBars (XAUUSD M5, via compare)
- Chart never loaded ("stuck at loading data")

## Root causes (two, both fixed)

1. **Trade RPC ran inline on the provider event loop** (`provider_common.py`
   handler called `self.trade_rpc(msg)` synchronously). When the MT5
   terminal hung (lost broker connection is the classic cause — every MT5
   call then blocks), the loop froze: no ticks, no pings, no bars replies.
   The socket stayed OPEN, so the client never fired `onclose` and just
   waited out each 20/45s timeout. Fix: `run_trade()` executes on the data
   executor with a 15s budget and ALWAYS answers (timeout error names the
   terminal + suggests provider restart). Side benefit: trade and data MT5
   calls are now serialized (the package is not thread-safe).
2. **No client-side stall detection for an open-but-silent socket.**
   Fix: app-level ping every 20s in `feed.js`; no pong 15s after OUR ping
   closes the socket into the existing onclose → bounded-backoff reconnect
   path (`app.js`). A healthy (even tick-quiet/weekend) provider answers
   pings, so there are no false positives.
3. **Prefetch weight (contributing):** cross-symbol prefetch could ask up
   to 25000 bars (e.g. M5 over a multi-year D1 chart) — a heavy MT5 archive
   sync. Capped at 5000 (same-TF coverage preserved: M1 needs ≤5000).

## What the user should still check

The timeouts prove the terminal stopped answering around 09:09:52. If it
recurs: MT5 terminal connection status (Journal tab), then restart the
provider (`run-mt5.bat`) — the app now says so in the timeout error and
recovers by itself when the socket goes silent.

## Tests

- `test_round174_provider_stall.py` (5 checks: hanging/raising/ok hooks)
- `test_round174_stall.mjs` (11 checks: decision table, pong, tick drive)
- Regression: broker/corpus/lazy suites + pine74 green.
