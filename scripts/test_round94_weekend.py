#!/usr/bin/env python3
"""ROUND94 — weekend (Sat/Sun/holiday) hang + jump regression tests for mt5.py.

User report: on Saturday/Sunday the chart never opens (stuck on "Loading
data") and the chart + drawing tools keep jumping. Two provider holes:
  A. THROTTLE — a rejected sample never advanced the 30 s timer, so every
     server_now() call ran the full 48-symbol mt5 sweep (per tick, per symbol,
     every 0.2 s) and starved the single mt5 worker thread.
  B. COLD START — a provider started on a weekend accepted its first sample
     unconditionally: friday_bar - now became the offset and was persisted.
"""
import os, sys, json, types, tempfile, time as _time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'provider'))

FAILS = []
def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra != '' else ''))
    if not cond:
        FAILS.append(name)

stub = types.ModuleType('MetaTrader5')
stub.TIMEFRAME_M1 = 1
stub.copy_rates_from_pos = lambda *a, **k: None
stub.symbols_get = lambda: None
sys.modules['MetaTrader5'] = stub
tmp = tempfile.mkdtemp(); os.environ['TEMP'] = tmp; os.environ['TMP'] = tmp
import mt5 as M

NOW = (int(_time.time()) // 60) * 60
calls = {'n': 0}
class R:
    def __init__(s, t): s.t = t
    def __getitem__(s, k): return s.t
def sampler(fn):
    def f(sym, tf, a, c):
        calls['n'] += 1
        v = fn(sym)
        return [R(v)] if v is not None else None
    M.mt5.copy_rates_from_pos = f
M.mt5.symbols_get = lambda: [type('S', (), {'name': 'SYM%d' % i, 'visible': True})() for i in range(60)]
M.SYM_CACHE['names'] = []; M._visible_symbols(40)

def fresh_life(off=0, file=None, server=''):
    M._SRV_OFF = 0; M._SRV_OFF_AT = 0.0; M._SRV_TRY_AT = 0.0
    M._SRV_ANCHORED = False; M._SRV_PREV = None; M._SRV_NAME = ''; M._SRV_NOPROV = False
    if os.path.exists(M.OFF_FILE): os.remove(M.OFF_FILE)
    if file is not None: json.dump(file, open(M.OFF_FILE, 'w'))
    M._load_off(server)

print('[1] THROTTLE: closed market, 10 000 server_now() calls -> at most ONE sweep per 30 s')
fresh_life(file={'off': 10800})
sampler(lambda s: NOW - 30 * 3600)          # Sunday: Friday tail is 30 h old
calls['n'] = 0
for _ in range(10000): M.server_now()
check('a single sweep (<= 48 mt5 calls) for 10 000 calls', calls['n'] <= 48, calls['n'])
check('estimate untouched', M._SRV_OFF == 10800, M._SRV_OFF)

print('[2] COLD START on Saturday (Friday tail 10 h old, inside the 14 h guard)')
fresh_life(file={'off': 10800})
sampler(lambda s: NOW - 10 * 3600 - 540)
M.server_now()
check('persisted +3h survives the frozen sample', M._SRV_OFF == 10800, M._SRV_OFF)
check('file NOT overwritten with garbage', json.load(open(M.OFF_FILE)).get('off') == 10800)

print('[3] no persisted file + frozen weekend bars: garbage rejected')
fresh_life()
sampler(lambda s: NOW - 10 * 3600 - 540)   # -36540 is not a 15-min multiple
M.server_now()
check('non-plausible first sample rejected (offset stays 0)', M._SRV_OFF == 0, M._SRV_OFF)
check('nothing persisted', not os.path.exists(M.OFF_FILE))

print('[4] a file already poisoned by the old bug is discarded on load')
fresh_life(file={'off': -36540})
check('poisoned value ignored', M._SRV_OFF == 0 and not M._SRV_ANCHORED, M._SRV_OFF)

print('[5] persisted value of ANOTHER broker server is ignored')
fresh_life(file={'off': 7200, 'server': 'BrokerA-Live'}, server='BrokerB-Demo')
check('other broker offset not adopted', M._SRV_OFF == 0 and not M._SRV_ANCHORED, M._SRV_OFF)
fresh_life(file={'off': 7200, 'server': 'BrokerA-Live'}, server='BrokerA-Live')
check('same broker offset adopted + anchored', M._SRV_OFF == 7200 and M._SRV_ANCHORED)

print('[6] weekday FRESH INSTALL: first live sample used immediately, PROVEN 2+ min later')
fresh_life()
live6 = {'t': NOW + 10800}                   # live forming bar, +3h broker
sampler(lambda s: live6['t'])
M.server_now()
check('first live sample accepted provisionally', M._SRV_OFF == 10800, M._SRV_OFF)
check('provisional value NOT persisted yet', not os.path.exists(M.OFF_FILE))
M._SRV_TRY_AT = 0.0                          # 2 device-minutes later the bar advanced too
M._SRV_PREV = (M._SRV_PREV[0] - 120, M._SRV_PREV[1] - 120)
M.server_now()
check('proven live -> anchored + persisted',
      M._SRV_ANCHORED and json.load(open(M.OFF_FILE)).get('off') == 10800)

print('[7] provisional garbage on a weekend cold start is disproved by the next run')
fresh_life()
garbage = NOW - 9 * 3600                     # quantized (-32400) by coincidence
sampler(lambda s: garbage)
M.server_now()
check('coincidentally-plausible first sample taken provisionally', M._SRV_OFF == -32400 - 0 or M._SRV_OFF == garbage - NOW, M._SRV_OFF)
check('...but never persisted / anchored', not M._SRV_ANCHORED and not os.path.exists(M.OFF_FILE))
M._SRV_TRY_AT = 0.0                          # 2 min later the bar has NOT moved -> closed market
M._SRV_PREV = (M._SRV_PREV[0] - 120, M._SRV_PREV[1])
M.server_now()
check('frozen on the next reference run -> provisional garbage dropped (back to 0)', M._SRV_OFF == 0, M._SRV_OFF)
M._SRV_TRY_AT = 0.0; M.server_now()          # 30 s later: must NOT flip back to the garbage
check('no flip-flop back to the garbage guess', M._SRV_OFF == 0, M._SRV_OFF)

print('[8] LIVE PROOF overrides a WRONG anchor (broker DST flipped while the app was closed)')
fresh_life(file={'off': 7200})               # winter value on disk
live = {'t': NOW + 10800}                    # the broker now runs +3h and its bar ADVANCES
sampler(lambda s: live['t'])
M.server_now()                               # run 1: not fresh under +2h, no proof yet
check('run 1: anchor kept (no proof yet)', M._SRV_OFF == 7200, M._SRV_OFF)
# simulate 2 minutes later: device minute +120, bar +120
M._SRV_TRY_AT = 0.0
M._SRV_PREV = (M._SRV_PREV[0] - 120, M._SRV_PREV[1] - 120)
M.server_now()
check('run 2: bar advanced in lockstep -> proven live -> +3h adopted', M._SRV_OFF == 10800, M._SRV_OFF)

print('[9] FROZEN bar never counts as live proof (weekend, 2 runs 5 min apart)')
fresh_life(file={'off': 10800})
sampler(lambda s: NOW - 20 * 3600)
M.server_now()
M._SRV_TRY_AT = 0.0
M._SRV_PREV = (M._SRV_PREV[0] - 300, M._SRV_PREV[1])   # same bar, 5 device minutes earlier
M.server_now()
check('estimate still +3h', M._SRV_OFF == 10800, M._SRV_OFF)

print('[10] a proven-live bar under a good anchor still rebases (regression of R89 #3)')
fresh_life(file={'off': 10800})
sampler(lambda s: NOW + 10800 + 60 if s == 'SYM7' else NOW - 20 * 3600)
M.server_now()
check('run 1 (no proof yet): anchor kept', M._SRV_OFF == 10800, M._SRV_OFF)
M._SRV_TRY_AT = 0.0
M._SRV_PREV = (M._SRV_PREV[0] - 120, M._SRV_PREV[1] - 120)
M.server_now()
check('run 2 (live bar advanced): rebased', abs(M._SRV_OFF - 10860) <= 60, M._SRV_OFF)

print('[11] current_off() never sweeps after the first call')
fresh_life(file={'off': 10800})
sampler(lambda s: NOW - 30 * 3600)
calls['n'] = 0
brk = M.MT5Broker.__new__(M.MT5Broker)
for _ in range(1000): brk.current_off()
check('<= one sweep for 1000 current_off() calls', calls['n'] <= 48, calls['n'])

print('[12] CHASE regression: frozen bar re-sampled every 30 s for 30 h never moves the estimate')
fresh_life(file={'off': 10800})
frozen = NOW + 10800 - 30                     # bar frozen 30 s ago (the moment the market closed)
sampler(lambda s: frozen)
import mt5 as _m
fake = {'t': NOW}
class _FD:
    class datetime:
        @staticmethod
        def now():
            class X:
                def timestamp(_s): return fake['t']
            return X()
real_dt = _m.dt; _m.dt = _FD
for i in range(30 * 120):                     # 30 h in 30 s steps
    fake['t'] = NOW + i * 30
    M.server_now()
_m.dt = real_dt
check('estimate still +3h after 30 simulated closed hours', M._SRV_OFF == 10800, M._SRV_OFF / 3600.0)

print('FAILS:', FAILS)
sys.exit(1 if FAILS else 0)
