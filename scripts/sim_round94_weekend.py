#!/usr/bin/env python3
"""ROUND94 — clock-driven simulation of the broker-offset estimator (mt5.py).

usage: sim_round94_weekend.py [provider_dir]

Runs server_now() every 30 s of SIMULATED time (the same cadence as the real
heal loop) against a broker whose bars are live on weekdays and FROZEN from
Friday 23:59 (server time) until Sunday 23:00 server time.
  A. provider running through the weekend  -> offset must stay +3h
  B. weekday, market live for 3 h          -> offset must stay +3h
  C. Sunday reopen with a DST flip (+2h)   -> adopted within 5 minutes of reopen
Exit code 1 on any failure. Against the round-93 code scenario A ends at -14h
(the estimate chased the frozen Friday bar at real-time speed).
"""
import os, sys, types, tempfile, calendar
provdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'provider')
sys.path.insert(0, provdir)
stub = types.ModuleType('MetaTrader5'); stub.TIMEFRAME_M1 = 1
stub.copy_rates_from_pos = lambda *a, **k: None
stub.symbols_get = lambda: None
sys.modules['MetaTrader5'] = stub
tmp = tempfile.mkdtemp(); os.environ['TEMP'] = tmp; os.environ['TMP'] = tmp
import mt5 as M

class FakeDT:
    cur = 0
    class datetime:
        @staticmethod
        def now():
            class X:
                def timestamp(_s): return FakeDT.cur
            return X()
M.dt = FakeDT
M.mt5.symbols_get = lambda: [type('S', (), {'name': 's%d' % i, 'visible': True})() for i in range(20)]
M.SYM_CACHE['names'] = []; M._visible_symbols(40)
class R:
    def __init__(s, t): s.t = t
    def __getitem__(s, k): return s.t

FAILS = []
def check(name, ok, extra=''):
    print(('  ✓ ' if ok else '  ✗ ') + name + (' — ' + str(extra) if extra != '' else ''))
    if not ok: FAILS.append(name)

def set_state(off, anchored=True, at=0):
    M._SRV_OFF = off; M._SRV_OFF_AT = at; M._SRV_TRY_AT = at
    for n, v in (('_SRV_ANCHORED', anchored), ('_SRV_PREV', None), ('_SRV_NOPROV', False)):
        if hasattr(M, n) or n == '_SRV_ANCHORED': setattr(M, n, v)

def run(t0, t1, bar_of, step=30):
    t = t0
    while t < t1:
        FakeDT.cur = t
        M.server_now()
        t += step
    return t

CLOSE_SRV = calendar.timegm((2026, 9, 18, 23, 59, 0))       # Fri last bar (server label)
REOPEN_SRV = calendar.timegm((2026, 9, 20, 23, 0, 0))       # Sun 23:00 server

def make_bars(true_off, reopen_off=None):
    ro = true_off if reopen_off is None else reopen_off
    def bar(now_utc):
        srv_before = now_utc + true_off
        if srv_before <= CLOSE_SRV + 60:
            return srv_before - srv_before % 60                 # live weekday bar
        srv_after = now_utc + ro
        if srv_after >= REOPEN_SRV:
            return srv_after - srv_after % 60                   # live again after the weekend
        return CLOSE_SRV                                         # frozen Friday tail
    return bar

print('[A] provider running through the weekend (+3h broker)')
bar = make_bars(3 * 3600)
M.mt5.copy_rates_from_pos = lambda s, tf, a, c: [R(bar(FakeDT.cur))]
t0 = CLOSE_SRV - 3 * 3600 - 4 * 3600
set_state(3 * 3600, True, t0)
run(t0, REOPEN_SRV - 3 * 3600 - 600, bar)
check('offset still +3h just before the Sunday reopen', M._SRV_OFF == 3 * 3600, '%+.2fh' % (M._SRV_OFF / 3600.0))

print('[B] weekday, market live for 3 h')
set_state(3 * 3600, True, t0)
run(t0, t0 + 3 * 3600, bar)
check('offset stays +3h on a live market', M._SRV_OFF == 3 * 3600, '%+.2fh' % (M._SRV_OFF / 3600.0))

print('[C] Sunday reopen with a broker DST flip (+3h -> +2h)')
bar2 = make_bars(3 * 3600, reopen_off=2 * 3600)
M.mt5.copy_rates_from_pos = lambda s, tf, a, c: [R(bar2(FakeDT.cur))]
reopen_utc = REOPEN_SRV - 2 * 3600
set_state(3 * 3600, True, reopen_utc - 40 * 3600)
run(reopen_utc - 3600, reopen_utc + 300, bar2)
check('new +2h offset adopted within 5 min of the reopen', M._SRV_OFF == 2 * 3600, '%+.2fh' % (M._SRV_OFF / 3600.0))

print('FAILS:', FAILS)
sys.exit(1 if FAILS else 0)
