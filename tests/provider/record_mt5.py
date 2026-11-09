"""Record a real MetaTrader 5 session into a replayable harness fixture.

This is the "record" half of the record/replay workflow used by
tests/provider/test_mt5_provider.py (the fake is the "replay" half). It only
READS from the terminal: no orders are sent and nothing is modified.

Usage (Windows, MT5 terminal running and logged in):

    set OJCHART_MT5_PASSWORD=<password>
    python tests/provider/record_mt5.py ^
        --login 12345678 --server "Broker-Live" ^
        --symbols "EURUSD,XAUUSD,USDJPY" ^
        --timeframes M1,M5,M15,H1,D1 ^
        --bars 500 --ticks 5000 --history-days 30 ^
        --output tests/provider/fixtures/mt5_session.json

Then replay it (any OS, no terminal needed):

    set MT5_FIXTURE=tests/provider/fixtures/mt5_session.json
    python -m unittest discover -s tests/provider -p "test_*.py" -v

By default account number, holder name and account money are redacted and
local paths are dropped, so a fixture is safe to commit. Pass
--include-account / --include-paths only for a private fixture.

The JSON schema is described in tests/provider/mt5_fake.py.
"""

import argparse
import datetime as dt
import json
import os
import sys
import time

TF_NAMES = ('M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H3', 'H4', 'D1', 'W1', 'MN1')


def _g(obj, name, default=None):
    try:
        v = getattr(obj, name, default)
        return default if v is None else v
    except Exception:
        return default


def _pos(p):
    return {
        'ticket': int(_g(p, 'ticket', 0)), 'time': int(_g(p, 'time', 0)),
        'type': int(_g(p, 'type', 0)), 'volume': float(_g(p, 'volume', 0)),
        'price_open': float(_g(p, 'price_open', 0)), 'sl': float(_g(p, 'sl', 0)),
        'tp': float(_g(p, 'tp', 0)), 'price_current': float(_g(p, 'price_current', 0)),
        'swap': float(_g(p, 'swap', 0)), 'profit': float(_g(p, 'profit', 0)),
        'symbol': str(_g(p, 'symbol', '')), 'comment': str(_g(p, 'comment', '')),
        'magic': int(_g(p, 'magic', 0)),
    }


def _ord(o):
    return {
        'ticket': int(_g(o, 'ticket', 0)), 'time_setup': int(_g(o, 'time_setup', 0)),
        'time': int(_g(o, 'time', 0)), 'type': int(_g(o, 'type', 0)),
        'volume_initial': float(_g(o, 'volume_initial', 0)),
        'volume_current': float(_g(o, 'volume_current', 0)),
        'price_open': float(_g(o, 'price_open', 0)),
        'price_current': float(_g(o, 'price_current', 0)),
        'sl': float(_g(o, 'sl', 0)), 'tp': float(_g(o, 'tp', 0)),
        'symbol': str(_g(o, 'symbol', '')), 'comment': str(_g(o, 'comment', '')),
        'type_time': int(_g(o, 'type_time', 0)),
        'time_expiration': int(_g(o, 'time_expiration', 0) or _g(o, 'expiration', 0) or 0),
        'magic': int(_g(o, 'magic', 0)),
    }


def _deal(d):
    return {
        'ticket': int(_g(d, 'ticket', 0)), 'order': int(_g(d, 'order', 0)),
        'time': int(_g(d, 'time', 0)), 'type': int(_g(d, 'type', 0)),
        'entry': int(_g(d, 'entry', 0)), 'position_id': int(_g(d, 'position_id', 0)),
        'volume': float(_g(d, 'volume', 0)), 'price': float(_g(d, 'price', 0)),
        'commission': float(_g(d, 'commission', 0)), 'swap': float(_g(d, 'swap', 0)),
        'profit': float(_g(d, 'profit', 0)), 'symbol': str(_g(d, 'symbol', '')),
        'comment': str(_g(d, 'comment', '')), 'magic': int(_g(d, 'magic', 0)),
        'reason': int(_g(d, 'reason', 0)), 'fee': float(_g(d, 'fee', 0)),
    }


def _symbol(s):
    info = {
        'name': str(s.name), 'digits': int(_g(s, 'digits', 5)),
        'point': float(_g(s, 'point', 0.00001)), 'visible': bool(_g(s, 'visible', True)),
        'spread': int(_g(s, 'spread', 0)),
        'trade_contract_size': float(_g(s, 'trade_contract_size', 0)),
        'trade_tick_value': float(_g(s, 'trade_tick_value', 0)),
        'trade_tick_size': float(_g(s, 'trade_tick_size', 0)),
        'volume_min': float(_g(s, 'volume_min', 0)),
        'volume_max': float(_g(s, 'volume_max', 0)),
        'volume_step': float(_g(s, 'volume_step', 0)),
        'trade_stops_level': int(_g(s, 'trade_stops_level', 0)),
        'trade_freeze_level': int(_g(s, 'trade_freeze_level', 0)),
        'filling_mode': int(_g(s, 'filling_mode', 0)),
        'trade_mode': int(_g(s, 'trade_mode', 0)),
        'currency_profit': str(_g(s, 'currency_profit', 'USD')),
    }
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description='Record a MetaTrader 5 session into a replay fixture.')
    ap.add_argument('--login', default='')
    ap.add_argument('--password', default='')
    ap.add_argument('--server', default='')
    ap.add_argument('--path', default='')
    ap.add_argument('--symbols', default='', help='comma-separated; default: up to 8 visible symbols')
    ap.add_argument('--timeframes', default='M1,M5,M15,H1,D1')
    ap.add_argument('--bars', type=int, default=500, help='bars per symbol/timeframe')
    ap.add_argument('--ticks', type=int, default=5000, help='recent ticks per symbol')
    ap.add_argument('--history-days', type=int, default=0, help='0 = do not record deals')
    ap.add_argument('--output', required=True, help='fixture JSON path')
    ap.add_argument('--include-account', action='store_true', help='keep login/name (private fixture)')
    ap.add_argument('--include-paths', action='store_true', help='keep terminal data/install paths')
    a = ap.parse_args(argv)

    try:
        import MetaTrader5 as mt5
    except ImportError:
        print('MetaTrader5 package missing: python -m pip install MetaTrader5', file=sys.stderr)
        return 3

    kw = {'path': a.path} if a.path else {}
    ok = mt5.initialize(login=int(a.login), password=a.password or os.environ.get('OJCHART_MT5_PASSWORD'),
                       server=a.server, **kw) if a.login else mt5.initialize(**kw)
    if not ok:
        print('initialize failed: ' + str(mt5.last_error()), file=sys.stderr)
        return 4
    if a.login and not mt5.login(int(a.login), password=a.password or os.environ.get('OJCHART_MT5_PASSWORD'),
                                 server=a.server):
        print('login failed: ' + str(mt5.last_error()), file=sys.stderr)
        mt5.shutdown()
        return 5

    now = int(time.time())
    acc = mt5.account_info()
    term = mt5.terminal_info()
    account = {
        'login': int(a.login or _g(acc, 'login', 0)),
        'name': str(_g(acc, 'name', '')),
        'server': str(a.server or _g(acc, 'server', 'Replay-Live')),
        'currency': str(_g(acc, 'currency', 'USD')),
        'leverage': int(_g(acc, 'leverage', 0)),
        'balance': float(_g(acc, 'balance', 0)),
        'equity': float(_g(acc, 'equity', 0)),
        'profit': float(_g(acc, 'profit', 0)),
        'margin': float(_g(acc, 'margin', 0)),
        'margin_free': float(_g(acc, 'margin_free', 0)),
        'margin_level': float(_g(acc, 'margin_level', 0)),
    }
    if not a.include_account:
        account['login'] = 0
        account['name'] = 'Replay Account'
        # Account money is private too: a committed fixture must not leak the
        # real balance/equity. Neutral values keep every replay path working.
        account['balance'] = 10000.0
        account['equity'] = 10000.0
        account['profit'] = 0.0
        account['margin'] = 0.0
        account['margin_free'] = 10000.0
        account['margin_level'] = 0.0
    terminal = {
        'connected': bool(_g(term, 'connected', True)),
        'trade_allowed': bool(_g(term, 'trade_allowed', False)),
        'server': str(_g(term, 'server', account['server'])),
        'path': str(_g(term, 'path', '')),
        'data_path': str(_g(term, 'data_path', '')),
        'name': str(_g(term, 'name', 'MetaTrader 5')),
        'build': int(_g(term, 'build', 0)),
    }
    if not a.include_paths:
        terminal['path'] = ''
        terminal['data_path'] = ''

    all_syms = list(mt5.symbols_get() or [])
    want = [s.strip() for s in a.symbols.split(',') if s.strip()]
    if want:
        source = [s for s in all_syms if s.name in want]
        missing = [w for w in want if w not in {s.name for s in all_syms}]
        if missing:
            print('warning: symbols not found: ' + ', '.join(missing), file=sys.stderr)
    else:
        source = [s for s in all_syms if _g(s, 'visible', False)][:8]
    if not source:
        print('no symbols selected (pass --symbols)', file=sys.stderr)
        mt5.shutdown()
        return 6

    tfs = [t.strip() for t in a.timeframes.split(',') if t.strip()]
    for t in tfs:
        if t not in TF_NAMES:
            print('unknown timeframe: ' + t, file=sys.stderr)
            mt5.shutdown()
            return 7

    fixture = {
        'meta': {'recorded_at': now, 'tool': 'tests/provider/record_mt5.py',
                 'bars': a.bars, 'ticks': a.ticks},
        'now': now,
        'account': account,
        'terminal': terminal,
        'symbols': [],
        'bars': {},
        'ticks': {},
        'quote_age': {},
        'positions': [_pos(p) for p in (mt5.positions_get() or [])],
        'orders': [_ord(o) for o in (mt5.orders_get() or [])],
        'deals': [],
    }

    for s in source:
        name = str(s.name)
        fixture['symbols'].append(_symbol(s))
        fixture['bars'][name] = {}
        for tf in tfs:
            const = getattr(mt5, 'TIMEFRAME_' + tf, None)
            if const is None:
                continue
            rates = mt5.copy_rates_from_pos(name, const, 0, a.bars)
            if rates is None:
                continue
            fixture['bars'][name][tf] = [
                [int(r['time']), float(r['open']), float(r['high']),
                 float(r['low']), float(r['close']), int(r['tick_volume'])]
                for r in rates
            ]
        if a.ticks > 0:
            # A closed market (weekend / holiday) has NO ticks in the tight
            # window. Widen step by step so a fixture recorded on Saturday
            # still carries the most recent real ticks (with a true quote_age)
            # instead of silently dropping the whole tick section.
            ticks = None
            for span in (max(60, int(a.ticks * 1.2)), 86400, 7 * 86400, 30 * 86400):
                frm = dt.datetime.fromtimestamp(now - span, tz=dt.timezone.utc)
                to = dt.datetime.fromtimestamp(now + 1, tz=dt.timezone.utc)
                ticks = mt5.copy_ticks_range(name, frm, to, mt5.COPY_TICKS_ALL)
                if ticks is not None and len(ticks):
                    break
            if ticks is not None and len(ticks):
                rows = [
                    [int(t['time']), float(t['bid'] or 0), float(t['ask'] or 0),
                     float(t['last'] or 0), int(t['volume'] or 0)]
                    for t in ticks[-a.ticks:]
                ]
                fixture['ticks'][name] = rows
                fixture['quote_age'][name] = max(0, now - rows[-1][0])

    if a.history_days > 0:
        frm = dt.datetime.fromtimestamp(now - a.history_days * 86400, tz=dt.timezone.utc)
        to = dt.datetime.fromtimestamp(now + 86400, tz=dt.timezone.utc)
        deals = mt5.history_deals_get(frm, to)
        if deals:
            fixture['deals'] = [_deal(d) for d in deals]

    os.makedirs(os.path.dirname(os.path.abspath(a.output)), exist_ok=True)
    with open(a.output, 'w', encoding='utf-8') as f:
        json.dump(fixture, f, indent=1, sort_keys=True)
    mt5.shutdown()
    print('wrote %s: %d symbols, %d bars sets, %d tick sets, %d deals'
          % (a.output, len(fixture['symbols']), sum(len(v) for v in fixture['bars'].values()),
             len(fixture['ticks']), len(fixture['deals'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
