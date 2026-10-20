"""Simulated market data provider — any symbol, all timeframes, live ticks."""
import asyncio, random, time, math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from provider_common import Broker, TF_SEC, main, bucket_start

SYMBOLS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
    'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CHFJPY',
    'XAUUSD', 'XAGUSD', 'BTCUSD', 'ETHUSD',
    'USOIL', 'UKOIL', 'NATGAS',
    'US30', 'NAS100', 'SPX500', 'GER40', 'UK100', 'JP225', 'HK50',
    'AAPL', 'MSFT', 'TSLA', 'AMZN', 'GOOGL', 'META', 'NVDA',
]
BASE = {
    'EURUSD': 1.0850, 'GBPUSD': 1.2700, 'USDJPY': 149.50, 'USDCHF': 0.8850,
    'USDCAD': 1.3600, 'AUDUSD': 0.6550, 'NZDUSD': 0.6050, 'EURGBP': 0.8540,
    'EURJPY': 162.20, 'GBPJPY': 189.80, 'AUDJPY': 97.90, 'CHFJPY': 168.9,
    'XAUUSD': 2325.0, 'XAGUSD': 28.50, 'BTCUSD': 64500.0, 'ETHUSD': 3350.0,
    'USOIL': 78.50, 'UKOIL': 82.30, 'NATGAS': 2.35,
    'US30': 39000.0, 'NAS100': 18200.0, 'SPX500': 5250.0, 'GER40': 18400.0,
    'UK100': 8150.0, 'JP225': 38500.0, 'HK50': 18400.0,
    'AAPL': 215.0, 'MSFT': 420.0, 'TSLA': 250.0, 'AMZN': 180.0, 'GOOGL': 175.0,
    'META': 500.0, 'NVDA': 120.0,
}
DIGITS = {
    'USDJPY': 3, 'EURJPY': 3, 'GBPJPY': 3, 'AUDJPY': 3, 'CHFJPY': 3,
    'XAUUSD': 2, 'XAGUSD': 3, 'BTCUSD': 2, 'ETHUSD': 2,
    'USOIL': 2, 'UKOIL': 2, 'NATGAS': 3,
    'US30': 1, 'NAS100': 1, 'SPX500': 2, 'GER40': 1, 'UK100': 1, 'JP225': 1, 'HK50': 1,
    'AAPL': 2, 'MSFT': 2, 'TSLA': 2, 'AMZN': 2, 'GOOGL': 2, 'META': 2, 'NVDA': 2,
}

BASE_PRICE = {}
LIVE = {}
HIST = {}  # (sym, tf) -> bars (DEEP cache — see gen_history)

# history-depth parity with the reference platform: the cache used to hold
# only as many bars as the FIRST request asked for, so a later deeper request
# (or an "older bars" page) returned the SAME tail — the demo chart could
# never show more candles than the initial load. We now generate a deep
# series once per (symbol, tf) and slice every request from it.
DEEP_N = 25000
# ...but a deep cache of monthly bars would reach before the epoch: cap the
# generated span at ~54 years per timeframe (epoch-safe for every TF).
DEEP_SPAN_CAP_SEC = int(54 * 365.25 * 86400)


def deep_count_for(tf):
    sec = TF_SEC[tf]
    return max(64, min(DEEP_N, DEEP_SPAN_CAP_SEC // sec))


def base_price(sym):
    if sym in BASE:
        return BASE[sym]
    h = sum(ord(c) * (i + 7) for i, c in enumerate(sym))
    return 20 + (h % 180) + (h % 97) / 100.0


def digits(sym):
    if sym in DIGITS:
        return DIGITS[sym]
    p = base_price(sym)
    if p < 5:
        return 5
    if p < 50:
        return 4
    return 2


def vol_of(price, sec):
    return price * 0.0007 * math.sqrt(max(1, sec) / 60.0)


def gen_history(sym, tf, count, off=0):
    """Seeded random walk aligned so the LAST close equals the live price.
    off>0 simulates a broker whose bars are anchored in SERVER tz (like MT5).
    The walk is generated ONCE at DEEP_N depth per (sym, tf); every request
    (live tail or an older page ending before `to`) slices that cache, so
    paging backwards yields genuinely older bars with stable OHLCV."""
    key = (sym, tf, off)
    if key not in HIST:
        sec = TF_SEC[tf]
        now = int(time.time())
        end = bucket_start(tf, now + off)
        rng = random.Random(hash((sym, tf)) & 0xFFFFFFFF)
        vol = vol_of(base_price(sym), sec)
        px = base_price(sym) * (1 + rng.uniform(-0.02, 0.02))
        bars = []
        for i in range(deep_count_for(tf), 0, -1):
            t = end - sec * i
            o = px
            drift = rng.gauss(0, 1) * vol
            c = o + drift
            h = max(o, c) + abs(rng.gauss(0, 1)) * vol * 0.6
            lo = min(o, c) - abs(rng.gauss(0, 1)) * vol * 0.6
            bars.append({'time': t, 'open': round(o, 8), 'high': round(h, 8),
                         'low': round(lo, 8), 'close': round(c, 8), 'volume': int(300 + rng.random() * 4700)})
            px = c
        # shift the whole series so the final close matches the shared live price
        target = LIVE.setdefault(sym, base_price(sym) * (1 + random.Random(sym).uniform(-0.01, 0.01)))
        shift = target - bars[-1]['close']
        for b in bars:
            b['open'] = round(b['open'] + shift, 8)
            b['high'] = round(b['high'] + shift, 8)
            b['low'] = round(b['low'] + shift, 8)
            b['close'] = round(b['close'] + shift, 8)
        HIST[key] = bars
    # return the FULL deep cache — callers slice (tail or older page) so a
    # `to`-terminated request always sees genuinely older bars
    return HIST[key]


def _slice_history(bars, tf, count, to):
    """last `count` bars, optionally strictly older than `to` (exclusive)."""
    if to is not None:
        bars = [b for b in bars if b['time'] < int(to)]
    return bars[-count:]


class DemoBroker(Broker):
    name = 'Demo'

    def __init__(self):
        super().__init__()
        # ---- ROUND85: simulated trading account (in-memory, resets on restart)
        self._t_acc = {'login': 100000, 'name': 'OJchart Demo', 'server': 'Demo',
                       'currency': 'USD', 'leverage': 100, 'balance': 10000.0,
                       'trade_allowed': True}
        self._t_pos = {}      # ticket -> position dict
        self._t_ord = {}      # ticket -> pending order dict
        self._t_deals = []    # closed deals (history)
        self._t_seq = 500001  # ticket generator
        self._t_ordseq = 900001
        self._quotes = {}     # symbol -> (bid, ask, tsec)

    def do_login(self, msg):
        return True, ''

    # ---- ROUND55: simulated broker access servers (MT5 login-dialog parity)
    # The demo "broker" exposes its data centers with per-server latency
    # profiles (same shape as a real terminal's scan: name + measured RTT),
    # so the login screen's server section — auto-pick lowest ping, manual
    # switch, Network Rescan — works end to end. Rescan re-jitters ±8%.
    DEMO_SERVERS = [
        ('UK01 AS', 0.095), ('DE01 DC', 0.108), ('DE02 DC', 0.110),
        ('DE03 DC', 0.112), ('FI01 DC', 0.155), ('AE01 DC', 0.335),
    ]

    def server_entries(self):
        return [{'name': n} for n, _ in self.DEMO_SERVERS]

    async def server_ping_ms(self, name):
        base = dict(self.DEMO_SERVERS).get(name)
        if base is None:
            return None
        t0 = time.time()
        await asyncio.sleep(base * (0.92 + random.random() * 0.16))
        return round((time.time() - t0) * 1000, 2)

    def get_digits(self, symbol):
        return digits(symbol)

    def get_bars(self, symbol, tf, count, to=None):
        count = max(50, min(count, deep_count_for(tf)))
        return _slice_history(gen_history(symbol, tf, count), tf, count, to)

    def search(self, query):
        # ROUND 35: case-insensitive matching + de-duplicated results
        q = (query or '').strip().upper()
        pool = list(dict.fromkeys(SYMBOLS))
        res = [s for s in pool if q in s.upper()] if q else pool
        return res[:60]

    def next_tick(self, symbol):
        px = LIVE.get(symbol)
        if px is None:
            px = base_price(symbol)
        d = digits(symbol)
        step = px * 0.00007
        px = round(px + random.gauss(0, 1) * step, d)
        LIVE[symbol] = px
        # BUG-004: every demo tick carries a synthesized, self-consistent
        # bid/ask pair (documented DEMO parity — real MT5 passes
        # SymbolInfoTick through). Spread = max(12 points, 1 bp of price).
        point = 10 ** -d
        spr = max(12 * point, px * 1e-4)
        bid = round(px - spr / 2, d)
        ask = round(px + spr / 2, d)
        # ROUND85: the trading engine consumes the same quotes the chart sees
        # (SL/TP + pending triggers run on every tick of a traded symbol)
        try:
            self._trade_on_tick(symbol, bid, ask, int(time.time()))
        except Exception:
            pass
        return px, int(random.random() * 50) + 1, int(time.time()), bid, ask

    # =====================================================================
    # ROUND85: SIMULATED TRADING ENGINE -----------------------------------
    # A faithful MINI broker so the whole trading UI works end-to-end in
    # Demo mode (and in CI tests on non-Windows machines): market +
    # pending orders (limit/stop/stop-limit), SL/TP execution on real demo
    # ticks, partial closes, margin check, live equity, deal history with
    # summaries. Semantics mirror the MetaTrader5 model (ORDER_TYPE_*,
    # POSITION_TYPE_*, DEAL_ENTRY_*, retcodes) so the renderer contract is
    # IDENTICAL for the demo and the real MT5 bridge.
    # Simplifications (documented, demo-only): commission/swap = 0, fills
    # at the trigger price without slippage/rejects, stop-limit fills at
    # its limit price when the stop leg triggers.
    # =====================================================================
    T_CONTRACT = {  # contract size per symbol family (USD-quote approx)
        'XAUUSD': 100, 'XAGUSD': 5000,
        'USOIL': 100, 'UKOIL': 100, 'NATGAS': 1000,
        'BTCUSD': 1, 'ETHUSD': 1,
    }

    def _t_contract(self, sym):
        if sym in self.T_CONTRACT:
            return float(self.T_CONTRACT[sym])
        if len(sym) == 6 and sym.isalpha():          # FX pairs
            return 100000.0
        return 1.0                                    # indices / stocks

    def _t_quote_ccy(self, sym):
        return sym[3:6] if len(sym) == 6 and sym.isalpha() else 'USD'

    def _t_quote_to_usd(self, ccy):
        """value of 1 unit of `ccy` in USD, from the live demo prices"""
        if ccy == 'USD':
            return 1.0
        p = LIVE.get(ccy + 'USD')
        if p:
            return 1.0 / p
        p = LIVE.get('USD' + ccy)
        if p:
            return p
        return 1.0

    def _t_spec(self, sym):
        d = digits(sym)
        point = 10 ** -d
        contract = self._t_contract(sym)
        q = self._quotes.get(sym)
        px = LIVE.get(sym) or base_price(sym)
        if q:
            bid, ask = q[0], q[1]
        else:
            spr = max(12 * point, px * 1e-4)
            bid, ask = round(px - spr / 2, d), round(px + spr / 2, d)
        # value of one tick (1 point) of one lot in the account currency
        tick_value = point * contract * self._t_quote_to_usd(self._t_quote_ccy(sym))
        return {'symbol': sym, 'digits': d, 'point': point, 'contract': contract,
                'tick_value': round(tick_value, 6), 'tick_size': point,
                'vol_min': 0.01, 'vol_max': 100.0, 'vol_step': 0.01,
                'stops_level': 20, 'freeze_level': 0,
                'filling_mask': 3, 'trade_mode': 4,  # FOK|IOC, full trading
                'currency_profit': 'USD',
                'bid': bid, 'ask': ask, 'spread': int(round((ask - bid) / point))}

    def _t_norm_vol(self, spec, volume):
        try:
            v = float(volume)
        except Exception:
            return 0.0
        step = spec['vol_step'] or 0.01
        v = math.floor(v / step + 1e-9) * step
        v = round(v, 8)
        if v < spec['vol_min']:
            return 0.0
        return min(v, spec['vol_max'])

    def _t_validate_stops(self, spec, otype, price, sl, tp):
        """distance check in POINTS against stops_level (retcode 10016).
        ref = ask for buy-side ops, bid for sell-side ops (demo rule)."""
        min_pts = spec['stops_level']
        pt = spec['point']
        ref = spec['ask'] if otype in (0, 2, 4, 6) else spec['bid']
        checks = []
        if otype in (2, 3, 4, 5, 6, 7) and price > 0:
            checks.append(abs(price - ref))
        if sl > 0:
            checks.append(abs(sl - ref))
        if tp > 0:
            checks.append(abs(tp - ref))
        for c in checks:
            if c / pt < min_pts:
                return False
        return True

    @staticmethod
    def _f(v):
        try:
            f = float(v)
        except Exception:
            return 0.0
        if f != f or f in (float('inf'), float('-inf')):
            return 0.0
        return f

    def _t_profit(self, pos, bid, ask):
        spec = self._t_spec(pos['symbol'])
        close = bid if pos['type'] == 0 else ask
        diff = (close - pos['open']) * (1 if pos['type'] == 0 else -1)
        return diff * pos['volume'] * spec['contract'] * \
            self._t_quote_to_usd(self._t_quote_ccy(pos['symbol']))

    def _t_margin_used(self):
        used = 0.0
        for p in self._t_pos.values():
            spec = self._t_spec(p['symbol'])
            used += p['volume'] * spec['contract'] * p['open'] / \
                max(1, self._t_acc['leverage']) * \
                self._t_quote_to_usd(self._t_quote_ccy(p['symbol']))
        return used

    def _t_account(self):
        floating = 0.0
        for p in self._t_pos.values():
            q = self._quotes.get(p['symbol'])
            if q:
                floating += self._t_profit(p, q[0], q[1])
        margin = self._t_margin_used()
        equity = self._t_acc['balance'] + floating
        free = equity - margin
        return {'login': self._t_acc['login'], 'name': self._t_acc['name'],
                'server': self._t_acc['server'], 'currency': self._t_acc['currency'],
                'leverage': self._t_acc['leverage'],
                'balance': round(self._t_acc['balance'], 2),
                'equity': round(equity, 2), 'profit': round(floating, 2),
                'margin': round(margin, 2), 'margin_free': round(free, 2),
                'margin_level': round(equity * 100.0 / margin, 2) if margin > 0 else 0.0,
                'trade_allowed': self._t_acc['trade_allowed']}

    def _t_pos_row(self, p, bid, ask):
        cur = bid if p['type'] == 0 else ask
        return {'ticket': p['ticket'], 'time': p['time'], 'type': p['type'],
                'volume': p['volume'], 'open': p['open'], 'sl': p['sl'] or 0,
                'tp': p['tp'] or 0, 'current': cur, 'swap': 0.0,
                'profit': round(self._t_profit(p, bid, ask), 2),
                'symbol': p['symbol'], 'comment': p['comment']}

    def _t_order_row(self, o, spec):
        return {'ticket': o['ticket'], 'time': o['time'], 'type': o['type'],
                'volume': o['volume'], 'filled': 0.0, 'price': o['price'],
                'sl': o['sl'] or 0, 'tp': o['tp'] or 0,
                'current': spec['bid'] if o['type'] in (3, 5, 7) else spec['ask'],
                'symbol': o['symbol'], 'comment': o['comment'],
                'type_time': o['type_time'], 'expiration': o['expiration']}

    def _t_deal(self, pos, price, entry, tsec, profit=0.0, order=0, comment='', reason=0):
        """ROUND113: deals also carry sl/tp/magic/fee + the close REASON
        (MT5 DEAL_REASON_SL=4 / DEAL_REASON_TP=5) so the History table can
        paint the S/L cell red on a stop-out and the T.P. cell green on a
        take-profit fill, exactly like the terminal does."""
        self._t_seq += 1
        self._t_deals.append({
            'ticket': self._t_seq, 'order': order, 'time': int(tsec),
            'type': pos['type'] if entry == 0 else (1 - pos['type']),
            'entry': entry, 'position_id': pos['ticket'],
            'volume': pos['volume'] if entry == 0 else pos.pop('_close_vol', pos['volume']),
            'price': price, 'commission': 0.0, 'swap': 0.0, 'fee': 0.0,
            'profit': round(profit, 2), 'symbol': pos['symbol'], 'comment': comment,
            'sl': float(pos.get('sl') or 0), 'tp': float(pos.get('tp') or 0),
            'magic': 0, 'reason': int(reason)})

    def _t_fill(self, o, fill_price, tsec):
        """pending order -> position (ORDER_STATE_PLACED -> filled deal IN)"""
        spec = self._t_spec(o['symbol'])
        pos_type = 0 if o['type'] in (2, 4, 6) else 1
        pos = {'ticket': o['ticket'], 'symbol': o['symbol'], 'type': pos_type,
               'volume': o['volume'], 'open': fill_price, 'sl': o['sl'],
               'tp': o['tp'], 'time': int(tsec), 'comment': o['comment']}
        self._t_pos[o['ticket']] = pos
        self._t_deal(pos, fill_price, 0, tsec, order=o['ticket'], comment=o['comment'])
        del self._t_ord[o['ticket']]

    def _t_close(self, pos, price, tsec, close_vol=0.0, reason=0):
        """close (or partially close) a position at `price`, booking the deal"""
        spec = self._t_spec(pos['symbol'])
        vol = close_vol if close_vol > 0 else pos['volume']
        q = self._quotes.get(pos['symbol'])
        bid, ask = (q[0], q[1]) if q else (price, price)
        # profit of the closed slice: scale by closed/total
        full = self._t_profit(pos, bid, ask)
        profit = full * (vol / pos['volume'] if pos['volume'] else 0)
        close_rec = dict(pos)
        close_rec['volume'] = vol
        close_rec['_close_vol'] = vol
        self._t_deal(close_rec, price, 1, tsec, profit=profit, reason=reason)
        self._t_acc['balance'] += profit
        pos['volume'] = round(pos['volume'] - vol, 8)
        if pos['volume'] < spec['vol_min'] - 1e-9:
            del self._t_pos[pos['ticket']]

    def _trade_on_tick(self, sym, bid, ask, tsec):
        """one quote -> pending triggers + SL/TP checks (MT5 semantics)"""
        self._quotes[sym] = (bid, ask, int(tsec))
        # 1) pending orders (buy side fills on ASK, sell side on BID)
        for o in list(self._t_ord.values()):
            if o['symbol'] != sym:
                continue
            if o['expiration'] and tsec >= o['expiration']:
                del self._t_ord[o['ticket']]
                continue
            t = o['type']
            trig = None
            if t == 2 and ask <= o['price'] + 1e-12:      # buy limit
                trig = o['price']
            elif t == 3 and bid >= o['price'] - 1e-12:    # sell limit
                trig = o['price']
            elif t == 4 and ask >= o['price'] - 1e-12:    # buy stop
                trig = o['price']
            elif t == 5 and bid <= o['price'] + 1e-12:    # sell stop
                trig = o['price']
            elif t in (6, 7):                              # stop-limit (demo: fill at limit leg)
                sl_leg = o.get('stoplimit') or o['price']
                if t == 6 and ask >= o['price'] - 1e-12:
                    trig = sl_leg
                elif t == 7 and bid <= o['price'] + 1e-12:
                    trig = sl_leg
            if trig is not None:
                self._t_fill(o, trig, tsec)
        # 2) SL/TP of open positions (buy closes on BID, sell on ASK)
        for p in list(self._t_pos.values()):
            if p['symbol'] != sym:
                continue
            hit = None
            reason = 0                      # ROUND113: 4 = SL, 5 = TP (MT5)
            if p['type'] == 0:
                if p['sl'] and bid <= p['sl']:
                    hit, reason = p['sl'], 4
                elif p['tp'] and bid >= p['tp']:
                    hit, reason = p['tp'], 5
            else:
                if p['sl'] and ask >= p['sl']:
                    hit, reason = p['sl'], 4
                elif p['tp'] and ask <= p['tp']:
                    hit, reason = p['tp'], 5
            if hit is not None:
                self._t_close(p, hit, tsec, reason=reason)

    def _t_ret(self, ok, comment, **extra):
        d = {'retcode': 10009 if ok else 10015, 'comment': comment}
        d.update(extra)
        return {'ok': bool(ok), 'data': d}

    def trade_rpc(self, msg):
        op = str(msg.get('op') or '')
        if op == 'account':
            return {'ok': True, 'data': self._t_account()}
        if op == 'spec':
            sym = str(msg.get('symbol') or '')
            if not sym:
                return {'ok': False, 'error': 'unknown symbol'}
            return {'ok': True, 'data': self._t_spec(sym)}
        if op == 'positions':
            rows = []
            for p in self._t_pos.values():
                q = self._quotes.get(p['symbol']) or (p['open'], p['open'])
                rows.append(self._t_pos_row(p, q[0], q[1]))
            return {'ok': True, 'data': {'positions': rows}}
        if op == 'orders':
            rows = [self._t_order_row(o, self._t_spec(o['symbol'])) for o in self._t_ord.values()]
            return {'ok': True, 'data': {'orders': rows}}
        if op == 'state':
            acc = self._t_account()
            pos_rows = []
            for p in self._t_pos.values():
                q = self._quotes.get(p['symbol']) or (p['open'], p['open'])
                pos_rows.append(self._t_pos_row(p, q[0], q[1]))
            ord_rows = [self._t_order_row(o, self._t_spec(o['symbol'])) for o in self._t_ord.values()]
            return {'ok': True, 'data': {'account': acc, 'positions': pos_rows, 'orders': ord_rows}}
        if op == 'history':
            to = int(msg.get('to') or (time.time() + 86400))
            frm = int(msg.get('from') or (to - 30 * 86400))
            rows = [d for d in self._t_deals if frm <= d['time'] <= to]
            closed = [d for d in rows if d['entry'] == 1]
            prof = sum(d['profit'] + d['commission'] + d['swap'] for d in closed)
            wins = len([d for d in closed if (d['profit'] + d['commission'] + d['swap']) > 0])
            return {'ok': True, 'data': {'deals': rows,
                                         'summary': {'profit': round(prof, 2), 'trades': len(closed), 'wins': wins}}}
        if op == 'order_send':
            sym = str(msg.get('symbol') or '')
            spec = self._t_spec(sym)
            if not sym:
                return {'ok': False, 'error': 'unknown symbol'}
            vol = self._t_norm_vol(spec, msg.get('volume'))
            if vol <= 0:
                return {'ok': False, 'error': 'Invalid volume (min ' + str(spec['vol_min']) + ', step ' + str(spec['vol_step']) + ')'}
            try:
                otype = int(msg.get('order_type') or 0)
            except Exception:
                otype = -1
            if not 0 <= otype <= 7:
                return {'ok': False, 'error': 'Invalid order type'}
            sl = self._f(msg.get('sl'))
            tp = self._f(msg.get('tp'))
            comment = str(msg.get('comment') or '')[:31]
            # ---- market execution
            if otype in (0, 1):
                price = spec['ask'] if otype == 0 else spec['bid']
                if sl > 0 or tp > 0:
                    if not self._t_validate_stops(spec, otype, 0, sl, tp):
                        # round85b: flat 'error' text mirrors mt5.py — the UI
                        # shows the real reason instead of 'trade failed'
                        return {'ok': False, 'error': 'Invalid stops (too close to the market)',
                                'data': {'retcode': 10016, 'comment': 'Invalid stops (too close to the market)'}}
                margin = vol * spec['contract'] * price / max(1, self._t_acc['leverage']) * \
                    self._t_quote_to_usd(self._t_quote_ccy(sym))
                acc = self._t_account()
                if margin > acc['margin_free'] + 1e-9:
                    return {'ok': False, 'error': 'Not enough money',
                            'data': {'retcode': 10019, 'comment': 'Not enough money'}}
                self._t_seq += 1
                ticket = self._t_seq
                pos = {'ticket': ticket, 'symbol': sym, 'type': otype,
                       'volume': vol, 'open': price, 'sl': sl or 0, 'tp': tp or 0,
                       'time': int(time.time()), 'comment': comment}
                self._t_pos[ticket] = pos
                self._t_deal(pos, price, 0, int(time.time()), order=ticket, comment=comment)
                return self._t_ret(True, 'Done', order=ticket, deal=ticket, volume=vol, price=price, position=ticket)
            # ---- pending orders
            price = self._f(msg.get('price'))
            if price <= 0:
                return {'ok': False, 'error': 'Invalid price'}
            stoplimit = self._f(msg.get('stoplimit'))
            if otype in (6, 7) and stoplimit <= 0:
                return {'ok': False, 'error': 'Stop-limit requires a limit price'}
            if not self._t_validate_stops(spec, otype, price, sl, tp):
                return {'ok': False, 'error': 'Invalid stops (entry/SL/TP too close to the market)',
                        'data': {'retcode': 10016, 'comment': 'Invalid stops (entry/SL/TP too close to the market)'}}
            tt = str(msg.get('type_time') or 'gtc').lower()
            t_time, exp = 0, 0
            if tt == 'day':
                t_time = 1
            elif tt == 'specified' and msg.get('expiration'):
                t_time = 2
                exp = int(msg['expiration'])
            self._t_ordseq += 1
            o = {'ticket': self._t_ordseq, 'symbol': sym, 'type': otype,
                 'volume': vol, 'price': price, 'stoplimit': stoplimit,
                 'sl': sl or 0, 'tp': tp or 0, 'time': int(time.time()),
                 'comment': comment, 'type_time': t_time, 'expiration': exp}
            self._t_ord[o['ticket']] = o
            retcode = 10009 if otype in (2, 3) else 10008
            return {'ok': True, 'data': {'retcode': retcode, 'comment': 'Order placed',
                                         'order': o['ticket'], 'deal': 0, 'volume': vol, 'price': price}}
        if op == 'close':
            ticket = int(msg.get('ticket') or 0)
            pos = self._t_pos.get(ticket)
            if not pos:
                return {'ok': False, 'error': 'Position ' + str(ticket) + ' not found'}
            spec = self._t_spec(pos['symbol'])
            close_vol = self._t_norm_vol(spec, msg.get('volume') or 0)
            if close_vol > pos['volume'] + 1e-9:
                return {'ok': False, 'error': 'Close volume exceeds the position volume',
                        'data': {'retcode': 10038, 'comment': 'Close volume exceeds the position volume'}}
            price = spec['bid'] if pos['type'] == 0 else spec['ask']
            self._t_close(pos, price, int(time.time()), close_vol if close_vol > 0 else 0.0)
            return self._t_ret(True, 'Done', order=ticket, volume=close_vol or pos['volume'], price=price)
        if op == 'close_all':
            flt = str(msg.get('symbol') or '')
            closed, errs = 0, []
            for p in list(self._t_pos.values()):
                if flt and p['symbol'] != flt:
                    continue
                self._t_close(p, self._t_spec(p['symbol'])['bid'] if p['type'] == 0 else self._t_spec(p['symbol'])['ask'], int(time.time()))
                closed += 1
            return {'ok': True, 'data': {'closed': closed, 'errors': errs}}
        if op == 'modify_sltp':
            ticket = int(msg.get('ticket') or 0)
            pos = self._t_pos.get(ticket)
            if not pos:
                return {'ok': False, 'error': 'Position ' + str(ticket) + ' not found'}
            spec = self._t_spec(pos['symbol'])
            sl, tp = self._f(msg.get('sl')), self._f(msg.get('tp'))
            if (sl > 0 or tp > 0) and not self._t_validate_stops(spec, pos['type'], 0, sl, tp):
                return {'ok': False, 'error': 'Invalid stops (too close to the market)',
                        'data': {'retcode': 10016, 'comment': 'Invalid stops (too close to the market)'}}
            pos['sl'], pos['tp'] = sl or 0, tp or 0
            return self._t_ret(True, 'Done')
        if op == 'order_modify':
            ticket = int(msg.get('ticket') or 0)
            o = self._t_ord.get(ticket)
            if not o:
                return {'ok': False, 'error': 'Order ' + str(ticket) + ' not found'}
            spec = self._t_spec(o['symbol'])
            price = self._f(msg.get('price')) or o['price']
            sl, tp = self._f(msg.get('sl')), self._f(msg.get('tp'))
            if not self._t_validate_stops(spec, o['type'], price, sl, tp):
                return {'ok': False, 'error': 'Invalid stops (entry/SL/TP too close to the market)',
                        'data': {'retcode': 10016, 'comment': 'Invalid stops (entry/SL/TP too close to the market)'}}
            o['price'], o['sl'], o['tp'] = price, sl or 0, tp or 0
            tt = str(msg.get('type_time') or '').lower()
            if tt == 'day':
                o['type_time'], o['expiration'] = 1, 0
            elif tt == 'specified' and msg.get('expiration'):
                o['type_time'], o['expiration'] = 2, int(msg['expiration'])
            return self._t_ret(True, 'Done')
        if op == 'order_cancel':
            ticket = int(msg.get('ticket') or 0)
            if ticket not in self._t_ord:
                return {'ok': False, 'error': 'Order ' + str(ticket) + ' not found'}
            del self._t_ord[ticket]
            return self._t_ret(True, 'Canceled')
        return {'ok': False, 'error': 'Unknown trade op: ' + op}

    def loops(self):
        # the trading engine keeps processing SL/TP + pending triggers even
        # when no chart subscribes the traded symbols (positions must never
        # freeze because a chart window is closed)
        async def trade_loop():
            while True:
                await asyncio.sleep(0.5)
                try:
                    if not (self._t_pos or self._t_ord):
                        continue
                    syms = set([p['symbol'] for p in self._t_pos.values()] +
                               [o['symbol'] for o in self._t_ord.values()])
                    now = int(time.time())
                    for sym in list(syms):
                        px = LIVE.get(sym)
                        if px is None:
                            continue
                        d = digits(sym)
                        point = 10 ** -d
                        spr = max(12 * point, px * 1e-4)
                        self._trade_on_tick(sym, round(px - spr / 2, d), round(px + spr / 2, d), now)
                except Exception:
                    pass
        return [trade_loop()]


if __name__ == '__main__':
    import argparse, asyncio
    ap = argparse.ArgumentParser()
    ap.add_argument('--off', type=int, default=0,
                    help='simulate broker server-tz offset (seconds) for tests')
    ap.add_argument('--tick-interval', type=float, default=None,
                    help='seconds between tick_loop polls (refresh rate, not network ping)')
    a = ap.parse_args()

    class OffDemoBroker(DemoBroker):
        def current_off(self):
            return a.off

        def get_bars(self, symbol, tf, count, to=None):
            count = max(50, min(count, deep_count_for(tf)))
            bars = _slice_history(gen_history(symbol, tf, count, a.off), tf, count, to)
            if to is None and bars:
                # the cache anchor froze at provider start; roll the LIVE TAIL
                # forward to the current forming bucket (server-label clock)
                # so a mid-test reload never steps the chart backwards
                sec = TF_SEC[tf]
                end = bucket_start(tf, int(time.time()) + a.off)
                cache = HIST[(symbol, tf, a.off)]
                rng = random.Random((hash((symbol, tf)) & 0xFFFFFFFF) ^ end)
                vol = vol_of(base_price(symbol), sec)
                px = cache[-1]['close']
                while cache and cache[-1]['time'] < end and len(cache) < deep_count_for(tf) + 4096:
                    t = cache[-1]['time'] + sec
                    o = px
                    c = o + rng.gauss(0, 1) * vol
                    h = max(o, c) + abs(rng.gauss(0, 1)) * vol * 0.6
                    lo = min(o, c) - abs(rng.gauss(0, 1)) * vol * 0.6
                    cache.append({'time': t, 'open': round(o, 8), 'high': round(h, 8),
                                  'low': round(lo, 8), 'close': round(c, 8), 'volume': int(300 + rng.random() * 4700)})
                    px = c
                bars = cache[-count:]
            return bars

        def next_tick(self, symbol):
            r = super().next_tick(symbol)
            return r[0], r[1], int(time.time()) + a.off, r[3], r[4]  # ticks in server-label time + bid/ask

    b = OffDemoBroker()
    if a.tick_interval is not None:
        from provider_common import clamp_tick_interval
        b.tick_interval = clamp_tick_interval(a.tick_interval)
    try:
        asyncio.run(b.run())
    except OSError as e:
        print('PORT_IN_USE' if '10048' in str(e) or 'address already in use' in str(e).lower() else str(e), flush=True)
        sys.exit(2)
