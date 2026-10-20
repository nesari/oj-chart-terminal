"""Unit test for mt5.py search (ROUND 35: case-insensitive) — runs on any OS
by injecting a FAKE MetaTrader5 module before importing the provider."""
import sys, types, os

# ---- fake MetaTrader5 package with a case-SENSITIVE wildcard (like the real one) ----
fake = types.ModuleType('MetaTrader5')
class _Sym:
    def __init__(self, name, visible):
        self.name, self.visible = name, visible
ALL = [_Sym('EURUSD', True), _Sym('GBPUSD', True), _Sym('USDJPY', True), _Sym('eurusd.m', False),
       _Sym('XAUUSD', True), _Sym('GER40', True), _Sym('BTCUSD', False)]
def symbols_get(group=None):
    if not group:
        return list(ALL)
    mask = group.strip('*').upper()  # the REAL MT5 wildcard is case-sensitive
    return [s for s in ALL if mask in s.name.upper() and (s.name.isupper() == mask.isupper() or mask in s.name)]
# emulate the real package: '*eur*' does NOT match 'EURUSD' (case-sensitive)
def symbols_get_strict(group=None):
    if not group:
        return list(ALL)
    mask = group.strip('*')
    return [s for s in ALL if mask in s.name]
fake.symbols_get = symbols_get_strict
for k in ('M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H3', 'H4', 'D1', 'W1', 'MN1'):
    setattr(fake, 'TIMEFRAME_' + k, k)
fake.initialize = lambda **kw: True
fake.login = lambda **kw: True
fake.shutdown = lambda: None
fake.account_info = lambda: None
fake.last_error = lambda: (0, 'ok')
fake.symbol_info = lambda s: None
fake.symbol_select = lambda s, e: True
fake.symbols_get.__doc__ = ''
sys.modules['MetaTrader5'] = fake

sys.path.insert(0, '/home/z/my-project/work/app/provider')
import mt5

b = mt5.MT5Broker('1', 'x', 's', '')
PASS = FAIL = 0
def check(name, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print('PASS', name, extra)
    else: FAIL += 1; print('FAIL', name, extra)

r = b.search('eur')          # lowercase -> must match EURUSD (and eurusd.m)
check('lowercase "eur" finds EURUSD', 'EURUSD' in r, str(r))
check('lowercase "eur" finds eurusd.m', 'eurusd.m' in r, str(r))
r = b.search('EuR')
check('mixed case "EuR" finds EURUSD', 'EURUSD' in r, str(r))
r = b.search('EUR')
check('uppercase "EUR" finds EURUSD', 'EURUSD' in r, str(r))
r = b.search('')
check('empty query lists all, no dups', len(r) == len(set(r)) and len(r) == len(ALL), str(r))
r = b.search('zzz')
check('no match -> empty', r == [], str(r))
r = b.search('  usd  ')
check('trimmed "usd" finds USDJPY', 'USDJPY' in r, str(r))
print(f'\n==== MT5 SEARCH UNIT: {PASS} PASS / {FAIL} FAIL ====')
sys.exit(1 if FAIL else 0)
