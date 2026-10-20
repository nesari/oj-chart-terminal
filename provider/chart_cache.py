"""Chart data cache (ROUND 95) — persistent per-chart bar store for providers.

WHAT
----
Every chart the user opens loads its bars through bars_req. Before this
module the provider asked the MT5 terminal for the FULL window again on every
chart open / TF switch / reconnect / older-page / Pine prefetch, so the same
history crossed the wire (and sometimes the broker archive) over and over.

This module keeps ONE compact binary file per (broker server, symbol,
timeframe) on disk and serves every repeated request from it:

- First open of a chart  -> raw fetch (unchanged behaviour), bars stored.
- Every later open       -> ONLY the delta ("tail") since the last cached bar
  is fetched from the terminal; everything older comes from the cache.
- "Load older bars" / Go-to-Date windows that the cache already covers are
  answered from disk with ZERO terminal calls.
- The cache survives app restarts (files under the user's data dir).
- A chart that is not opened for 30 days is deleted by the sweep; reopening
  it within the window just updates it with the new bars.

STORAGE FORMAT (48 bytes per bar + zlib-1 compression)
------------------------------------------------------
    magic 'MT5CDC\x00\x01' | u32 header_len | header JSON | u32 payload_len
    | zlib( little-endian records '<qddddq' )  time,open,high,low,close,volume

25k bars ~= 1.2 MB raw ~= a few hundred KB on disk. Writes are atomic
(temp file + os.replace); a corrupt/truncated file is deleted and rebuilt
from the raw path automatically, so a cache bug can never poison a chart.

CORRECTNESS RULES (data integrity comes before hit rate)
--------------------------------------------------------
1. Every range fetch is BUCKET-ALIGNED and the whole forming bucket is
   rebuilt on every tail serve, then REPLACED over the cached copy — a bar
   that was still forming when cached (or slightly revised history) is
   healed on the next open instead of being frozen wrong forever.
2. An entry is always ONE contiguous broker-backed span [oldest..newest]:
   head extensions fetch windows that END at the current oldest bar, tail
   merges fetch windows that START at the last cached bucket. No internal
   holes are ever created by construction.
3. If the gap since the last cached bar exceeds what the raw source can
   reliably serve (tick timeframes: their max tick span; native bars: 200k
   bars), the entry restarts from the fresh tail instead of guessing.
4. Every serve is wrapped: on ANY internal error the request falls back to
   the untouched raw path, so the cache can only make things faster, never
   wrong-or-empty. The demo provider does not use this module at all.

RELATIONSHIP WITH THE METATRADER TERMINAL'S OWN CACHE
-----------------------------------------------------
The terminal already stores the history it downloaded for its own charts
under <terminal data path>\\bases\\<server>\\history\\*.hcc. The MetaTrader5
python API serves copy_rates_* FROM that store, so as long as this app only
requests the MISSING delta (rule above), history that the terminal already
has is served from the terminal's local disk — the same data is never
downloaded twice (broker->terminal once, terminal->app once, then deltas
only). The .hcc files are intentionally NOT parsed directly: the format is
undocumented and version-dependent; a mis-parse would print silently wrong
prices on a trading chart. Detection of the terminal history folder is
exposed via MT5Broker.mt5_history_dir() for diagnostics only.

CONFIG (optional env vars)
--------------------------
    MT5CHART_CACHE=0            disable the feature (default on)
    MT5CHART_CACHE_DIR=...      override the storage root
    MT5CHART_CACHE_TTL_DAYS=N   unused-chart TTL, default 30
    MT5CHART_CACHE_MAX_MB=N     total size cap with LRU sweep, default 2048
"""

import os
import json
import time
import struct
import zlib
import traceback
import datetime as dt
from collections import OrderedDict

from provider_common import TF_SEC, bucket_start

MAGIC = b'MT5CDC\x00\x01'
REC = struct.Struct('<qddddq')          # time, open, high, low, close, volume
U32 = struct.Struct('<I')

DAY = 86400
MAX_BARS_REQ = 25000                    # wire parity with mt5.py
BACKFILL_CAP_BARS = 200000              # max bars fetched in one gap backfill
ENTRY_CAP_BARS = 200000                 # max bars kept per (symbol, tf) entry
HOT_BARS_BUDGET = 400000                # hot in-memory bars across all entries
SWEEP_EVERY = 3600                      # seconds between sweeps (in-serve)
FLUSH_TOUCH_EVERY = 3600                # persist last_open at most hourly
DEFAULT_TTL_DAYS = 30
DEFAULT_SIZE_CAP_MB = 2048
_MAX_SLICES = 480                       # tick backfill slice cap per request


def _env_int(name, default):
    try:
        v = int(os.environ.get(name, '') or default)
        return v if v > 0 else default
    except Exception:
        return default


def _slug(s):
    out = []
    for ch in str(s or ''):
        out.append(ch if (ch.isalnum() and ch.isascii()) or ch in '._-' else '_')
    s = ''.join(out).strip('._-')
    return (s or 'default')[:80]


def cache_root():
    """Stable per-user storage root (Windows-first, like the app itself)."""
    env = os.environ.get('MT5CHART_CACHE_DIR')
    if env:
        return env
    if os.name == 'nt':
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
        return os.path.join(base, 'MT5ChartTerminal', 'chart-cache')
    return os.path.join(os.path.expanduser('~'), '.mt5chartterminal', 'chart-cache')


def pack_bars(bars):
    """bars (list of dicts) -> zlib-compressed record blob."""
    raw = b''.join(REC.pack(int(b['time']), float(b['open']), float(b['high']),
                            float(b['low']), float(b['close']),
                            int(b.get('volume') or 0)) for b in bars)
    return zlib.compress(raw, 1)


def unpack_bars(blob):
    raw = zlib.decompress(blob)
    n = len(raw) // REC.size
    out = []
    for i in range(n):
        t, o, h, l, c, v = REC.unpack_from(raw, i * REC.size)
        out.append({'time': t, 'open': o, 'high': h, 'low': l, 'close': c, 'volume': v})
    return out


def dedupe_sort(bars):
    """Sort by open time; on duplicate time the LAST write wins (the fresh
    value from a rebuild always replaces the cached one)."""
    if not bars:
        return []
    bars.sort(key=lambda b: b['time'])
    out = [bars[0]]
    for b in bars[1:]:
        if b['time'] == out[-1]['time']:
            out[-1] = b
        else:
            out.append(b)
    return out


class ChartCache:
    """The engine. All calls happen on the provider's single-thread data
    executor (see provider_common.Broker._run_data), so no locking needed."""

    def __init__(self, root=None, agg_tf=None, tick_span=None):
        self.enabled = os.environ.get('MT5CHART_CACHE', '1') != '0'
        self.root = root or cache_root()
        self.agg_tf = dict(agg_tf or {})
        self.tick_span = dict(tick_span or {})
        self.ttl = _env_int('MT5CHART_CACHE_TTL_DAYS', DEFAULT_TTL_DAYS) * DAY
        self.size_cap = _env_int('MT5CHART_CACHE_MAX_MB', DEFAULT_SIZE_CAP_MB) * 1024 * 1024
        self._hot = OrderedDict()       # key -> {'bars': [...], 'hdr': {...}, 'dirty': bool}
        self._hot_bars = 0
        self._last_sweep = 0.0

    # ---------------- keys / files ----------------

    def _server_dir(self, srv):
        return os.path.join(self.root, _slug(srv))

    def _file(self, key):
        srv, sym, tf = key
        return os.path.join(self._server_dir(srv), _slug(sym) + '_' + _slug(tf) + '.cdc')

    @staticmethod
    def _key(broker, sym, tf):
        try:
            srv = broker.cache_server()
        except Exception:
            srv = ''
        return ((srv or 'default'), str(sym), str(tf))

    # ---------------- hot store ----------------

    def _hot_put(self, key, ent):
        if key in self._hot:
            old = self._hot.pop(key)
            self._hot_bars -= len(old['bars'])
        self._hot[key] = ent
        self._hot_bars += len(ent['bars'])
        while self._hot_bars > HOT_BARS_BUDGET and len(self._hot) > 1:
            k, old = self._hot.popitem(last=False)   # LRU
            self._hot_bars -= len(old['bars'])
            if old.get('dirty'):
                try:
                    self._save(k, old, force=True)
                except Exception:
                    traceback.print_exc()

    def _load(self, key):
        ent = self._hot.get(key)
        if ent is not None:
            self._hot.move_to_end(key)
            return ent
        p = self._file(key)
        try:
            with open(p, 'rb') as f:
                blob = f.read()
            if len(blob) < 8 or blob[:8] != MAGIC:
                raise ValueError('bad magic')
            hl = U32.unpack_from(blob, 8)[0]
            hdr = json.loads(blob[12:12 + hl].decode('utf-8'))
            off = 12 + hl
            pl = U32.unpack_from(blob, off)[0]
            bars = unpack_bars(blob[off + 4:off + 4 + pl])
            if hdr.get('v') != 1:
                raise ValueError('bad version')
            ent = {'bars': bars, 'hdr': hdr, 'dirty': False}
        except FileNotFoundError:
            return None
        except Exception:
            try:
                os.unlink(p)
            except Exception:
                pass
            return None
        self._hot_put(key, ent)
        return ent

    def _save(self, key, ent, force=False):
        hdr, bars = ent['hdr'], ent['bars']
        now = time.time()
        if not ent['dirty'] and not force and now - float(hdr.get('last_flush') or 0) < FLUSH_TOUCH_EVERY:
            return
        p = self._file(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        hdr = dict(hdr)
        hdr.update({'n': len(bars),
                    'first': bars[0]['time'] if bars else 0,
                    'last': bars[-1]['time'] if bars else 0,
                    'updated': int(now),
                    'last_flush': now})
        ent['hdr'] = hdr
        hj = json.dumps(hdr, separators=(',', ':')).encode('utf-8')
        payload = pack_bars(bars)
        tmp = p + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(MAGIC)
            f.write(U32.pack(len(hj)))
            f.write(hj)
            f.write(U32.pack(len(payload)))
            f.write(payload)
        os.replace(tmp, p)
        ent['dirty'] = False

    # ---------------- sweep (30-day TTL + size cap) ----------------

    def _read_hdr(self, p):
        with open(p, 'rb') as f:
            head = f.read(12)
            if len(head) < 12 or head[:8] != MAGIC:
                raise ValueError('bad magic')
            hl = U32.unpack_from(head, 8)[0]
            return json.loads(f.read(hl).decode('utf-8'))

    def sweep(self):
        """Delete entries not opened within the TTL, then enforce the size
        cap LRU-side. Header-only reads: a few hundred files cost a few ms."""
        now = time.time()
        deleted, kept = 0, 0
        files = []   # (last_open, path, size)
        try:
            srvs = os.listdir(self.root) if os.path.isdir(self.root) else []
        except Exception:
            return {'deleted': 0, 'kept': 0, 'bytes': 0}
        for srv in srvs:
            d = os.path.join(self.root, srv)
            if not os.path.isdir(d):
                continue
            for fn in os.listdir(d):
                if not fn.endswith('.cdc'):
                    continue
                p = os.path.join(d, fn)
                try:
                    size = os.path.getsize(p)
                    hdr = self._read_hdr(p)
                    lo = float(hdr.get('last_open') or 0)
                    if lo and now - lo > self.ttl:
                        os.unlink(p)
                        deleted += 1
                        continue
                    files.append((lo, p, size))
                    kept += 1
                except FileNotFoundError:
                    pass
                except Exception:
                    try:
                        os.unlink(p)
                        deleted += 1
                    except Exception:
                        pass
        total = sum(s for _, _, s in files)
        if total > self.size_cap and files:
            files.sort(key=lambda x: x[0])
            for lo, p, s in files:
                if total <= self.size_cap:
                    break
                try:
                    os.unlink(p)
                    total -= s
                    deleted += 1
                    kept -= 1
                except Exception:
                    pass
        return {'deleted': deleted, 'kept': kept, 'bytes': total}

    def _maybe_sweep(self):
        now = time.time()
        if now - self._last_sweep < SWEEP_EVERY:
            return
        self._last_sweep = now
        try:
            r = self.sweep()
            if r['deleted']:
                print('[chart-cache] sweep: deleted %d stale entries, kept %d (%.1f MB)'
                      % (r['deleted'], r['kept'], r['bytes'] / 1048576.0), flush=True)
        except Exception:
            traceback.print_exc()

    def bootstrap(self, broker=None):
        """Called once after the provider connects: sweep + info line."""
        self._last_sweep = time.time()
        try:
            r = self.sweep()
            print('[chart-cache] enabled, root=%s, entries=%d, %.1f MB, stale deleted=%d'
                  % (self.root, r['kept'], r['bytes'] / 1048576.0, r['deleted']), flush=True)
        except Exception:
            traceback.print_exc()
        if broker is not None:
            try:
                h = broker.mt5_history_dir()
                if h:
                    print('[chart-cache] MT5 terminal history store: %s (served via copy_rates, no re-download)' % h, flush=True)
            except Exception:
                pass

    # ---------------- policy helpers ----------------

    def _sec(self, tf):
        return TF_SEC.get(tf)

    def span_for(self, tf, count):
        """Window span the raw source needs to confidently return `count`
        bars ending at a given time (same 3x heuristic as mt5.native_bars)."""
        sec = self._sec(tf)
        if tf in self.agg_tf:
            src, mult = self.agg_tf[tf]
            return min(TF_SEC[src] * max(4, count * mult * 3), 40 * 365 * DAY)
        if tf in self.tick_span:
            return self.tick_span[tf]
        return min(sec * max(4, count * 3), 40 * 365 * DAY)

    def _max_backfill(self, tf):
        """Largest gap this entry will backfill from the raw source; beyond
        it the entry restarts from the fresh tail (rule 3)."""
        if tf in self.tick_span:
            return self.tick_span[tf]
        sec = self._sec(tf)
        if tf in self.agg_tf:
            sec = TF_SEC[self.agg_tf[tf][0]]
        return BACKFILL_CAP_BARS * sec

    # ---------------- serve ----------------

    def serve_bars(self, broker, sym, tf, cnt, to=None):
        """The MT5Broker.get_bars front-end. Same wire contract as the raw
        path: list of {time,open,high,low,close,volume} ending at now (to
        None) or strictly before `to`."""
        if not self.enabled:                     # feature off -> raw path
            return broker.raw_bars(sym, tf, cnt, to=to)
        cnt = max(1, min(int(cnt or 0), MAX_BARS_REQ))
        if not sym or tf not in TF_SEC:
            return broker.raw_bars(sym, tf, cnt, to=to)
        key = self._key(broker, sym, tf)
        self._maybe_sweep()
        try:
            if to is None:
                return self._serve_tail(broker, key, sym, tf, cnt)
            to = int(to)
            if to <= 0:
                return broker.raw_bars(sym, tf, cnt, to=to)
            return self._serve_page(broker, key, sym, tf, cnt, to)
        except Exception:
            traceback.print_exc()
            try:
                return broker.raw_bars(sym, tf, cnt, to=to)
            except Exception:
                return []

    # ---- tail request: the last `cnt` bars ending at "now" ----

    def _serve_tail(self, broker, key, sym, tf, cnt):
        now = int(broker.now_epoch() or time.time())
        sec = self._sec(tf)
        ent = self._load(key)
        if ent is None or not ent['bars']:
            bars = dedupe_sort(broker.raw_bars(sym, tf, cnt) or [])
            if not bars:
                return []           # cold terminal: nothing to store yet
            ent = {'bars': bars, 'dirty': True,
                   'hdr': {'v': 1, 'sym': sym, 'tf': tf, 'srv': key[0],
                           'created': int(now), 'last_open': int(now),
                           # NOT inferred from len(bars) < cnt: a terminal
                           # mid-archive-sync returns partial pages and must
                           # be allowed to deepen on a later serve. Dryness
                           # is proven by the extension path instead.
                           'head_done': False, 'last_flush': 0.0}}
            self._hot_put(key, ent)
            try:
                self._save(key, ent, force=True)
            except Exception:
                traceback.print_exc()
            return ent['bars'][-cnt:]

        bars = ent['bars']
        hdr = ent['hdr']
        hdr['last_open'] = int(now)
        last = bars[-1]['time']
        rebuild = bucket_start(tf, last)         # rebuild the WHOLE forming bucket
        new_era = False
        if now - last > self._max_backfill(tf):
            # stale beyond what the source can serve contiguously -> restart
            # the span from the freshest backfillable point (rule 3)
            rebuild = max(rebuild, bucket_start(tf, now - self._max_backfill(tf)))
            new_era = True
        fresh = broker.fetch_range(sym, tf, rebuild, now + 1) or []
        # now+1: the FORMING bucket (open time == bucket_start(now)) must be
        # part of the rebuild — it is the one bar that changes until close
        fresh = dedupe_sort([b for b in fresh if b['time'] >= rebuild])
        if fresh:
            if new_era:
                bars = fresh
                hdr['head_done'] = False
            else:
                bars = [b for b in bars if b['time'] < rebuild] + fresh
            bars = dedupe_sort(bars)
            if len(bars) > ENTRY_CAP_BARS:
                bars = bars[-ENTRY_CAP_BARS:]
                hdr['head_done'] = False
            ent['bars'] = bars
            ent['dirty'] = True
        # deepen towards `cnt` when the cached span is shorter (e.g. the Pine
        # 25k M1 prefetch after a 5k chart load) — one head extension, the
        # 3x window span guarantees enough unless the archive ends there
        if len(bars) < cnt and not hdr.get('head_done'):
            self._extend_head(broker, key, sym, tf, ent, cnt - len(bars))
            bars = ent['bars']
        try:
            self._save(key, ent)
        except Exception:
            traceback.print_exc()
        return bars[-cnt:]

    # ---- paged request: `cnt` bars strictly before `to` ----

    def _serve_page(self, broker, key, sym, tf, cnt, to):
        ent = self._load(key)
        now = int(broker.now_epoch() or time.time())
        if ent is None or not ent['bars']:
            return broker.raw_bars(sym, tf, cnt, to=to) or []
        bars = ent['bars']
        hdr = ent['hdr']
        hdr['last_open'] = int(now)
        if to < bars[0]['time']:
            # No cache coverage for this window (below the oldest cached bar):
            # detached historical request (typical deep Go-to-Date). Answer
            # raw, store nothing — the contiguous-span invariant is worth
            # more than a stray island. (to == floor is served by the head
            # extension below so the "Load older bars" chain keeps working.)
            return broker.raw_bars(sym, tf, cnt, to=to) or []
        below = [b for b in bars if b['time'] < to]
        if len(below) < cnt and not hdr.get('head_done'):
            # extend the span downwards (window ends at the current oldest
            # bar -> contiguity kept); short/dry fetch = archive start
            self._extend_head(broker, key, sym, tf, ent, cnt - len(below))
            bars = ent['bars']
            below = [b for b in bars if b['time'] < to]
        try:
            self._save(key, ent)
        except Exception:
            traceback.print_exc()
        return below[-cnt:]

    def _extend_head(self, broker, key, sym, tf, ent, need):
        """Grow the span downwards until `need` more bars are present or the
        broker archive runs dry. Every window ENDS at the current oldest bar
        (bucket-aligned) and copy-style range responses are complete for
        their window, so the entry stays an exact broker bar sequence.

        head_done is set ONLY when a whole window comes back EMPTY: a
        weekend-heavy window still returns the Friday/Monday edges, and the
        next window from the new floor reaches deeper. Marking dryness on a
        short page here would permanently kill the older-bars chain after a
        single weekend inside the window — worse than the raw path, where
        the next session simply retries."""
        need = max(1, min(need, ENTRY_CAP_BARS))
        hdr = ent['hdr']
        total = 0
        for _ in range(48):                     # bounded archive crawl
            head = ent['bars'][0]['time']
            end = bucket_start(tf, head)        # aligned; the head bar excluded
            # span floor: the window must CROSS a weekend (and, on monthly
            # bars, a whole month) even when almost nothing is missing — a
            # micro-window can sit entirely inside a closed stretch
            span = max(self.span_for(tf, need - total + 64),
                       6 * DAY, TF_SEC[tf] * 2)
            span = min(span, 40 * 365 * DAY)
            frm = end - span
            try:
                fetched = broker.fetch_range(sym, tf, frm, end) or []
            except Exception:
                traceback.print_exc()
                fetched = []
            fetched = dedupe_sort([b for b in fetched if b['time'] < end])
            if not fetched:
                # one widened retry before declaring dryness: the empty
                # window may still be a long market halt (holiday week),
                # not the archive start
                wide = min(max(span * 3, TF_SEC[tf] * 4, 30 * DAY), 40 * 365 * DAY)
                try:
                    fetched = broker.fetch_range(sym, tf, end - wide, end) or []
                except Exception:
                    traceback.print_exc()
                    fetched = []
                fetched = dedupe_sort([b for b in fetched if b['time'] < end])
                if not fetched:
                    hdr['head_done'] = True
                    break
            ent['bars'] = dedupe_sort(fetched + ent['bars'])
            if len(ent['bars']) > ENTRY_CAP_BARS:
                ent['bars'] = ent['bars'][-ENTRY_CAP_BARS:]
            ent['dirty'] = True
            total += len(fetched)
            if total >= need:
                break

    # ---------------- diagnostics ----------------

    def info(self):
        return {'enabled': self.enabled, 'root': self.root,
                'hot_entries': len(self._hot), 'hot_bars': self._hot_bars}
