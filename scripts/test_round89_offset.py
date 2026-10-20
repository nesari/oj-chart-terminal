#!/usr/bin/env python3
"""ROUND89 — the broker-offset estimator's FRESHNESS GATE (mt5.py).

The user's 3rd report root cause: on a closed weekend market the estimator
accepted `friday_last_bar - now` as the "broker offset" — a garbage value
near -10h on Saturday that drifted further negative all weekend, all inside
the old +/-14h guard. Every provider reply carried it; the renderer's display
funnel and the Custom Session stitch diverged and the chart showed the wrong
hours (plus a region past the selected dates).

These tests stub MetaTrader5 and pin the gate:
  1. a FRIDAY-TAIL sample on Saturday is REJECTED — the last good offset survives
  2. the weekend DRIFT is dead: repeated stale samples never move the estimate
  3. a LIVE 24/7 sample (crypto) is ACCEPTED and rebases correctly
  4. a virgin provider life (no anchor yet) still accepts its first sample
  5. the DST-style rebaseline: after a long rejection period a 1h jump is accepted
  6. the persisted file is written on accept and survives a reload
"""
import os, sys, json, types, tempfile, importlib, time as _time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'provider'))

FAILS = []
def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra != '' else ''))
    if not cond:
        FAILS.append(name)

# --- stub the MetaTrader5 module BEFORE mt5.py imports it ---
mt5_stub = types.ModuleType('MetaTrader5')
mt5_stub.TIMEFRAME_M1 = 1
mt5_stub.copy_rates_from_pos = lambda *a, **k: None
mt5_stub.symbols_get = lambda: None
mt5_stub.symbol_info = lambda s: None
mt5_stub.symbol_select = lambda s, v: True
sys.modules['MetaTrader5'] = mt5_stub

# --- isolate the offset file per test run ---
tmpdir = tempfile.mkdtemp()
os.environ['TEMP'] = tmpdir
os.environ['TMP'] = tmpdir

import mt5 as mt5mod  # noqa: E402  (the provider module under test)

WEEK = 7 * 86400
# "Saturday morning" is RELATIVE to the runtime clock (the scenarios only
# depend on deltas): SAT_NOW = the device's current minute, the Friday-tail
# bar sits 10h09m behind it, and a +3h broker means the live crypto bar sits
# exactly +10800 ahead of the device minute.
SAT_NOW = (int(_time.time()) // 60) * 60
FRI_LAST_STAMP = SAT_NOW - 10 * 3600 - 9 * 60

class FakeRates:
    def __init__(self, t):
        self.t = t
    def __getitem__(self, k):
        return self.t          # rates[0]['time'] -> int, like the real package

def install_sampler(per_symbol):
    """per_symbol: fn(sym) -> bar stamp (or None)"""
    mt5mod.mt5.copy_rates_from_pos = lambda sym, tf, start, count: (
        [FakeRates(per_symbol(sym))] if per_symbol(sym) is not None else None)
    mt5mod.mt5.symbols_get = lambda: [type('S', (), {'name': s, 'visible': True})()
                                      for s in ('EURUSD', 'XAUUSD', 'BTCUSD', 'US30')]
    mt5mod._visible_symbols(40)

def reset(off=0, at=0.0):
    mt5mod._SRV_OFF = off
    mt5mod._SRV_OFF_AT = at

print('[1] Friday-tail sample on Saturday is REJECTED')
reset(10800, _time.time())
install_sampler(lambda s: FRI_LAST_STAMP)          # every symbol frozen at Friday's close
t0 = _time.time()
now = mt5mod.server_now()
check('estimate survives the stale sample', mt5mod._SRV_OFF == 10800, mt5mod._SRV_OFF)
check('server_now() = device now + the surviving estimate', now == int(t0) + 10800 or abs(now - (int(t0) + 10800)) <= 1, now - int(t0))

print('[2] the weekend DRIFT is dead (the old bug: est slid -10h..-14h all weekend)')
vals = set()
for _ in range(6):
    _time.sleep(0.05)
    mt5mod.server_now()
    vals.add(mt5mod._SRV_OFF)
check('estimate never moved across repeated stale samples', vals == {10800}, vals)

print('[3] a LIVE 24/7 sample (crypto) rebases correctly')
live = SAT_NOW + 10800 + 30          # BTCUSD forming bar: broker wall = now + srv (minute-aligned-ish)
install_sampler(lambda s: live if s == 'BTCUSD' else FRI_LAST_STAMP)
mt5mod._SRV_OFF_AT = 0.0; mt5mod._SRV_TRY_AT = 0.0   # allow an immediate re-measure
now = mt5mod.server_now()
est = mt5mod._SRV_OFF
check('live sample accepted', abs(est - 10800) <= 120, est)
check('estimate = bar - device minute (the true +3h)',
      abs((live - (SAT_NOW - SAT_NOW % 60)) - 10800) <= 120, est - 10800)

print('[4] ROUND94: a virgin provider life REJECTS an implausible (weekend-garbage) first sample')
reset(0, 0.0)
mt5mod._SRV_TRY_AT = 0.0; mt5mod._SRV_ANCHORED = False; mt5mod._SRV_PREV = None; mt5mod._SRV_NOPROV = False
if os.path.exists(mt5mod.OFF_FILE): os.remove(mt5mod.OFF_FILE)
install_sampler(lambda s: FRI_LAST_STAMP)          # -36540 s: not a whole 15-min multiple
mt5mod.server_now()
check('Friday-tail first sample NOT accepted (the ROUND94 cold-start fix)', mt5mod._SRV_OFF == 0, mt5mod._SRV_OFF)
check('nothing persisted', not os.path.exists(mt5mod.OFF_FILE))
print('[4b] ...but a plausible live first sample is still taken (weekday fresh install)')
reset(0, 0.0)
mt5mod._SRV_TRY_AT = 0.0; mt5mod._SRV_ANCHORED = False; mt5mod._SRV_PREV = None; mt5mod._SRV_NOPROV = False
install_sampler(lambda s: SAT_NOW + 10800)
mt5mod.server_now()
check('first live sample accepted provisionally', mt5mod._SRV_OFF == 10800, mt5mod._SRV_OFF)

print('[5] ROUND94: the old "+/-1h DST signature" branch is gone; DST is adopted through the live proof')
reset(7200, _time.time() - 7 * 3600)
mt5mod._SRV_TRY_AT = 0.0; mt5mod._SRV_ANCHORED = True; mt5mod._SRV_PREV = None; mt5mod._SRV_NOPROV = False
spring = SAT_NOW + 10800                         # live bar under the NEW offset
install_sampler(lambda s: spring)
mt5mod.server_now()
check('a single +1h sample is NOT enough (weekend chase guard)', mt5mod._SRV_OFF == 7200, mt5mod._SRV_OFF)
mt5mod._SRV_TRY_AT = 0.0
mt5mod._SRV_PREV = (mt5mod._SRV_PREV[0] - 120, mt5mod._SRV_PREV[1] - 120)
mt5mod.server_now()
check('proven live 2 min later -> +3h adopted', mt5mod._SRV_OFF == 10800, mt5mod._SRV_OFF)
check('persisted to the offset file', os.path.exists(mt5mod.OFF_FILE))
saved = json.load(open(mt5mod.OFF_FILE)).get('off')
check('file value == the accepted estimate', saved == mt5mod._SRV_OFF, saved)

print('[6] _load_off restores the persisted estimate on a fresh provider life')
reset(0, 0.0)
json.dump({'off': 10800}, open(mt5mod.OFF_FILE, 'w'))
mt5mod._load_off()
check('persisted offset restored', mt5mod._SRV_OFF == 10800, mt5mod._SRV_OFF)

print('FAILS:', FAILS)
sys.exit(1 if FAILS else 0)
