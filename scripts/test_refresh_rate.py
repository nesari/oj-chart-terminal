"""Unit test for the refresh-rate (tick_loop poll interval) setting.
Verifies: default value, clamping to [MIN, MAX], bad-input fallback, and
that it's a Broker instance attribute (so mt5/demo can override it without
touching shared state)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider'))
import provider_common as pc

PASS = FAIL = 0
def check(name, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print('PASS', name, extra)
    else: FAIL += 1; print('FAIL', name, extra)

check('default is 0.2', pc.TICK_INTERVAL_DEFAULT == 0.2)
check('clamp within range unchanged', pc.clamp_tick_interval(0.15) == 0.15)
check('clamp below min -> min', pc.clamp_tick_interval(0.001) == pc.TICK_INTERVAL_MIN)
check('clamp above max -> max', pc.clamp_tick_interval(10) == pc.TICK_INTERVAL_MAX)
check('clamp bad string -> default', pc.clamp_tick_interval('abc') == pc.TICK_INTERVAL_DEFAULT)
check('clamp None -> default', pc.clamp_tick_interval(None) == pc.TICK_INTERVAL_DEFAULT)
check('clamp NaN -> default', pc.clamp_tick_interval(float('nan')) == pc.TICK_INTERVAL_DEFAULT)

b = pc.Broker()
check('Broker default tick_interval', b.tick_interval == pc.TICK_INTERVAL_DEFAULT)
b2 = pc.Broker()
b.tick_interval = 0.05
check('per-instance, not shared class state', b2.tick_interval == pc.TICK_INTERVAL_DEFAULT, str(b2.tick_interval))

print(f'\n==== REFRESH RATE UNIT: {PASS} PASS / {FAIL} FAIL ====')
sys.exit(1 if FAIL else 0)
