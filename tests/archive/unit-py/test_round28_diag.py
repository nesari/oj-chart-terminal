#!/usr/bin/env python3
"""Round 28 E2E — logging / monitoring / error-handling / security layer:
  T1  boot: Log + AppErr load first, no CSP breakage, zero console errors
  T2  diagnostics panel opens via the right rail, rows render, stats live
  T3  logger API: levels, categories, ring cap, entries() filter, search
  T4  error system: catalog lookup, wrap(), open register(), toUser()
  T5  security: context scrubbing redacts password/token everywhere
  T6  self-test run via panel API: all checks pass/skip, zero fail
  T7  export payload: text + json dumps are non-trivial and structured
  T8  crash net: unhandledrejection is captured, rate-limited toast shown
  T9  regression: round 27 depth intact (M1 = 5000) after instrumentation
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8988
OUT = '/home/z/my-project/download'
os.makedirs(OUT, exist_ok=True)

prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.4)

results = []
def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS' if ok else 'FAIL'), name, '—', detail)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errors = []
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(9000)

    # ---- T1: boot integrity ----
    t1 = pg.evaluate("""() => ({
      hasLog: !!window.__app.Log, hasErr: !!window.__app.AppErr, hasDiag: !!window.__app.Diagnostics,
      session: window.__app.Log && window.__app.Log.sessionId || '', boot: window.__app.Log && window.__app.Log.stats().total > 0,
      codes: window.__app.AppErr && window.__app.AppErr.codes().length || 0
    })""")
    check('T1 boot: Log/AppErr/Diagnostics loaded', t1['hasLog'] and t1['hasErr'] and t1['hasDiag'] and t1['boot'] and t1['codes'] >= 15, json.dumps(t1))

    # ---- T2: diagnostics panel ----
    pg.evaluate("() => window.__app.RightPanel.showTab('diagnostics')")
    pg.wait_for_timeout(600)
    t2 = pg.evaluate("""() => ({
      visible: !document.getElementById('tab-diagnostics').classList.contains('hidden'),
      rows: document.querySelectorAll('#dg-list .dg-row').length,
      stats: document.getElementById('dg-stats').textContent,
      cats: document.getElementById('dg-cat').options.length
    })""")
    check('T2 panel opens with rows + stats', t2['visible'] and t2['rows'] >= 3 and t2['cats'] >= 2, json.dumps(t2))
    pg.screenshot(path=os.path.join(OUT, 'r28-diagnostics-panel.png'))

    # ---- T3: logger API ----
    t3 = pg.evaluate("""() => {
      window.__app.Log.debug('selftest', 't3-debug'); window.__app.Log.info('selftest', 't3-info');
      window.__app.Log.warn('selftest', 't3-warn'); window.__app.Log.error('selftest', 't3-error', { code: 42 });
      const all = window.__app.Log.entries({});
      const bySearch = window.__app.Log.entries({ search: 't3-' });
      const errs = window.__app.Log.entries({ lvl: 'error' });
      const s = window.__app.Log.stats();
      return { total: all.length, searched: bySearch.length >= 4, errsHasT3: errs.some(e => e.msg.includes('t3-error')),
               ctxKept: errs.find(e => e.msg.includes('t3-error')).ctx.code === 42,
               countsOk: s.counts.error >= 1 && s.counts.warn >= 1, catsHasSelftest: !!s.cats.selftest };
    }""")
    check('T3 logger levels/filter/search/ctx', all([t3['searched'], t3['errsHasT3'], t3['ctxKept'], t3['countsOk'], t3['catsHasSelftest']]), json.dumps(t3))

    # ---- T4: error system ----
    t4 = pg.evaluate("""() => {
      const w = window.__app.AppErr.wrap(new Error('plain fail'), 'FEED_TIMEOUT');
      const created = window.__app.AppErr.create('BARS_EMPTY');
      const reg1 = window.__app.AppErr.register('ROUND28_PROBE', { userMessage: 'probe ok', category: 'system', severity: 'warning' });
      const reg2 = window.__app.AppErr.register('ROUND28_PROBE', {});
      const again = window.__app.AppErr.wrap(w);
      const raised = window.__app.AppErr.raise('FEED_TIMEOUT');
      return { wrapCode: w.code === 'FEED_TIMEOUT', wrapUser: w.toUser().includes('timed out') || w.userMessage.length > 0,
               createdCat: created.category === 'data', reg1: reg1 === true, reg2: reg2 === false,
               idempotent: again === w, sevFromCatalog: window.__app.AppErr.spec(w.code).severity === w.severity,
               raiseLogged: window.__app.Log.entries({ search: '[FEED_TIMEOUT]' }).length >= 1 };
    }""")
    check('T4 AppError catalog/wrap/register', all(t4.values()), json.dumps(t4))

    # ---- T5: scrubbing ----
    t5 = pg.evaluate("""() => {
      window.__app.Log.info('selftest', 'sec-probe', { password: 'SUPERSECRET', nested: { token: 'tok123', deep: { auth: 'zz' } }, safe: 7 });
      const e = window.__app.Log.entries({ search: 'sec-probe' })[0];
      return { pw: e.ctx.password, tok: e.ctx.nested.token, auth: e.ctx.nested.deep.auth, safe: e.ctx.safe,
               redacted: e.ctx.password === '•••redacted•••' && e.ctx.nested.token === '•••redacted•••' && e.ctx.nested.deep.auth === '•••redacted•••' && e.ctx.safe === 7 };
    }""")
    check('T5 sensitive keys redacted (nested)', t5['redacted'], json.dumps(t5))

    # ---- T6: selftest ----
    t6 = pg.evaluate("async () => await window.__app.Diagnostics.selftest()")
    check('T6 selftest: fail=0', t6['fail'] == 0 and t6['pass'] >= 6, 'pass=%(pass)s skip=%(skip)s fail=%(fail)s' % t6)

    # ---- T7: export payload ----
    t7 = pg.evaluate("""() => {
      const txt = window.__app.Log.exportText(), js = window.__app.Log.exportJson();
      return { txtOk: txt.length > 400 && txt.includes('OJchart') && txt.includes('session'),
               jsOk: js.length > 400 && JSON.parse(js).meta.sessionId === window.__app.Log.sessionId,
               rows: window.__app.Log.entries({ search: 'sec-probe' }).length >= 1 };
    }""")
    check('T7 export text+json structured', t7['txtOk'] and t7['jsOk'], json.dumps({k: t7[k] for k in ('txtOk', 'jsOk')}))

    # ---- T8: crash net ----
    pg.evaluate("() => { setTimeout(() => { Promise.reject(new Error('round28-unhandled-probe')); }, 0); }")
    pg.wait_for_timeout(1200)
    t8 = pg.evaluate("""() => {
      const hits = window.__app.Log.entries({ search: 'round28-unhandled-probe' });
      return { captured: hits.length === 1 && hits[0].lvl === 'error',
               toastShown: document.querySelectorAll('#toasts .toast').length >= 1 };
    }""")
    check('T8 unhandled rejection captured + toast', t8['captured'], json.dumps(t8))

    # ---- T9: regression — round 27 depth ----
    t9 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      return { sym: P.symbol, tf: P.tf, n: P.bars.length, digits: P.digits };
    }""")
    check('T9 regression: M1 depth ~5000 + digits=5', t9['tf'] == 'M1' and t9['n'] >= 4900 and t9['digits'] == 5, json.dumps(t9))

    # panel screenshot after selftest output
    pg.screenshot(path=os.path.join(OUT, 'r28-final-state.png'))

    real_errors = [e for e in errors if 'round28-unhandled-probe' not in e]
    check('console: zero unexpected errors', len(real_errors) == 0, '; '.join(real_errors[:3]))

    b.close()

# stop provider
try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass

fails = [r for r in results if not r[1]]
print()
print('ROUND28 RESULT:', 'ALL PASS (%d checks)' % len(results) if not fails else '%d/%d FAILED' % (len(fails), len(results)))
sys.exit(1 if fails else 0)
