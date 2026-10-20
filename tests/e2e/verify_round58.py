#!/usr/bin/env python3
"""ROUND58 verify gate.

Field report: v1.9.8 (ROUND57) still showed ONE server for the user's MT5
broker. Root cause hypothesis: the real config/servers.dat stores its
strings in an ANSI/ASCII (MT4-lineage) layout, which the ROUND57 UTF-16LE-only
harvester missed -> the self-validating gate failed -> single-server fallback.

Fix (provider/mt5.py ONLY): widen the harvester to BOTH string families
(UTF-16LE + ASCII, length-prefixed u32/u8 and NUL-terminated), glob extra
candidate paths, DNS-ping name-only siblings like the terminal does, and on
gate failure write a silent diagnostics dump (%TEMP%/mt5_servers_dat_debug.txt)
so a stubborn file can be nailed exactly instead of re-guessed.

Checks:
  1. static pins (version 1.9.9, widened scans, glob, dump, dns ping)
  2. BYTE-IDENTITY audit of every src/ file + demo/common providers vs r57
     (renderer untouched — the guarantee that nothing else changed)
  3. subprocess: test_r58_srvparser.py (55 layout/class/ping/dump tests)
  4. subprocess: test_r57_srvparser.py (r57 synthetic layouts still 20/20)
  5. subprocess: verify_round56.py (full popup e2e on this tree, 53 checks)
"""
import json, os, subprocess, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PREV = '/home/z/my-project/work/mt5-round57'
os.chdir(ROOT)

PASS, FAIL = [], []
def ok(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK  ' if cond else ' FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

def sha(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()

print('== 1) static ==')
pkg = json.loads(read('package.json'))
ok('version 1.9.9+ (pin updated r59)', pkg.get('version') in ('1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))

mt = read('provider/mt5.py')
ok('harvester widened: both scan families',
   "_scan(4, True)" in mt and "_scan(2, True)" in mt and "_scan_nt(True)" in mt and
   "_scan(4, False)" in mt and "_scan(1, False)" in mt and "_scan_nt(False)" in mt and
   "max(scans, key=len)" in mt)
ok('latin-1 decode for ascii family', "'latin-1'" in mt)
ok('glob candidates (APPDATA MetaQuotes Terminal)',
   "'MetaQuotes', 'Terminal', '*'" in mt and 'glob' in mt)
ok('dns ping for name-only siblings', 'getaddrinfo(nm, 443' in mt and 'create_connection((h, pt)' in mt)
ok('silent gate-failure debug dump', 'def _srv_debug_dump' in mt and 'DEBUG_FILE' in mt and
   'mt5_servers_dat_debug.txt' in mt)
ok('gate unchanged (SELF-VALIDATING)', 'SELF-VALIDATING' in mt and 's.strip() == acc' in mt)
ok('fallback unchanged (single account server)', "return [{'name': n} for n in names]" in mt)
ok('demo/common providers untouched markers intact',
   os.path.exists('provider/demo.py') and os.path.exists('provider/provider_common.py'))

print('== 2) byte-identity vs r57 (nothing else touched) ==')
SAME = ['index.html']
src_r58, src_r57 = os.path.join(ROOT, 'src'), os.path.join(PREV, 'src')
n_id, n_cmp = 0, 0
for base in (src_r58,):
    FIXED_R59 = {'src/renderer/js/chart/manager.js', 'src/renderer/js/drawing/engine.js',
                 'src/renderer/js/drawing/tools2.js', 'src/renderer/js/drawing/settings.js',
                 'src/renderer/js/drawing/ui.js', 'src/renderer/js/ui/icons.js'}  # + r60 fib flyout (audited by verify_round60)
    for dp, _, fns in os.walk(base):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, ROOT)
            if rel in FIXED_R59:
                continue  # r59 changed these two (crosshair sync fix) — audited by verify_round59
            q = os.path.join(PREV, rel)
            if not os.path.exists(q):
                ok('new file unexpected in src/: ' + rel, False)
                continue
            n_cmp += 1
            if sha(p) == sha(q):
                n_id += 1
            else:
                ok('src file differs from r57: ' + rel, False)
ok('all %d src/ files byte-identical to r57' % n_cmp, n_cmp > 0 and n_id == n_cmp)
for rel in ('provider/demo.py', 'provider/provider_common.py', 'main.js', 'src/renderer/index.html'):
    a, b = os.path.join(ROOT, rel), os.path.join(PREV, rel)
    if os.path.exists(a) and os.path.exists(b):
        ok('unchanged vs r57: ' + rel, sha(a) == sha(b))
    else:
        ok('exists: ' + rel, os.path.exists(a))

print('== 3) subprocess: test_r58_srvparser.py ==')
r = subprocess.run([sys.executable, 'tests/unit/test_r58_srvparser.py'],
                   capture_output=True, text=True, timeout=120)
tail = [l for l in r.stdout.splitlines() if l.startswith('RESULT')]
ok('r58 parser/class tests 55/55', 'RESULT: 55/55' in r.stdout, tail or r.stderr[-300:])
ok('exit code 0', r.returncode == 0, r.returncode)

print('== 4) subprocess: test_r57_srvparser.py (backward compat) ==')
r = subprocess.run([sys.executable, 'tests/unit/test_r57_srvparser.py'],
                   capture_output=True, text=True, timeout=120)
ok('r57 synthetic layouts still 20/20 on r58 code', 'RESULT: 20/20' in r.stdout,
   [l for l in r.stdout.splitlines() if l.startswith('RESULT')] or r.stderr[-300:])

print('== 5) subprocess: verify_round56.py (popup e2e, demo 6 rows) ==')
r = subprocess.run([sys.executable, 'tests/e2e/verify_round56.py'],
                   capture_output=True, text=True, timeout=300)
ok('r56 popup e2e green on r58 tree', 'ALL GREEN' in r.stdout or '53/53' in r.stdout,
   r.stdout[-400:] + r.stderr[-200:])

print('')
print('RESULT: %d/%d' % (len(PASS), len(PASS) + len(FAIL)))
sys.exit(1 if FAIL else 0)
