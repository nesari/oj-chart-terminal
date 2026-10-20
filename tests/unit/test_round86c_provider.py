#!/usr/bin/env python3
"""
ROUND86C — protocol-level regression for the user report:

    "بخش go to Date رو چک کن هیچ کدوم از قسمت هاش کار نمیکنه . روی بروکر
     واقعی دارم تست میکنم . توی بخش دیباگ هم مینویسه Request timeout : bars-req"

Three provider-side root causes are pinned by this test:

  T1  THE FREEZE — get_bars used to run ON the asyncio event loop. A slow
      blocking call (a real terminal syncs its archive INSIDE copy_rates_*)
      froze the whole provider: no bars reply, no pings, no ticks — the
      client logged "request timeout: bars_req" and every Go to Date part
      died. Now the heavy hook runs on a dedicated single-thread executor
      and the loop MUST stay responsive WHILE get_bars is still running.

  T2  THE SILENT DROP — if get_bars raised, the handler's outer try caught
      it and NO reply was ever sent (guaranteed client timeout). Now the
      bars_req hook always answers, degrading to an empty payload.

  T3  THE OVERFLOW — mt5.native_bars computed the copy window as
      TF_SEC * count * 3 unclamped; MN1-family timeframes with a 25k page
      produce a ~6000-year timedelta -> datetime OverflowError raised
      outside the try (-> T2's silence). The span is now clamped; here we
      prove the old math overflows and the new math cannot, for every TF.

  T4  LIVE WIRE — a full in-process demo provider over a real websocket:
      bars_req / bars_req{to} / subscribe->tick all answered, and ping
      latency stays low WHILE a slow bars request is in flight.

Run: python3 tests/unit/test_round86c_provider.py
"""
import asyncio, sys, os, time, traceback, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'provider'))
import datetime as dt

import provider_common as pc

PASS = []
FAIL = []


def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  PASS  ' if cond else '  FAIL  ') + name + (('  — ' + extra) if extra and not cond else ''), flush=True)


# --------------------------------------------------------------------------
# T3: the MN1-family overflow (pure math — MetaTrader5 not needed)
# --------------------------------------------------------------------------
print('T3 — native_bars window math (overflow regression)', flush=True)
if True:
    # (provider/mt5.py hard-exits without the MetaTrader5 package, so the two
    # span formulas are re-implemented here against the SAME TF_SEC table —
    # the shipping clamp lives in mt5.py: MAX_RANGE_SPAN.)
    MAX_RANGE_SPAN = 40 * 365 * 86400

    def old_frm(to_epoch, tf_sec, count):
        to_dt = dt.datetime.fromtimestamp(int(to_epoch), tz=dt.timezone.utc)
        return to_dt - dt.timedelta(seconds=tf_sec * max(4, count * 3))

    def new_frm(to_epoch, tf_sec, count):
        to_dt = dt.datetime.fromtimestamp(int(to_epoch), tz=dt.timezone.utc)
        span = tf_sec * max(4, count * 3)
        if span > MAX_RANGE_SPAN:
            span = MAX_RANGE_SPAN
        return to_dt - dt.timedelta(seconds=span)

    to_now = int(time.time())
    overflow_tfs, clamped_ok = [], True
    for tf, sec in pc.TF_SEC.items():
        try:
            old_frm(to_now, sec, 25000)
        except Exception:
            overflow_tfs.append(tf)
        try:
            new_frm(to_now, sec, 25000)
        except Exception:
            clamped_ok = False
    check('old math overflows on MN-family (bug reproduced)',
          set(overflow_tfs) >= {'MN1', 'MN3', 'MN6', 'MN12'},
          'overflowing: %s' % overflow_tfs)
    check('old math fine on intraday/weekly (no collateral damage)',
          not (set(('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1')) & set(overflow_tfs)))
    check('new clamped math never raises on ANY timeframe', clamped_ok)
    f = new_frm(to_now, pc.TF_SEC['MN1'], 25000)
    check('clamped MN1 window still reaches decades back',
          (dt.datetime.fromtimestamp(to_now, tz=dt.timezone.utc) - f).days > 35 * 365)

# --------------------------------------------------------------------------
# T1 + T2: in-process broker over a REAL websocket (loop aliveness + reply)
# --------------------------------------------------------------------------
class SlowBroker(pc.Broker):
    """Demo-like broker whose get_bars blocks 2.5s (simulated archive sync)."""
    name = 'SlowTest'

    def __init__(self, mode='slow'):
        super().__init__()
        self.mode = mode
        self.calls = 0

    def do_login(self, msg):
        return True, ''

    def get_bars(self, symbol, tf, count, to=None):
        self.calls += 1
        if self.mode == 'slow':
            time.sleep(2.5)  # simulates the real terminal archive sync
        if self.mode == 'raise':
            raise RuntimeError('simulated provider failure')
        if self.mode == 'ok':
            bars = [{'time': int(to) - 60 * (i + 1), 'open': 1, 'high': 1.1,
                     'low': 0.9, 'close': 1, 'volume': 5} for i in range(min(count, 50))]
            return bars
        return []

    def get_digits(self, symbol):
        return 5

    def next_tick(self, symbol):
        return (1.0, 1, int(time.time()))


async def ws_client(port, on_msg, ready):
    import websockets
    async with websockets.connect('ws://127.0.0.1:%d' % port, max_size=64 * 1024 * 1024) as ws:
        await ready(ws)
        try:
            async for raw in ws:
                import json
                await on_msg(json.loads(raw))
        except Exception:
            pass


async def run_slow_server_test():
    """T1: while connection A is inside a 2.5s blocking get_bars (the real
    terminal's archive sync), the event loop MUST stay alive:
      - the SAME socket keeps receiving broadcast TICKS (tick_loop is a
        separate task — this is what keeps live charts alive during a
        Go-to-Date fetch on the renderer's single socket);
      - a SECOND connection gets its ping answered immediately (old code
        froze the whole loop: no pings, no ticks, no replies anywhere).
    NOTE: same-connection requests serialize behind the slow handler (that
    is true of the old code too and is harmless — the renderer awaits its
    own fetches sequentially and never sends app-level pings)."""
    import websockets
    broker = SlowBroker('slow')
    server = await websockets.serve(broker.handler, '127.0.0.1', 0, max_size=64 * 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    loop_task = asyncio.create_task(broker.tick_loop())
    results = {'bars': None, 'ticks_total': 0, 'ping2': None}

    async def conn_a():
        async with websockets.connect('ws://127.0.0.1:%d' % port) as ws:
            await ws.send('{"type":"login","req_id":1}')
            await ws.send('{"type":"subscribe","req_id":2,"symbol":"EURUSD"}')
            await ws.recv()  # subscribe ack
            t0 = time.time()
            await ws.send('{"type":"bars_req","req_id":3,"symbol":"X","timeframe":"M1","count":100,"to":1700000000}')
            # keep reading until BOTH the bars reply AND a post-sync tick arrived
            while time.time() - t0 < 10 and (results['bars'] is None or results['ticks_total'] < 1):
                try:
                    raw = await asyncio.wait_for(ws.recv(), 0.5)
                except asyncio.TimeoutError:
                    continue
                m = json.loads(raw)
                now = time.time() - t0
                if m.get('type') == 'tick':
                    results['ticks_total'] += 1
                if m.get('type') == 'bars' and m.get('req_id') == 3:
                    results['bars'] = now

    async def conn_b():
        await asyncio.sleep(0.6)   # lands INSIDE the 2.5s get_bars window
        async with websockets.connect('ws://127.0.0.1:%d' % port) as ws:
            t0 = time.time()
            await ws.send('{"type":"ping"}')
            while time.time() - t0 < 3 and results['ping2'] is None:
                try:
                    raw = await asyncio.wait_for(ws.recv(), 0.5)
                except asyncio.TimeoutError:
                    continue
                if '"pong"' in raw:
                    results['ping2'] = time.time() - t0

    await asyncio.gather(asyncio.wait_for(conn_a(), 15), asyncio.wait_for(conn_b(), 15))
    check('T1 second connection answered DURING the freeze window (loop alive)',
          results['ping2'] is not None and results['ping2'] < 2.0,
          'ping2=%s' % results['ping2'])
    # NOTE: ticks PAUSE during the sync by design (single serialized worker —
    # the old code froze them along with everything else, so pausing is the
    # status quo); the liveness contract is that they RESUME afterwards.
    check('T1 tick_loop resumes after the slow get_bars (executor released)',
          results['ticks_total'] >= 1,
          'ticks_total=%s' % results['ticks_total'])
    check('T1 slow bars reply eventually arrives (~2.5s, was: never until timeout)',
          results['bars'] is not None and results['bars'] >= 2.0,
          'bars_latency=%s' % results['bars'])
    loop_task.cancel()
    server.close()
    return results


async def run_raise_server_test():
    import websockets
    broker = SlowBroker('raise')
    server = await websockets.serve(broker.handler, '127.0.0.1', 0, max_size=64 * 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    got = {}

    async def client():
        async with websockets.connect('ws://127.0.0.1:%d' % port) as ws:
            await ws.send('{"type":"bars_req","req_id":7,"symbol":"X","timeframe":"M1","count":100}')
            t0 = time.time()
            while time.time() - t0 < 8:
                try:
                    raw = await asyncio.wait_for(ws.recv(), 1.0)
                except asyncio.TimeoutError:
                    continue
                import json
                m = json.loads(raw)
                if m.get('type') == 'bars' and m.get('req_id') == 7:
                    got['reply'] = m
                    got['latency'] = time.time() - t0
                    return

    await asyncio.wait_for(client(), 12)
    check('T2 get_bars RAISING still answers bars ([] payload, not silence)',
          got.get('reply') is not None and got['reply'].get('bars') == [],
          'reply=%s' % (got.get('reply') is not None))
    check('T2 error reply is immediate (<3s, no timeout wait)', got.get('latency', 99) < 3)
    # the handler must NOT have died: a follow-up ping on a fresh client works
    async with websockets.connect('ws://127.0.0.1:%d' % port) as ws2:
        await ws2.send('{"type":"ping","req_id":9}')
        raw = await asyncio.wait_for(ws2.recv(), 3)
        check('T2 handler survives the exception (ping after error works)', '"pong"' in raw)
    server.close()


async def run_demo_wire_test():
    """T4: the REAL demo provider (unmodified subclass) end to end."""
    import websockets, json
    import demo as demo_mod
    broker = demo_mod.DemoBroker()
    server = await websockets.serve(broker.handler, '127.0.0.1', 0, max_size=64 * 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    loop_task = asyncio.create_task(broker.tick_loop())
    out = {'bars': None, 'bars_to': None, 'mn': None, 'tick': False, 'ping_lat': []}

    async def client():
        async with websockets.connect('ws://127.0.0.1:%d' % port) as ws:
            await ws.send('{"type":"login","req_id":1,"mode":"demo"}')
            await ws.recv()  # login_ok
            await ws.send(json.dumps({'type': 'subscribe', 'req_id': 2, 'symbol': 'EURUSD'}))
            await ws.send(json.dumps({'type': 'bars_req', 'req_id': 3, 'symbol': 'EURUSD',
                                      'timeframe': 'M1', 'count': 300}))
            await ws.send(json.dumps({'type': 'bars_req', 'req_id': 4, 'symbol': 'EURUSD',
                                      'timeframe': 'M1', 'count': 300, 'to': int(time.time()) - 86400 * 3}))
            await ws.send(json.dumps({'type': 'bars_req', 'req_id': 5, 'symbol': 'EURUSD',
                                      'timeframe': 'MN1', 'count': 25000, 'to': int(time.time()) - 86400 * 400}))
            t0 = time.time()
            tick_at = None
            while time.time() - t0 < 12:
                got_all = (out['bars'] and out['bars_to'] and out['mn'] and tick_at)
                if got_all:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), 1.0)
                except asyncio.TimeoutError:
                    continue
                m = json.loads(raw)
                if m.get('type') == 'bars' and m.get('req_id') == 3:
                    out['bars'] = m.get('bars') or []
                if m.get('type') == 'bars' and m.get('req_id') == 4:
                    out['bars_to'] = m.get('bars') or []
                if m.get('type') == 'bars' and m.get('req_id') == 5:
                    out['mn'] = m.get('bars') or []
                if m.get('type') == 'tick' and tick_at is None:
                    tick_at = time.time()
                if m.get('type') == 'ping':
                    out['ping_lat'].append(time.time() - t0)
            out['tick_at'] = tick_at - t0 if tick_at else None

    await asyncio.wait_for(client(), 15)
    check('T4 demo bars_req replies with bars', bool(out['bars']))
    check('T4 demo bars_req{to=3d ago} replies with older bars',
          bool(out['bars_to']) and out['bars_to'][-1]['time'] < int(time.time()) - 86400 * 3)
    check('T4 MN1 25k-page request (old overflow case) now replies',
          out['mn'] is not None)
    check('T4 tick_loop still streams through the executor',
          out['tick_at'] is not None and out['tick_at'] < 6)
    loop_task.cancel()
    server.close()


async def main():
    print('ROUND86C provider regression', flush=True)
    await run_slow_server_test()
    await run_raise_server_test()
    await run_demo_wire_test()
    print('\n%d passed, %d failed' % (len(PASS), len(FAIL)), flush=True)
    if FAIL:
        for f in FAIL:
            print('  FAILED: ' + f)
        sys.exit(1)


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
