#!/usr/bin/env python3
"""ROUND145 — provider backfill vs Windows pre-1970 datetimes.

The user log showed chart_cache._extend_head tracebacks ending in
  OSError: [Errno 22] Invalid argument
right after MN12/MN3 loads. Root cause: 40-year crawl windows push `frm`
before 1970 and Windows datetime.fromtimestamp() raises EINVAL there
(Linux tolerates negatives — why dev never saw it). fetch_range must
clamp + never throw.

Run: py -3 scripts/test_round145_provider_backfill.py
"""
import datetime as dt
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'provider'))

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

PASS, FAIL = 0, []
def check(name, cond, extra=''):
    global PASS
    print(('  \u2713 ' if cond else '  \u2717 ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
    if cond:
        PASS += 1
    else:
        FAIL.append(name)

import mt5 as M

# --- the platform hazard itself (documents WHY the guard exists) ---
NEG = 1199145600 - 1261440000  # MN12 _extend_head window off a 2008 head
try:
    dt.datetime.fromtimestamp(NEG, tz=dt.timezone.utc)
    print('  (platform tolerates pre-1970 stamps; guard still required for Windows)')
except OSError:
    print('  (platform raises OSError EINVAL for pre-1970 stamps — the user crash)')

calls = []
class Dummy:  # TF_MAP path needs no instance state; AGG recursion re-enters
    def fetch_range(self, *a, **k):
        return M.MT5Broker.fetch_range(self, *a, **k)

real_ensure = M.ensure_symbol
M.ensure_symbol = lambda s: (s, object())
real_crr = M.mt5.copy_rates_range
def fake_crr(sym, tf, frm_dt, to_dt):
    calls.append((frm_dt, to_dt))
    return []
M.mt5.copy_rates_range = fake_crr
try:
    r = M.MT5Broker.fetch_range(Dummy(), 'XAUUSD', 'MN12', NEG, 1199145600)
    check('pre-1970 MN12 window returns [] without raising', r == [], repr(r)[:80])
    bad = [c for c in calls if c[0].year < 1970 or c[1].year < 1970]
    check('no pre-1970 datetime ever reaches copy_rates_range', not bad, bad[:1])
    calls.clear()
    r = M.MT5Broker.fetch_range(Dummy(), 'XAUUSD', 'H1', 1790600000, 1790603600)
    check('normal window still forwarded', len(calls) == 1 and r == [], calls)
    r = M.MT5Broker.fetch_range(Dummy(), 'XAUUSD', 'H1', 100, 50)
    check('inverted window returns []', r == [])
    r = M.MT5Broker.fetch_range(Dummy(), 'XAUUSD', 'H1', -100, -50)
    check('fully pre-1970 window returns []', r == [])
finally:
    M.ensure_symbol = real_ensure
    M.mt5.copy_rates_range = real_crr

print('ROUND145-provider: %d failed' % len(FAIL) if FAIL else 'ROUND145-provider: all green (%d passed)' % PASS)
sys.exit(1 if FAIL else 0)
