"""MetaTrader 5 bridge provider. Requires: pip install MetaTrader5 websockets"""
import os, sys, json, time, argparse, asyncio, datetime as dt, socket, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from provider_common import (Broker, TF_SEC, main, aggregate_ticks,
                             aggregate_bars, bucket_start, news_calendar,
                             news_ff)
import chart_cache

# MT5 bar/tick times are in BROKER SERVER time, while datetime.now() is the
# local machine clock. Any gap between the two breaks live-bar continuation
# (ticks land in wrong buckets or get dropped -> charts of the same symbol
# diverge). We estimate server_now = local_now + SRV_OFF from the current
# forming M1 bar open and use it for tick timestamps and tick-range queries.
_SRV_OFF = 0
_SRV_OFF_AT = 0.0      # last time an estimate was ACCEPTED (DST 1h window)
# ROUND94 (weekend hang / jump): three extra pieces of state.
_SRV_TRY_AT = 0.0      # last time the estimator RAN (accepted OR rejected) -> throttle
_SRV_ANCHORED = False  # _SRV_OFF is trustworthy (disk value of THIS broker / confirmed live)
_SRV_PREV = None       # (device_minute, newest_m1) of the previous run -> liveness proof
_SRV_NOPROV = False    # a frozen bar was seen while unanchored: no more provisional guesses
_SRV_NAME = ''         # broker server the persisted offset belongs to
# ROUND71: module-level back-reference to the live MT5Broker instance —
# _newest_forming_m1 reads the SUBSCRIBED symbols from it (see below).
_BROKER = None
# ROUND36 FIX: this cache holds THREE INDEPENDENT slots now. ROUND35 made
# search() read SYM_CACHE['all'] while _visible_symbols() (below) still
# REPLACED the whole dict with {'names': ..., 'at': ...} — dropping the 'all'
# key. _visible_symbols runs from server_now()'s 30s offset refresh (fired by
# every tick / bars answer), so a few seconds after the first live tick every
# search() raised KeyError('all'); the ws handler swallowed it and NEVER
# replied -> the Symbol Search / Watchlist / Compare boxes all showed nothing
# (the user's "search shows nothing at all" report). Separate slots + separate
# timestamps can no longer clobber each other.
SYM_CACHE = {'names': [], 'names_at': 0.0, 'all': [], 'all_at': 0.0, 'vis': set()}
OFF_FILE = os.path.join(os.environ.get('TEMP', os.environ.get('TMP', '/tmp')), 'mt5_srv_off.json')
GUARD = 14 * 3600  # +/- 14h plausibility guard (rejects weekend garbage)
# ROUND58: when the broker-tree gate fails we write a small diagnostics dump
# next to the offset file so a still-failing machine can be fixed WITHOUT
# guessing the layout twice. Pure file side-effect — zero UI impact.
DEBUG_FILE = os.path.join(os.environ.get('TEMP', os.environ.get('TMP', '/tmp')), 'mt5_servers_dat_debug.txt')


def _quantized(v, tol=120):
    """A REAL broker offset is a whole multiple of 15 min (device clock skew
    adds a few seconds). Weekend garbage (friday_bar - now) is an arbitrary
    number of minutes and is rejected by this test ~3 times out of 4."""
    return abs(v - round(v / 900.0) * 900) <= tol


def _snap_off(v):
    """Snap an accepted estimate to the real broker 15-minute clock grid.

    ROUND276 (real-account report: every symbol showed "Market closed" while
    history loaded). `_newest_forming_m1` samples the newest M1 BAR OPEN, and
    the terminal publishes the new minute's forming bar a second or two after
    :00 — so the raw estimate flickers between 7140 and 7200 at every minute
    boundary (reproduced on a live broker). 7140 was even persisted to disk
    and survived restarts (the ±120 s quantizer accepts it), leaving ticks and
    bars stamped 60 s apart. A genuine broker offset is always a whole
    multiple of 15 min, so rounding removes the lag and the jitter."""
    return int(round(float(v) / 900.0) * 900)


def _load_off(server=''):
    """Reload the persisted offset estimate (weekend restarts keep the good value).

    ROUND94: the value is only trusted when it is plausible (whole 15-min
    multiple — files poisoned by the old weekend bug hold values like -36540
    and are discarded) and belongs to the SAME broker server (a different
    broker has a different clock). A trusted value ANCHORS the estimator."""
    global _SRV_OFF, _SRV_ANCHORED, _SRV_NAME
    _SRV_NAME = (server or '').strip()
    try:
        with open(OFF_FILE, 'r') as f:
            d = json.load(f)
        v = int(d.get('off', 0))
        srv = (d.get('server') or '').strip()
        if srv and _SRV_NAME and srv != _SRV_NAME:
            return
        if abs(v) <= GUARD and _quantized(v):
            _SRV_OFF = _snap_off(v)
            _SRV_ANCHORED = True
    except Exception:
        pass


def _save_off():
    try:
        with open(OFF_FILE, 'w') as f:
            json.dump({'off': int(_SRV_OFF), 'server': _SRV_NAME}, f)
    except Exception:
        pass


def server_now():
    """Local epoch adjusted toward broker server time (refreshed every 30s).

    ROUND89 (user report — Custom Session showed the wrong hours on a REAL
    broker over the weekend): the estimator used to accept ANY newest-bar
    delta. On a closed market the newest bar is FRIDAY's last minute, so the
    measured "offset" became friday_bar - now — garbage. FIX: a sample may
    only move the estimate when it is wall-fresh under the CURRENT estimate
    (SUPERSEDED by ROUND94 below — that test turned out to be self-referential).

    ROUND94 (user report — Saturday/Sunday: chart stuck on "Loading data" and
    jumping). Three holes were left in the ROUND89 gate:
      1. THROTTLE: `_SRV_OFF_AT` (the 30 s timer) only advanced on ACCEPT.
         On a closed market samples are rejected, so the timer never advanced
         and EVERY server_now() call (each next_tick per subscribed symbol
         every 0.2 s, each bars reply, current_off) ran the full 48-symbol
         copy_rates sweep. The single mt5 worker thread drowned and bars_req
         queued behind it. The throttle has its own timestamp now
         (`_SRV_TRY_AT`) that advances on EVERY attempt.
      2. CHASE: the "wall-fresh under the current estimate" test rebased onto
         the frozen Friday bar and then stayed "fresh" forever (each 30 s step
         is < 180 s) — the offset slid -1 h per hour to the +/-14 h guard.
         The +/-1 h "DST signature" branch did the same. Now an anchored
         estimate moves ONLY on a PROVEN-LIVE bar (advanced in lockstep with
         the device clock across >= 2 minutes) — a frozen bar never can.
      3. COLD START: a provider started on a weekend took its first sample
         unconditionally, overwrote the good persisted file and carried the
         garbage. The persisted value of THIS broker (and plausible: a whole
         15-min multiple) is an anchor now; an unanchored life takes a
         plausible first sample provisionally (not persisted) until proven."""
    global _SRV_OFF, _SRV_OFF_AT, _SRV_TRY_AT, _SRV_ANCHORED, _SRV_PREV, _SRV_NOPROV
    now = int(dt.datetime.now().timestamp())
    if now - _SRV_TRY_AT >= 30:
        _SRV_TRY_AT = now          # ROUND94: throttle EVERY attempt
        try:
            m1 = _newest_forming_m1()
            if m1:
                nmin = now - now % 60
                est = m1 - nmin
                # ROUND276: the sample is a BAR OPEN and the terminal publishes
                # the forming bar a moment after :00, so the raw value flickers
                # by exactly -60 s at every minute boundary (7140 <-> 7200 on a
                # real broker). Only a 15-min multiple is a real offset — snap
                # the accepted estimate so ticks/bars/chip share one clock.
                if _quantized(est):
                    est = _snap_off(est)
                # liveness proof against the previous reference run, >= 2
                # device minutes apart (with a 1-minute gap a FROZEN bar,
                # delta 0, would sit inside the +/-60 s tolerance). A live bar
                # advances by the same whole minutes as the device clock; a
                # frozen Friday bar does not move at all.
                prev = _SRV_PREV
                live = False
                frozen = False
                if prev is None:
                    _SRV_PREV = (nmin, m1)
                elif nmin - prev[0] >= 120:
                    live = abs((m1 - prev[1]) - (nmin - prev[0])) <= 60
                    frozen = (not live) and m1 == prev[1]
                    _SRV_PREV = (nmin, m1)
                if abs(est) <= GUARD:
                    # ROUND94: ONLY a proven-live bar may move an anchored
                    # estimate. The ROUND89 "wall-fresh under the CURRENT
                    # estimate" test is gone: it was self-referential — right
                    # after Friday's close a frozen bar is < 180 s old, gets
                    # accepted, est is rebased onto the frozen bar so the NEXT
                    # sample (30 s later) is again < 180 s old under the new
                    # est, and so on: the estimate CHASED the frozen bar at
                    # real-time speed (-1 h per hour, -14 h by Sunday — proven
                    # by scripts/sim_round94_weekend.py on the round-93 code).
                    # The old "+/-1h DST signature" branch had the same flaw.
                    # A real DST flip is adopted through the live proof too
                    # (~2-4 min after the market reopens).
                    if live:
                        _SRV_OFF = est
                        _SRV_OFF_AT = now
                        _SRV_ANCHORED = True
                        _save_off()
                    elif not _SRV_ANCHORED and frozen:
                        # the provisional value rode on a bar that has not
                        # moved in >= 2 minutes: closed market, the value was
                        # garbage -> drop it (0 = "unmeasured") until a live
                        # bar proves a real offset
                        _SRV_OFF = 0
                        _SRV_NOPROV = True
                    elif not _SRV_ANCHORED and not _SRV_NOPROV and _quantized(est):
                        # first measurement of an unanchored life: needed so a
                        # weekday fresh install stamps its first ticks right.
                        # Provisional only — a frozen bar is disproved by the
                        # next run and the value is NOT written to disk.
                        _SRV_OFF = est
                        _SRV_OFF_AT = now
                    # else: stale sample -> keep the last good estimate silently
        except Exception:
            pass
    return now + _SRV_OFF


def _newest_forming_m1():
    """Open time of the NEWEST forming M1 bar among up to 4 visible symbols
    (a halted symbol can't poison the estimate).

    ROUND71 ROOT FIX (weekend / closed-market failure that made the chart
    reload + jump every few seconds instead of building candles live):
    the sample used to be ONLY the FIRST 4 VISIBLE symbols of the broker
    tree. On a weekend (forex shut, Friday evening, holidays) those hold
    FRIDAY bars, so est = friday_bar - now was either garbage beyond the
    14h guard (rejected -> _SRV_OFF froze at 0/stale) or a wrong value —
    and off_heal_loop re-tried the SAME dead sample every 30s, never
    healing. Ticks stamped with a wrong server_now() landed minutes/hours
    away from the history bar labels, so EVERY tick looked like a "huge
    gap" to the renderer's onTick -> scheduleStaleReload -> the WHOLE
    chart reloaded (and jumped) on a loop. The symbols the user actually
    SUBSCRIBED to are always market-relevant (crypto trades 24/7, and on
    weekdays these are exactly the traded markets), so they are sampled
    FIRST; the old visible-symbol sweep stays as the fallback for the
    pre-subscription window (server_now() also runs before any subscribe)."""
    names = []
    try:
        b = _BROKER
        if b is not None:
            subs = set()
            for syms in list(getattr(b, 'subs', {}).values()):
                subs |= syms
            names.extend(sorted(subs)[:8])
    except Exception:
        pass
    # ROUND89: sweep up to 40 visible symbols, not just 4. Brokers list at
    # least one 24/7 market (crypto) well inside the tree; on weekends the
    # forex/metals bars all freeze at Friday's close while the crypto bar
    # keeps forming, so the WIDEST sweep hands the estimator a LIVE bar and
    # the freshness gate in server_now() keeps accepting the true offset
    # instead of drifting into friday_minus_now garbage.
    for s in (_visible_symbols(40) or []):
        if s not in names:
            names.append(s)
    best = None
    for sym in names:
        try:
            rates = mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_M1, 0, 1)
            if rates is None or len(rates) == 0:
                continue
            t = int(rates[0]['time'])
            if best is None or t > best:
                best = t
        except Exception:
            continue
    return best


def _visible_symbols(n):
    """Up to n visible symbol names, cached for 30 minutes (symbols_get is heavy).
    ROUND36: writes ONLY its own slot — never replaces the SYM_CACHE dict
    (that destroyed search()'s 'all' list -> KeyError, see cache comment)."""
    global SYM_CACHE
    now = time.time()
    if SYM_CACHE['names'] and now - SYM_CACHE['names_at'] < 1800:
        return SYM_CACHE['names']
    out = [s.name for s in (mt5.symbols_get() or []) if s.visible][:n]
    if out:
        SYM_CACHE['names'] = out
        SYM_CACHE['names_at'] = now
    return out

try:
    import MetaTrader5 as mt5
except ImportError:
    print('MetaTrader5 python package missing. Run: pip install MetaTrader5', flush=True)
    sys.exit(3)

# Native timeframes resolved SAFELY: not every TF exists in the MetaTrader5
# python package (TIMEFRAME_M45 does NOT exist -> import-time AttributeError
# crashed the provider on Windows). Anything missing must never crash here.
TF_MAP = {}
for _k in ('M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H3', 'H4', 'D1', 'W1', 'MN1'):
    _v = getattr(mt5, 'TIMEFRAME_' + _k, None)
    if _v is not None:
        TF_MAP[_k] = _v

# Timeframes MT5 does NOT provide — the APP builds them itself by aggregating
# a smaller native series (user requirement: app-side timeframe construction).
AGG_TF = {'M45': ('M15', 3), 'MN3': ('MN1', 3), 'MN6': ('MN1', 6), 'MN12': ('MN1', 12)}
S_TICK_SPAN = {'S1': 3600 * 3, 'S5': 3600 * 12, 'S15': 86400 * 3, 'S30': 86400 * 7}
DIG_CACHE = {}
TICK_CACHE = {}
ENSURED = set()   # symbols we already symbol_select()-ed (Market Watch restore)
_INIT_ONCE = {'done': False}
# history-depth parity with the reference platform: the old hard cap of 5000
# bars starved the chart ("far fewer candles than the reference app"). The
# real MT5 copy_rates path serves up to 25k bars per request and the
# renderer pages OLDER history on top of that via `to`-terminated requests.
MAX_BARS_REQ = 25000
# ROUND86C: absolute cap for the copy_rates_range window span (~40 years —
# datetime-overflow-proof and far beyond any broker archive; see native_bars).
MAX_RANGE_SPAN = 40 * 365 * 86400

# ROUND95 CHART CACHE: every bars_req flows through one persistent per-chart
# store (see chart_cache.py) — reopening a chart fetches ONLY the delta since
# the last cached bar, older pages / repeated windows are served from disk,
# charts unused for 30 days are swept, and history the MT5 terminal already
# holds in its own bases/.../history store is never requested twice (the
# copy_rates_* path serves from that store; we only ask for missing ranges).
# Failure containment: any cache error falls back to the untouched raw path.
CHART_CACHE = chart_cache.ChartCache(agg_tf=AGG_TF, tick_span=S_TICK_SPAN)
# tick backfill slice caps for fetch_range: one copy_ticks_range slice small
# enough to stay far below the package's internal 200k-tick truncation.
_TICK_SLICE_CAP = {'S1': 1800, 'S5': 3600, 'S15': 7200, 'S30': 14400}
_MAX_SLICE_COUNT = 480  # per-request slice cap (~20 days of S1 at the cap)


def ensure_symbol(sym):
    info = mt5.symbol_info(sym)
    if info is None:
        # try case-insensitive match
        for s in (mt5.symbols_get() or []):
            if s.name.lower() == sym.lower():
                sym = s.name
                info = mt5.symbol_info(sym)
                break
    if info is not None and not info.visible:
        mt5.symbol_select(sym, True)
        info = mt5.symbol_info(sym)
    if info is not None:
        ENSURED.add(sym)
    return sym, info


# ---- ROUND57/58: the broker's FULL access-server tree ---------------------
# MT5 keeps the broker tree — the exact list its own server dialog shows — in
# <data folder>/config/servers.dat ("Trade server settings for connection",
# per the official data-folder docs). The binary layout is UNDOCUMENTED and
# there is no published spec; community tooling (mtapi.io's Dat2Srv) proves
# the file is plain-parseable (not encrypted). ROUND57 only scanned
# UTF-16LE string layouts and the field report ("still one server") shows
# that guess can miss. ROUND58 scans BOTH string families — UTF-16LE AND
# ANSI/ASCII (the MT4-lineage servers.dat/.srv files store Pascal-style
# length-prefixed and NUL-terminated ASCII strings) — plus globbed candidate
# paths, and on a failed gate writes a diagnostics dump so a stubborn file
# can be nailed exactly instead of re-guessed. The parse stays
# SELF-VALIDATING: a harvest is only trusted if it contains the account's own
# server name (it MUST be there — the terminal is connected through it);
# anything unexpected falls back to the account's single server (ROUND55).
_SRV_LEN_CAP = 512          # max chars per string
_SRV_FILE_CAP = 8 * 1024 * 1024


def _srv_harvest(data):
    """servers.dat strings -> [(offset, text)]. Runs every realistic layout
    scan (UTF-16LE and ASCII, length-prefixed u32/u8 and NUL-terminated) and
    keeps the RICHEST harvest; the caller re-validates against the account
    server, so a wrong-scan win is inert by construction."""
    def _scan(width, utf16):
        step = 2 if utf16 else 1
        out, i, n = [], 0, len(data)
        while i + width <= n:
            ln = int.from_bytes(data[i:i + width], 'little')
            if 2 <= ln <= _SRV_LEN_CAP and i + width + ln * step <= n:
                try:
                    s = data[i + width:i + width + ln * step].decode('utf-16-le' if utf16 else 'latin-1')
                except Exception:
                    i += 1
                    continue
                if s and all(32 <= ord(c) < 127 for c in s):
                    out.append((i, s))
                    i += width + ln * step
                    continue
            i += 1
        return out

    def _scan_nt(utf16):
        # hedge: some layouts are null-terminated rather than length-prefixed
        out, cur, i, n = [], [], 0, len(data)
        while i + (2 if utf16 else 1) <= n:
            if utf16:
                ch = int.from_bytes(data[i:i + 2], 'little')
                i += 2
            else:
                ch = data[i]
                i += 1
            if ch == 0:
                if 2 <= len(cur) <= _SRV_LEN_CAP:
                    s = ''.join(cur)
                    if all(32 <= ord(c) < 127 for c in s):
                        out.append((i - (len(cur) + 1) * (2 if utf16 else 1), s))
                cur = []
            elif 32 <= ch < 127:
                cur.append(chr(ch))
            else:
                cur = []
        return out

    scans = (_scan(4, True), _scan(2, True), _scan_nt(True),
             _scan(4, False), _scan(2, False), _scan(1, False), _scan_nt(False))
    return max(scans, key=len)


def _srv_debug_dump(acc, tried, best_harvest):
    """Write gate-failure diagnostics (layout archaeology for the next fix).
    Silent best-effort; never raises."""
    try:
        lines = ['time: ' + time.strftime('%Y-%m-%d %H:%M:%S'),
                 'account server: ' + repr(acc),
                 'candidates: ' + json.dumps([[p, len(h)] for p, h in tried]),
                 'harvest strings (%d):' % len(best_harvest)]
        lines += ['  ' + repr(s) for _, s in best_harvest[:200]]
        for p, hexd in tried:
            if hexd:
                lines.append('hex head of ' + p + ':')
                for r in range(0, min(len(hexd), 1536), 16):
                    chunk = hexd[r:r + 16]
                    lines.append('  %04x  %s  %s' % (r,
                        ' '.join('%02x' % b for b in chunk),
                        ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)))
                break
        with open(DEBUG_FILE, 'w') as f:
            f.write('\n'.join(lines))
    except Exception:
        pass


def _srv_addr(s):
    """A plausible access address: 'host:port' (or dotted host for adjacency
    pairing). Server display names do not look like this."""
    if not s or len(s) > 253:
        return None
    if ':' in s:
        host, _, port = s.rpartition(':')
        if host and port.isdigit() and 0 < int(port) < 65536:
            return s
        return None
    # bare dotted host — but a '-' usually marks a server DISPLAY name
    # ("Stonex.eu-Live"), so bare hosts must not contain one
    if '.' in s and '-' not in s and all(c.isalnum() or c == '.' for c in s):
        return s
    return None


def _srv_tree(harvest, account_server):
    """{server_name: [addresses...]} for the account's broker block, in file
    order. Gated on the account server itself being present in the harvest —
    that is the self-validation that keeps garbage parses from ever reaching
    the UI."""
    if not account_server:
        return {}
    acc = account_server.strip()
    ks = [k for k, (_, s) in enumerate(harvest) if s.strip() == acc]
    if not ks:
        return {}
    k0 = ks[0]
    pre = acc.lower().split('-')[0].split(' ')[0]
    if len(pre) < 3:
        return {}

    def sib(s):
        t = s.strip().lower()
        return t.startswith(pre) and len(t) > len(pre)

    # block root: walk back over the account entry's own addresses/siblings
    start = k0
    while start > 0:
        s = harvest[start - 1][1].strip()
        if _srv_addr(s) or sib(s) or s.lower() == acc.lower():
            start -= 1
        else:
            break
    tree, cur = {}, None
    for j in range(start, len(harvest)):
        s = harvest[j][1].strip()
        a = _srv_addr(s)
        if a:
            if cur:
                tree[cur] = tree.get(cur, []) + [a]
            continue
        if sib(s) or s.lower() == acc.lower():
            cur = s
            tree.setdefault(cur, [])
        elif tree:
            break  # another broker's title -> block ended
    return tree


class MT5Broker(Broker):
    name = 'MetaTrader5'

    def __init__(self, login, password, server, path):
        super().__init__()
        global _BROKER
        _BROKER = self # ROUND71: _newest_forming_m1 samples the SUBSCRIBED symbols first
        self.login, self.password, self.server, self.path = login, password, server, path
        self.connected = False
        _load_off(server)  # r16: persisted offset estimate survives restarts (R94: per broker server)

    # ---- ROUND55/57: broker access servers (MT5 login-dialog parity) ----
    # ROUND57: the bridge now reads the terminal's OWN broker tree from
    # <data folder>/config/servers.dat (the file behind MT5's server
    # dialog): EVERY access server of this broker, not just the connected
    # one. Self-validating parse (the account's server must be found in the
    # file) -> otherwise the ROUND55 single-server fallback applies.
    _srv_tree_cache = {}  # (path, mtime) -> parsed tree

    def _acc_server(self):
        """The account's server name: typed server, else terminal_info()."""
        s = (self.server or '').strip()
        if s:
            return s
        try:
            if mt5 is not None:
                ti = mt5.terminal_info()
                if ti is not None:
                    return (getattr(ti, 'server', '') or '').strip()
        except Exception:
            pass
        return ''

    def _srv_paths(self):
        """Candidate servers.dat locations: data folder, install dir (portable
        terminals), then globbed MetaQuotes Terminal dirs (covers terminals
        whose data_path is unavailable at scan time). Deduped, order kept."""
        out = []
        try:
            if mt5 is not None:
                ti = mt5.terminal_info()
                if ti is not None:
                    dp = getattr(ti, 'data_path', '') or ''
                    if dp:
                        out.append(os.path.join(dp, 'config', 'servers.dat'))
                    p = getattr(ti, 'path', '') or ''
                    if p:
                        out.append(os.path.join(os.path.dirname(p), 'config', 'servers.dat'))
        except Exception:
            pass
        try:  # ROUND58: glob every installed terminal's data dir
            import glob as _g
            roots = [os.environ.get('APPDATA', ''),
                     os.path.expandvars('%APPDATA%'),
                     os.path.expanduser('~')]
            seen = set()
            for r in roots:
                if not r or r in seen:
                    continue
                seen.add(r)
                pat = os.path.join(r, 'MetaQuotes', 'Terminal', '*', 'config', 'servers.dat')
                out.extend(sorted(_g.glob(pat))[:4])
        except Exception:
            pass
        ded = []
        for p in out:
            if p not in ded:
                ded.append(p)
        return ded[:12]

    def _srv_addrs_map(self):
        """{server_name: [host:port, ...]} for this broker ({} = unknown)."""
        acc = self._acc_server()
        if not acc:
            return {}
        tried, best_h = [], []
        for p in self._srv_paths():
            try:
                key = (p, int(os.stat(p).st_mtime))
                tree = MT5Broker._srv_tree_cache.get(key)
                if tree is None:
                    with open(p, 'rb') as f:
                        data = f.read(_SRV_FILE_CAP)
                    h = _srv_harvest(data)
                    tree = _srv_tree(h, acc)
                    if len(h) > len(best_h):
                        best_h = h
                    MT5Broker._srv_tree_cache.clear()  # keep only the fresh one
                    MT5Broker._srv_tree_cache[key] = tree
                if tree:
                    return tree
                tried.append((p, data[:1536]))  # gate failed on this candidate
            except Exception:
                tried.append((p, b''))
        if acc:
            _srv_debug_dump(acc, tried, best_h)  # ROUND58: silent diagnostics
        return {}

    # ---- ROUND65: REAL economic calendar ----
    # The inherited hook serves the r39 SYNTHETIC generator (fixed fake UTC
    # slots, tiny hardcoded event set). On a live terminal the user verifies
    # the panel + chart news lines against the real calendar, so MT5 mode
    # serves the REAL feed (ForexFactory weekly JSON) as TRUE UTC epoch sec —
    # the r64 render funnel then applies the broker offset exactly once and
    # the user's selected chart timezone. Feed unreachable (offline PC, feed
    # down) -> fall back to the synthetic generator; the panel never blanks.
    def news(self):
        try:
            events = news_ff()
        except Exception:
            traceback.print_exc()
            events = None
        return events if events else news_calendar()

    def server_entries(self):
        try:
            tree = self._srv_addrs_map()
            if tree:
                names = list(tree.keys())
                cur = (self.server or '').strip()
                if cur in names:  # the connected server is always listed first
                    names.remove(cur)
                    names.insert(0, cur)
                return [{'name': n, 'addrs': tree.get(n, [])} for n in names[:40]]
        except Exception:
            pass
        names = []  # ROUND55 fallback: the account's actual server only
        if self.server:
            names.append(self.server)
        else:
            try:
                if mt5 is not None:
                    ti = mt5.terminal_info()
                    if ti is not None and getattr(ti, 'server', ''):
                        names.append(ti.server)
            except Exception:
                pass
        return [{'name': n} for n in names]

    async def server_ping_ms(self, name):
        loop = asyncio.get_event_loop()
        cur = self._acc_server()
        # the CONNECTED server: real terminal IPC round trip (as ROUND55)
        if name.strip() == cur and mt5 is not None:
            def _rtt():
                t0 = time.time()
                try:
                    ti = mt5.terminal_info()  # cheapest full IPC round trip
                    if ti is None:
                        return None
                except Exception:
                    return None
                return round((time.time() - t0) * 1000, 2)

            try:
                return await loop.run_in_executor(None, _rtt)
            except Exception:
                return None
        # sibling servers: REAL tcp-connect time to their access address —
        # the same measurement the terminal's own server dialog performs
        addrs = []
        try:
            addrs = self._srv_addrs_map().get(name.strip()) or []
        except Exception:
            addrs = []
        hosts = []
        for a in addrs[:3]:
            h, _, pt = a.rpartition(':')
            hosts.append((h, int(pt) if pt.isdigit() else 443))
        if not hosts:
            # ROUND58: MT5 server names ARE hostnames — the terminal itself
            # resolves a bare name via DNS, so ping the name the same way
            nm = name.strip()
            if nm and all(c.isalnum() or c in '-.' for c in nm) and any(c.isalnum() for c in nm):
                try:
                    ai = socket.getaddrinfo(nm, 443, type=socket.SOCK_STREAM)
                    if ai:
                        hosts.append((ai[0][4][0], 443))
                except Exception:
                    pass
        if not hosts:
            return None

        def _tcp():
            for h, pt in hosts:
                try:
                    t0 = time.time()
                    s = socket.create_connection((h, pt), timeout=1.5)
                    s.close()
                    return round((time.time() - t0) * 1000, 2)
                except Exception:
                    continue
            return None

        try:
            return await loop.run_in_executor(None, _tcp)
        except Exception:
            return None

    def _init_once(self, quiet=False):
        """initialize + login with the saved credentials (used at boot AND by
        the watchdog when the terminal was closed).
        AUDIT FIX: `quiet` lets the watchdog's retry loop suppress this
        function's own per-attempt print (it already logs its own throttled
        summary line), so a multi-minute outage doesn't write one raw
        'initialize failed' ERROR line to the log every single attempt."""
        kw = {}
        if self.path:
            kw['path'] = self.path
        if self.login:
            ok = mt5.initialize(login=int(self.login), password=self.password, server=self.server, **kw)
        else:
            ok = mt5.initialize(**kw)
        if not ok:
            if not quiet:
                print('MT5 initialize failed: ' + str(mt5.last_error()), flush=True)
            return False
        if self.login and not mt5.login(int(self.login), password=self.password, server=self.server):
            if not quiet:
                print('MT5 login failed: ' + str(mt5.last_error()), flush=True)
            mt5.shutdown()
            return False
        return True

    def connect(self):
        if not _INIT_ONCE['done']:
            if not self._init_once():
                return False
            _INIT_ONCE['done'] = True
        self.connected = True
        print('MT5 connected: ' + str(mt5.account_info().login if mt5.account_info() else 'terminal'), flush=True)
        try:
            CHART_CACHE.bootstrap(self)  # ROUND95: TTL sweep + cache info
        except Exception:
            traceback.print_exc()
        return True

    def do_login(self, msg):
        return self.connected, ('Terminal not connected' if not self.connected else '')

    def get_digits(self, symbol):
        if symbol not in DIG_CACHE:
            _, info = ensure_symbol(symbol)
            DIG_CACHE[symbol] = info.digits if info else 5
        return DIG_CACHE[symbol]

    # ---- ROUND95 hooks the chart cache drives (see chart_cache.py) ----
    def now_epoch(self):
        """Broker-server clock (epoch sec) — the same time base bar labels use."""
        try:
            return int(server_now())
        except Exception:
            return int(time.time())

    def cache_server(self):
        """Cache namespace: the account's broker server name (different
        brokers = different price history = different cache files)."""
        return self._acc_server() or 'terminal'

    def mt5_history_dir(self):
        """The terminal's own history store (bases/<server>/history) — the
        folder behind the .hcc files MT5 fills for its own charts. Diagnostics
        only: copy_rates_* already serves FROM it, and the files are never
        parsed here (undocumented format — a mis-parse would show wrong
        prices; the API path is the safe way to reuse that data)."""
        try:
            ti = mt5.terminal_info()
            dp = getattr(ti, 'data_path', '') if ti else ''
            if not dp:
                return None
            bases = os.path.join(dp, 'bases')
            if not os.path.isdir(bases):
                return None
            srv = self._acc_server()
            try:
                dirs = os.listdir(bases)
            except Exception:
                return bases
            cand = None
            for d in dirs:
                if srv and d.strip().lower() == srv.strip().lower():
                    cand = d
                    break
            if cand is None and len(dirs) == 1:
                cand = dirs[0]
            h = os.path.join(bases, cand, 'history') if cand else None
            return h if (h and os.path.isdir(h)) else bases
        except Exception:
            return None

    def fetch_range(self, symbol, tf, frm, to):
        """Broker bars with open time in [frm, to) for tf — the EXACT window
        the chart cache asks for (bucket-aligned bounds), nothing more.
        Seconds timeframes are fetched in tick slices small enough to stay
        far below the package's internal 200k-tick truncation; app-built
        timeframes aggregate their native source over the same window."""
        frm, to = int(frm), int(to)
        if to <= frm:
            return []
        sym, info = ensure_symbol(symbol)
        if info is None:
            return []
        if tf in AGG_TF:
            src, mult = AGG_TF[tf]
            raw = self.fetch_range(sym, src, frm, to)
            return aggregate_bars(raw, tf, MAX_BARS_REQ)
        if tf in S_TICK_SPAN:
            cap = _TICK_SLICE_CAP.get(tf, 3600)
            out = []
            a, n = frm, 0
            while a < to and n < _MAX_SLICE_COUNT:
                b = min(a + cap, to)
                try:
                    out.extend(self._tick_bars_span(sym, tf, MAX_BARS_REQ, b - a, to=b))
                except Exception:
                    traceback.print_exc()
                a = b
                n += 1
            return out
        if tf in TF_MAP:
            # tz-AWARE bounds (same trap as copy_ticks_range — a naive
            # datetime is re-interpreted in the machine's local tz)
            # ROUND145: _extend_head crawls 40-year windows on sparse high
            # TFs (MN12/MN3) — frm can slide BEFORE 1970 and Windows
            # fromtimestamp() raises OSError EINVAL there (Linux tolerates
            # negatives, which is why this only ever crashed on user
            # machines). Clamp to the epoch: no broker archive predates it.
            frm = max(0, frm)
            to = max(1, to)
            if to <= frm:
                return []
            try:
                frm_dt = dt.datetime.fromtimestamp(frm, tz=dt.timezone.utc)
                to_dt = dt.datetime.fromtimestamp(to, tz=dt.timezone.utc)
            except Exception:
                return []
            try:
                rates = mt5.copy_rates_range(sym, TF_MAP[tf], frm_dt, to_dt)
            except Exception:
                rates = None
            if rates is None or len(rates) == 0:
                return []
            out = []
            for r in rates:
                t = int(r['time'])
                if t < frm or t >= to:
                    continue
                out.append({'time': t, 'open': float(r['open']), 'high': float(r['high']),
                            'low': float(r['low']), 'close': float(r['close']),
                            'volume': int(r['tick_volume'])})
            return out
        return []

    def get_bars(self, symbol, tf, count, to=None):
        if CHART_CACHE.enabled:
            # ROUND95: persistent incremental cache in front of the raw path
            return CHART_CACHE.serve_bars(self, symbol, tf, count, to)
        return self.raw_bars(symbol, tf, count, to=to)

    def raw_bars(self, symbol, tf, count, to=None):
        count = max(50, min(count, MAX_BARS_REQ))
        if tf in S_TICK_SPAN:
            return self.tick_bars(symbol, tf, count, to=to)
        if tf in TF_MAP:
            return self.native_bars(symbol, tf, count, to=to)
        if tf in AGG_TF:  # app-built timeframe from a smaller native series
            src, mult = AGG_TF[tf]
            src_bars = self.native_bars(symbol, src, min(count * mult, MAX_BARS_REQ), to=to)
            return aggregate_bars(src_bars, tf, count)
        return []

    def native_bars(self, symbol, tf, count, to=None):
        sym, info = ensure_symbol(symbol)
        if info is None:
            return []
        if to is not None:
            # OLDER-HISTORY page: bars ending strictly before `to` (server
            # epoch seconds). copy_rates_range needs tz-aware UTC datetimes
            # (same tz trap as copy_ticks_range — see _tick_bars_span); a
            # naive datetime is re-interpreted in the machine's local tz on
            # non-UTC machines and the whole window slides hours away.
            # ROUND86C: the window span used to be TF_SEC*count*3 UNCLAMPED —
            # on MN1-family timeframes with a 25k-bar page that is ~6000
            # YEARS, so `to_dt - timedelta(...)` underflowed below datetime
            # year 1 -> OverflowError raised OUTSIDE the try -> the ws
            # handler caught it and sent NO REPLY -> the client always saw
            # "request timeout: bars_req" on MN1/MN3/MN6/MN12. The span is
            # now clamped far beyond any real archive (copy_rates_range
            # simply returns whatever exists inside it).
            to_dt = dt.datetime.fromtimestamp(int(to), tz=dt.timezone.utc)
            span = TF_SEC[tf] * max(4, count * 3)
            if span > MAX_RANGE_SPAN:
                span = MAX_RANGE_SPAN
            # 1x slack absorbs weekends/holidays; copy_rates_range is
            # inclusive on BOTH ends -> filter b.time < to afterwards.
            frm_dt = to_dt - dt.timedelta(seconds=span)
            try:
                rates = mt5.copy_rates_range(sym, TF_MAP[tf], frm_dt, to_dt)
            except Exception:
                rates = None
            if rates is None or len(rates) == 0:
                return []
            out = []
            for r in rates:
                t = int(r['time'])
                if t >= int(to):
                    continue
                out.append({'time': t, 'open': float(r['open']), 'high': float(r['high']),
                            'low': float(r['low']), 'close': float(r['close']), 'volume': int(r['tick_volume'])})
            return out[-count:]
        rates = mt5.copy_rates_from_pos(sym, TF_MAP[tf], 0, count)
        if rates is None:
            return []
        out = []
        for r in rates:
            out.append({'time': int(r['time']), 'open': float(r['open']), 'high': float(r['high']),
                        'low': float(r['low']), 'close': float(r['close']), 'volume': int(r['tick_volume'])})
        return out

    def tick_bars(self, symbol, tf, count, to=None):
        sym, info = ensure_symbol(symbol)
        if info is None:
            return []
        span = S_TICK_SPAN[tf]
        if to is not None:
            # OLDER-HISTORY page for second timeframes: aggregate the RAW
            # ticks of the window ending strictly before `to`
            return self._tick_bars_span(sym, tf, count, span, to=int(to))
        # tight window first: only as much tick history as the bars actually
        # need (+30 min slack) -> fast loads on every seconds timeframe; widen
        # to the full span only when the market was closed inside the tight
        # window (weekend / session break) so TV-like older bars still show
        tight = min(span, count * TF_SEC[tf] + 1800)
        bars = self._tick_bars_span(sym, tf, count, tight)
        if len(bars) < count:
            wide = self._tick_bars_span(sym, tf, count, span)
            if len(wide) > len(bars):
                bars = wide
        return bars

    def _tick_bars_span(self, sym, tf, count, span, to=None):
        # copy_ticks_range bounds MUST be tz-AWARE UTC datetimes. A naive
        # utcfromtimestamp() value is re-interpreted in the machine's LOCAL
        # timezone by the MetaTrader5 package -> on non-UTC machines (e.g.
        # UTC+3:30) the whole window slides hours into the past: seconds
        # history ends long before "now", the next live tick then appends a
        # far-future bar and the seconds chart looks completely wrong.
        if to is not None:
            to = dt.datetime.fromtimestamp(int(to), tz=dt.timezone.utc)
        else:
            to = dt.datetime.fromtimestamp(server_now(), tz=dt.timezone.utc)
        frm = to - dt.timedelta(seconds=span)
        try:
            ticks = mt5.copy_ticks_range(sym, frm, to, mt5.COPY_TICKS_ALL)
        except Exception:
            return []
        if ticks is None or len(ticks) == 0:
            return []
        pairs = []
        for t in ticks[-200000:]:
            px = float(t['bid']) if t['bid'] else (float(t['last']) if t['last'] else 0.0)
            if px > 0:
                tt = int(t['time'])
                if to is not None and tt >= int(to.timestamp()):
                    continue
                pairs.append((tt, px))
        return aggregate_ticks(pairs, tf, count, lambda p: p)

    def search(self, query):
        # ROUND 35: the MT5 wildcard filter (symbols_get('*q*')) is
        # CASE-SENSITIVE — typing lowercase returned nothing. The FULL symbol
        # list is fetched (one symbols_get(), cached 30 min) and filtered HERE,
        # case-insensitively, always. ROUND 36: the cache no longer collapses
        # when the offset refresh refreshes its own 'names' slot (that was the
        # "search shows nothing anywhere" regression), the visible-set rides
        # on the SAME single symbols_get() (no second full-table call per
        # keystroke), and the FULL matched list is returned — provider_common
        # replies with symbols[:400] + the exact 'total' so the dialog can
        # show "N symbols" truthfully.
        global SYM_CACHE
        q = (query or '').strip().upper()
        now = time.time()
        if not SYM_CACHE['all'] or now - SYM_CACHE['all_at'] >= 1800:
            try:
                infos = mt5.symbols_get() or []
            except Exception:
                infos = []
            if infos:
                SYM_CACHE['all'] = [s.name for s in infos]
                SYM_CACHE['vis'] = {s.name for s in infos if s.visible}
                SYM_CACHE['all_at'] = now
        names = SYM_CACHE['all']
        if not names:
            # cache cold AND symbols_get failed: fall back to the wildcard
            # (best effort — upper + raw, the two common symbol casings)
            try:
                syms = (mt5.symbols_get('*' + q + '*') if q else mt5.symbols_get()) or []
                out = []
                for s in syms:
                    if s.name not in out:
                        out.append(s.name)
                vis = [s.name for s in syms if s.visible and s.name in out]
                return (vis if vis else out)[:80]
            except Exception:
                return []
        if q:
            hits = [n for n in names if q in n.upper()]
        else:
            hits = list(names)
        if not hits:
            return []
        # visible symbols first (same preference as the old path), then the rest
        vis_set = SYM_CACHE['vis']
        if vis_set:
            hits.sort(key=lambda n: 0 if n in vis_set else 1)
        return hits

    def next_tick(self, symbol):
        t = mt5.symbol_info_tick(symbol)
        if t is None:
            # retry with resolution
            sym, info = ensure_symbol(symbol)
            if info is None or sym != symbol:
                t = mt5.symbol_info_tick(sym) if info else None
            if t is None:
                return None
        # DATA-PARITY FIX (r72): MT5 draws its charts on BID prices. The old
        # path preferred t.last and then the bid/ask MID — both sit half a
        # spread (or more) ABOVE the price MT5 actually paints, which is
        # exactly the numeric mismatch the user reported on the price scale
        # and in the live candles' O/H/L/C. Bid first, then last (exchange
        # symbols whose quotes carry no bid), then nothing — now the live
        # ticks share the exact price base of copy_rates history bars AND of
        # the terminal's own chart. _tick_bars_span already preferred bid.
        px = float(t.bid) if t.bid else (float(t.last) if t.last else 0.0)
        if px <= 0:
            return None
        # MARKET-CLOSED GATE (r72): when a session is closed (weekend, daily
        # break, holiday) the terminal keeps returning the LAST quote with a
        # FROZEN time. The old path kept emitting it stamped with server_now()
        # -> the renderer built phantom candles all weekend/holiday and the
        # chip read "Market open". A quote older than 180s (= the renderer's
        # own chip rule) means the session is closed for this symbol: emit
        # nothing at all, so no candles are created while the market is
        # closed. A quote AHEAD of the offset estimate (age < 0) is always
        # fresh: emit it.
        qt = int(t.time) if t.time else 0
        stamp = server_now()   # may refresh _SRV_OFF — read it back ONCE
        off = int(_SRV_OFF)
        if qt > 0 and stamp - qt > 180:
            return None
        prev = TICK_CACHE.get(symbol)
        TICK_CACHE[symbol] = px
        # stamp the tick in SERVER time -> same time base as history bars,
        # so live updates continue the loaded chart seamlessly on any offset.
        # 4th/5th elements (bid/ask) are optional extras for the renderer's
        # Bid and Ask price lines; provider_common passes them through when set.
        # ROUND276: the 6th element is the offset that produced THIS stamp, so
        # the renderer can never pair a tick time with a differing estimate
        # (the old shape re-read current_off() a moment later).
        bid = float(t.bid) if t.bid else 0.0
        ask = float(t.ask) if t.ask else 0.0
        return px, 1, stamp, bid, ask, off

    def current_off(self):
        # ROUND94: this runs on the EVENT-LOOP thread (every tick reply, every
        # bars reply, login_ok). It used to call server_now() = a possible
        # 48-symbol mt5 sweep ON THE LOOP, concurrently with the mt5data worker
        # (the package is not thread-safe). Now it only READS the cached
        # estimate; the sweep lives in the worker (next_tick) + the heal loop.
        # The one exception is the very first call of a provider life, so
        # login_ok carries a real value instead of 0.
        if _SRV_TRY_AT == 0.0:
            server_now()
        return int(_SRV_OFF)

    # ==================================================================
    # ROUND85: TRADING BRIDGE — real order execution through the connected
    # MetaTrader5 terminal. Every op follows the official python-integration
    # contract (mql5.com docs): order_send() takes the TRADE_ACTION_* request
    # dict, positions_get()/orders_get() return namedtuples,
    # history_deals_get() is bounded by tz-aware UTC datetimes (the same trap
    # _tick_bars_span documents for copy_ticks_range — a naive datetime is
    # re-interpreted in the machine's LOCAL tz and the window slides hours).
    # Supported ops ('msg.op'):
    #   account         -> account_info snapshot (balance/equity/margin/...)
    #   spec            -> symbol trade specs (tick value/size, volumes,
    #                      stops/freeze level, filling mask, digits, bid/ask)
    #   order_send      -> market OR pending order (TRADE_ACTION_DEAL/PENDING)
    #   close           -> close a position (full or partial) by ticket
    #   close_all       -> close every position (optional symbol filter)
    #   modify_sltp     -> TRADE_ACTION_SLTP (position SL/TP)
    #   order_modify    -> TRADE_ACTION_MODIFY (pending price/SL/TP/expiry)
    #   order_cancel    -> TRADE_ACTION_REMOVE (delete a pending order)
    #   positions/orders-> live tables
    #   history         -> deals in [from, to] (epoch SEC) + summary
    #   state           -> account + positions + orders in ONE round trip
    #                      (the renderer's 1.2s poll — 3 IPC calls, no HTTP)
    # ==================================================================
    _RETCODE_TXT = {
        10004: 'Requote', 10005: 'Request rejected', 10006: 'Request rejected',
        10007: 'Canceled by trader', 10008: 'Order placed', 10009: 'Done',
        10010: 'Partially done', 10011: 'Request processing error',
        10012: 'Request canceled by timeout', 10013: 'Invalid request',
        10014: 'Invalid volume', 10015: 'Invalid price',
        10016: 'Invalid stops (SL/TP/entry too close to the market)',
        10017: 'Trading disabled', 10018: 'Market closed',
        10019: 'Not enough money', 10020: 'Prices changed',
        10021: 'No quotes to process the request',
        10022: 'Invalid order expiration', 10023: 'Order state changed',
        10024: 'Too frequent requests', 10025: 'No changes in the request',
        10026: 'Autotrading disabled by the SERVER (enable Algo Trading on the broker account)',
        10027: 'Autotrading disabled in the TERMINAL (enable the Algo Trading button)',
        10028: 'Request locked for processing', 10029: 'Order or position frozen',
        10030: 'Invalid order filling type', 10031: 'No connection with the trade server',
        10032: 'Operation allowed only for live accounts', 10033: 'Pending-orders limit reached',
        10034: 'Orders/positions volume limit reached',
        10035: 'Close volume exceeds the position volume',
        10036: 'Close volume limit reached',
        10038: 'Close volume exceeds the position volume',
        10044: 'Only position closing is allowed',
    }

    def _ret_txt(self, code, comment=''):
        base = self._RETCODE_TXT.get(code) or ('Trade error ' + str(code))
        c = (comment or '').strip()
        return base + (': ' + c if c and c not in ('', 'none') else '')

    def _connected_or_err(self):
        if not self.connected:
            return 'MetaTrader5 terminal is not connected'
        return None

    @staticmethod
    def _f(v):
        try:
            f = float(v)
        except Exception:
            return 0.0
        if f != f or f in (float('inf'), float('-inf')):  # NaN / inf
            return 0.0
        return f

    @staticmethod
    def _norm_filling(info):
        """symbol_info().filling_mode is a BITMASK (SYMBOL_FILLING_FOK=1,
        SYMBOL_FILLING_IOC=2) per the docs; RETURN (2 in the request) is the
        exchange default. Order: FOK -> IOC -> RETURN (typical retail broker)."""
        try:
            mask = int(info.filling_mode)
        except Exception:
            mask = 0
        if mask & 1:
            return mt5.ORDER_FILLING_FOK
        if mask & 2:
            return mt5.ORDER_FILLING_IOC
        return mt5.ORDER_FILLING_RETURN

    def _send_mt5(self, req):
        """One order_send round trip with the standard INVALID_FILL retry:
        retcode 10030 -> flip FOK/IOC/RETURN once and retry (docs: the
        broker's accepted filling mode may differ from the symbol mask)."""
        res = mt5.order_send(req)
        if res is None:
            return None, self._last_err_txt('order_send')
        if res.retcode == 10030:  # TRADE_RETCODE_INVALID_FILL
            alt = {mt5.ORDER_FILLING_FOK: mt5.ORDER_FILLING_IOC,
                   mt5.ORDER_FILLING_IOC: mt5.ORDER_FILLING_RETURN,
                   mt5.ORDER_FILLING_RETURN: mt5.ORDER_FILLING_FOK}.get(req.get('type_filling'))
            if alt is not None:
                req['type_filling'] = alt
                res = mt5.order_send(req)
                if res is None:
                    return None, self._last_err_txt('order_send')
        return res, None

    def _last_err_txt(self, what):
        """Human text for order_send() returning None (round85b): decode
        last_error() and add the actionable AutoTrading hint when the
        terminal's Algo Trading switch is off — the #1 real-world cause of
        'the order never reaches the broker' while charts still stream."""
        err = mt5.last_error()
        code = err[0] if isinstance(err, (tuple, list)) and len(err) else 0
        txt = str(err[1]) if isinstance(err, (tuple, list)) and len(err) > 1 and err[1] else str(err)
        hint = ''
        if code == 10027:
            hint = ' — enable the "Algo Trading" button in the MetaTrader toolbar'
        elif code == 10026:
            hint = ' — enable Algo Trading for this account with your broker'
        try:
            ti = mt5.terminal_info()
            if ti is not None and not ti.trade_allowed and not hint:
                hint = ' — AutoTrading is OFF in the terminal ("Algo Trading" button)'
        except Exception:
            pass
        return what + ' failed: ' + txt + hint

    def _ret_res(self, res, data):
        """Round85b: uniform result for every order_send()-backed op.
        Broker rejections now carry BOTH data.retcode/comment AND a flat
        'error' text so any client layer shows the real reason."""
        ok = res.retcode in (10008, 10009, 10010)  # PLACED / DONE / PARTIAL
        txt = self._ret_txt(res.retcode, res.comment)
        if not ok:
            try:
                ti = mt5.terminal_info()
                if ti is not None and not ti.trade_allowed:
                    txt += ' — AutoTrading is OFF in the terminal ("Algo Trading" button)'
            except Exception:
                pass
            return {'ok': False, 'error': txt, 'data': data}
        return {'ok': True, 'data': data}

    def _pos_row(self, p):
        return {'ticket': int(p.ticket), 'time': int(p.time), 'type': int(p.type),
                'volume': float(p.volume), 'open': float(p.price_open),
                'sl': float(p.sl or 0), 'tp': float(p.tp or 0),
                'current': float(p.price_current or 0), 'swap': float(p.swap or 0),
                'profit': float(p.profit or 0), 'symbol': p.symbol,
                'comment': str(p.comment or '')}

    def _order_row(self, o):
        # ROUND118 (user bug: "pendings never show anywhere"): MetaTrader5's
        # TradeOrder namedtuple has NO 'volume_filled' attribute — the docs
        # list volume_initial + volume_current only. Reading o.volume_filled
        # raised AttributeError, so trade_rpc('state'/'orders') failed EVERY
        # 1.2s poll while at least ONE pending order existed -> the renderer
        # froze on the last pre-pending snapshot: no pending row in Positions,
        # no pending line on the chart, empty Orders tab (exactly the user's
        # screenshot: sell limit in MetaTrader, nothing in the app). Filled
        # volume is derived (initial - current) and every field now goes
        # through getattr fallbacks so one absent attribute can never kill
        # the trade feed again. Wire row shape is unchanged for the client.
        vi = self._f(getattr(o, 'volume_initial', 0))
        vc = self._f(getattr(o, 'volume_current', 0))
        return {'ticket': int(o.ticket),
                'time': int(getattr(o, 'time_setup', 0) or getattr(o, 'time', 0) or 0),
                'type': int(o.type), 'volume': vi,
                'filled': round(max(0.0, vi - vc), 8),
                'price': self._f(o.price_open), 'sl': self._f(o.sl),
                'tp': self._f(o.tp), 'current': self._f(o.price_current),
                'symbol': o.symbol, 'comment': str(o.comment or ''),
                'type_time': int(getattr(o, 'type_time', 0) or 0),
                'expiration': int(getattr(o, 'time_expiration', 0)
                                  or getattr(o, 'expiration', 0) or 0)}

    @staticmethod
    def _safe_rows(rows, mapper, tag=''):
        # ROUND118 belt-and-braces: one malformed broker row must NEVER freeze
        # the WHOLE state feed again (that is how pendings went invisible).
        # Skip the bad row, keep the rest, print the traceback on the provider
        # console so the cause is still debuggable.
        out = []
        for r in rows:
            try:
                out.append(mapper(r))
            except Exception:
                traceback.print_exc()
                try:
                    print('ROUND118: dropped one bad ' + tag + ' row', flush=True)
                except Exception:
                    pass
        return out

    def _deal_row(self, d):
        # ROUND113: additive fields for the History table — magic + the close
        # REASON (DEAL_REASON_SL=4 / DEAL_REASON_TP=5) power the S/L-red /
        # T.P.-green cell paint; fee is its own column. TradeDeal has no
        # sl/tp attrs, so they ride as 0 and the client falls back to the
        # fill price when the reason says the deal WAS an SL/TP exit.
        return {'ticket': int(d.ticket), 'order': int(d.order), 'time': int(d.time),
                'type': int(d.type), 'entry': int(d.entry),
                'position_id': int(d.position_id), 'volume': float(d.volume),
                'price': float(d.price), 'commission': float(d.commission or 0),
                'swap': float(d.swap or 0), 'profit': float(d.profit or 0),
                'symbol': d.symbol, 'comment': str(d.comment or ''),
                'magic': int(getattr(d, 'magic', 0) or 0),
                'reason': int(getattr(d, 'reason', 0) or 0),
                'fee': float(getattr(d, 'fee', 0) or 0),
                'sl': 0.0, 'tp': 0.0}

    def _account_row(self):
        a = mt5.account_info()
        if a is None:
            return None
        return {'login': int(a.login), 'name': str(a.name or ''), 'server': str(a.server or ''),
                'currency': str(a.currency or 'USD'), 'leverage': int(a.leverage or 0),
                'balance': float(a.balance or 0), 'equity': float(a.equity or 0),
                'profit': float(a.profit or 0), 'margin': float(a.margin or 0),
                'margin_free': float(a.margin_free or 0),
                'margin_level': float(a.margin_level or 0),
                'trade_allowed': bool(getattr(mt5.terminal_info(), 'trade_allowed', False))
                    if mt5.terminal_info() is not None else None}

    def _spec_row(self, symbol):
        sym, info = ensure_symbol(symbol)
        if info is None:
            return None
        t = mt5.symbol_info_tick(sym)
        # filling mask for the client's own validation display (the real
        # request path re-derives + retries in _send_mt5)
        try:
            fm = int(info.filling_mode)
        except Exception:
            fm = 0
        return {'symbol': sym, 'digits': int(info.digits), 'point': float(info.point),
                'contract': float(info.trade_contract_size or 0),
                'tick_value': float(info.trade_tick_value or 0),
                'tick_size': float(info.trade_tick_size or 0) or float(info.point),
                'vol_min': float(info.volume_min or 0), 'vol_max': float(info.volume_max or 0),
                'vol_step': float(info.volume_step or 0.01),
                'stops_level': int(info.trade_stops_level or 0),
                'freeze_level': int(info.trade_freeze_level or 0),
                'filling_mask': fm, 'trade_mode': int(info.trade_mode or 0),
                'currency_profit': str(info.currency_profit or 'USD'),
                'bid': float(t.bid) if (t is not None and t.bid) else 0.0,
                'ask': float(t.ask) if (t is not None and t.ask) else 0.0,
                'spread': int(info.spread or 0)}

    def _time_type(self, msg, req):
        """ORDER_TIME_GTC / DAY / SPECIFIED (+expiration datetime, tz-aware)."""
        tt = str(msg.get('type_time') or 'gtc').lower()
        if tt == 'day':
            req['type_time'] = mt5.ORDER_TIME_DAY
        elif tt == 'specified' and msg.get('expiration'):
            req['type_time'] = mt5.ORDER_TIME_SPECIFIED
            req['expiration'] = dt.datetime.fromtimestamp(int(msg['expiration']), tz=dt.timezone.utc)
        else:
            req['type_time'] = mt5.ORDER_TIME_GTC
        return req

    def trade_rpc(self, msg):
        err = self._connected_or_err()
        if err:
            return {'ok': False, 'error': err}
        op = str(msg.get('op') or '')
        if op == 'account':
            a = self._account_row()
            if a is None:
                return {'ok': False, 'error': 'account_info failed: ' + str(mt5.last_error())}
            return {'ok': True, 'data': a}
        if op == 'spec':
            s = self._spec_row(msg.get('symbol') or '')
            if s is None:
                return {'ok': False, 'error': 'unknown symbol ' + str(msg.get('symbol'))}
            return {'ok': True, 'data': s}
        if op == 'positions':
            rows = self._safe_rows(mt5.positions_get() or [], self._pos_row, 'position')
            return {'ok': True, 'data': {'positions': rows}}
        if op == 'orders':
            rows = self._safe_rows(mt5.orders_get() or [], self._order_row, 'order')
            return {'ok': True, 'data': {'orders': rows}}
        if op == 'state':
            a = self._account_row()
            if a is None:
                return {'ok': False, 'error': 'account_info failed: ' + str(mt5.last_error())}
            return {'ok': True, 'data': {'account': a,
                                         'positions': self._safe_rows(mt5.positions_get() or [], self._pos_row, 'position'),
                                         'orders': self._safe_rows(mt5.orders_get() or [], self._order_row, 'order')}}
        if op == 'history':
            to = int(msg.get('to') or (time.time() + 86400))
            frm = int(msg.get('from') or (to - 30 * 86400))
            # ROUND120 (user report — app history != terminal history): deal
            # epochs the terminal filters on are BROKER SERVER wall time while
            # the client's boundaries are device-wall epochs. Shift both
            # bounds into the broker base with the measured server offset, so
            # the window selects the same trades the terminal's History does.
            off = self.current_off()
            deals = mt5.history_deals_get(
                dt.datetime.fromtimestamp(frm + off, tz=dt.timezone.utc),
                dt.datetime.fromtimestamp(to + off, tz=dt.timezone.utc))
            # ROUND120: a position opened BEFORE the requested window but
            # closed INSIDE it used to come back without its IN deal — the
            # client dropped the whole group and the trade never appeared
            # (the count diverged from the terminal). Backfill the missing
            # position histories by position id (the docs' position= selector)
            # and merge, bounded so a pathological account cannot stall RPC.
            if deals is not None and len(deals):
                has_in = set()
                for d in deals:
                    try:
                        if int(d.entry) == 0 and int(d.position_id) > 0:
                            has_in.add(int(d.position_id))
                    except Exception:
                        continue
                missing = []
                for d in deals:
                    try:
                        pid = int(d.position_id)
                        if int(d.entry) in (1, 2, 3) and pid > 0 and pid not in has_in and pid not in missing:
                            missing.append(pid)
                    except Exception:
                        continue
                if missing:
                    rows_l = list(deals)
                    seen_t = set(int(d.ticket) for d in rows_l)
                    for pid in missing[:400]:
                        try:
                            extra = mt5.history_deals_get(position=pid)
                        except Exception:
                            extra = None
                        if extra:
                            for d in extra:
                                t_ = int(d.ticket)
                                if t_ not in seen_t:
                                    seen_t.add(t_)
                                    rows_l.append(d)
                    deals = rows_l
            if deals is None:
                return {'ok': True, 'data': {'deals': [], 'summary': {'profit': 0, 'trades': 0, 'wins': 0}}}
            rows = [self._deal_row(d) for d in deals]
            closed = [d for d in rows if d['entry'] == 1]  # DEAL_ENTRY_OUT
            prof = sum(d['profit'] + d['commission'] + d['swap'] for d in closed)
            wins = len([d for d in closed if (d['profit'] + d['commission'] + d['swap']) > 0])
            return {'ok': True, 'data': {'deals': rows,
                                         'summary': {'profit': round(prof, 2), 'trades': len(closed), 'wins': wins}}}
        if op == 'order_send':
            symbol = str(msg.get('symbol') or '')
            sym, info = ensure_symbol(symbol)
            if info is None:
                return {'ok': False, 'error': 'unknown symbol ' + symbol}
            try:
                volume = float(msg.get('volume') or 0)
            except Exception:
                volume = 0.0
            if volume <= 0:
                return {'ok': False, 'error': 'Invalid volume'}
            otype = int(msg.get('order_type') or 0)  # ORDER_TYPE_* numeric
            if not 0 <= otype <= 7:
                return {'ok': False, 'error': 'Invalid order type'}
            action = mt5.TRADE_ACTION_DEAL if otype in (0, 1) else mt5.TRADE_ACTION_PENDING
            req = {'action': action, 'symbol': sym, 'volume': volume,
                   'type': otype, 'magic': int(msg.get('magic') or 0),
                   'comment': str(msg.get('comment') or '')[:31],
                   'type_filling': self._norm_filling(info)}
            if otype in (0, 1):
                req['deviation'] = int(msg.get('deviation') if msg.get('deviation') is not None else 20)
                # round85b: the documented market request carries the CURRENT
                # price (ask for buy, bid for sell) — several terminal builds
                # reject a price-less TRADE_ACTION_DEAL with 10015/10013
                t = mt5.symbol_info_tick(sym)
                if t is None or not (t.ask > 0 or t.bid > 0):
                    return {'ok': False, 'error': 'No quotes for ' + sym + ' (market closed or symbol not tradable now)'}
                req['price'] = float(t.ask) if otype == 0 else float(t.bid)
            else:
                price = self._f(msg.get('price'))
                if price <= 0:
                    return {'ok': False, 'error': 'Invalid price'}
                req['price'] = price
                if otype in (6, 7):  # stop-limit needs the limit leg
                    sl_price = self._f(msg.get('stoplimit'))
                    if sl_price <= 0:
                        return {'ok': False, 'error': 'Stop-limit requires a limit price'}
                    req['stoplimit'] = sl_price
                self._time_type(msg, req)
            sl = self._f(msg.get('sl'))
            tp = self._f(msg.get('tp'))
            if sl > 0:
                req['sl'] = sl
            if tp > 0:
                req['tp'] = tp
            res, send_err = self._send_mt5(req)
            if send_err:
                return {'ok': False, 'error': send_err}
            return self._ret_res(res, {'retcode': int(res.retcode), 'comment': self._ret_txt(res.retcode, res.comment),
                                       'order': int(res.order or 0), 'deal': int(res.deal or 0),
                                       'volume': float(res.volume or 0), 'price': float(res.price or 0),
                                       'position': int(getattr(res, 'position', 0) or 0)})
        if op == 'close':
            # TRADE_ACTION_DEAL with `position` — the docs' standard close
            # path (partial when volume < position volume)
            ticket = int(msg.get('ticket') or 0)
            try:
                volume = float(msg.get('volume') or 0)  # 0 = full
            except Exception:
                volume = 0.0
            poss = mt5.positions_get(ticket=ticket) or []
            if not poss:
                return {'ok': False, 'error': 'Position ' + str(ticket) + ' not found'}
            p = poss[0]
            sym, info = ensure_symbol(p.symbol)
            if info is None:
                return {'ok': False, 'error': 'unknown symbol ' + p.symbol}
            t = mt5.symbol_info_tick(sym)
            if t is None:
                return {'ok': False, 'error': 'no tick for ' + sym}
            closing_type = mt5.ORDER_TYPE_SELL if p.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
            price = t.bid if p.type == mt5.POSITION_TYPE_BUY else t.ask
            req = {'action': mt5.TRADE_ACTION_DEAL, 'position': int(p.ticket), 'symbol': sym,
                   'volume': volume if volume > 0 else float(p.volume), 'type': closing_type,
                   'price': float(price), 'deviation': int(msg.get('deviation') if msg.get('deviation') is not None else 20),
                   'magic': int(p.magic or 0), 'comment': 'close from OJchart',
                   'type_filling': self._norm_filling(info)}
            res, send_err = self._send_mt5(req)
            if send_err:
                return {'ok': False, 'error': send_err}
            return self._ret_res(res, {'retcode': int(res.retcode), 'comment': self._ret_txt(res.retcode, res.comment),
                                       'order': int(res.order or 0), 'deal': int(res.deal or 0),
                                       'volume': float(res.volume or 0), 'price': float(res.price or 0)})
        if op == 'close_all':
            flt = str(msg.get('symbol') or '')
            closed, errs = 0, []
            for p in (mt5.positions_get() or []):
                if flt and p.symbol != flt:
                    continue
                r = self.trade_rpc({'op': 'close', 'ticket': int(p.ticket)})
                if r.get('ok'):
                    closed += 1
                else:
                    errs.append(str(p.ticket) + ': ' + str(r.get('error') or (r.get('data') or {}).get('comment') or 'failed'))
            return {'ok': True, 'data': {'closed': closed, 'errors': errs}}
        if op == 'modify_sltp':
            ticket = int(msg.get('ticket') or 0)
            poss = mt5.positions_get(ticket=ticket) or []
            if not poss:
                return {'ok': False, 'error': 'Position ' + str(ticket) + ' not found'}
            p = poss[0]
            req = {'action': mt5.TRADE_ACTION_SLTP, 'position': int(p.ticket), 'symbol': p.symbol,
                   'sl': self._f(msg.get('sl')), 'tp': self._f(msg.get('tp'))}
            res, send_err = self._send_mt5(req)
            if send_err:
                return {'ok': False, 'error': send_err}
            return self._ret_res(res, {'retcode': int(res.retcode), 'comment': self._ret_txt(res.retcode, res.comment)})
        if op == 'order_modify':
            ticket = int(msg.get('ticket') or 0)
            ords = mt5.orders_get(ticket=ticket) or []
            if not ords:
                return {'ok': False, 'error': 'Order ' + str(ticket) + ' not found'}
            o = ords[0]
            req = {'action': mt5.TRADE_ACTION_MODIFY, 'order': int(o.ticket),
                   'price': self._f(msg.get('price')) or float(o.price_open or 0),
                   'sl': self._f(msg.get('sl')), 'tp': self._f(msg.get('tp'))}
            self._time_type(msg, req)
            res, send_err = self._send_mt5(req)
            if send_err:
                return {'ok': False, 'error': send_err}
            return self._ret_res(res, {'retcode': int(res.retcode), 'comment': self._ret_txt(res.retcode, res.comment)})
        if op == 'order_cancel':
            ticket = int(msg.get('ticket') or 0)
            req = {'action': mt5.TRADE_ACTION_REMOVE, 'order': ticket}
            res, send_err = self._send_mt5(req)
            if send_err:
                return {'ok': False, 'error': send_err}
            return self._ret_res(res, {'retcode': int(res.retcode), 'comment': self._ret_txt(res.retcode, res.comment)})
        return {'ok': False, 'error': 'Unknown trade op: ' + op}

    # ---- MT5 terminal watchdog (r15): a CLOSED terminal is relaunched and
    # logged back in automatically, behind a LIVE websocket, with the Market
    # Watch (ENSURED symbols) restored and caches cleared ----
    def loops(self):
        async def watch_loop():
            while True:
                await asyncio.sleep(3)
                try:
                    ti = mt5.terminal_info()
                    if ti is not None and ti.connected:
                        if not self.connected:
                            self.connected = True
                            await self.broadcast({'type': 'mt5_status', 'state': 'ok'})
                        continue
                    if not self.connected:
                        continue
                    self.connected = False
                    print('MT5 terminal lost - relaunching', flush=True)
                    await self.broadcast({'type': 'mt5_status', 'state': 'reconnecting'})
                    # AUDIT FIX (network-drop hardening): this used to retry
                    # on a FIXED 2s interval for up to 30 attempts (~1 minute
                    # total), which is fine for a brief hiccup but floods the
                    # log with an identical "Authorization failed" line every
                    # 2 seconds for the whole duration of a longer outage
                    # (e.g. the user's ISP dropping for a few minutes), and
                    # gives up entirely after 1 minute even though the cause
                    # (no internet) is often still there. Now: exponential
                    # backoff (2s -> 4s -> 8s -> 16s, capped at 30s) and no
                    # attempt ceiling — it keeps trying, patiently, for as
                    # long as the terminal window stays open, which is what
                    # "auto-reconnect" should mean from the user's side.
                    delay = 2
                    attempt = 0
                    last_broadcast = 0.0
                    while not self.connected:
                        attempt += 1
                        try:
                            mt5.shutdown()
                        except Exception:
                            pass
                        await asyncio.sleep(delay)
                        if self._init_once(quiet=True):
                            _INIT_ONCE['done'] = True
                            DIG_CACHE.clear()
                            TICK_CACHE.clear()
                            for sym in list(ENSURED):
                                try:
                                    mt5.symbol_select(sym, True)
                                except Exception:
                                    pass
                            self.connected = True
                            print('MT5 relaunched + logged in (after %d attempt%s)' %
                                  (attempt, '' if attempt == 1 else 's'), flush=True)
                            await self.broadcast({'type': 'mt5_status', 'state': 'ok'})
                            break
                        # AUDIT FIX: only the FIRST failure of a run and then
                        # one summary line every ~20s are logged as WARN (not
                        # ERROR) — a reconnect-in-progress is expected
                        # behaviour, not an application error; the raw
                        # per-attempt "initialize failed" print from
                        # _init_once() is what used to spam ERROR level.
                        now = time.time()
                        if attempt == 1 or now - last_broadcast >= 20:
                            print('MT5 still reconnecting (attempt %d, next retry in %ds)' %
                                  (attempt, min(delay * 2, 30)), flush=True)
                            last_broadcast = now
                        delay = min(delay * 2, 30)
                except Exception:
                    pass

        async def off_heal_loop():
            # self-heals the offset every 30s (broker DST changes)
            while True:
                await asyncio.sleep(30)
                try:
                    # ROUND94: off the event loop, serialized with every other
                    # mt5.* call on the single data worker thread
                    await self._run_data(server_now)
                except Exception:
                    pass

        return [watch_loop(), off_heal_loop()]


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--login', default='')
    ap.add_argument('--password', default='')
    ap.add_argument('--server', default='')
    ap.add_argument('--path', default='')
    ap.add_argument('--tick-interval', type=float, default=None,
                    help='seconds between tick_loop polls (refresh rate, not network ping)')
    a = ap.parse_args()
    # ROUND104 (security): the broker password arrives in the environment, not
    # on argv. A process' command line is readable by any other process on the
    # machine (ps / Task Manager "Command line" / WMI), so --password leaked
    # the credential to every local user for as long as the provider ran.
    # The environment block is owner-readable only. --password is still
    # accepted so an older launcher keeps working.
    pw = os.environ.pop('OJCHART_MT5_PASSWORD', None)
    if pw is None:
        pw = a.password
    b = MT5Broker(a.login, pw, a.server, a.path)
    if a.tick_interval is not None:
        from provider_common import clamp_tick_interval
        b.tick_interval = clamp_tick_interval(a.tick_interval)
    if not b.connect():
        sys.exit(4)
    import asyncio
    asyncio.run(b.run())
