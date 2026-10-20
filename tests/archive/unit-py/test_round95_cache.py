"""ROUND95 — chart data cache tests (provider/chart_cache.py).

Runs WITHOUT a terminal: a FakeBroker stands in for MT5Broker and simulates
the raw source semantics (copy_rates windows, forming bars, history start,
weekend gaps, cold terminal, AGG timeframes). Verifies:

  1.  first load stores, second load fetches ONLY the delta
  2.  persistence across provider restart (disk load, delta-only fetch)
  3.  older pages served from cache (zero terminal calls on repeat)
  4.  "Load older bars" chain extension + head_done at the archive start
  5.  30-day TTL sweep deletes unused charts, fresh ones survive
  6.  forming-bar revision is healed by the bucket rebuild (replace rule)
  7.  new-era restart when the gap exceeds the source span (no hole)
  8.  corrupt cache file self-heals via the raw path (cold engine)
  9.  wire shape: sorted, unique, clamped to the requested count
  10. app-built timeframe (M45 from M15) tail merge stays bucket-aligned
  11. disabled cache -> untouched raw path
  12. mt5.py wiring smoke-import (stubbed MetaTrader5)

Run: python tests/unit/test_round95_cache.py
"""
import os, sys, time, shutil, tempfile, types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'provider'))

from provider_common import TF_SEC, bucket_start, aggregate_bars
from chart_cache import ChartCache, MAGIC, pack_bars, unpack_bars

PASS = 0
FAIL = 0


def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  ok  %s' % name)
    else:
        FAIL += 1
        print('FAIL  %s %s' % (name, ('— ' + str(detail)) if detail else ''))


# ---------------------------------------------------------------- fake broker
class FakeBroker:
    """Mimics the raw MT5 path semantics."""

    def __init__(self, now, hist_start, cold_until=0):
        self.now = int(now)              # controllable clock (server time)
        self.hist_start = int(hist_start)  # oldest bar the "broker archive" has
        self.cold_until = cold_until     # raw tail fetches return [] before this
        self.raw_calls = []              # (sym, tf, count, to)
        self.range_calls = []            # (src tf, frm, to) — innermost source
        self.forming_seq = 0             # every call evolves the forming bar
        self.agg_tf = {'M45': ('M15', 3)}

    # -- clock / identity (the hooks MT5Broker provides) --
    def now_epoch(self):
        return self.now

    def cache_server(self):
        return 'TestBroker-Server'

    def mt5_history_dir(self):
        return None

    # -- data generation --
    def _px(self, sym, t, forming=False):
        h = (hash((sym, t // 60)) & 0xFFFFFF) / 0xFFFFFF
        base = {'EURUSD': 1.0850, 'GBPUSD': 1.2700, 'XAUUSD': 2325.0}[sym]
        px = base + (h - 0.5) * base * 0.002 + (t - self.hist_start) * 1e-7
        if forming:
            px += self.forming_seq * 1e-5
        return round(px, 6)

    def _weekend(self, t):
        return time.gmtime(t).tm_wday >= 5  # Sat/Sun (UTC) — broker closed

    def _bars_window(self, sym, tf, frm, to):
        """All broker bars with open time in [frm, to); weekends closed.
        The bucket containing `now` is the FORMING bar: it evolves on every
        call (like a real forming candle)."""
        sec = TF_SEC[tf]
        forming_t = bucket_start(tf, self.now)
        out = []
        t = bucket_start(tf, frm)
        while t < to:
            if not self._weekend(t):
                forming = (t == forming_t)
                px = self._px(sym, t, forming=forming)
                o = px
                c = round(px * (1 + ((t % 37) - 18) * 2e-6), 6)
                h = max(o, c) + 2e-5
                l = min(o, c) - 2e-5
                out.append({'time': t, 'open': o, 'high': h, 'low': l,
                            'close': c, 'volume': int(300 + (t // sec) % 4700)})
            t += sec
        return out

    def _resolve_tf(self, tf):
        """AGG tf -> source tf (records the innermost source call), like
        MT5Broker.fetch_range."""
        src = tf
        while src in self.agg_tf:
            src, _ = self.agg_tf[src]
        return src

    # -- the raw path (pre-cache behaviour) --
    def raw_bars(self, sym, tf, count, to=None):
        self.forming_seq += 1
        self.raw_calls.append((sym, tf, count, to))
        if self.now < self.cold_until:
            return []
        if to is not None:
            bars = self._bars_window(sym, tf, max(self.hist_start, to - TF_SEC[tf] * max(4, count * 3)), to)
            return bars[-count:]
        bars = self._bars_window(sym, tf, self.hist_start, self.now + 1)
        return bars[-count:]

    # -- the exact-window path the cache drives --
    def fetch_range(self, sym, tf, frm, to):
        self.forming_seq += 1
        frm, to = int(frm), int(to)
        if to <= frm:
            return []
        frm = max(frm, self.hist_start)     # a terminal has nothing older
        if to <= frm:
            return []
        src = self._resolve_tf(tf)
        self.range_calls.append((src, frm, to))
        bars = self._bars_window(sym, src, frm, to)
        if src != tf:
            bars = aggregate_bars(bars, tf, 25000)
        return bars


def new_cache(root):
    return ChartCache(root=root,
                      agg_tf={'M45': ('M15', 3)},
                      tick_span={'S1': 3600 * 3, 'S30': 86400 * 7})


def entry_file(root, sym, tf, srv='TestBroker-Server'):
    from chart_cache import _slug
    return os.path.join(root, _slug(srv), '%s_%s.cdc' % (_slug(sym), _slug(tf)))


# T0 = an open-market instant (weekday, >=03:00 so intraday lookbacks stay
# inside the session) anchored near REAL time so the sweep's time.time()
# comparison treats test entries as fresh.
T0 = int(time.time())
T0 -= T0 % 3600                       # whole hour
while time.gmtime(T0).tm_wday >= 5 or time.gmtime(T0).tm_hour < 3:
    T0 += 3600                        # walk off the weekend / early morning
HIST_START = T0 - 40 * 86400          # the "broker archive" starts 40 days back


def main():
    tmp = tempfile.mkdtemp(prefix='cdc95-')
    try:
        # ---- 1) first load stores; second load = delta only ----
        root1 = os.path.join(tmp, 'r1')
        b = FakeBroker(T0, HIST_START)
        c = new_cache(root1)
        bars1 = c.serve_bars(b, 'EURUSD', 'M1', 500)
        check('1a first load returns 500 bars', len(bars1) == 500, len(bars1))
        check('1b first load did one raw fetch', len(b.raw_calls) == 1, b.raw_calls)
        n_ranges = len(b.range_calls)
        b.now = T0 + 3600  # one hour later, chart reopened
        bars2 = c.serve_bars(b, 'EURUSD', 'M1', 500)
        check('1c reopen ends at the forming bucket',
              bars2[-1]['time'] == bucket_start('M1', b.now), bars2[-1]['time'])
        check('1d reopen did NOT re-fetch raw', len(b.raw_calls) == 1, b.raw_calls)
        new_ranges = b.range_calls[n_ranges:]
        width = max((r[2] - r[1]) for r in new_ranges) if new_ranges else 10 ** 9
        check('1e delta window is tiny (~1h, not 500 bars ~8h)', 0 < width <= 5400, width)
        ent = c._load(('TestBroker-Server', 'EURUSD', 'M1'))
        check('1f cache grew internally (500 -> 500+60)', len(ent['bars']) >= 560, len(ent['bars']))

        # ---- 2) persistence across restart (fresh engine, same disk) ----
        root2 = os.path.join(tmp, 'r2')
        b = FakeBroker(T0, HIST_START)
        c1 = new_cache(root2)
        c1.serve_bars(b, 'EURUSD', 'M1', 500)
        c2 = new_cache(root2)  # simulates app restart
        b.raw_calls.clear()
        b.range_calls.clear()
        b.now = T0 + 600
        bars = c2.serve_bars(b, 'EURUSD', 'M1', 500)
        check('2a restart serves from disk with delta fetch only',
              len(bars) >= 500 and len(b.raw_calls) == 0 and 1 <= len(b.range_calls) <= 2,
              (len(b.raw_calls), b.range_calls))
        check('2b last bar continuous at new now', bars[-1]['time'] == bucket_start('M1', b.now))
        check('2c history still deep (no gap)', bars[0]['time'] < T0 - 300 * 60, bars[0]['time'])

        # ---- 3) older pages: cache hit, zero terminal calls on repeat ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r3'))
        c.serve_bars(b, 'EURUSD', 'M1', 500)
        head = c._load(('TestBroker-Server', 'EURUSD', 'M1'))['bars'][0]['time']
        b.range_calls.clear()
        page1 = c.serve_bars(b, 'EURUSD', 'M1', 1000, to=head)
        fetched_once = len(b.range_calls)
        check('3a older page returned 1000 bars', len(page1) == 1000, len(page1))
        check('3b page bars strictly before `to`', all(p['time'] < head for p in page1))
        b.range_calls.clear()
        page2 = c.serve_bars(b, 'EURUSD', 'M1', 1000, to=head)
        check('3c repeat page = pure cache hit (no fetch)', len(b.range_calls) == 0, b.range_calls)
        check('3d repeat page identical', page1 == page2)
        check('3e exactly one head fetch was made for the first page', fetched_once == 1, fetched_once)

        # ---- 4) "Load older bars" chain: extensions then head_done ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r4'))
        c.serve_bars(b, 'EURUSD', 'M1', 300)
        to = c._load(('TestBroker-Server', 'EURUSD', 'M1'))['bars'][0]['time']
        first_page = c.serve_bars(b, 'EURUSD', 'M1', 1000, to=to)
        check('4a first older page is full and adjacent', len(first_page) == 1000
              and first_page[-1]['time'] < to, (len(first_page), to))
        to = first_page[0]['time']
        pages, reached_start = 1, False
        for _ in range(60):
            p = c.serve_bars(b, 'EURUSD', 'M1', 1000, to=to)
            if not p:
                reached_start = True
                break
            check_ok = all(p[i]['time'] < p[i + 1]['time'] for i in range(len(p) - 1))
            if not check_ok:
                break
            to = p[0]['time']
            pages += 1
            if len(p) < 1000:
                reached_start = True
                break
        ent = c._load(('TestBroker-Server', 'EURUSD', 'M1'))
        check('4b chain reaches the archive start (short page)', reached_start, pages)
        check('4c head_done set after the archive ran dry', ent['hdr'].get('head_done') is True, ent['hdr'])
        check('4d deepest bar == archive start', ent['bars'][0]['time'] >= HIST_START
              and ent['bars'][0]['time'] < HIST_START + 3600, ent['bars'][0]['time'])
        b.range_calls.clear()
        p = c.serve_bars(b, 'EURUSD', 'M1', 1000, to=to)
        check('4e no terminal calls once dry', len(b.range_calls) == 0 and p == [], (b.range_calls, len(p)))

        # ---- 5) TTL sweep: 31 days unused -> deleted; 10 days -> kept ----
        root5 = os.path.join(tmp, 'r5')
        b = FakeBroker(T0, HIST_START)
        c = new_cache(root5)
        c.serve_bars(b, 'EURUSD', 'M1', 200)
        c.serve_bars(b, 'GBPUSD', 'H1', 200)
        f_eu = entry_file(root5, 'EURUSD', 'M1')
        f_gu = entry_file(root5, 'GBPUSD', 'H1')
        check('5a files exist on disk', os.path.exists(f_eu) and os.path.exists(f_gu))
        ent = c._load(('TestBroker-Server', 'EURUSD', 'M1'))
        ent['hdr']['last_open'] = int(time.time()) - 31 * 86400
        c._save(('TestBroker-Server', 'EURUSD', 'M1'), ent, force=True)
        ent = c._load(('TestBroker-Server', 'GBPUSD', 'H1'))
        ent['hdr']['last_open'] = int(time.time()) - 10 * 86400
        c._save(('TestBroker-Server', 'GBPUSD', 'H1'), ent, force=True)
        r = c.sweep()
        check('5b 31-day-old entry deleted', not os.path.exists(f_eu) and r['deleted'] == 1, r)
        check('5c 10-day-old entry survives', os.path.exists(f_gu) and r['kept'] == 1, r)

        # ---- 6) forming-bar revision healed by bucket rebuild ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r6'))
        bars1 = c.serve_bars(b, 'EURUSD', 'M1', 200)
        last_t = bars1[-1]['time']
        c1_close = bars1[-1]['close']
        b.now += 30  # still inside the same M1 bucket
        bars2 = c.serve_bars(b, 'EURUSD', 'M1', 200)
        fresh_px = b._px('EURUSD', last_t, forming=True)
        fresh_close = round(fresh_px * (1 + ((last_t % 37) - 18) * 2e-6), 6)
        check('6a same forming bucket rebuilt', bars2[-1]['time'] == last_t)
        check('6b forming close replaced by the fresh value',
              bars2[-1]['close'] == fresh_close and fresh_close != c1_close,
              (c1_close, bars2[-1]['close'], fresh_close))
        times = [x['time'] for x in bars2]
        check('6c no duplicate bucket after replace', len(times) == len(set(times)))

        # ---- 7) new-era restart when the gap exceeds the source span ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r7'))
        c.serve_bars(b, 'EURUSD', 'S1', 3000)
        b.now = T0 + 3600 * 6  # 6h gap > S1 max tick span (3h)
        bars = c.serve_bars(b, 'EURUSD', 'S1', 3000)
        first_allowed = bucket_start('S1', b.now - 3600 * 3)
        check('7a new era starts inside the backfillable span',
              bars and bars[0]['time'] >= first_allowed, (len(bars), bars[0]['time'] if bars else None))
        check('7b new era bars end at the forming bucket',
              bars[-1]['time'] == bucket_start('S1', b.now))
        gaps = [(bars[i + 1]['time'] - bars[i]['time']) for i in range(len(bars) - 1)]
        check('7c no gap beyond the tick span inside the era',
              all(g <= 3600 * 3 + 60 for g in gaps), max(gaps) if gaps else 0)
        ent = c._load(('TestBroker-Server', 'EURUSD', 'S1'))
        times = [x['time'] for x in ent['bars']]
        check('7d stored span stays contiguous (unique, sorted)',
              times == sorted(set(times)))

        # ---- 8) corrupt file self-heals (cold engine reads the disk) ----
        root8 = os.path.join(tmp, 'r8')
        b = FakeBroker(T0, HIST_START)
        c = new_cache(root8)
        c.serve_bars(b, 'EURUSD', 'M1', 200)
        with open(entry_file(root8, 'EURUSD', 'M1'), 'wb') as f:
            f.write(b'GARBAGE-NOT-A-CACHE-FILE')
        c2 = new_cache(root8)  # fresh engine -> must read the corrupt file
        b.raw_calls.clear()
        bars = c2.serve_bars(b, 'EURUSD', 'M1', 200)
        check('8a corrupt file -> raw path rebuilds',
              len(b.raw_calls) >= 1 and len(bars) >= 200, (len(b.raw_calls), len(bars)))
        with open(entry_file(root8, 'EURUSD', 'M1'), 'rb') as f:
            check('8b file valid again', f.read(8) == MAGIC)

        # ---- 9) wire shape ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r9'))
        bars = c.serve_bars(b, 'EURUSD', 'M1', 500)
        bars = c.serve_bars(b, 'EURUSD', 'M1', 500)  # merge pass too
        times = [x['time'] for x in bars]
        check('9a strictly increasing unique times', all(times[i] < times[i + 1] for i in range(len(times) - 1)))
        check('9b count clamp to requested', len(c.serve_bars(b, 'EURUSD', 'M1', 300)) == 300)
        check('9c keys exact', set(bars[0].keys()) == {'time', 'open', 'high', 'low', 'close', 'volume'})
        check('9d roundtrip pack/unpack', unpack_bars(pack_bars(bars[:10])) == bars[:10])

        # ---- 10) app-built timeframe M45 (from M15) ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r10'))
        bars1 = c.serve_bars(b, 'XAUUSD', 'M45', 400)
        check('10a M45 initial load buckets aligned', all(x['time'] % 2700 == 0 for x in bars1))
        n_ranges = len(b.range_calls)
        b.now += 3 * 3600
        bars2 = c.serve_bars(b, 'XAUUSD', 'M45', 400)
        newr = b.range_calls[n_ranges:]
        check('10b M45 reopen fetches the M15 source only', newr and all(r[0] == 'M15' for r in newr), newr)
        width = max((r[2] - r[1]) for r in newr) if newr else 10 ** 9
        check('10c M45 delta window ~ the elapsed gap', width <= 3 * 3600 + 2 * 2700, width)
        check('10d M45 result aligned, ends at forming bucket',
              all(x['time'] % 2700 == 0 for x in bars2)
              and bars2[-1]['time'] == bucket_start('M45', b.now))
        ent = c._load(('TestBroker-Server', 'XAUUSD', 'M45'))
        check('10e M45 cache grew internally', len(ent['bars']) > 400, len(ent['bars']))

        # ---- 11) disabled cache -> raw path untouched ----
        b = FakeBroker(T0, HIST_START)
        c = new_cache(os.path.join(tmp, 'r11'))
        c.enabled = False
        bars = c.serve_bars(b, 'EURUSD', 'M1', 250)
        check('11a disabled = one raw call, no cache file',
              len(b.raw_calls) == 1 and len(b.range_calls) == 0
              and not os.path.exists(entry_file(os.path.join(tmp, 'r11'), 'EURUSD', 'M1')))
        check('11b raw result passthrough', len(bars) == 250)

        # ---- 11b) thin archive (terminal mid-sync) deepens later ----
        b = FakeBroker(T0, T0 - 2 * 3600)   # "archive" holds only 2 hours
        c = new_cache(os.path.join(tmp, 'r11b'))
        bars = c.serve_bars(b, 'EURUSD', 'M1', 500)
        check('11b-a thin archive returns what exists', 100 <= len(bars) < 500, len(bars))
        b.hist_start = T0 - 40 * 86400      # terminal finished syncing
        bars2 = c.serve_bars(b, 'EURUSD', 'M1', 500)
        check('11b-b entry deepens after the archive grows', len(bars2) == 500
              and bars2[0]['time'] < T0 - 2 * 3600, (len(bars2), bars2[0]['time']))

        # ---- 12) mt5.py wiring smoke-import (stubbed MetaTrader5) ----
        stub = types.ModuleType('MetaTrader5')

        def _any(*a, **k):
            return None
        stub.__getattr__ = lambda name: (600 + hash(name) % 100) if name.startswith('TIMEFRAME_') else _any
        stub.initialize = _any
        stub.login = _any
        stub.shutdown = _any
        sys.modules['MetaTrader5'] = stub
        try:
            import mt5 as mt5mod  # noqa
            check('12a mt5.py imports with cache wired',
                  hasattr(mt5mod, 'CHART_CACHE') and mt5mod.CHART_CACHE.enabled)
            check('12b MT5Broker.get_bars dispatches through the cache',
                  'serve_bars' in mt5mod.MT5Broker.get_bars.__code__.co_names)
            for hook in ('raw_bars', 'fetch_range', 'now_epoch', 'cache_server', 'mt5_history_dir'):
                check('12c hook %s exists' % hook, hasattr(mt5mod.MT5Broker, hook))
            check('12d connect() bootstraps the cache sweep',
                  'CHART_CACHE' in mt5mod.MT5Broker.connect.__code__.co_names)
        except SystemExit as e:
            check('12a mt5.py imports with cache wired', False, 'SystemExit %s' % e)
        finally:
            sys.modules.pop('MetaTrader5', None)

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\nROUND95 cache tests: %d passed, %d failed' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
