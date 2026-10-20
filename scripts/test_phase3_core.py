#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 3 E2E — platform-agnostic core extraction:
  T1  Node purity: every core module imports & runs in plain Node (no DOM,
      no Electron) — logger ring/scrub/transport, errors catalog, indicators
      math, timezone funnel, state catalogs, feed fallbacks, util helpers
  T2  static purity: src/core has ZERO host-global references (env.js is the
      single sanctioned seam) and every cross-file import resolves
  T3  browser boot: renderer graph + provider login still clean over the new
      layout (src/ web root), zero console errors, __app facade + Log alive
"""
import os, re, shutil, sys, json, time, threading, http.server, functools, subprocess, signal

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(PROJ, 'src')
CORE = os.path.join(SRC, 'core')
ROOT = SRC  # web root for the browser check
PROV = os.path.join(PROJ, 'provider', 'demo.py')
PORT = 8995
OUT = '/home/z/my-project/download'
TMP = '/home/z/my-project/scripts/.phase3core'
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), str(detail)[:300]))
    print(('PASS' if ok else 'FAIL'), name, '—', str(detail)[:200])

# ---------------------------------------------------------------- T1: Node
# copy core modules as .mjs (Node needs the extension to treat them as ESM)
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)
for fn in os.listdir(CORE):
    if fn.endswith('.js'):
        s = open(os.path.join(CORE, fn)).read()
        s = re.sub(r"from '(\./[A-Za-z0-9_-]+)\.js'", r"from '\1.mjs'", s)
        open(os.path.join(TMP, fn[:-3] + '.mjs'), 'w').write(s)

node_script = r'''
const results = [];
const check = (name, ok, detail = '') => results.push([name, !!ok, String(detail).slice(0, 200)]);
const B = process.env.CORE_MJS + '/';
const { ENV } = await import(B + 'env.mjs');
const { Log } = await import(B + 'logger.mjs');
const { AppErr } = await import(B + 'errors.mjs');
const { Indicators } = await import(B + 'indicators.mjs');
const { TZ } = await import(B + 'timezone.mjs');
const { App } = await import(B + 'state.mjs');
const { Feed, priceDigits } = await import(B + 'feed.mjs');
const { clamp, timeToLogical, durHuman } = await import(B + 'util.mjs');

// ---- logger ----
const e1 = Log.info('app', 'hello core', { ok: 1 });
check('logger.info returns structured entry', e1 && e1.seq > 0 && e1.lvl === 'info' && e1.t > 0);
const e2 = Log.info('app', 'secret probe', { password: 'TOPSECRET', nested: { token: 'x' }, ok: 1 });
const s2 = JSON.stringify(e2.ctx);
check('scrub redacts nested secrets', s2.includes('redacted') && !s2.includes('TOPSECRET') && !s2.includes('"x"'), s2.slice(0, 80));
let batch = null;
Log.setTransport((b) => { batch = (batch || []).concat(b); });
Log.warn('test', 'transport probe');
Log.flushNow();
check('injected transport receives batch', Array.isArray(batch) && batch.some((e) => e.msg === 'transport probe'));
check('stats.ipc true after transport', Log.stats().ipc === true);
check('entries() search case-insensitive', Log.entries({ search: 'TRANSPORT PROBE' }).length >= 1);
const txt = Log.exportText();
check('exportText stable format', txt.includes('diagnostics log') && txt.includes('transport probe') && txt.includes('session   : s-'));
JSON.parse(Log.exportJson());

// ---- errors ----
check('catalog has >= 19 codes', AppErr.codes().length >= 19, 'n=' + AppErr.codes().length);
check('register() opens the catalog', AppErr.register('PHASE3_TEST', { severity: 'warning', category: 'system', userMessage: 'test msg' }) === true);
AppErr.raise('PHASE3_TEST', { context: { a: 1 } });
check('raise() logs [CODE] entry', Log.entries({ search: '[PHASE3_TEST]' }).length >= 1);
const w1 = AppErr.wrap(new Error('x'), 'UNKNOWN');
check('wrap() idempotent', w1 instanceof AppErr.AppError && AppErr.wrap(w1) === w1);

// ---- indicators ----
check('registry: 27 indicators', Indicators.all.length === 27, 'n=' + Indicators.all.length);
check('def("sma") computable', typeof Indicators.def('sma').compute === 'function');
const bars = Array.from({ length: 60 }, (_, i) => ({ time: 1700000000 + i * 60, open: 1, high: 2, low: 0.5, close: 1 + Math.sin(i / 6) * 0.5, volume: 1 }));
const sma = Indicators.compute({ type: 'sma', params: { length: 14 } }, bars);
check('sma aligns with bars', sma.lines[0].values.length === 60 && sma.lines[0].values[30] != null);
const rsi = Indicators.compute({ type: 'rsi', params: { length: 14 } }, bars);
check('rsi bounded 0..100', rsi.lines[0].values.slice(20).every((v) => v == null || (v >= 0 && v <= 100)));

// ---- timezone ----
check('zones list (TV) + broker pinned', TZ.zones().length >= 90 && TZ.sortedZones()[0] === 'broker');
const p = TZ.parts('UTC', 1700000000);
check('parts() shape', /^\d{2}$/.test(p.hour) && /^\d{4}$/.test(p.year) && !!p.monthShort);
check('tickLabel() non-empty', TZ.tickLabel('Asia/Tehran', 1700000000, 3, true).length >= 4);
check('fullLabel() funnel', TZ.fullLabel('broker', 1700000000).includes(':') && TZ.fullLabel('broker', 1700000000).length > 16);

// ---- state ----
check('App state + catalogs', Array.isArray(App.tfFavorites) && App.watchlist.length === 5 && typeof App.panes !== 'undefined');

// ---- feed (no connect in Node) ----
check('priceDigits fallbacks', priceDigits('EURUSD') === 5 && priceDigits('USDJPY') === 3 && priceDigits('XAUUSD') === 2 && priceDigits('XAGUSD') === 3);
const f = new Feed('ws://example.invalid:1');
check('Feed(url) injectable', f.url === 'ws://example.invalid:1' && typeof f.connect === 'function');

// ---- util + env storage degrade ----
check('pure helpers', clamp(5, 0, 3) === 3 && durHuman(90) === '1m 30s');
check('timeToLogical interpolation', timeToLogical([100, 200, 300], 150) === 0.5);
check('ENV.storage degrades in Node', ENV.storage.get('phase3-nope', 'D') === 'D' && ENV.electron === false);

console.log('PHASE3-NODE-RESULT:' + JSON.stringify(results));
'''

env = dict(os.environ, CORE_MJS=TMP)
proc = subprocess.run(['node', '--input-type=module', '-e', node_script],
                      capture_output=True, text=True, env=env, timeout=60)
m = re.search(r'PHASE3-NODE-RESULT:(\[.*\])', proc.stdout, re.S)
if proc.returncode != 0 or not m:
    check('T1 Node core smoke run', False, (proc.stderr or proc.stdout)[-400:])
else:
    for name, ok, detail in json.loads(m.group(1)):
        check('T1 ' + name, ok, detail)

# ---------------------------------------------------------------- T2: static
FORBID = re.compile(r'window\.|document\.|electronAPI|localStorage')
bad = []
for fn in sorted(os.listdir(CORE)):
    if not fn.endswith('.js'):
        continue
    src = open(os.path.join(CORE, fn)).read()
    hits = FORBID.findall(src)
    if fn == 'env.js':
        continue  # the single sanctioned seam
    if hits:
        bad.append((fn, hits[:3]))
check('T2 core has zero host-global refs (env.js = only seam)', not bad, json.dumps(bad))
# ...and env.js is the only file allowed to carry them
seam = [fn for fn in os.listdir(CORE) if fn.endswith('.js') and FORBID.search(open(os.path.join(CORE, fn)).read())]
check('T2 env.js is the ONLY core file touching host globals', seam == ['env.js'], json.dumps(seam))

# import resolution across the whole tree
spec_re = re.compile(r"""(?:from|import)\s+['"](\.[^'"]+)['"]""")
unresolved = []
for dirpath, _dirs, files in os.walk(SRC):
    for fn in files:
        if not fn.endswith('.js'):
            continue
        fp = os.path.join(dirpath, fn)
        for spec in spec_re.findall(open(fp).read()):
            tgt = os.path.normpath(os.path.join(dirpath, spec))
            if not os.path.isfile(tgt):
                unresolved.append(f'{os.path.relpath(fp, SRC)} -> {spec}')
check('T2 every relative import resolves', not unresolved, '; '.join(unresolved[:4]))

# ---------------------------------------------------------------- T3: browser
prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.4)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errors = []
    pg.on('console', lambda mm: errors.append(mm.text) if mm.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)

    t = pg.evaluate("""() => {
      const A = window.__app || {};
      return {
        facade: !!window.__app,
        logStats: A.Log ? A.Log.stats() : null,
        setTransport: A.Log ? typeof A.Log.setTransport : 'missing',
        feedUrl: A.App && A.App.feed ? A.App.feed.url : null,
        indicators: A.Indicators ? A.Indicators.all.length : 0,
        errCount: A.Log ? A.Log.entries({ lvl: 'error' }).length : -1
      };
    }""")
    check('T3 facade + Log alive on new layout', t['facade'] and t['logStats'] and t['setTransport'] == 'function', json.dumps({k: t[k] for k in ('facade', 'setTransport', 'indicators')}))
    check('T3 feed default URL kept', t['feedUrl'] == 'ws://127.0.0.1:8777', str(t['feedUrl']))

    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(9000)
    t2 = pg.evaluate("""() => {
      const A = window.__app;
      return {
        bars: A.App.activePane && A.App.activePane.bars ? A.App.activePane.bars.length : 0,
        indicators: A.Indicators.all.length,
        scr: JSON.stringify(A.Log.stats())
      };
    }""")
    check('T3 demo login + bars land (zero regression)', t2['bars'] > 100, 'bars=' + str(t2['bars']))
    check('T3 zero console errors (boot+login+bars)', len(errors) == 0, '; '.join(errors[:3]))
    pg.screenshot(path=os.path.join(OUT, 'phase3-core.png'))
    b.close()

try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass

fails = [r for r in results if not r[1]]
print()
print('PHASE3 RESULT:', 'ALL PASS (%d checks)' % len(results) if not fails else '%d/%d FAILED' % (len(fails), len(results)))
sys.exit(1 if fails else 0)
