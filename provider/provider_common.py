import asyncio, json, math, os, sys, tempfile, faulthandler, traceback
import concurrent.futures
import datetime as dt
import calendar

_CRASH_LOG = os.path.join(tempfile.gettempdir(), 'mt5_provider_crash.log')
faulthandler.enable(open(_CRASH_LOG, 'w'))

HOST, PORT = '127.0.0.1', int(os.environ.get('MT5_WS_PORT', '8777'))

TF_SEC = {
    'S1': 1, 'S5': 5, 'S15': 15, 'S30': 30,
    'M1': 60, 'M3': 180, 'M5': 300, 'M15': 900, 'M30': 1800, 'M45': 2700,
    'H1': 3600, 'H2': 7200, 'H3': 10800, 'H4': 14400,
    'D1': 86400, 'W1': 604800,
    'MN1': 2592000, 'MN3': 7776000, 'MN6': 15552000, 'MN12': 31104000,
}

try:
    from websockets.asyncio.server import serve as ws_serve  # websockets >= 13
except ImportError:
    from websockets import serve as ws_serve  # legacy API


def j(obj):
    return json.dumps(obj, separators=(',', ':'))


def bucket_start(tf, t):
    """Start epoch of the bar containing t (UTC)."""
    if tf in ('S1', 'S5', 'S15', 'S30', 'M1', 'M3', 'M5', 'M15', 'M30', 'M45', 'H1', 'H2', 'H3', 'H4'):
        s = TF_SEC[tf]
        return t - t % s
    if tf == 'D1':
        return t - t % 86400
    if tf == 'W1':
        day = (t // 86400 + 4) % 7  # epoch day 0 = Thursday
        return (t // 86400 - day) * 86400
    d = dt.datetime.utcfromtimestamp(t)
    m = d.month - 1
    if tf == 'MN3':
        m -= m % 3
    elif tf == 'MN6':
        m -= m % 6
    elif tf == 'MN12':
        m = 0
    # ROUND94: timegm, not naive .timestamp() — the latter re-reads the value in the
    # MACHINE's local tz (UTC+3:30 shifted every MN3/MN6/MN12 bucket by -3.5h)
    return calendar.timegm((d.year, m + 1, 1, 0, 0, 0))


def aggregate_ticks(ticks, tf, count, price_of):
    """ticks: iterable of (epoch, price); returns OHLC list."""
    sec = TF_SEC[tf]
    out = []
    cur = None
    for t, px in ticks:
        if px <= 0:
            continue
        bt = bucket_start(tf, int(t))
        if cur is None or bt != cur['time']:
            if cur is not None:
                out.append(cur)
            cur = {'time': bt, 'open': px, 'high': px, 'low': px, 'close': px, 'volume': 1}
        else:
            cur['high'] = max(cur['high'], px)
            cur['low'] = min(cur['low'], px)
            cur['close'] = px
            cur['volume'] += 1
    if cur is not None:
        out.append(cur)
    return out[-count:]


def aggregate_bars(bars, tf, count):
    """Merge native bars into higher app-built buckets (e.g. M45 from M15).
    Bucket anchors match the renderer's bucketStartFor for the same tf."""
    out = []
    cur = None
    for b in bars:
        bt = bucket_start(tf, int(b['time']))
        if cur is None or bt != cur['time']:
            if cur is not None:
                out.append(cur)
            cur = {'time': bt, 'open': b['open'], 'high': b['high'],
                   'low': b['low'], 'close': b['close'], 'volume': int(b['volume'])}
        else:
            cur['high'] = max(cur['high'], b['high'])
            cur['low'] = min(cur['low'], b['low'])
            cur['close'] = b['close']
            cur['volume'] += int(b['volume'])
    if cur is not None:
        out.append(cur)
    return out[-count:]


# ============================ economic news calendar ============================
# ROUND39: deterministic (per UTC date) economic-calendar generator shared by
# the demo AND mt5 providers — the renderer's Economic News panel + chart
# marks feed off it via the 'news' ws request. No external network (CSP only
# allows the local provider anyway); the schedule below mirrors the real
# release rhythm (NFP first Friday, CPI mid-month, central-bank rate cycles,
# weekly claims/inventories) so the UI behaves like a live calendar.
def _nday_seed(name, day):
    import hashlib
    h = hashlib.md5((name + '|' + day.isoformat()).encode()).hexdigest()
    return int(h[:8], 16)


def _first_weekdayday(y, m, weekday):
    """Epoch day-of-month of the first `weekday` (0=Mon) in month m of year y."""
    d = dt.date(y, m, 1)
    return d + dt.timedelta(days=(weekday - d.weekday()) % 7)


def _every_n_weeks(y, m, dd, weekday, cycle):
    """Approximate a ~N-weekly release cycle (rate decisions): True when the
    month/day sits on the cycle lattice (deterministic, stable per month)."""
    return ((m * 31 + dd) % cycle) < 7 and dt.date(y, m, dd).weekday() == weekday


def _val(seed, lo, hi, step, unit):
    v = lo + (seed % max(1, (hi - lo) // step + 1)) * step
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return (s + unit) if unit else s


def news_calendar(now=None, window_h=48):
    """Return economic events in [now-window_h, now+window_h], sorted by time.
    Event: {time (epoch SEC), currency, impact 'high'|'med'|'low', name,
            actual, forecast, previous} — actual omitted for future events."""
    now = int(now if now is not None else dt.datetime.now(dt.timezone.utc).timestamp())
    t0 = now - window_h * 3600
    t1 = now + window_h * 3600
    out = []
    base = dt.datetime.utcfromtimestamp(now).date()

    def mk(day, hh, mm, ccy, imp, name, fc_lo, fc_hi, fc_step, unit='%'):
        nonlocal out
        ts = int(dt.datetime(day.year, day.month, day.day, hh, mm,
                             tzinfo=dt.timezone.utc).timestamp())
        if ts < t0 or ts > t1:
            return
        s = _nday_seed(name, day)
        speech = (fc_lo == 0 and fc_hi == 0)  # speeches carry no numbers
        prev = '' if speech else _val(s, fc_lo, fc_hi, fc_step, unit)
        fcst = '' if speech else _val(s >> 3, fc_lo, fc_hi, fc_step, unit)
        ev = {'time': ts, 'currency': ccy, 'impact': imp, 'name': name,
              'forecast': fcst, 'previous': prev}
        if ts <= now:  # released -> deterministic actual near forecast
            ev['actual'] = '' if speech else _val(s >> 6, fc_lo, fc_hi, fc_step, unit)
        out.append(ev)

    for k in range(-3, 4):
        d = base + dt.timedelta(days=k)
        wd = d.weekday()
        y, m, dd = d.year, d.month, d.day
        f_fri = _first_weekdayday(y, m, 4)
        # ---- USD ----
        if d == f_fri:
            mk(d, 13, 30, 'USD', 'high', 'Nonfarm Payrolls', 120000, 320000, 5000, 'K')
            mk(d, 13, 30, 'USD', 'med', 'Unemployment Rate', 3.4, 4.4, 0.1, '%')
        if d == f_fri + dt.timedelta(days=2):
            mk(d, 13, 30, 'USD', 'high', 'CPI m/m', 0.1, 0.7, 0.1, '%')
        if d == f_fri + dt.timedelta(days=7):
            mk(d, 13, 30, 'USD', 'med', 'Retail Sales m/m', -0.4, 1.2, 0.1, '%')
        if wd == 3:  # Thursday
            mk(d, 13, 30, 'USD', 'med', 'Unemployment Claims', 200000, 280000, 1000, 'K')
        if wd == 2:  # Wednesday
            mk(d, 14, 30, 'USD', 'med', 'Crude Oil Inventories', -4.0, 6.0, 0.5, 'M')
            if _every_n_weeks(y, m, dd, 2, 6):
                mk(d, 19, 0, 'USD', 'high', 'FOMC Statement — Federal Funds Rate', 3.75, 5.5, 0.25, '%')
                mk(d, 19, 30, 'USD', 'high', 'FOMC Press Conference', 0, 0, 1, '')
        if wd == 0:
            mk(d, 15, 0, 'USD', 'low', 'FOMC Member Speech', 0, 0, 1, '')
        if d.day == 1:
            mk(d, 15, 0, 'USD', 'med', 'ISM Manufacturing PMI', 46.0, 53.0, 0.5, '')
        # ---- EUR ----
        if d.day == 10:
            mk(d, 10, 0, 'EUR', 'high', 'CPI Flash Estimate y/y', 1.9, 3.4, 0.1, '%')
        if d.day == 14:
            mk(d, 10, 0, 'EUR', 'med', 'GDP q/q', 0.0, 0.5, 0.1, '%')
        if _every_n_weeks(y, m, dd, 3, 6):
            mk(d, 12, 45, 'EUR', 'high', 'ECB Monetary Policy Statement — Deposit Rate', 2.0, 4.0, 0.25, '%')
            mk(d, 13, 45, 'EUR', 'high', 'ECB Press Conference', 0, 0, 1, '')
        if wd == 1:
            mk(d, 9, 0, 'EUR', 'low', 'ECB Lane Speech', 0, 0, 1, '')
        # ---- GBP ----
        if d.day == 20:
            mk(d, 7, 0, 'GBP', 'high', 'CPI y/y', 2.5, 4.5, 0.1, '%')
        if _every_n_weeks(y, m, dd, 3, 6):
            mk(d, 11, 0, 'GBP', 'high', 'MPC Official Bank Rate Vote', 4.0, 5.5, 0.25, '%')
        if wd == 2:
            mk(d, 9, 30, 'GBP', 'low', 'BoE Gov Speech', 0, 0, 1, '')
        # ---- JPY ----
        if _every_n_weeks(y, m, dd, 4, 6):
            mk(d, 3, 0, 'JPY', 'high', 'BOJ Policy Rate', -0.1, 0.5, 0.1, '%')
        if d.day == 15:
            mk(d, 23, 50, 'JPY', 'med', 'National Core CPI y/y', 1.8, 3.2, 0.1, '%')
        # ---- CAD ----
        if _every_n_weeks(y, m, dd, 2, 6):
            mk(d, 14, 0, 'CAD', 'high', 'BOC Interest Rate Decision', 2.25, 5.0, 0.25, '%')
        if d == f_fri:
            mk(d, 12, 30, 'CAD', 'med', 'Employment Change', 5.0, 45.0, 2.5, 'K')
        # ---- AUD ----
        if wd == 1 and 1 <= dd <= 7:
            mk(d, 4, 30, 'AUD', 'high', 'RBA Interest Rate Decision', 3.6, 4.6, 0.25, '%')
        if d.day == 15:
            mk(d, 0, 30, 'AUD', 'med', 'Employment Change', 10.0, 50.0, 2.5, 'K')
        # ---- NZD ----
        if _every_n_weeks(y, m, dd, 2, 7):
            mk(d, 2, 0, 'NZD', 'high', 'RBNZ Interest Rate Decision', 2.5, 5.5, 0.25, '%')
        if d.day == 20:
            mk(d, 22, 45, 'NZD', 'low', 'Trade Balance', -200, 400, 50, 'M')
        # ---- CHF ----
        if _every_n_weeks(y, m, dd, 3, 12):
            mk(d, 7, 30, 'CHF', 'high', 'SNB Policy Rate', 0.0, 2.0, 0.25, '%')
        if d.day == 5:
            mk(d, 6, 45, 'CHF', 'med', 'CPI m/m', -0.1, 0.4, 0.1, '%')
        # ---- CNY ----
        if d.day == 10:
            mk(d, 2, 0, 'CNY', 'med', 'Trade Balance', 40.0, 110.0, 5.0, 'B')
        if d.day == 17:
            mk(d, 2, 0, 'CNY', 'med', 'Industrial Production y/y', 3.5, 7.5, 0.5, '%')
    out.sort(key=lambda e: e['time'])
    return out


# ---------------- ROUND65: REAL economic calendar (ForexFactory feed) -------
# The r39 generator above only MIMICS a release rhythm — fixed fake UTC slots
# (claims 13:30Z, ECB 12:45Z/13:45Z, flash CPI 10:00Z…) and a tiny hardcoded
# event set. On a live terminal the user checks the panel + the chart news
# lines against the REAL calendar (ForexFactory — their reference screenshot),
# so MT5 mode must serve the real thing: the weekly JSON feed the ForexFactory
# site itself renders (nfs.faireconomy.media). Dates arrive ISO8601 WITH an
# explicit UTC offset and are parsed to TRUE UTC here — the r64 wire contract
# (renderer applies the broker offset once, then the user's selected chart
# timezone) stays untouched. Feed unreachable and nothing cached -> None and
# the MT5 provider falls back to the synthetic generator: the panel never
# goes blank, offline still works, demo/tests stay deterministic.
_FF_TTL = 1800  # 30 min between live fetches ('news' is polled every 5 min)
_FF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
_FF_IMPACT = {'High': 'high', 'Medium': 'med', 'Low': 'low', 'Holiday': 'low'}
_FF_HOSTS = ('https://nfs.faireconomy.media', 'https://cdn-nfs.faireconomy.media')
_FF_FAIL_TTL = 600  # after a failed round, don't hit the network again for 10 min
_ff_cache = {'ts': 0, 'events': None, 'fail_ts': 0}


def _ff_parse(items):
    """Feed rows -> the app's event dict contract. TRUE UTC epoch seconds."""
    out = []
    for e in items or []:
        try:
            t = dt.datetime.fromisoformat(str(e.get('date') or '').replace('Z', '+00:00'))
            ts = int(t.timestamp())
            name = str(e.get('title') or '').strip()
            ccy = str(e.get('country') or '').upper().strip()
        except Exception:
            continue
        if not name or not ts:
            continue
        out.append({'time': ts, 'currency': ccy or 'ALL',
                    'impact': _FF_IMPACT.get(str(e.get('impact') or ''), 'low'),
                    'name': name,
                    'forecast': str(e.get('forecast') or ''),
                    'previous': str(e.get('previous') or '')})
    out.sort(key=lambda x: x['time'])
    # thisweek + nextweek overlap -> dedupe on (time, currency, name)
    seen, uniq = set(), []
    for e in out:
        k = (e['time'], e['currency'], e['name'])
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    return uniq


def _ff_get(url):
    import urllib.request
    req = urllib.request.Request(url, headers={
        'User-Agent': _FF_UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def _ff_fetch():
    """One fetch round: thisweek (mandatory, tries each mirror host) +
    nextweek (best-effort, only on the host that answered)."""
    last = None
    for host in _FF_HOSTS:
        try:
            events = list(_ff_get(host + '/ff_calendar_thisweek.json'))
        except Exception as e:
            last = e
            continue
        try:
            events += _ff_get(host + '/ff_calendar_nextweek.json')
        except Exception:
            pass  # nextweek is optional coverage; ignore its failures
        return events
    raise last if last else RuntimeError('no calendar host configured')


def news_ff(now=None):
    """REAL economic calendar for the MT5 provider (ROUND65). Cached _FF_TTL.
    Returns None when the feed is unreachable and nothing was ever fetched —
    the caller (mt5.py 'news' hook) then serves news_calendar() instead.
    A failed round is remembered for _FF_FAIL_TTL so an unreachable feed
    (offline PC, filtered network, 429) is not retried on every 5-min poll,
    and it logs ONE short line instead of a full traceback."""
    now = int(now if now is not None else dt.datetime.now(
        dt.timezone.utc).timestamp())
    if _ff_cache['events'] is not None and now - _ff_cache['ts'] < _FF_TTL:
        return _ff_cache['events']
    if _ff_cache['fail_ts'] and now - _ff_cache['fail_ts'] < _FF_FAIL_TTL:
        return _ff_cache['events']  # recent failure: serve stale/None, no network
    try:
        events = _ff_parse(_ff_fetch())
    except Exception as e:
        _ff_cache['fail_ts'] = now
        # deliberately NOT traceback.print_exc(): an unreachable feed is an
        # expected condition with a working fallback, not an app error
        print('news: live calendar unreachable, using offline calendar (%s)'
              % (str(e) or type(e).__name__)[:100], file=sys.stderr, flush=True)
        events = []
    if events:
        _ff_cache['ts'] = now
        _ff_cache['fail_ts'] = 0
        _ff_cache['events'] = events
        return events
    return _ff_cache['events']  # None until one good fetch lands


# Refresh-rate presets for tick_loop (seconds between polls of the terminal/
# feed for a fresh price). This is NOT network ping -- it only controls how
# often we ask an already-connected source "do you have a new price yet?".
# Real network latency to the broker's server is shown separately by the
# server-scan ping (server_ping_ms). Clamped so a bad/typo value from the
# client can't spin the loop or starve it.
TICK_INTERVAL_MIN = 0.05
TICK_INTERVAL_MAX = 1.0
TICK_INTERVAL_DEFAULT = 0.2

# ROUND174: trading-RPC budget. The client times trade requests out at 20s;
# the provider must always answer first (see run_trade). A hung MT5 terminal
# call past this becomes an error reply, never a silent loop freeze.
TRADE_RPC_TIMEOUT = 15


def clamp_tick_interval(v):
    try:
        v = float(v)
    except Exception:
        return TICK_INTERVAL_DEFAULT
    if v != v:  # NaN
        return TICK_INTERVAL_DEFAULT
    return max(TICK_INTERVAL_MIN, min(TICK_INTERVAL_MAX, v))


class Broker:
    """Minimal ws server shared by demo/mt5 providers. Subclass implements the hooks."""
    def __init__(self):
        self.subs = {}  # ws -> set(symbols)
        self.off = 0    # broker server-tz offset estimate (seconds), sent on ticks
        self.tick_interval = TICK_INTERVAL_DEFAULT  # refresh-rate setting (see above)
        # ROUND86C (user report: "Request timeout: bars_req" on a REAL broker
        # — none of the Go to Date parts worked): the MT5 package calls are
        # BLOCKING. get_bars ran directly inside the async ws handler, so the
        # first bars_req{to} for history the terminal has not downloaded yet
        # (archive sync — seconds to minutes on a real broker) froze the WHOLE
        # event loop: no bars reply, no ticks, no pings, every queued request
        # timed out client-side. All heavy data calls now run on this DEDICATED
        # SINGLE-THREAD executor: the loop never blocks AND mt5.* calls stay
        # serialized (the package is not safe under concurrent callers).
        self._data_exec = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix='mt5data')

    async def _run_data(self, fn, *args):
        """Run a blocking provider data hook off the event loop. The loop
        keeps answering pings/ticks/trade while an archive sync chews in the
        worker thread."""
        return await asyncio.get_running_loop().run_in_executor(self._data_exec, fn, *args)

    def current_off(self):
        return int(getattr(self, 'off', 0))

    # ---- hooks to override ----
    def do_login(self, msg):
        return True, ''

    def get_bars(self, symbol, tf, count, to=None):
        return []

    def get_digits(self, symbol):
        return 5

    def search(self, query):
        return []

    def news(self):
        """Economic calendar (ROUND39): shared deterministic generator — both
        providers serve the same wire shape; override for a real feed."""
        return news_calendar()

    def next_tick(self, symbol):
        return None  # (price, volume) or None

    # ---- ROUND85: TRADING BRIDGE (order execution from the app) ----------
    # Generic trading RPC hook. msg carries {'type':'trade', 'op': ...} plus
    # op-specific fields; the reply is ALWAYS sent (round-36 rule — a dropped
    # reply left the UI hanging for its full timeout):
    #   {'type':'trade', 'req_id': n, 'op': op, 'ok': True/False, 'data': {...}}
    # (the renderer's feed resolves req/replies and rejects when ok:false, so
    # both branches surface as promise result/rejection at the call site).
    # The base broker does not trade — demo.py and mt5.py implement the hook.
    def trade_rpc(self, msg):
        return {'ok': False, 'error': 'Trading is not supported by this provider'}

    # ---- ROUND55: broker access servers (MT5 login-dialog parity) ----
    def server_entries(self):
        """The broker's access-server list for the scan section.
        Base broker: none (subclasses override)."""
        return []

    async def server_ping_ms(self, name):
        """Round-trip ms for ONE access server, measured on the provider side
        of the scan socket. None = not measurable (row renders as '—').
        Demo overrides with its per-server latency profile; the MT5 bridge
        measures the real terminal round trip."""
        return None

    # ---- server ----
    async def run_trade(self, msg):
        """Execute one trading RPC off the event loop with a timeout (see
        the ROUND174 note at the 'trade' handler). Always returns a dict."""
        try:
            res = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(self._data_exec, self.trade_rpc, msg),
                timeout=TRADE_RPC_TIMEOUT)
        except asyncio.TimeoutError:
            res = {'ok': False, 'error': 'trade op timed out after %ds (terminal may be disconnected — check MT5 + restart the provider if it persists)' % int(TRADE_RPC_TIMEOUT)}
        except Exception:
            traceback.print_exc()
            res = {'ok': False, 'error': 'trade op failed (provider error)'}
        if not isinstance(res, dict):
            res = {'ok': False, 'error': 'bad trade hook result'}
        return res

    async def handler(self, ws):
        self.subs[ws] = set()
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                t = msg.get('type')
                try:
                    if t == 'ping':
                        await ws.send(j({'type': 'pong'}))
                    elif t == 'refresh_rate':
                        # get/set the tick_loop poll interval (refresh rate),
                        # kept distinct from server ping -- see the comment
                        # above TICK_INTERVAL_DEFAULT. Omitting 'value' just
                        # reads the current setting.
                        if 'value' in msg:
                            self.tick_interval = clamp_tick_interval(msg.get('value'))
                        await ws.send(j({'type': 'refresh_rate', 'req_id': msg.get('req_id'),
                                         'value': self.tick_interval,
                                         'min': TICK_INTERVAL_MIN, 'max': TICK_INTERVAL_MAX}))
                    elif t == 'servers':
                        # ROUND55: scan list (no login required, like 'ping')
                        ent = []
                        try:
                            ent = self.server_entries() or []
                        except Exception:
                            ent = []
                        await ws.send(j({'type': 'servers', 'req_id': msg.get('req_id'), 'servers': ent}))
                    elif t == 'servers_ping':
                        # ROUND55: one server's round trip; the hook measures
                        # (demo sleeps its latency profile -> the client's
                        # measured RTT differs realistically per server)
                        name = msg.get('name', '')
                        try:
                            ms = await self.server_ping_ms(name)
                        except Exception:
                            ms = None
                        await ws.send(j({'type': 'servers_ping', 'req_id': msg.get('req_id'), 'name': name, 'ping': ms}))
                    elif t == 'login':
                        ok, err = self.do_login(msg)
                        if ok:
                            await ws.send(j({'type': 'login_ok', 'server': self.name, 'off': self.current_off()}))
                        else:
                            await ws.send(j({'type': 'login_failed', 'error': err or 'Login failed'}))
                    elif t == 'bars_req':
                        sym = msg.get('symbol', '')
                        tf = msg.get('timeframe', 'M1')
                        cnt = int(msg.get('count', 1500))
                        # `to` (exclusive epoch seconds) = older-history page
                        # request: return bars ending strictly BEFORE it
                        # ("Load older bars" pagination, parity with the
                        # reference platform). None = live tail as before.
                        to_v = msg.get('to')
                        try:
                            to_v = int(to_v) if to_v is not None else None
                        except Exception:
                            to_v = None
                        # ROUND86C: get_bars runs OFF the event loop (a real
                        # terminal syncs its archive INSIDE the blocking
                        # copy_rates_* call — that used to freeze the whole
                        # provider and the reply never went out -> the client's
                        # "request timeout: bars_req"). The hook now ALWAYS
                        # answers, even when get_bars raises (round-36 rule:
                        # a dropped reply leaves the UI hanging for its full
                        # timeout) — an error degrades to an empty payload
                        # which every caller already polls.
                        try:
                            bars = await self._run_data(
                                lambda: self.get_bars(sym, tf, cnt, to=to_v)) or []
                        except Exception:
                            traceback.print_exc()
                            bars = []
                        await ws.send(j({'type': 'bars', 'req_id': msg.get('req_id'), 'symbol': sym,
                                         'timeframe': tf, 'digits': self.get_digits(sym),
                                         'off': self.current_off(), 'bars': bars}))
                    elif t == 'subscribe':
                        # Subscription requests are state mutations, but the
                        # renderer uses request/reply semantics. ACK them
                        # explicitly so the client never waits 20s for a
                        # response that the provider intentionally omitted.
                        sym = msg.get('symbol')
                        if isinstance(sym, str) and sym:
                            bucket = self.subs.get(ws)
                            if bucket is not None:
                                bucket.add(sym)
                        await ws.send(j({'type': 'subscribe', 'req_id': msg.get('req_id'),
                                         'symbol': sym}))
                    elif t == 'unsubscribe':
                        sym = msg.get('symbol')
                        bucket = self.subs.get(ws)
                        if bucket is not None and isinstance(sym, str):
                            bucket.discard(sym)
                        await ws.send(j({'type': 'unsubscribe', 'req_id': msg.get('req_id'),
                                         'symbol': sym}))
                    elif t == 'symbol_search':
                        # ROUND36 hardening: the hook's result is sent even if
                        # it RAISES (empty list instead of NO reply — a dropped
                        # reply left the UI hanging for its full 20s timeout
                        # with a silently empty search, the user's report).
                        # 'total' = exact match count; 'symbols' is capped for
                        # the wire (400 names) — the dialog's "N symbols"
                        # footer stays truthful for 5000-symbol brokers.
                        try:
                            res = self.search(msg.get('query', '')) or []
                        except Exception:
                            traceback.print_exc()
                            res = []
                        await ws.send(j({'type': 'symbol_search', 'req_id': msg.get('req_id'),
                                         'symbols': res[:400], 'total': len(res)}))
                    elif t == 'news':
                        # ROUND39: economic calendar for the Economic News panel
                        # + chart marks. Always answers (round-36 rule).
                        # ROUND64 (user report — stale double-clock fixed):
                        # times now go over the wire as TRUE UTC and the
                        # renderer applies the broker offset ONCE, at render
                        # time, through the SAME live feed.serverOff the axis
                        # and clock use. The old contract shifted the stamps
                        # here with the offset captured at fetch time — on a
                        # fresh boot (offset not yet measured) or a weekend
                        # restart (stale persisted estimate) that shifted the
                        # news by the WRONG amount while the bars kept their
                        # true server labels, so every news line sat one
                        # broker-offset away from the bar where the release
                        # actually happened, no matter what the user's chart
                        # timezone was. One clock, applied where it is drawn.
                        try:
                            # network fetch can take seconds: run it OFF the
                            # event loop (own pool thread, not the serialized
                            # mt5 data executor) so ticks/pings never stall
                            items = await asyncio.get_running_loop().run_in_executor(
                                None, self.news) or []
                        except Exception:
                            traceback.print_exc()
                            items = []
                        await ws.send(j({'type': 'news', 'req_id': msg.get('req_id'),
                                         'news': items}))
                    elif t == 'trade':
                        # ROUND85: trading bridge (order execution + live trade
                        # management from the app). Always answers, even when
                        # the hook raises (round-36 rule) — a dropped reply
                        # would leave the ticket/panel hanging for its full
                        # 20s timeout. op echoes back so the client can route.
                        # ROUND174 (user log: trade + bars_req timeouts TOGETHER
                        # after adding a script — the MT5 terminal hung and the
                        # hook ran INLINE on the event loop, freezing ticks,
                        # pings and bars with it): the hook now runs on the
                        # data executor with a timeout, so one hung terminal
                        # call degrades to an error reply instead of a silent
                        # whole-provider stall (check the MT5 terminal +
                        # restart the provider if timeouts persist).
                        op = msg.get('op', '')
                        try:
                            res = await self.run_trade(msg)
                        except Exception:
                            traceback.print_exc()
                            res = {'ok': False, 'error': 'trade op failed (provider error)'}
                        if not isinstance(res, dict):
                            res = {'ok': False, 'error': 'bad trade hook result'}
                        out = {'type': 'trade', 'req_id': msg.get('req_id'), 'op': op}
                        out.update(res)
                        await ws.send(j(out))
                    elif t == 'echo':
                        await ws.send(raw)
                except Exception:
                    traceback.print_exc()
        except Exception:
            pass
        finally:
            # Idempotent cleanup: tick_loop may have already removed this
            # websocket after a failed send.
            self.subs.pop(ws, None)

    async def tick_loop(self):
        while True:
            await asyncio.sleep(self.tick_interval)
            if not self.subs:
                continue
            # Take a stable snapshot before doing any await. WebSocket
            # handlers can add/remove connections while tick_loop is awaiting
            # network I/O. Iterating the live dict across an await caused the
            # production crash: "dictionary changed size during iteration".
            # Copy both the mapping and symbol sets so this loop has an
            # immutable view for the whole tick cycle.
            snapshot = [(ws, set(syms)) for ws, syms in list(self.subs.items())]
            if not snapshot:
                continue
            needed = set()
            for _, syms in snapshot:
                needed |= syms
            for sym in sorted(needed):
                # ROUND86C: the tick hook also runs off the loop so a long
                # history sync in the shared worker only DELAYS ticks (they
                # queue behind it, same as the old freeze behaviour) without
                # ever freezing replies/pings/trade. Serialized on the SAME
                # single-thread executor -> mt5.* is never called
                # concurrently from two threads.
                try:
                    tk = await self._run_data(self.next_tick, sym)
                except Exception:
                    traceback.print_exc()
                    continue
                if not tk:
                    continue
                # hook may return (price, vol), (price, vol, epoch_sec) or
                # (price, vol, epoch_sec, bid, ask) — the 3rd element lets MT5
                # stamp ticks in SERVER time so they land in the same time base
                # as history bars (see mt5.py); bid/ask feed the renderer's
                # Bid and Ask price lines (absent on the demo provider = fine)
                price, vol = tk[0], tk[1]
                tsec = int(tk[2]) if len(tk) > 2 else int(dt.datetime.now().timestamp())
                m = {'type': 'tick', 'symbol': sym, 'time': tsec,
                     'price': price, 'volume': vol, 'off': self.current_off(),
                     # BUG-F/R25: the symbol's real digit count rides on every
                     # tick so the renderer can express spreads in POINTS
                     # (ask-bid / 10^-digits) instead of raw price decimals —
                     # the old regex heuristic missed broker-specific symbols
                     # (DJIUSD, NDXUSD, BRNUSD, ...) and printed decimals.
                     # Both providers cache get_digits, so this is cheap.
                     'digits': self.get_digits(sym)}
                if len(tk) > 4 and tk[3] and tk[4]:
                    m['bid'] = float(tk[3])
                    m['ask'] = float(tk[4])
                msg = j(m)
                dead = []
                # Use the same stable snapshot; NEVER iterate self.subs while
                # awaiting ws.send(). The handler may remove a dead socket at
                # any await point.
                for ws, syms in snapshot:
                    if sym not in syms:
                        continue
                    try:
                        await ws.send(msg)
                    except Exception:
                        dead.append(ws)
                # Cleanup is deliberately performed from a snapshot too.
                # pop(..., None) is idempotent because the handler may already
                # have removed the same websocket.
                for ws in dead:
                    self.subs.pop(ws, None)

    async def broadcast(self, obj):
        msg = j(obj)
        dead = []
        for ws in list(self.subs.keys()):
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.subs.pop(ws, None)

    def loops(self):
        """extra background loops (watchdog, offset self-heal) — override"""
        return []

    async def run(self):
        async with ws_serve(self.handler, HOST, PORT, ping_interval=20, ping_timeout=20, max_size=64 * 1024 * 1024):
            print(f'[{self.name}] provider listening on ws://{HOST}:{PORT}', flush=True)
            extra = self.loops()
            if extra:
                await asyncio.gather(self.tick_loop(), *extra)
            else:
                await self.tick_loop()


def main(broker_cls):
    try:
        b = broker_cls()
        asyncio.run(b.run())
    except OSError as e:
        print('PORT_IN_USE' if '10048' in str(e) or 'address already in use' in str(e).lower() else str(e), flush=True)
        sys.exit(2)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
