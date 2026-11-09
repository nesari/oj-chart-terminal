#!/usr/bin/env python3
"""ROUND57 verify — the broker's FULL access-server list in MT5 mode.

User report: the server section (login screen r55 + in-app popup r56) showed
only the CONNECTED server, not the whole list the broker has. Root cause:
the MT5 bridge's server_entries() returned just the account's server (the
automation API cannot enumerate the terminal's internal server list).
Fix (provider/mt5.py ONLY): read the terminal's OWN broker tree from
<data folder>/config/servers.dat — the exact file behind MT5's server
dialog — with a self-validating UTF-16LE string harvester (u32/u16/
null-terminated scans, gated on finding the account's own server in the
file, ROUND55 single-server fallback otherwise); sibling pings are REAL
tcp-connect times to the harvested host:port addresses; the connected
server keeps its REAL terminal IPC round trip. Renderer untouched.

Layers:
  1. static pins + mt5.py probe assertions
  2. byte-identity audit vs mt5-round56 for every file NOT part of this
     round (proves "nothing else touched" at byte level)
  3. subprocess: tests/unit/test_r57_srvparser.py  (synthetic servers.dat, 20)
  4. subprocess: tests/e2e/verify_round56.py      (r56 contract incl. e2e, 53)
"""
import json, os, re, subprocess, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PREV = os.path.join(os.path.dirname(ROOT), 'mt5-round56')
os.chdir(ROOT)

PASS, FAIL = [], []
def ok(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK  ' if cond else ' FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

# ---------- 1) static ----------
print('== static ==')
pkg = json.loads(read('package.json'))
ok('version 1.9.8+ (pin updated r58)', pkg.get('version') in ('1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))

mt = read('provider/mt5.py')
ok('mt5: socket imported alongside asyncio', 'import os, sys, json, time, argparse, asyncio, datetime as dt, socket' in mt)
ok('mt5: harvester present', 'def _srv_harvest(data):' in mt and '_SRV_LEN_CAP' in mt and '_SRV_FILE_CAP' in mt)
ok('mt5: three scan families (u32/u16/null-terminated; pin widened r58)', '_scan(4' in mt and '_scan(2' in mt and '_scan_nt(' in mt and ('key=len)' in mt))
ok('mt5: address classifier', 'def _srv_addr(s):' in mt and "rpartition(':')" in mt)
ok('mt5: tree builder with prefix rule', 'def _srv_tree(harvest, account_server):' in mt and "split('-')[0].split(' ')[0]" in mt and 'len(pre) < 3' in mt)
ok('mt5: SELF-VALIDATING gate on the account server', 'SELF-VALIDATING' in mt and "s.strip() == acc" in mt)
ok('mt5: block boundary walk + stop at next broker', 'block ended' in mt)
ok('mt5: ROUND55 single-server fallback kept', 'ROUND55 fallback' in mt)
ok('mt5: data-folder + install-dir servers.dat paths', "os.path.join(dp, 'config', 'servers.dat')" in mt and "os.path.join(os.path.dirname(p), 'config', 'servers.dat')" in mt)
ok('mt5: mtime-keyed tree cache', '(p, int(os.stat(p).st_mtime))' in mt and '_srv_tree_cache.clear()' in mt)
ok('mt5: server_entries returns addrs + cur first', "'addrs': tree.get(n, [])" in mt and 'names.remove(cur)' in mt and 'names[:40]' in mt)
ok('mt5: connected server keeps terminal IPC RTT', 'cheapest full IPC round trip' in mt)
ok('mt5: siblings get REAL tcp-connect ping (pin widened r58: + dns hosts list)', 'socket.create_connection(' in mt and 'timeout=1.5' in mt and ('create_connection((host, int(port)' in mt or 'create_connection((h, pt)' in mt))
ok('mt5: only ONE server_entries/server_ping_ms each', mt.count('def server_entries') == 1 and mt.count('async def server_ping_ms') == 1)
import ast
try:
    ast.parse(mt)
    ok('mt5: ast parses', True)
except SyntaxError as e:
    ok('mt5: ast parses', False, e)

# ---------- 2) byte-identity audit vs r56 ----------
print('== byte-identity vs mt5-round56 (nothing else touched) ==')
IDENT = [
    'src/renderer/index.html',
    'src/renderer/js/chart/toolbar.js',
    'src/renderer/js/ui/login.js',
    'src/renderer/css/app.css',
    'src/renderer/js/app.js',
    'main.js',
    'preload.js',
    'provider/demo.py',
    'provider/provider_common.py',
]
def h(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()
for rel in IDENT:
    ok('identical: ' + rel, os.path.exists(os.path.join(PREV, rel)) and h(rel) == h(os.path.join(PREV, rel)))

# ---------- 3) parser unit tests ----------
print('== subprocess: synthetic servers.dat parser tests ==')
r = subprocess.run([sys.executable, 'tests/unit/test_r57_srvparser.py'], capture_output=True, text=True, timeout=120)
m = re.search(r'RESULT: (\d+)/(\d+)', r.stdout)
ok('parser tests 20/20', bool(m) and m.group(1) == m.group(2) == '20', (m.group(0) if m else r.stdout[-200:] + r.stderr[-200:]))

# ---------- 4) r56 contract (static + full e2e) ----------
print('== subprocess: verify_round56 (behavior contract incl. e2e) ==')
r2 = subprocess.run([sys.executable, 'tests/e2e/verify_round56.py'], capture_output=True, text=True, timeout=420)
m2 = re.search(r'RESULT: (\d+)/(\d+)', r2.stdout)
ok('r56 contract 53/53', bool(m2) and m2.group(1) == m2.group(2) == '53', (m2.group(0) if m2 else r2.stdout[-300:] + r2.stderr[-300:]))

print(f'\nRESULT: {len(PASS)}/{len(PASS)+len(FAIL)}')
if FAIL:
    print('FAILED:', *FAIL, sep='\n  - ')
    sys.exit(1)
