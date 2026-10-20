#!/usr/bin/env python3
"""Demo provider with a DYNAMIC broker offset: bar stamps are generated at
the FIXED --off (historical facts never move) while current_off() — the value
that rides on every login/bars/tick reply like mt5.py's live estimate — can
be drifted at runtime through /tmp/round89_off.json {"off": N}."""
import sys, os, json, time, random, argparse, threading

sys.path.insert(0, '/home/z/my-project/mt5-terminal/provider')

ap = argparse.ArgumentParser()
ap.add_argument('--off', type=int, default=10800)
ap.add_argument('--port', type=int, default=8777)
ap.add_argument('--tick-interval', type=float, default=1.0)
a = ap.parse_args()

OFF_BOX = {'v': a.off}
CTRL = '/tmp/round89_off.json'

def _ctrl_loop():
    while True:
        try:
            with open(CTRL) as f:
                OFF_BOX['v'] = int(json.load(f).get('off', a.off))
        except Exception:
            pass
        time.sleep(0.25)

threading.Thread(target=_ctrl_loop, daemon=True).start()

import demo
from provider_common import TF_SEC, bucket_start, main


class DynOffDemoBroker(demo.DemoBroker):
    def current_off(self):
        return OFF_BOX['v']

    def get_bars(self, symbol, tf, count, to=None):
        count = max(50, min(count, demo.deep_count_for(tf)))
        bars = demo._slice_history(demo.gen_history(symbol, tf, count, a.off), tf, count, to)
        if to is None and bars:
            sec = TF_SEC[tf]
            end = bucket_start(tf, int(time.time()) + a.off)
            cache = demo.HIST[(symbol, tf, a.off)]
            rng = random.Random((hash((symbol, tf)) & 0xFFFFFFFF) ^ end)
            vol = demo.vol_of(demo.base_price(symbol), sec)
            px = cache[-1]['close']
            while cache and cache[-1]['time'] < end and len(cache) < demo.deep_count_for(tf) + 4096:
                t = cache[-1]['time'] + sec
                o = px
                c = o + rng.gauss(0, 1) * vol
                h = max(o, c) + abs(rng.gauss(0, 1)) * vol * 0.6
                lo = min(o, c) - abs(rng.gauss(0, 1)) * vol * 0.6
                cache.append({'time': t, 'open': round(o, 8), 'high': round(h, 8),
                              'low': round(lo, 8), 'close': round(c, 8), 'volume': int(300 + rng.random() * 4700)})
        return bars


if __name__ == '__main__':
    import provider_common
    provider_common.PORT = a.port
    main(DynOffDemoBroker)
