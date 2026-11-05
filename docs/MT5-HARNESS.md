# MT5 provider harness (record / replay)

`provider/mt5.py` talks to the Windows-only `MetaTrader5` package and a live
terminal. Historically that made the whole trading/history/timeframe bridge
manual-test-only. The harness removes that dependency:

```
real terminal ──record──▶ fixture JSON ──replay──▶ tests/provider/test_mt5_provider.py
                                      └── fake package (tests/provider/mt5_fake.py)
```

## Run

```powershell
npm run check:mt5
# or
python -m unittest discover -s tests/provider -p "test_*.py" -v
```

`check:mt5` is part of `npm run verify`, so CI (Windows, Linux under Xvfb,
macOS) exercises the bridge on every push. No terminal, account or credentials
are needed.

## Record a real session (Windows, MT5 running)

`record_mt5.py` only **reads** from the terminal; it never sends orders.

```powershell
$env:OJCHART_MT5_PASSWORD = '<password>'
python tests/provider/record_mt5.py `
  --login 12345678 --server "Broker-Live" `
  --symbols "EURUSD,XAUUSD,USDJPY" `
  --timeframes M1,M5,M15,H1,D1 `
  --bars 500 --ticks 5000 --history-days 30 `
  --output tests/provider/fixtures/mt5_session.json
```

Replay it on any machine:

```powershell
$env:MT5_FIXTURE = 'tests/provider/fixtures/mt5_session.json'
npm run check:mt5
```

Account number/holder name are redacted by default and local paths are
dropped, so a fixture is safe to commit. Use `--include-account` /
`--include-paths` only for a private fixture.

## Fixture schema

The schema is documented at the top of `tests/provider/mt5_fake.py`. Keys:

| Key | Meaning |
|---|---|
| `now` | clock used to synthesize missing data |
| `account`, `terminal` | `account_info()` / `terminal_info()` snapshots |
| `symbols` | symbol specs (`digits`, `point`, contract, volume, filling mask…) |
| `bars` | `{symbol: {timeframe: [[t,o,h,l,c,v], …]}}` (optional) |
| `ticks` | `{symbol: [[t,bid,ask,last,vol], …]}` (optional) |
| `positions`, `orders`, `deals` | live tables replayed by `*_get()` |
| `quote_age` | per-symbol quote age (drives the market-closed gate) |
| `order_fail` | queue of `order_send` retcodes (e.g. `10030` fill retry) |
| `order_none` | make N `order_send()` calls return `None` (hard API error) |

When `bars`/`ticks` are omitted the fake synthesizes deterministic series
(5 000 bars per requested native timeframe, one tick per second), so even an
empty scenario produces realistic candles.

## What is covered

- native bars + older-page pagination (`to` exclusive)
- `fetch_range` window boundaries
- app-built timeframes (`M45` from `M15`) and seconds timeframes from ticks
- bid-based ticks, offset hand-off, stale/frozen quote gate
- case-insensitive symbol search and `symbol_select` reveal
- account/spec/state/positions/orders shapes
- market and pending orders, modify/cancel, partial/full close, close-all,
  SL/TP, history backfill + summary
- invalid requests, `INVALID_FILL` retry and AutoTrading error text
- `servers.dat` harvest/tree parse and gateway fallback
- offset quantization/snap
- chart-cache tail served twice from disk
- optional replay of a recorded real fixture (`MT5_FIXTURE`)

## Adding a test for a bug report

1. Capture the broker payload with `record_mt5.py` (or add the relevant keys
   to a scenario in `test_mt5_provider.py`).
2. Add a `test_...` method that drives the public surface (`trade_rpc`,
   `get_bars`, `next_tick`, `fetch_range`).
3. Run `npm run check:mt5`; the regression now fails without a terminal.
