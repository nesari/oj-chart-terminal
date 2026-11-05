"""Provider harness: exercises provider/mt5.py against a replayable MT5 package.

Run:  python -m unittest discover -s tests/provider -p "test_*.py" -v
or:   npm run check:mt5

No Windows terminal, broker login or MetaTrader5 package is required: each
test installs `tests/provider/mt5_fake.py` under the name `MetaTrader5` and
drives the bridge with a JSON-shaped scenario (the same schema a recorded
fixture uses, see record_mt5.py).
"""

import importlib.util
import os
import pathlib
import shutil
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROVIDER = ROOT / 'provider'

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(PROVIDER))

import mt5_fake  # noqa: E402

_counter = [0]


def _symbol(name, **over):
    base = mt5_fake._price_base(name)
    digits = 5 if base < 10 else 2
    point = 1.0 / (10 ** digits)
    s = {
        'name': name, 'digits': digits, 'point': point, 'visible': True,
        'spread': 10, 'trade_contract_size': 100000 if base < 10 else 100,
        'trade_tick_value': 1.0, 'trade_tick_size': point,
        'volume_min': 0.01, 'volume_max': 100.0, 'volume_step': 0.01,
        'trade_stops_level': 0, 'trade_freeze_level': 0,
        'filling_mode': 1, 'trade_mode': 4, 'currency_profit': 'USD',
    }
    s.update(over)
    return s


def make_scenario(**over):
    sc = {
        'now': int(time.time()),
        'account': {
            'login': 900001, 'name': 'Harness', 'server': 'Acme-Live',
            'currency': 'USD', 'leverage': 100, 'balance': 10000.0,
            'equity': 10000.0, 'profit': 0.0, 'margin': 0.0,
            'margin_free': 10000.0, 'margin_level': 0.0,
        },
        'terminal': {
            'connected': True, 'trade_allowed': True, 'server': 'Acme-Live',
            'path': '', 'data_path': '', 'name': 'MetaTrader 5', 'build': 4000,
        },
        'symbols': [_symbol('EURUSD'), _symbol('XAUUSD'), _symbol('USDJPY')],
    }
    sc.update(over)
    return sc


def deal(ticket, pid, entry, profit, when, **over):
    d = {
        'ticket': ticket, 'order': ticket + 1000, 'time': int(when), 'type': 0,
        'entry': int(entry), 'position_id': int(pid), 'volume': 1.0,
        'price': 1.1, 'commission': -0.1, 'swap': 0.0, 'profit': float(profit),
        'symbol': 'EURUSD', 'comment': '', 'magic': 0, 'reason': 0, 'fee': 0.0,
    }
    d.update(over)
    return d


class ProviderHarness(unittest.TestCase):
    maxDiff = None

    def load(self, scenario=None, cache=False):
        """Fresh provider module + fake MT5 + isolated temp/OFF/cache paths."""
        _counter[0] += 1
        tmp = tempfile.mkdtemp(prefix='mt5-harness-')
        self.addCleanup(lambda p=tmp: shutil.rmtree(p, ignore_errors=True))
        os.environ['TEMP'] = tmp
        os.environ['TMP'] = tmp
        os.environ['MT5CHART_CACHE'] = '1' if cache else '0'
        os.environ['MT5CHART_CACHE_DIR'] = os.path.join(tmp, 'cache')
        broker = mt5_fake.install(scenario or make_scenario())
        sys.modules.pop('chart_cache', None)
        name = 'mt5_uut_%d' % _counter[0]
        spec = importlib.util.spec_from_file_location(name, PROVIDER / 'mt5.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod, broker

    def broker_obj(self, mod, server='Acme-Live'):
        return mod.MT5Broker('', '', server, '')

    def connected(self, mod, broker, server='Acme-Live'):
        b = self.broker_obj(mod, server)
        self.assertTrue(b.connect())
        return b

    # ---- data path ---------------------------------------------------
    def test_native_bars_and_older_pagination(self):
        mod, _ = self.load()
        b = self.broker_obj(mod)
        bars = b.get_bars('EURUSD', 'M5', 60)
        self.assertEqual(len(bars), 60)
        self.assertEqual([x['time'] for x in bars], sorted(x['time'] for x in bars))
        self.assertTrue(all(set(x) == {'time', 'open', 'high', 'low', 'close', 'volume'} for x in bars))

        to = bars[0]['time']
        older = b.get_bars('EURUSD', 'M5', 50, to=to)
        self.assertEqual(len(older), 50)
        self.assertTrue(all(x['time'] < to for x in older))
        self.assertTrue(all(x['high'] >= x['low'] for x in bars))

    def test_fetch_range_is_exclusive_at_end(self):
        mod, _ = self.load()
        b = self.broker_obj(mod)
        frm = (int(time.time()) // 300) * 300 - 5 * 300
        to = frm + 5 * 300
        rows = b.fetch_range('EURUSD', 'M5', frm, to)
        self.assertEqual(len(rows), 5)
        self.assertTrue(all(frm <= r['time'] < to for r in rows))

    def test_app_built_m45_aggregates_m15(self):
        mod, _ = self.load()
        b = self.broker_obj(mod)
        to = (int(time.time()) // 2700) * 2700
        frm = to - 10 * 2700
        rows = b.fetch_range('EURUSD', 'M45', frm, to)
        self.assertEqual(len(rows), 10)
        self.assertTrue(all(r['time'] % 2700 == 0 for r in rows))
        self.assertTrue(all(r['high'] >= r['open'] and r['high'] >= r['close'] for r in rows))
        self.assertTrue(all(r['low'] <= r['open'] and r['low'] <= r['close'] for r in rows))

    def test_seconds_timeframe_is_built_from_ticks(self):
        mod, _ = self.load()
        b = self.broker_obj(mod)
        bars = b.get_bars('EURUSD', 'S1', 120)
        self.assertEqual(len(bars), 120)
        self.assertEqual([x['time'] for x in bars], sorted(x['time'] for x in bars))
        self.assertTrue(all(b2['time'] - b1['time'] == 1 for b1, b2 in zip(bars, bars[1:])))
        info = mod.ensure_symbol('EURUSD')[1]
        tick = mod.mt5.symbol_info_tick('EURUSD')
        self.assertGreater(info.digits, 0)
        self.assertGreater(tick.bid, 0)

    def test_search_is_case_insensitive_and_prefers_visible(self):
        sc = make_scenario(symbols=[
            _symbol('EURUSD', visible=True),
            _symbol('USDJPY', visible=False),
            _symbol('XAUUSD', visible=True),
        ])
        mod, _ = self.load(sc)
        b = self.broker_obj(mod)
        self.assertEqual(b.search('usd'), ['EURUSD', 'XAUUSD', 'USDJPY'])
        self.assertEqual(b.search('eur'), ['EURUSD'])
        self.assertEqual(b.search(''), ['EURUSD', 'XAUUSD', 'USDJPY'])

    def test_ensure_symbol_resolves_case_and_reveals(self):
        sc = make_scenario(symbols=[_symbol('EURUSD', visible=False)])
        mod, _ = self.load(sc)
        sym, info = mod.ensure_symbol('eurusd')
        self.assertEqual(sym, 'EURUSD')
        self.assertIsNotNone(info)
        self.assertTrue(info.visible)
        self.assertIn('EURUSD', mod.ENSURED)
        b = self.broker_obj(mod)
        self.assertEqual(b.get_digits('EURUSD'), 5)
        self.assertEqual(b.get_digits('NOPE'), 5)

    def test_next_tick_shape_and_market_closed_gate(self):
        mod, _ = self.load()
        b = self.broker_obj(mod)
        tk = b.next_tick('EURUSD')
        self.assertIsNotNone(tk)
        self.assertEqual(len(tk), 6)
        price, vol, stamp, bid, ask, off = tk
        self.assertEqual(vol, 1)
        self.assertGreater(price, 0)
        self.assertEqual(price, bid)  # MT5 parity: BID is the painted price
        self.assertGreaterEqual(int(off), -14 * 3600)

        stale = make_scenario(quote_age={'EURUSD': 600})
        mod2, _ = self.load(stale)
        b2 = self.broker_obj(mod2)
        self.assertIsNone(b2.next_tick('EURUSD'))  # frozen quote -> closed market

        missing = make_scenario(symbols=[_symbol('EURUSD', no_quotes=True)])
        mod3, _ = self.load(missing)
        b3 = self.broker_obj(mod3)
        self.assertIsNone(b3.next_tick('EURUSD'))

    def test_cache_serves_the_same_tail_twice(self):
        mod, _ = self.load(cache=True)
        b = self.broker_obj(mod)
        first = b.get_bars('EURUSD', 'M5', 50)
        second = b.get_bars('EURUSD', 'M5', 50)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 50)
        root = os.environ['MT5CHART_CACHE_DIR']
        files = []
        for dirpath, _dirs, names in os.walk(root):
            files.extend(os.path.join(dirpath, n) for n in names)
        self.assertTrue(files, 'chart cache should have persisted at least one entry')

    # ---- trading bridge ---------------------------------------------
    def test_account_spec_and_state_shapes(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)

        acc = b.trade_rpc({'op': 'account'})
        self.assertTrue(acc['ok'])
        self.assertEqual(acc['data']['login'], 900001)
        self.assertEqual(acc['data']['currency'], 'USD')

        spec = b.trade_rpc({'op': 'spec', 'symbol': 'EURUSD'})
        self.assertTrue(spec['ok'])
        for key in ('symbol', 'digits', 'point', 'contract', 'tick_value', 'tick_size',
                    'vol_min', 'vol_max', 'vol_step', 'stops_level', 'freeze_level',
                    'filling_mask', 'trade_mode', 'currency_profit', 'bid', 'ask', 'spread'):
            self.assertIn(key, spec['data'])

        state = b.trade_rpc({'op': 'state'})
        self.assertTrue(state['ok'])
        self.assertEqual(state['data']['account']['balance'], 10000.0)
        self.assertEqual(state['data']['positions'], [])
        self.assertEqual(state['data']['orders'], [])
        self.assertEqual(b.trade_rpc({'op': 'positions'})['data'], {'positions': []})
        self.assertEqual(b.trade_rpc({'op': 'orders'})['data'], {'orders': []})

    def test_market_order_creates_position_and_deal(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)
        r = b.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0.25,
                         'order_type': 0, 'sl': 1.0, 'tp': 1.2})
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['data']['retcode'], 10009)
        self.assertGreater(r['data']['position'], 0)

        rows = b.trade_rpc({'op': 'positions'})['data']['positions']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['symbol'], 'EURUSD')
        self.assertEqual(rows[0]['type'], 0)
        self.assertEqual(rows[0]['volume'], 0.25)
        self.assertEqual(len(broker.deals), 1)
        self.assertEqual(broker.deals[0]['entry'], 0)

    def test_pending_order_modify_and_cancel(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)
        price = mod.mt5.symbol_info_tick('EURUSD').bid - 0.0100
        r = b.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0.10,
                         'order_type': 2, 'price': price, 'sl': price - 0.005,
                         'tp': price + 0.010})
        self.assertTrue(r['ok'], r)
        self.assertGreater(r['data']['order'], 0)

        pend = b.trade_rpc({'op': 'orders'})['data']['orders']
        self.assertEqual(len(pend), 1)
        self.assertEqual(pend[0]['price'], price)
        self.assertEqual(pend[0]['filled'], 0)

        ticket = pend[0]['ticket']
        mod_r = b.trade_rpc({'op': 'order_modify', 'ticket': ticket,
                             'price': price - 0.001, 'sl': price - 0.006})
        self.assertTrue(mod_r['ok'], mod_r)
        self.assertEqual(b.trade_rpc({'op': 'orders'})['data']['orders'][0]['price'], price - 0.001)

        can = b.trade_rpc({'op': 'order_cancel', 'ticket': ticket})
        self.assertTrue(can['ok'], can)
        self.assertEqual(b.trade_rpc({'op': 'orders'})['data']['orders'], [])

    def test_close_partial_then_full_and_close_all(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)
        open_r = b.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 1.0,
                              'order_type': 0})
        ticket = open_r['data']['position']

        part = b.trade_rpc({'op': 'close', 'ticket': ticket, 'volume': 0.4})
        self.assertTrue(part['ok'], part)
        pos = b.trade_rpc({'op': 'positions'})['data']['positions']
        self.assertEqual(len(pos), 1)
        self.assertAlmostEqual(pos[0]['volume'], 0.6, places=8)

        full = b.trade_rpc({'op': 'close', 'ticket': ticket, 'volume': 0})
        self.assertTrue(full['ok'], full)
        self.assertEqual(b.trade_rpc({'op': 'positions'})['data']['positions'], [])

        b.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0.1, 'order_type': 0})
        b.trade_rpc({'op': 'order_send', 'symbol': 'XAUUSD', 'volume': 0.1, 'order_type': 0})
        all_r = b.trade_rpc({'op': 'close_all', 'symbol': 'EURUSD'})
        self.assertTrue(all_r['ok'])
        self.assertEqual(all_r['data']['closed'], 1)
        self.assertEqual(len(b.trade_rpc({'op': 'positions'})['data']['positions']), 1)
        self.assertEqual(b.trade_rpc({'op': 'state'})['data']['positions'][0]['symbol'], 'XAUUSD')

    def test_modify_sltp(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)
        r = b.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0.2, 'order_type': 1})
        ticket = r['data']['position']
        m = b.trade_rpc({'op': 'modify_sltp', 'ticket': ticket, 'sl': 1.1234, 'tp': 1.0987})
        self.assertTrue(m['ok'], m)
        row = b.trade_rpc({'op': 'positions'})['data']['positions'][0]
        self.assertAlmostEqual(row['sl'], 1.1234, places=6)
        self.assertAlmostEqual(row['tp'], 1.0987, places=6)

    def test_invalid_trade_requests(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)
        cases = [
            ({'op': 'spec', 'symbol': 'NOPE'}, 'unknown symbol'),
            ({'op': 'order_send', 'symbol': 'NOPE', 'volume': 1, 'order_type': 0}, 'unknown symbol'),
            ({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0, 'order_type': 0}, 'Invalid volume'),
            ({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 1, 'order_type': 9}, 'Invalid order type'),
            ({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 1, 'order_type': 2, 'price': 0}, 'Invalid price'),
            ({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 1, 'order_type': 6, 'price': 1.1}, 'Stop-limit'),
            ({'op': 'close', 'ticket': 42}, 'not found'),
            ({'op': 'modify_sltp', 'ticket': 42}, 'not found'),
            ({'op': 'order_modify', 'ticket': 42}, 'not found'),
            ({'op': 'nope'}, 'Unknown trade op'),
        ]
        for msg, expected in cases:
            r = b.trade_rpc(msg)
            self.assertFalse(r['ok'], msg)
            self.assertIn(expected, r['error'], msg)

        noquote = make_scenario(symbols=[_symbol('EURUSD', no_quotes=True)])
        mod2, broker2 = self.load(noquote)
        b2 = self.connected(mod2, broker2)
        r = b2.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 1, 'order_type': 0})
        self.assertFalse(r['ok'])
        self.assertIn('No quotes', r['error'])

    def test_invalid_fill_retry_and_hard_api_error(self):
        mod, broker = self.load()
        b = self.connected(mod, broker)
        broker.order_fail = [10030]  # INVALID_FILL -> provider must retry once
        r = b.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0.1, 'order_type': 0})
        self.assertTrue(r['ok'], r)
        self.assertEqual(broker.order_send_calls, 2)

        mod2, broker2 = self.load()
        b2 = self.connected(mod2, broker2)
        broker2.order_none = 1
        broker2.last_error_value = (10027, 'Autotrading disabled')
        r2 = b2.trade_rpc({'op': 'order_send', 'symbol': 'EURUSD', 'volume': 0.1, 'order_type': 0})
        self.assertFalse(r2['ok'])
        self.assertIn('Algo Trading', r2['error'])

    def test_history_backfills_missing_entry_and_summarizes(self):
        now = int(time.time())
        deals = [
            deal(1, 5, 1, 25.0, now - 500),
            deal(2, 5, 0, 0.0, now - 20000),
            deal(3, 6, 1, -10.0, now - 600),
            deal(4, 6, 0, 0.0, now - 21000),
        ]
        sc = make_scenario(now=now, deals=deals)
        mod, broker = self.load(sc)
        b = self.connected(mod, broker)
        r = b.trade_rpc({'op': 'history', 'from': now - 10000, 'to': now})
        self.assertTrue(r['ok'])
        data = r['data']
        self.assertEqual(len(data['deals']), 4)          # two OUT + two backfilled IN
        self.assertEqual(len([d for d in data['deals'] if d['entry'] == 0]), 2)
        self.assertEqual(data['summary']['trades'], 2)
        self.assertEqual(data['summary']['wins'], 1)
        self.assertAlmostEqual(data['summary']['profit'], 14.8, places=6)

    # ---- server tree / offset helpers -----------------------------------------
    def test_servers_dat_parse_and_fallback(self):
        mod, broker = self.load()
        b = self.broker_obj(mod, server='Acme-Live')
        self.assertEqual(b.server_entries(), [{'name': 'Acme-Live'}])

        harvest = [(0, 'Acme-Live'), (1, 'acme-live.com:443'),
                   (2, 'Acme-Live2'), (3, 'acme2.com:443'),
                   (4, 'OtherBroker-Live'), (5, 'other.com:443')]
        tree = mod._srv_tree(harvest, 'Acme-Live')
        self.assertEqual(tree, {'Acme-Live': ['acme-live.com:443'],
                                'Acme-Live2': ['acme2.com:443']})

        names = ['Acme-Live', 'acme-live.com:443', 'Acme-Live2', 'acme2.com:443']
        blob = b''.join(len(n).to_bytes(4, 'little') + n.encode('latin-1') for n in names)
        found = [s for _, s in mod._srv_harvest(blob)]
        self.assertIn('Acme-Live', found)
        self.assertIn('acme-live.com:443', found)

        self.assertEqual(mod._srv_addr('host.example.com:443'), 'host.example.com:443')
        self.assertIsNone(mod._srv_addr('Acme-Live'))
        self.assertIsNone(mod._srv_addr('host.example.com:99999'))

    def test_offset_quantization_and_snap(self):
        mod, _ = self.load()
        self.assertTrue(mod._quantized(7140))
        self.assertTrue(mod._quantized(7200))
        self.assertFalse(mod._quantized(7350))
        self.assertEqual(mod._snap_off(7140), 7200)
        self.assertEqual(mod._snap_off(7141), 7200)
        self.assertEqual(mod._snap_off(-10830), -10800)

    @unittest.skipUnless(os.environ.get('MT5_FIXTURE'),
                         'set MT5_FIXTURE=<recorded.json> to replay a real session')
    def test_replay_recorded_fixture(self):
        sc = mt5_fake.load_scenario(os.environ['MT5_FIXTURE'])
        mod, broker = self.load(sc)
        b = self.broker_obj(mod, server=sc.get('account', {}).get('server', '') or 'Acme-Live')
        sym = sc['symbols'][0]['name']
        tf = next(iter(sc.get('bars', {}).get(sym) or {'M5': []}))
        recorded = sc['bars'][sym][tf]
        if not recorded:
            self.skipTest('fixture has no bars for the first symbol')
        want = min(100, len(recorded))
        rows = b.raw_bars(sym, tf, want)
        self.assertEqual(len(rows), min(len(recorded), max(50, want)))
        self.assertEqual(rows[-1]['time'], recorded[-1][0])
        self.assertAlmostEqual(rows[-1]['close'], recorded[-1][4], places=6)

        spec = b.trade_rpc({'op': 'spec', 'symbol': sym})
        if spec.get('ok'):
            self.assertEqual(spec['data']['symbol'], sym)


if __name__ == '__main__':
    unittest.main(verbosity=2)
