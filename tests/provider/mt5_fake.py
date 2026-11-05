"""Replayable stand-in for the Windows-only MetaTrader5 python package.

WHY
---
`provider/mt5.py` is the largest untested surface in the project: it needs a
running terminal, a logged-in broker account and real market data. That made
every trading/history/timeframe fix rely on manual testing. This module
implements the SAME module-level API the real package exposes, driven by a
plain JSON scenario (a "fixture"), so `tests/provider/test_mt5_provider.py`
can exercise the bridge deterministically on every OS and in CI.

The fixture schema is shared with `tests/provider/record_mt5.py`, which
captures a real terminal session on a Windows machine:

    {
      "now": 1700000000,                       # clock used for synthetic data
      "account":  {"login": 0, "name": "", "server": "Acme-Live", ...},
      "terminal": {"connected": true, "trade_allowed": true, ...},
      "symbols":  [{"name": "EURUSD", "digits": 5, "point": 0.00001, ...}],
      "bars":     {"EURUSD": {"M5": [[t,o,h,l,c,v], ...]}},   # optional
      "ticks":    {"EURUSD": [[t,bid,ask,last,vol], ...]},    # optional
      "positions": [...], "orders": [...], "deals": [...],
      "quote_age": {"EURUSD": 0},              # seconds behind "now"
      "order_fail": [10030],                   # retcodes queue for order_send
      "order_none": 1,                         # order_send() -> None (hard API error)
      "last_error": [10027, "Autotrading disabled"]
    }

Missing bars/ticks are synthesized deterministically from `now`, so a tiny
scenario still gives thousands of candles on every timeframe.

Usage:
    import mt5_fake
    broker = mt5_fake.install(scenario_dict)   # sys.modules['MetaTrader5']
    # ... import/reload provider/mt5.py ...
"""

import fnmatch
import math
import sys
import types
import time
from collections import OrderedDict
from types import SimpleNamespace

# ---- real MetaTrader5 constant values -------------------------------------
TF_CONST = {
    'M1': 1, 'M2': 2, 'M3': 3, 'M4': 4, 'M5': 5, 'M6': 6, 'M10': 10,
    'M12': 12, 'M15': 15, 'M20': 20, 'M30': 30,
    'H1': 16385, 'H2': 16386, 'H3': 16387, 'H4': 16388,
    'D1': 16408, 'W1': 32769, 'MN1': 49153,
}

TF_SECONDS = {
    'S1': 1, 'S5': 5, 'S15': 15, 'S30': 30,
    'M1': 60, 'M3': 180, 'M5': 300, 'M15': 900, 'M30': 1800, 'M45': 2700,
    'H1': 3600, 'H2': 7200, 'H3': 10800, 'H4': 14400,
    'D1': 86400, 'W1': 604800,
    'MN1': 2592000, 'MN3': 7776000, 'MN6': 15552000, 'MN12': 31104000,
}

CONSTANTS = {
    'COPY_TICKS_ALL': -1,
    'COPY_TICKS_INFO': 0,
    'COPY_TICKS_TRADE': 1,
    'ORDER_TYPE_BUY': 0,
    'ORDER_TYPE_SELL': 1,
    'ORDER_TYPE_BUY_LIMIT': 2,
    'ORDER_TYPE_SELL_LIMIT': 3,
    'ORDER_TYPE_BUY_STOP': 4,
    'ORDER_TYPE_SELL_STOP': 5,
    'ORDER_TYPE_BUY_STOP_LIMIT': 6,
    'ORDER_TYPE_SELL_STOP_LIMIT': 7,
    'POSITION_TYPE_BUY': 0,
    'POSITION_TYPE_SELL': 1,
    'DEAL_ENTRY_IN': 0,
    'DEAL_ENTRY_OUT': 1,
    'DEAL_ENTRY_INOUT': 2,
    'DEAL_ENTRY_OUT_BY': 3,
    'DEAL_TYPE_BUY': 0,
    'DEAL_TYPE_SELL': 1,
    'ORDER_FILLING_FOK': 0,
    'ORDER_FILLING_IOC': 1,
    'ORDER_FILLING_RETURN': 2,
    'ORDER_TIME_GTC': 0,
    'ORDER_TIME_DAY': 1,
    'ORDER_TIME_SPECIFIED': 6,
    'TRADE_ACTION_DEAL': 1,
    'TRADE_ACTION_PENDING': 5,
    'TRADE_ACTION_SLTP': 6,
    'TRADE_ACTION_MODIFY': 7,
    'TRADE_ACTION_REMOVE': 8,
    'SYMBOL_TRADE_MODE_FULL': 4,
}
CONSTANTS.update({'TIMEFRAME_' + k: v for k, v in TF_CONST.items()})
_TF_BY_VALUE = {v: k for k, v in TF_CONST.items()}


def _tf_name(tf):
    """Provider code passes either a wire name ('M5') or a native constant."""
    if isinstance(tf, str) and tf in TF_SECONDS:
        return tf
    try:
        return _TF_BY_VALUE.get(int(tf))
    except Exception:
        return None

_RETCODE_TXT = {
    10008: 'Order placed', 10009: 'Done', 10010: 'Partially done',
    10013: 'Invalid request', 10014: 'Invalid volume', 10015: 'Invalid price',
    10016: 'Invalid stops', 10018: 'Market closed', 10019: 'Not enough money',
    10027: 'Autotrading disabled in the TERMINAL',
    10030: 'Invalid order filling type', 10035: 'Close volume exceeds the position volume',
}


def _price_base(sym):
    """Deterministic, plausible price base per symbol (1.05..60000)."""
    s = str(sym).upper()
    if s.startswith('XAU'):
        return 2000.0
    if s.startswith('XAG'):
        return 25.0
    if s.startswith('BTC'):
        return 60000.0
    if s.startswith('ETH'):
        return 3000.0
    if s.startswith('USDJPY'):
        return 150.0
    if s.startswith('USDCAD'):
        return 1.35
    h = sum((i + 1) * ord(c) for i, c in enumerate(s))
    return round(1.05 + (h % 90) / 1000.0, 6)


def _norm_bar(row):
    if isinstance(row, dict):
        return {'time': int(row['time']), 'open': float(row['open']),
                'high': float(row['high']), 'low': float(row['low']),
                'close': float(row['close']), 'volume': int(row.get('volume') or 0)}
    return {'time': int(row[0]), 'open': float(row[1]), 'high': float(row[2]),
            'low': float(row[3]), 'close': float(row[4]),
            'volume': int(row[5]) if len(row) > 5 else 0}


def _norm_tick(row):
    if isinstance(row, dict):
        return {'time': int(row['time']), 'bid': float(row.get('bid') or 0),
                'ask': float(row.get('ask') or 0), 'last': float(row.get('last') or 0),
                'volume': int(row.get('volume') or 0)}
    return {'time': int(row[0]), 'bid': float(row[1]), 'ask': float(row[2]),
            'last': float(row[3]), 'volume': int(row[4]) if len(row) > 4 else 0}


class FakeMT5:
    """Stateful implementation of the MetaTrader5 module API."""

    def __init__(self, scenario=None):
        self.scenario = scenario or {}
        self.now = int(self.scenario.get('now') or time.time())
        self.account = dict(self.scenario.get('account') or {
            'login': 0, 'name': 'Replay Account', 'server': 'Replay-Live',
            'currency': 'USD', 'leverage': 100, 'balance': 10000.0,
            'equity': 10000.0, 'profit': 0.0, 'margin': 0.0,
            'margin_free': 10000.0, 'margin_level': 0.0,
        })
        self.terminal = dict(self.scenario.get('terminal') or {
            'connected': True, 'trade_allowed': True,
            'server': self.account.get('server') or 'Replay-Live',
            'path': '', 'data_path': '', 'name': 'MetaTrader 5', 'build': 4000,
        })
        self._connected = bool(self.terminal.get('connected', True))
        self._initialize_ok = bool(self.scenario.get('initialize_ok', True))
        self._login_ok = bool(self.scenario.get('login_ok', True))
        self.last_error_value = tuple(self.scenario.get('last_error') or (0, 'Success'))
        self.order_fail = list(self.scenario.get('order_fail') or [])
        self.order_none = int(self.scenario.get('order_none') or 0)

        self.symbols = OrderedDict()
        for s in self.scenario.get('symbols') or []:
            self.symbols[str(s['name'])] = dict(s)
        if not self.symbols:
            self.symbols['EURUSD'] = self._default_symbol('EURUSD')
            self.symbols['XAUUSD'] = self._default_symbol('XAUUSD')

        self.bars_in = self.scenario.get('bars') or {}
        self.ticks_in = self.scenario.get('ticks') or {}
        self.quote_age = dict(self.scenario.get('quote_age') or {})
        self.quote_age_default = float(self.scenario.get('quote_age_default') or 0)
        self._bars_cache = {}
        self._ticks_cache = {}

        self.positions = [dict(p) for p in self.scenario.get('positions') or []]
        self.orders = [dict(o) for o in self.scenario.get('orders') or []]
        self.deals = [dict(d) for d in self.scenario.get('deals') or []]
        self._next_id = int(self.scenario.get('next_ticket') or 1001)
        self.initialize_calls = []
        self.shutdown_calls = 0
        self.copy_ticks_calls = 0
        self.copy_rates_calls = 0
        self.order_send_calls = 0

    # ------------------------------------------------------------------
    @staticmethod
    def _default_symbol(name, visible=True):
        base = _price_base(name)
        digits = 5 if base < 10 else 2
        point = 1.0 / (10 ** digits)
        return {
            'name': name, 'digits': digits, 'point': point, 'visible': visible,
            'spread': 10, 'trade_contract_size': 100000 if base < 10 else 100,
            'trade_tick_value': 1.0, 'trade_tick_size': point,
            'volume_min': 0.01, 'volume_max': 100.0, 'volume_step': 0.01,
            'trade_stops_level': 0, 'trade_freeze_level': 0,
            'filling_mode': 1, 'trade_mode': 4, 'currency_profit': 'USD',
        }

    def _ticket(self):
        t = self._next_id
        self._next_id += 1
        return t

    def _symbol_dict(self, sym):
        return self.symbols.get(sym)

    def _info(self, sym):
        s = self._symbol_dict(sym)
        if s is None:
            return None
        out = dict(s)
        out.setdefault('digits', 5)
        out.setdefault('point', 0.00001)
        return SimpleNamespace(**out)

    # ---- synthetic series -------------------------------------------
    def _price_at(self, sym, t):
        base = _price_base(sym)
        day = 2 * math.pi * t / 86400.0
        hour = 2 * math.pi * t / 3600.0
        return base * (1 + 0.0015 * math.sin(day) + 0.0004 * math.sin(hour))

    def _synth_bars(self, sym, tf, count):
        tf = _tf_name(tf)
        key = (sym, tf)
        if key in self._bars_cache:
            return self._bars_cache[key]
        explicit = (self.bars_in.get(sym) or {}).get(tf)
        if explicit is not None:
            bars = sorted((_norm_bar(r) for r in explicit), key=lambda b: b['time'])
            self._bars_cache[key] = bars
            return bars
        sec = TF_SECONDS.get(tf)
        if sec is None:
            bars = []
        else:
            end = self.now - (self.now % sec)
            n = max(int(count), int(self.scenario.get('synthetic_bars') or 5000))
            bars = []
            prev_close = None
            for i in range(n):
                t = end - (n - 1 - i) * sec
                o = self._price_at(sym, t) if prev_close is None else prev_close
                c = self._price_at(sym, t + sec)
                hi = max(o, c) + abs(c) * 0.0002
                lo = min(o, c) - abs(c) * 0.0002
                v = 100 + int((t // sec) % 50)
                bars.append({'time': t, 'open': o, 'high': hi, 'low': lo,
                             'close': c, 'volume': v})
                prev_close = c
        self._bars_cache[key] = bars
        return bars

    def _synth_ticks(self, sym):
        if sym in self._ticks_cache:
            return self._ticks_cache[sym]
        explicit = self.ticks_in.get(sym)
        if explicit is not None:
            ticks = sorted((_norm_tick(r) for r in explicit), key=lambda t: t['time'])
            self._ticks_cache[sym] = ticks
            return ticks
        span = int(self.scenario.get('synthetic_tick_span') or 10800)
        step = max(1, int(self.scenario.get('synthetic_tick_step') or 1))
        info = self._symbol_dict(sym) or self._default_symbol(sym)
        point = float(info.get('point') or 0.00001)
        spread = float(info.get('spread') or 10) * point
        ticks = []
        for t in range(self.now - span, self.now + 1, step):
            bid = self._price_at(sym, t)
            ticks.append({'time': t, 'bid': bid, 'ask': bid + spread,
                          'last': 0.0, 'volume': 1})
        self._ticks_cache[sym] = ticks
        return ticks

    def _full_bars(self, sym, tf):
        return self._synth_bars(sym, tf, max(len(self._bars_cache.get((sym, _tf_name(tf))) or []), 5000))

    @staticmethod
    def _api_bar(b):
        """Real copy_rates_* records expose `tick_volume`, not `volume`."""
        return {'time': int(b['time']), 'open': float(b['open']),
                'high': float(b['high']), 'low': float(b['low']),
                'close': float(b['close']), 'tick_volume': int(b['volume']),
                'spread': 0, 'real_volume': 0}

    # ---- module API --------------------------------------------------
    def initialize(self, login=None, password=None, server=None, path=None, **kw):
        self.initialize_calls.append({'login': login, 'server': server, 'path': path})
        if not self._initialize_ok:
            self.last_error_value = (10031, 'No connection with the trade server')
            return False
        self._connected = True
        self.terminal['connected'] = True
        if server:
            self.terminal['server'] = server
        if path:
            self.terminal['path'] = path
        if login:
            self.account['login'] = int(login)
        return True

    def login(self, login=None, password=None, server=None, **kw):
        if not self._login_ok:
            self.last_error_value = (10004, 'Authorization failed')
            return False
        self._connected = True
        self.terminal['connected'] = True
        if login:
            self.account['login'] = int(login)
        if server:
            self.account['server'] = server
            self.terminal['server'] = server
        return True

    def shutdown(self):
        self.shutdown_calls += 1
        self._connected = False
        self.terminal['connected'] = False
        return True

    def last_error(self):
        return self.last_error_value

    def terminal_info(self):
        if not self._connected:
            return None
        return SimpleNamespace(**self.terminal)

    def account_info(self):
        if not self._connected:
            return None
        return SimpleNamespace(**self.account)

    def symbols_get(self, pattern=None):
        names = list(self.symbols.keys())
        if pattern:
            p = str(pattern).upper()
            names = [n for n in names if fnmatch.fnmatchcase(n.upper(), p)]
        return [self._info(n) for n in names]

    def symbol_info(self, sym):
        return self._info(sym)

    def symbol_select(self, sym, enable=True):
        s = self._symbol_dict(sym)
        if s is None:
            return False
        s['visible'] = bool(enable)
        return True

    def symbol_info_tick(self, sym):
        s = self._symbol_dict(sym)
        if s is None:
            return None
        if s.get('no_quotes'):
            return SimpleNamespace(time=0, bid=0.0, ask=0.0, last=0.0, volume=0, flags=0)
        ticks = self._synth_ticks(sym)
        if not ticks:
            return None
        t = dict(ticks[-1])
        age = self.quote_age.get(sym, self.quote_age_default)
        t['time'] = int(t['time'] - age)
        return SimpleNamespace(**t)

    def copy_rates_from_pos(self, sym, tf, start, count):
        self.copy_rates_calls += 1
        info = self._symbol_dict(sym)
        if info is None:
            return None
        full = self._full_bars(sym, tf)
        start = int(start or 0)
        count = int(count or 0)
        if start <= 0:
            return [self._api_bar(b) for b in full[-count:]] if count > 0 else []
        end = len(full) - start
        begin = max(0, end - count)
        return [self._api_bar(b) for b in full[begin:end]]

    def copy_rates_range(self, sym, tf, frm, to):
        self.copy_rates_calls += 1
        info = self._symbol_dict(sym)
        if info is None:
            return None
        frm_ts = int(frm.timestamp()) if hasattr(frm, 'timestamp') else int(frm)
        to_ts = int(to.timestamp()) if hasattr(to, 'timestamp') else int(to)
        out = [self._api_bar(b) for b in self._full_bars(sym, tf)
               if frm_ts <= b['time'] <= to_ts]
        return out

    def copy_ticks_range(self, sym, frm, to, flags=CONSTANTS['COPY_TICKS_ALL']):
        self.copy_ticks_calls += 1
        if self._symbol_dict(sym) is None:
            return None
        frm_ts = int(frm.timestamp()) if hasattr(frm, 'timestamp') else int(frm)
        to_ts = int(to.timestamp()) if hasattr(to, 'timestamp') else int(to)
        return [dict(t) for t in self._synth_ticks(sym)
                if frm_ts <= t['time'] <= to_ts]

    def positions_get(self, symbol=None, ticket=None, **kw):
        rows = list(self.positions)
        if symbol is not None:
            rows = [p for p in rows if p['symbol'] == symbol]
        if ticket is not None:
            tid = int(ticket)
            rows = [p for p in rows if int(p['ticket']) == tid]
        return [SimpleNamespace(**p) for p in rows]

    def orders_get(self, symbol=None, ticket=None, **kw):
        rows = list(self.orders)
        if symbol is not None:
            rows = [o for o in rows if o['symbol'] == symbol]
        if ticket is not None:
            tid = int(ticket)
            rows = [o for o in rows if int(o['ticket']) == tid]
        return [SimpleNamespace(**o) for o in rows]

    def history_deals_get(self, from_date=None, to_date=None, position=None, **kw):
        rows = list(self.deals)
        if position is not None:
            pid = int(position)
            rows = [d for d in rows if int(d.get('position_id') or 0) == pid]
        else:
            if from_date is not None:
                frm = int(from_date.timestamp()) if hasattr(from_date, 'timestamp') else int(from_date)
                rows = [d for d in rows if int(d['time']) >= frm]
            if to_date is not None:
                to = int(to_date.timestamp()) if hasattr(to_date, 'timestamp') else int(to_date)
                rows = [d for d in rows if int(d['time']) <= to]
        return [SimpleNamespace(**d) for d in rows]

    def _tick_price(self, sym, side):
        t = self.symbol_info_tick(sym)
        if t is None:
            return 0.0
        if side == 0:  # buy at ask
            return float(t.ask or t.bid or t.last or 0)
        return float(t.bid or t.last or t.ask or 0)

    def _result(self, retcode, **over):
        data = {'retcode': retcode, 'comment': _RETCODE_TXT.get(retcode, 'Trade error ' + str(retcode)),
                'order': 0, 'deal': 0, 'volume': 0.0, 'price': 0.0, 'position': 0,
                'request_id': 0, 'retcode_external': 0}
        data.update(over)
        return SimpleNamespace(**data)

    def _find(self, rows, ticket):
        for r in rows:
            if int(r['ticket']) == int(ticket):
                return r
        return None

    def _profit(self, pos, close_price, volume):
        info = self._symbol_dict(pos['symbol']) or {}
        contract = float(info.get('trade_contract_size') or 100000)
        sign = 1 if int(pos['type']) == 0 else -1
        return (float(close_price) - float(pos['price_open'])) * sign * float(volume) * contract

    def order_send(self, req):
        self.order_send_calls += 1
        if self.order_none > 0:
            self.order_none -= 1
            return None
        if self.order_fail:
            code = int(self.order_fail.pop(0))
            return self._result(code)

        action = int(req.get('action') or 0)
        sym = str(req.get('symbol') or '')
        if (action in (CONSTANTS['TRADE_ACTION_DEAL'], CONSTANTS['TRADE_ACTION_PENDING'])
                and self._symbol_dict(sym) is None):
            self.last_error_value = (10013, 'Invalid request')
            return self._result(10013)

        if action == CONSTANTS['TRADE_ACTION_DEAL'] and 'position' not in req:
            side = int(req.get('type') or 0)
            vol = float(req.get('volume') or 0)
            price = float(req.get('price') or self._tick_price(sym, side))
            ticket = self._ticket()
            pos = {'ticket': ticket, 'time': self.now, 'type': side, 'magic': int(req.get('magic') or 0),
                   'volume': vol, 'price_open': price, 'sl': float(req.get('sl') or 0),
                   'tp': float(req.get('tp') or 0), 'price_current': price, 'swap': 0.0,
                   'profit': 0.0, 'symbol': sym, 'comment': str(req.get('comment') or '')}
            self.positions.append(pos)
            deal = {'ticket': self._ticket(), 'order': self._ticket(), 'time': self.now,
                    'type': side, 'entry': 0, 'position_id': ticket, 'volume': vol,
                    'price': price, 'commission': 0.0, 'swap': 0.0, 'profit': 0.0,
                    'symbol': sym, 'comment': str(req.get('comment') or ''), 'magic': int(req.get('magic') or 0),
                    'reason': 0, 'fee': 0.0}
            self.deals.append(deal)
            return self._result(10009, order=deal['order'], deal=deal['ticket'],
                                volume=vol, price=price, position=ticket)

        if action == CONSTANTS['TRADE_ACTION_DEAL'] and 'position' in req:
            pos = self._find(self.positions, req.get('position'))
            if pos is None:
                return self._result(10013)
            vol = float(req.get('volume') or 0)
            if vol <= 0:
                vol = float(pos['volume'])
            if vol > float(pos['volume']) + 1e-9:
                return self._result(10035)
            price = float(req.get('price') or self._tick_price(sym, 0 if int(pos['type']) == 1 else 1))
            deal = {'ticket': self._ticket(), 'order': self._ticket(), 'time': self.now,
                    'type': 0 if int(pos['type']) == 0 else 1, 'entry': 1,
                    'position_id': int(pos['ticket']), 'volume': vol, 'price': price,
                    'commission': 0.0, 'swap': 0.0,
                    'profit': self._profit(pos, price, vol), 'symbol': pos['symbol'],
                    'comment': str(req.get('comment') or ''), 'magic': int(pos.get('magic') or 0),
                    'reason': 0, 'fee': 0.0}
            self.deals.append(deal)
            if abs(vol - float(pos['volume'])) < 1e-9:
                self.positions.remove(pos)
            else:
                pos['volume'] = float(pos['volume']) - vol
                pos['price_current'] = price
            return self._result(10009, order=deal['order'], deal=deal['ticket'],
                                volume=vol, price=price, position=int(pos['ticket']))

        if action == CONSTANTS['TRADE_ACTION_PENDING']:
            exp = req.get('expiration')
            exp_ts = int(exp.timestamp()) if hasattr(exp, 'timestamp') else int(exp or 0)
            ticket = self._ticket()
            vol = float(req.get('volume') or 0)
            price = float(req.get('price') or 0)
            order = {'ticket': ticket, 'time_setup': self.now, 'time': self.now,
                     'type': int(req.get('type') or 0), 'magic': int(req.get('magic') or 0),
                     'volume_initial': vol, 'volume_current': vol,
                     'price_open': price, 'price_current': self._tick_price(sym, 0),
                     'sl': float(req.get('sl') or 0), 'tp': float(req.get('tp') or 0),
                     'symbol': sym, 'comment': str(req.get('comment') or ''),
                     'type_time': int(req.get('type_time') or CONSTANTS['ORDER_TIME_GTC']),
                     'time_expiration': exp_ts}
            self.orders.append(order)
            return self._result(10009, order=ticket, volume=vol, price=price)

        if action in (CONSTANTS['TRADE_ACTION_SLTP'], CONSTANTS['TRADE_ACTION_MODIFY'],
                      CONSTANTS['TRADE_ACTION_REMOVE']):
            ticket = int(req.get('position') or req.get('order') or 0)
            if action == CONSTANTS['TRADE_ACTION_SLTP']:
                pos = self._find(self.positions, ticket)
                if pos is None:
                    return self._result(10013)
                pos['sl'] = float(req.get('sl') or 0)
                pos['tp'] = float(req.get('tp') or 0)
                return self._result(10009, position=ticket)
            if action == CONSTANTS['TRADE_ACTION_MODIFY']:
                order = self._find(self.orders, ticket)
                if order is None:
                    return self._result(10013)
                if 'price' in req and float(req.get('price') or 0) > 0:
                    order['price_open'] = float(req['price'])
                order['sl'] = float(req.get('sl') or 0)
                order['tp'] = float(req.get('tp') or 0)
                if req.get('type_time') is not None:
                    order['type_time'] = int(req['type_time'])
                if hasattr(req.get('expiration'), 'timestamp'):
                    order['time_expiration'] = int(req['expiration'].timestamp())
                return self._result(10009, order=ticket)
            order = self._find(self.orders, ticket)
            if order is None:
                return self._result(10013)
            self.orders.remove(order)
            return self._result(10009, order=ticket)

        return self._result(10013)


def load_scenario(path):
    """Read a fixture JSON recorded by tests/provider/record_mt5.py."""
    import json
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def install(scenario=None, module_name='MetaTrader5'):
    """Install a fake package under `module_name` and return its broker state."""
    if isinstance(scenario, (str, bytes)) or hasattr(scenario, '__fspath__'):
        scenario = load_scenario(scenario)
    broker = FakeMT5(scenario or {})
    mod = types.ModuleType(module_name)
    mod.__file__ = '<mt5_fake>'
    mod.FakeMT5 = FakeMT5
    mod.install = install
    for k, v in CONSTANTS.items():
        setattr(mod, k, v)
    for name in (
        'initialize', 'login', 'shutdown', 'last_error', 'terminal_info',
        'account_info', 'symbols_get', 'symbol_info', 'symbol_select',
        'symbol_info_tick', 'copy_rates_from_pos', 'copy_rates_range',
        'copy_ticks_range', 'positions_get', 'orders_get', 'history_deals_get',
        'order_send',
    ):
        setattr(mod, name, getattr(broker, name))
    sys.modules[module_name] = mod
    return broker
