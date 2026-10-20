#!/usr/bin/env python3
"""ROUND58 — synthetic unit tests for the WIDENED servers.dat harvester.

Covers the ROUND58 hypothesis directly: the field report ("still one server")
means the real file's strings may be ANSI/ASCII (MT4-lineage Pascal/NUL
layouts), not only UTF-16LE. Every realistic layout family must yield the
broker tree, the self-validating gate must stay inert on garbage, the
gate-failure debug dump must fire exactly once, and MT5Broker must surface
the full list through server_entries()/server_ping_ms() with a stubbed
MetaTrader5 module (no Windows package on this machine).
"""
import os, sys, json, struct, asyncio, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, 'provider'))

PASS, FAIL = [], []
def ok(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK  ' if cond else ' FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

# ---- harvest the helper block straight from the real source text ----------
src = open('provider/mt5.py', encoding='utf-8').read()
i = src.find('# ---- ROUND57')
assert i >= 0
j = src.find('class MT5Broker(Broker):')
assert i > 0 and j > i
ns = {'os': os, 'json': json, 'time': __import__('time')}
exec(compile(src[i:j], 'helpers', 'exec'), ns)
_harvest, _addr, _tree = ns['_srv_harvest'], ns['_srv_addr'], ns['_srv_tree']

ACC = 'CapitalxtendLLC-MU'
STRINGS = [
    'CapitalXtend Markets',        # broker title (block boundary)
    ACC,                           # the account's own server
    '5.135.10.1:443',
    '5.135.10.2:443',
    'CapitalxtendLLC-Live',
    'eu-1.capitalxtend.com:443',
    'CapitalxtendLLC-Demo',
    'demo.capitalxtend.com:443',
    'OtherBroker Ltd',             # next broker's title (block must stop)
    'OtherBroker-S1',
]

def blob_u32u16():  return b''.join(struct.pack('<I', len(s)) + s.encode('utf-16-le') for s in STRINGS)
def blob_u16u16():  return b''.join(struct.pack('<H', len(s)) + s.encode('utf-16-le') for s in STRINGS)
def blob_ntu16():   return b'\x00\x00'.join(s.encode('utf-16-le') for s in STRINGS) + b'\x00\x00'
def blob_a32():     return b''.join(struct.pack('<I', len(s)) + s.encode('ascii') for s in STRINGS)
def blob_a8():      return b''.join(bytes([len(s)]) + s.encode('ascii') for s in STRINGS)
def blob_ant():     return b'\x00'.join(s.encode('ascii') for s in STRINGS) + b'\x00'

EXPECT_NAMES = [ACC, 'CapitalxtendLLC-Live', 'CapitalxtendLLC-Demo']

def check_layout(name, blob):
    h = _harvest(blob)
    got = [s for _, s in h]
    ok(name + ': all 10 strings harvested', len(got) == len(STRINGS), got)
    tree = _tree(h, ACC)
    ok(name + ': broker tree = 3 servers', list(tree.keys()) == EXPECT_NAMES, list(tree.keys()))
    ok(name + ': MU addresses paired', tree.get(ACC) == ['5.135.10.1:443', '5.135.10.2:443'], tree.get(ACC))
    ok(name + ': sibling address paired', tree.get('CapitalxtendLLC-Live') == ['eu-1.capitalxtend.com:443'], tree.get('CapitalxtendLLC-Live'))
    ok(name + ': block stops at next broker', 'OtherBroker-S1' not in tree)

check_layout('utf16-u32', blob_u32u16())
check_layout('utf16-u16', blob_u16u16())
check_layout('utf16-nt ', blob_ntu16())
check_layout('ascii-u32', blob_a32())
check_layout('ascii-u8 ', blob_a8())
check_layout('ascii-nt ', blob_ant())

# gate inertness: garbage / account-absent must yield an empty tree
ok('gate: account absent -> empty tree', _tree(_harvest(blob_a32()), 'SomeOtherServer-X') == {})
ok('gate: empty input -> empty tree', _harvest(b'') == [] and _tree([], ACC) == {})
noise = bytes(range(256)) * 8
ok('gate: binary noise -> empty tree', _tree(_harvest(noise), ACC) == {})
ok('addr: host:port accepted', _addr('5.135.10.1:443') == '5.135.10.1:443')
ok('addr: display name rejected', _addr('Stonex.eu-Live') is None)
ok('addr: bad port rejected', _addr('host:notaport') is None)

# ---- full class path with a stubbed MetaTrader5 module ---------------------
stub = types.ModuleType('MetaTrader5')
stub.terminal_info = lambda: None
stub.initialize = lambda **kw: False
stub.login = lambda **kw: False
stub.shutdown = lambda: None
stub.last_error = lambda: (0, 'stub')
stub.account_info = lambda: None
stub.copy_rates_range = lambda *a, **k: None
stub.copy_ticks_range = lambda *a, **k: None
stub.symbols_get = lambda *a, **k: None
stub.symbol_info = lambda *a, **k: None
stub.symbol_select = lambda *a, **k: None
stub.TIMEFRAME_M1 = 1; stub.TIMEFRAME_M5 = 5; stub.TIMEFRAME_M15 = 15
stub.TIMEFRAME_M30 = 30; stub.TIMEFRAME_H1 = 16385; stub.TIMEFRAME_H4 = 16388
stub.TIMEFRAME_D1 = 16408; stub.TIMEFRAME_W1 = 32769; stub.TIMEFRAME_MN1 = 49153
stub.TIMEFRAME_M2 = 2; stub.TIMEFRAME_M3 = 3; stub.TIMEFRAME_M4 = 4
stub.TIMEFRAME_M6 = 6; stub.TIMEFRAME_M10 = 10; stub.TIMEFRAME_M12 = 12
stub.TIMEFRAME_M20 = 20; stub.TIMEFRAME_H2 = 16386; stub.TIMEFRAME_H3 = 16387
stub.TIMEFRAME_H6 = 16390; stub.TIMEFRAME_H8 = 16392; stub.TIMEFRAME_H12 = 16396
sys.modules['MetaTrader5'] = stub

spec_ok = True
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location('mt5mod58', os.path.join(ROOT, 'provider', 'mt5.py'))
    mt5mod = importlib.util.module_from_spec(spec)
    sys.modules['mt5mod58'] = mt5mod
    spec.loader.exec_module(mt5mod)
except SystemExit:
    spec_ok = False
    print(' FAIL  mt5.py import with stubbed MetaTrader5 (SystemExit)')
ok('mt5.py imports cleanly with stubbed MetaTrader5', spec_ok)

if spec_ok:
    tmp = tempfile.mkdtemp(prefix='r58srv_')
    dat = os.path.join(tmp, 'servers.dat')
    open(dat, 'wb').write(blob_a32())  # the NEW ascii layout is what matters

    B = mt5mod.MT5Broker(123, 'x', ACC, '')
    B._acc_server = lambda: ACC
    B._srv_paths = lambda: [dat]
    mt5mod.MT5Broker._srv_tree_cache.clear()
    mt5mod.DEBUG_FILE = os.path.join(tmp, 'dbg.txt')

    tree = B._srv_addrs_map()
    ok('class: ascii file -> full addrs map', list(tree.keys()) == EXPECT_NAMES, list(tree.keys()))

    ents = B.server_entries()
    ok('class: server_entries lists ALL 3 servers', [e['name'] for e in ents] == EXPECT_NAMES,
       [e['name'] for e in ents])
    ok('class: entries carry addrs', ents[0].get('addrs') == ['5.135.10.1:443', '5.135.10.2:443'], ents[0])
    ok('class: success writes NO debug dump', not os.path.exists(mt5mod.DEBUG_FILE))

    # gate failure -> empty map + diagnostics dump written exactly once
    B2 = mt5mod.MT5Broker(123, 'x', 'NotPresentAnywhere-1', '')
    B2._acc_server = lambda: 'NotPresentAnywhere-1'
    B2._srv_paths = lambda: [dat]
    mt5mod.MT5Broker._srv_tree_cache.clear()
    tree2 = B2._srv_addrs_map()
    ok('class: gate failure -> empty map (fallback preserved)', tree2 == {})
    ok('class: gate failure writes debug dump', os.path.exists(mt5mod.DEBUG_FILE))
    dump = open(mt5mod.DEBUG_FILE).read() if os.path.exists(mt5mod.DEBUG_FILE) else ''
    ok('dump: names the account server', 'NotPresentAnywhere-1' in dump)
    ok('dump: names the candidate path', dat in dump)
    ok('dump: includes harvest strings', 'CapitalXtend Markets' in dump)
    ok('dump: includes hex head', 'hex head of' in dump and ' 0000 ' in dump)

    # no candidates at all -> empty, no crash, no dump (nothing learned)
    if os.path.exists(mt5mod.DEBUG_FILE):
        os.remove(mt5mod.DEBUG_FILE)
    B3 = mt5mod.MT5Broker(123, 'x', 'NotPresentAnywhere-1', '')
    B3._acc_server = lambda: 'NotPresentAnywhere-1'
    B3._srv_paths = lambda: []
    ok('class: zero candidates -> {} ', B3._srv_addrs_map() == {})
    ok('class: zero candidates ALSO dumps (says no file found anywhere)',
       os.path.exists(mt5mod.DEBUG_FILE) and 'candidates: []' in open(mt5mod.DEBUG_FILE).read())

    # entries order: connected server first, capped at 40
    many = {n: [] for n in ['S%02d' % i for i in range(60)]}
    many[ACC] = ['5.135.10.1:443']
    B4 = mt5mod.MT5Broker(123, 'x', ACC, '')
    B4._srv_addrs_map = lambda: dict(many)
    e4 = B4.server_entries()
    ok('class: entries capped at 40', len(e4) == 40)
    ok('class: connected server listed first', e4[0]['name'] == ACC)

    # DNS ping for a name-only sibling (fully patched socket, no network)
    import socket as _s
    class _FakeSock:
        def __init__(self, *a, **k): pass
        def close(self): pass
    real_gai, real_conn = _s.getaddrinfo, _s.create_connection
    _s.getaddrinfo = lambda h, p, type=None: [(2, 1, 6, '', ('9.9.9.9', p))]
    _s.create_connection = lambda hp, timeout=None: _FakeSock()
    try:
        B5 = mt5mod.MT5Broker(123, 'x', ACC, '')
        B5._acc_server = lambda: 'ZZZ-Other'  # force the sibling branch
        B5._srv_addrs_map = lambda: {'CapitalxtendLLC-Live': []}
        r = asyncio.get_event_loop().run_until_complete(B5.server_ping_ms('CapitalxtendLLC-Live'))
        ok('ping: name-only sibling resolves via DNS + real tcp', isinstance(r, float) and r >= 0, r)
        B5b = mt5mod.MT5Broker(123, 'x', ACC, '')
        B5b._acc_server = lambda: 'ZZZ-Other'
        B5b._srv_addrs_map = lambda: {}
        _s.getaddrinfo = lambda h, p, type=None: []
        r2 = asyncio.get_event_loop().run_until_complete(B5b.server_ping_ms('Nope No Space'))
        ok('ping: unresolvable sibling -> None (row shows unknown, not fake)', r2 is None, r2)
    finally:
        _s.getaddrinfo, _s.create_connection = real_gai, real_conn

    # _srv_paths glob branch (fake APPDATA terminal dir)
    appd = os.path.join(tmp, 'appdata')
    tdir = os.path.join(appd, 'MetaQuotes', 'Terminal', 'DEADBEEF', 'config')
    os.makedirs(tdir)
    open(os.path.join(tdir, 'servers.dat'), 'wb').write(blob_u32u16())
    os.environ['APPDATA'] = appd
    B6 = mt5mod.MT5Broker(123, 'x', ACC, '')
    B6.__class__._srv_tree_cache and setattr(mt5mod.MT5Broker, '_srv_tree_cache', {})
    ps = mt5mod.MT5Broker._srv_paths(B6)
    ok('paths: APPDATA glob finds terminal config', any(p.endswith(os.path.join('DEADBEEF', 'config', 'servers.dat')) for p in ps), ps)
    ok('paths: deduped', len(ps) == len(set(ps)))
    os.environ.pop('APPDATA', None)

print('')
print('RESULT: %d/%d' % (len(PASS), len(PASS) + len(FAIL)))
sys.exit(1 if FAIL else 0)
