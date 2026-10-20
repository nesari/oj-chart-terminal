#!/usr/bin/env python3
"""ROUND174 — provider trade RPC never stalls the loop.

The user log showed trade + bars_req timeouts together with the socket
OPEN: trade_rpc ran inline on the event loop, so one hung MT5 terminal
call froze ticks/pings/bars with it. run_trade now executes off-loop
with a 15s budget and ALWAYS answers (error on timeout/raise).

Run: py -3 tests/unit/test_round174_provider_stall.py
"""
import asyncio
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'provider'))

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

PASS, FAIL = 0, []
def check(name, cond, extra=''):
    global PASS
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
    if cond:
        PASS += 1
    else:
        FAIL.append(name)

import provider_common as P

class HangingBroker(P.Broker):
    def trade_rpc(self, msg):
        time.sleep(60)
        return {'ok': True}

class RaisingBroker(P.Broker):
    def trade_rpc(self, msg):
        raise RuntimeError('mt5 down')

class OkBroker(P.Broker):
    def trade_rpc(self, msg):
        return {'ok': True, 'data': {'op': msg.get('op')}}

async def main():
    t0 = time.time()
    r = await HangingBroker().run_trade({'type': 'trade', 'op': 'state'})
    dt = time.time() - t0
    check('hanging hook answers (no 60s stall)', r.get('ok') is False, r)
    check('timeout error names the cause', 'timed out' in str(r.get('error', '')), r.get('error'))
    check('timeout budget respected (<25s)', dt < 25, round(dt, 1))

    r2 = await RaisingBroker().run_trade({'type': 'trade', 'op': 'state'})
    check('raising hook answers error (never silent)', r2.get('ok') is False, r2)

    r3 = await OkBroker().run_trade({'type': 'trade', 'op': 'state'})
    check('ok hook passes through', r3.get('ok') is True and r3.get('data', {}).get('op') == 'state', r3)

asyncio.run(main())
print('ROUND174-provider: %d failed' % len(FAIL) if FAIL else 'ROUND174-provider: all green')
sys.exit(1 if FAIL else 0)
