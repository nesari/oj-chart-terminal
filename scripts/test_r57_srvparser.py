#!/usr/bin/env python3
"""ROUND57 — synthetic unit tests for the servers.dat harvester/tree parser.

mt5.py hard-exits without the Windows-only MetaTrader5 package, so the
module-level helpers are exec'd from the source text in a clean namespace.
"""
import os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # dynamic since r58
os.chdir(ROOT)

PASS, FAIL = [], []
def ok(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK  ' if cond else ' FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

src = open('provider/mt5.py', encoding='utf-8').read()
i = src.find('# ---- ROUND57')
assert i >= 0
assert i >= 0
j = src.find('class MT5Broker(Broker):')
assert i > 0 and j > i
ns = {}
exec(compile(src[i:j], 'helpers', 'exec'), ns)
_harvest, _addr, _tree = ns['_srv_harvest'], ns['_srv_addr'], ns['_srv_tree']

def enc_u32(s):
    b = s.encode('utf-16-le')
    return len(s).to_bytes(4, 'little') + b

def enc_u16(s):
    b = s.encode('utf-16-le')
    return len(s).to_bytes(2, 'little') + b

STRINGS = [
    'ICMarketsSC',                      # broker title (boundary)
    'ICMarketsSC-MT5',                  # the account's server
    'live.icmarketsc.com:443',
    'icm-eu.icmarketsc.com:443',
    'ICMarketsSC-Live14',
    'eu15.icmarketsc.com:443',
    'ICMarketsSC-Demo',
    'demo.icmarketsc.com:443',
    'OtherBroker',                      # next broker -> block ends
    'OtherBroker-Live',
    'other.example.com:443',
]

# ---- layout A: u32-prefixed ------------------------------------------------
data32 = b''.join(enc_u32(s) for s in STRINGS)
h = _harvest(data32)
ok('u32 harvest: all 11 strings', [s for _, s in h] == STRINGS, [s for _, s in h])
t = _tree(h, 'ICMarketsSC-MT5')
ok('u32 tree: 3 sibling servers', sorted(t.keys()) == ['ICMarketsSC-Demo', 'ICMarketsSC-Live14', 'ICMarketsSC-MT5'], t)
ok('u32 tree: addresses paired', t.get('ICMarketsSC-Live14') == ['eu15.icmarketsc.com:443'], t)
ok('u32 tree: acc server kept', t.get('ICMarketsSC-MT5') == ['live.icmarketsc.com:443', 'icm-eu.icmarketsc.com:443'], t)
ok('u32 tree: no cross-broker leak', all('other' not in k.lower() for k in t), t)

# ---- layout B: u16-prefixed ------------------------------------------------
data16 = b''.join(enc_u16(s) for s in STRINGS)
h16 = _harvest(data16)
ok('u16 harvest: all 11 strings', [s for _, s in h16] == STRINGS, [s for _, s in h16])
ok('u16 tree: same result', sorted(_tree(h16, 'ICMarketsSC-MT5').keys()) == sorted(t.keys()))

# ---- gates & fallbacks -----------------------------------------------------
ok('gate: acc server absent -> {}', _tree(_harvest(data32), 'NoSuchServer-Live') == {})
ok('gate: garbage bytes -> no crash', isinstance(_tree(_harvest(b'\x01\x02\x03\x04' * 50), 'X-Live'), dict))
ok('gate: empty acc -> {}', _tree(_harvest(data32), '') == {})
ok('gate: 2-char prefix -> {}', _tree(_harvest(data32), 'AB-Live') == {})
mixed = b''.join(enc_u32(s) for s in STRINGS) + b'\xff\xfe\x00 garbage \x00\xff' + enc_u32('ICMarketsSC-Extra') + enc_u32('x15.icmarketsc.com:443')
t2 = _tree(_harvest(mixed), 'ICMarketsSC-MT5')
ok('garbage tolerated: base tree intact (no crash/corruption)',
   sorted(t2.keys()) == ['ICMarketsSC-Demo', 'ICMarketsSC-Live14', 'ICMarketsSC-MT5'], t2)

# ---- address classifier ----------------------------------------------------
ok('addr: host:port', _addr('live.broker.com:443') == 'live.broker.com:443')
ok('addr: ipv4:port', _addr('192.168.10.5:443') == '192.168.10.5:443')
ok('addr: bare dotted host', _addr('live.broker.com') == 'live.broker.com')
ok('name with dash is NOT an addr', _addr('Stonex.eu-Live') is None)
ok('name without dot is NOT an addr', _addr('ICMarketsSC') is None)
ok('bad port rejected', _addr('host.com:99999') is None)
ok('empty rejected', _addr('') is None)

# ---- sibling-name edge: dotted display name kept as server ------------------
STR2 = ['GlobalPrime', 'GPR-Live', 'live.gp.com:443', 'GPR-Live2', 'gp2.gp.com:443']
t3 = _tree(_harvest(b''.join(enc_u32(s) for s in STR2)), 'GPR-Live')
ok('edge: plain sibling names', sorted(t3.keys()) == ['GPR-Live', 'GPR-Live2'], t3)

print(f'\nRESULT: {len(PASS)}/{len(PASS)+len(FAIL)}')
if FAIL:
    print('FAILED:', *FAIL, sep='\n  - ')
    sys.exit(1)
