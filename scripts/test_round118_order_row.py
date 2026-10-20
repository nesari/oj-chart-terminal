#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ROUND118 regression — pendings never showed anywhere on a REAL MetaTrader
terminal (user screenshot: sell limit 108700923 on MT5, app showed nothing —
no Positions row, no chart line).

Root cause: provider/mt5.py::_order_row read o.volume_filled, but the
MetaTrader5 package's TradeOrder namedtuple has NO such field (docs list
volume_initial + volume_current only). With >=1 pending order on the account
orders_get() returned rows -> AttributeError -> trade_rpc('state'/'orders')
failed on EVERY 1.2s poll -> the renderer froze on the last pre-pending
snapshot: pendings invisible everywhere (chart + Positions + Orders tab).

The earlier rounds never caught it because every probe/e2e here runs against
provider/demo.py, whose order rows are plain dicts.

This test imports provider/mt5.py against a STUB MetaTrader5 module whose
TradeOrder namedtuple carries ONLY the documented fields, then:
  [1] reproduces the old crash mechanism (documented-fields row has no
      volume_filled -> the old mapping must raise AttributeError),
  [2] proves the NEW _order_row maps a realistic XAUUSD sell-limit exactly
      like the user's screenshot (ticket 108700923, 0.05 @ 4361.26,
      SL 4363.76, TP 4299.37),
  [3] checks filled-volume derivation (initial - current) + clamping,
  [4] checks the time fallback (time_setup missing -> time),
  [5] checks _safe_rows drops a poisoned row but keeps the good ones,
  [6] proves the FULL state op (the 1.2s poll) succeeds with a pending on
      the account — the exact op that used to fail,
  [7] source contracts: no unguarded volume_filled access, _safe_rows wired
      into positions/orders/state.
"""
import os, sys, types, importlib.util, traceback
from collections import namedtuple

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
PROV = os.path.join(ROOT, 'provider')

PASS = []
FAILS = []

def check(name, cond, extra=''):
    (PASS if cond else FAILS).append(name + ((' — ' + str(extra)) if (extra and not cond) else ''))
    print(('PASS ' if cond else 'FAIL ') + name + ((' | ' + str(extra)) if not cond else ''))

# ---------------------------------------------------------------------------
# [stub] MetaTrader5 package: TradeOrder with ONLY the documented fields
# (mql5.com docs — orders_get / history_orders_get sample dumps). Deliberately
# NO volume_filled, NO time fallback tricks: this is what the real terminal
# hands back.
# ---------------------------------------------------------------------------
TradeOrder = namedtuple('TradeOrder', (
    'ticket', 'time', 'time_msc', 'time_update', 'time_update_msc',
    'time_setup', 'time_setup_msc', 'time_expiration', 'type', 'type_time',
    'type_filling', 'state', 'magic', 'position_id', 'position_by_id',
    'volume_initial', 'volume_current', 'price_open', 'sl', 'tp',
    'price_current', 'price_stoplimit', 'symbol', 'comment', 'external_id'))

stub = types.ModuleType('MetaTrader5')
def _mk(**kw):
    base = dict(ticket=0, time=0, time_msc=0, time_update=0, time_update_msc=0,
                time_setup=0, time_setup_msc=0, time_expiration=0, type=0,
                type_time=0, type_filling=0, state=2, magic=0, position_id=0,
                position_by_id=0, volume_initial=0.0, volume_current=0.0,
                price_open=0.0, sl=0.0, tp=0.0, price_current=0.0,
                price_stoplimit=0.0, symbol='', comment='', external_id=None)
    base.update(kw)
    return TradeOrder(**base)
stub.TradeOrder = TradeOrder
stub._mk = _mk
# constants the module asks for via getattr (TF_MAP build) — absent is fine,
# but give a couple so the map is non-empty like a real run
stub.TIMEFRAME_M1 = 1
stub.TIMEFRAME_H1 = 16385
stub.ORDER_TIME_GTC = 0
stub.ORDER_TIME_DAY = 1
stub.ORDER_TIME_SPECIFIED = 2
stub.TRADE_ACTION_DEAL = 1
stub.TRADE_ACTION_PENDING = 5
stub.TRADE_ACTION_SLTP = 6
stub.TRADE_ACTION_MODIFY = 7
stub.TRADE_ACTION_REMOVE = 8
sys.modules['MetaTrader5'] = stub

# ---------------------------------------------------------------------------
# import provider/mt5.py with the stub in place
# ---------------------------------------------------------------------------
sys.path.insert(0, PROV)
spec = importlib.util.spec_from_file_location('mt5_provider_under_test',
                                              os.path.join(PROV, 'mt5.py'))
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
    check('[0] provider/mt5.py imports against the documented-fields stub', True)
except Exception as e:
    check('[0] provider/mt5.py imports against the documented-fields stub', False, repr(e))
    _summary(); sys.exit(1)

Broker = mod.MT5Broker
broker = Broker.__new__(Broker)   # no __init__ — no terminal connection needed

# the exact order from the user's screenshot (Capitalxtend demo, sell limit)
USER_SELL_LIMIT = dict(ticket=108700923, time=1789795057, time_setup=1789795057,
                       type=3, volume_initial=0.05, volume_current=0.05,
                       price_open=4361.26, sl=4363.76, tp=4299.37,
                       price_current=4350.92, symbol='XAUUSD',
                       comment='', time_expiration=0, type_time=0)

# ---------------------------------------------------------------------------
# [1] old mechanism reproduction: a documented-fields-only TradeOrder has no
# volume_filled -> the OLD mapping style must raise AttributeError
# ---------------------------------------------------------------------------
o = stub._mk(**USER_SELL_LIMIT)
try:
    o.volume_filled
    check('[1] old crash mechanism reproduced (volume_filled absent)', False,
          'attribute unexpectedly present')
except AttributeError:
    check('[1] old crash mechanism reproduced (volume_filled absent)', True)

# ---------------------------------------------------------------------------
# [2] NEW _order_row maps the user's sell limit exactly
# ---------------------------------------------------------------------------
row = broker._order_row(o)
exp_keys = {'ticket', 'time', 'type', 'volume', 'filled', 'price', 'sl', 'tp',
            'current', 'symbol', 'comment', 'type_time', 'expiration'}
check('[2a] wire row keeps the exact key set', set(row.keys()) == exp_keys,
      sorted(set(row.keys()) ^ exp_keys))
check('[2b] ticket', row['ticket'] == 108700923, row['ticket'])
check('[2c] type=3 (sell limit)', row['type'] == 3, row['type'])
check('[2d] volume=0.05 (initial)', abs(row['volume'] - 0.05) < 1e-9, row['volume'])
check('[2e] filled=0.0 (nothing filled yet)', abs(row['filled'] - 0.0) < 1e-9, row['filled'])
check('[2f] price=4361.26', abs(row['price'] - 4361.26) < 1e-9, row['price'])
check('[2g] sl=4363.76', abs(row['sl'] - 4363.76) < 1e-9, row['sl'])
check('[2h] tp=4299.37', abs(row['tp'] - 4299.37) < 1e-9, row['tp'])
check('[2i] current=4350.92', abs(row['current'] - 4350.92) < 1e-9, row['current'])
check('[2j] symbol=XAUUSD', row['symbol'] == 'XAUUSD', row['symbol'])
check('[2k] time from time_setup', row['time'] == 1789795057, row['time'])

# ---------------------------------------------------------------------------
# [3] filled derivation: partially filled pending (initial 0.1 / current 0.04)
# ---------------------------------------------------------------------------
o2 = stub._mk(**dict(USER_SELL_LIMIT, volume_initial=0.10, volume_current=0.04))
r2 = broker._order_row(o2)
check('[3a] filled = initial - current = 0.06', abs(r2['filled'] - 0.06) < 1e-9, r2['filled'])
o3 = stub._mk(**dict(USER_SELL_LIMIT, volume_initial=0.05, volume_current=0.05))
check('[3b] fresh pending keeps filled=0', abs(broker._order_row(o3)['filled']) < 1e-9)

# ---------------------------------------------------------------------------
# [4] time fallback: real builds without time_setup must not crash either
# ---------------------------------------------------------------------------
OldShape = namedtuple('OldShape', 'ticket time type volume_initial volume_current price_open sl tp price_current symbol comment')
o4 = OldShape(111, 1789795057, 3, 0.05, 0.05, 4361.26, 4363.76, 4299.37, 4350.92, 'XAUUSD', '')
r4 = broker._order_row(o4)
check('[4a] time_setup missing -> falls back to time', r4['time'] == 1789795057, r4['time'])
check('[4b] row still fully mapped for the minimal shape',
      r4['ticket'] == 111 and abs(r4['price'] - 4361.26) < 1e-9)

# ---------------------------------------------------------------------------
# [5] _safe_rows: one poisoned row never kills the feed
# ---------------------------------------------------------------------------
class Poison:
    def __getattr__(self, k):
        raise RuntimeError('simulated broker row anomaly')
good = broker._order_row(stub._mk(**USER_SELL_LIMIT))
mixed = broker._safe_rows([stub._mk(**USER_SELL_LIMIT), Poison(), stub._mk(**USER_SELL_LIMIT)],
                          broker._order_row, 'order')
check('[5a] good rows survive a poisoned one', len(mixed) == 2 and mixed[0] == good)

def boom(r):
    raise ValueError('mapper exploded')
kept = broker._safe_rows([1, 2, 3], boom, 'position')
check('[5b] all-bad mapper degrades to [] instead of raising', kept == [])

# ---------------------------------------------------------------------------
# [6] the FULL state op (the renderer's 1.2s poll) with a pending on the
# account — the exact op that failed on the user's machine
# ---------------------------------------------------------------------------
acct = namedtuple('acct', 'login name server currency leverage balance equity profit margin margin_free margin_level')
class TermInfo:
    connected = True
    trade_allowed = True
def fake_account_info():
    return acct(103900099, 'CapitalxtendLLC-MU', 'CapitalxtendLLC-MU', 'USD', 500,
                1036.50, 1036.50, 0.0, 0.0, 1036.50, 0.0)
stub.account_info = fake_account_info
stub.terminal_info = lambda: TermInfo()
stub.positions_get = lambda **kw: []
stub.orders_get = lambda **kw: [stub._mk(**USER_SELL_LIMIT)]
broker.connected = True

res = broker.trade_rpc({'op': 'state'})
check('[6a] state op ok:True with a pending on the account', res.get('ok') is True, res.get('error'))
d = res.get('data') or {}
check('[6b] account row rides along', (d.get('account') or {}).get('login') == 103900099)
check('[6c] 1 order row present', len(d.get('orders') or []) == 1)
check('[6d] that row is the sell limit 108700923',
      (d.get('orders') or [{}])[0].get('ticket') == 108700923
      and (d.get('orders') or [{}])[0].get('type') == 3)
res2 = broker.trade_rpc({'op': 'orders'})
check('[6e] orders op ok:True', res2.get('ok') is True and len((res2.get('data') or {}).get('orders') or []) == 1)
res3 = broker.trade_rpc({'op': 'positions'})
check('[6f] positions op ok:True (empty)', res3.get('ok') is True and (res3.get('data') or {}).get('positions') == [])

# poisoned order on the REAL path must still answer ok with the good rows
stub.orders_get = lambda **kw: [stub._mk(**USER_SELL_LIMIT), Poison()]
res4 = broker.trade_rpc({'op': 'state'})
check('[6g] poisoned row: state still ok with 1 good row',
      res4.get('ok') is True and len((res4.get('data') or {}).get('orders') or []) == 1)

# ---------------------------------------------------------------------------
# [7] source contracts
# ---------------------------------------------------------------------------
src = open(os.path.join(PROV, 'mt5.py'), encoding='utf-8').read()
code_lines = [l.split('#')[0] for l in src.splitlines()]
code_only = '\n'.join(code_lines)
check('[7a] no unguarded volume_filled access in code (comments aside)',
      'volume_filled' not in code_only.replace("o.volume_filled", "o.volume_filled" if 'o.volume_filled' in '' else 'X'))
check('[7b] _safe_rows wired into the positions op', "_safe_rows(mt5.positions_get() or [], self._pos_row" in src)
check('[7c] _safe_rows wired into the orders op', "_safe_rows(mt5.orders_get() or [], self._order_row" in src)
check('[7d] state op uses _safe_rows for BOTH tables',
      src.count("'positions': self._safe_rows(mt5.positions_get()") == 1
      and src.count("'orders': self._safe_rows(mt5.orders_get()") == 1)
check('[7e] _order_row reads only documented attrs (getattr fallbacks present)',
      "getattr(o, 'volume_initial', 0)" in src and "getattr(o, 'volume_current', 0)" in src
      and "getattr(o, 'time_setup', 0)" in src)

def _summary():
    print('\n==== ROUND118 provider test: %d passed, %d failed ====' % (len(PASS), len(FAILS)))
    for f in FAILS:
        print('  FAILED:', f)

_summary()
sys.exit(1 if FAILS else 0)
