#!/usr/bin/env python3
"""ROUND299 e2e — built-in indicators are Pine scripts, live.

ROUND298 verified that channel bands painted through a hand-written
lightweight-charts series primitive. That primitive has been DELETED: every
built-in indicator is a Pine script now, so the band is Pine's fill() painted by
the SHARED Pine adapter — the same code path the user's own scripts use.

What this proves in the REAL app:
  1. every one of the 27 built-ins runs through the engine and paints (its plots
     exist, its pane is right, its legend row exists, no runtime leaks);
  2. the three channel indicators carry a real fill() band, coloured on every
     bar and not hidden by the Style tab;
  3. the Indicators dialog does not present built-ins as the user's own scripts
     (they are app-provided scripts, not entries in "My Scripts").

Run: python tests/archive/e2e/e2e_round299_builtin_pine.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9023, 8903
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)


def wait_port(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def serve_http():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()


# Add every built-in in turn; assert the engine ran it, its pane is right and a
# legend row exists. The engine is async (chunked passes), so each add waits for
# a status, not a fixed sleep.
ALL_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 80; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };
  const out = [];
  for (const def of A.Indicators.all) {
    const before = ((pane.pineScripts || []).length);
    const rec = A.IndicatorsUI.add(pane, def.type);
    if (!rec) { out.push({ type: def.type, error: 'add failed' }); continue; }
    const inst = (pane.pineScripts || [])[before];
    const st = inst ? await settle(inst.id) : null;
    const outPlots = st && st.rt && st.rt.out ? st.rt.out.plotsOrder.length : -1;
    const fills = st && st.rt && st.rt.out ? (st.rt.out.fills || []).length : -1;
    const row = pane.root.querySelector('.ind-row[data-iid="' + rec.id + '"]');
    out.push({
      type: def.type,
      status: st ? st.status : 'timeout',
      errors: st && st.errors ? st.errors.slice(0, 1) : [],
      plots: outPlots,
      fills,
      rows: row ? 1 : 0,
      pane: def.pane,
      sub: !!(st && st.adapter && st.adapter.sub),
    });
    A.IndicatorsUI.remove(pane, rec.id);
    await frames(3);
  }
  return { out, legacyLeft: (pane.indicators || []).length, pineLeft: (pane.pineScripts || []).length };
}"""

# The band fill, verified where it can be verified deterministically.
#
# ROUND298 tested the band by diffing chart pixels because the fill was a
# canvas primitive this module owned. ROUND299 deleted that primitive: the band
# is Pine's fill() painted by the SHARED Pine adapter. Pixel-diffing a live feed
# proved unreliable (candles repaint between snapshots and dominate the diff),
# so this asserts what actually determines whether a band is visible:
#   1. the script declares a fill between its own two plots;
#   2. the runtime colours it on every bar (not na / transparent);
#   3. the Style tab does not hide it.
BAND_JS = """async (kind) => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 80; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };

  await frames(8);
  const before = (pane.pineScripts || []).length;
  const rec = A.IndicatorsUI.add(pane, kind);
  if (!rec) return { error: 'add failed' };
  const inst = (pane.pineScripts || [])[before];
  const st = inst ? await settle(inst.id) : null;
  await frames(12);
  if (!st || !st.rt) { A.IndicatorsUI.remove(pane, rec.id); return { error: 'no runtime' }; }

  const o = st.rt.viewOut || st.rt.out;
  const fills = o.fills || [];
  const f = fills[0] || null;
  const cols = (f && f.colors) || [];
  const painted = cols.filter((c) => c && c.a > 0 && !(c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0)).length;
  const withCss = cols.filter((c) => c && c.css).length;
  const css = cols.find((c) => c && c.css) ? cols.find((c) => c && c.css).css() : null;
  const hidden = st.adapter && st.adapter._fillHidden ? st.adapter._fillHidden(0) : null;

  /* which plots does the fill join? they must be the upper/lower plots */
  const titles = new Map();
  for (const k of o.plotsOrder) { const p = o.plots.get(k); if (p) titles.set(k, p.title); }
  const joined = f ? [titles.get(f.p1), titles.get(f.p2)] : [];

  A.IndicatorsUI.remove(pane, rec.id);
  await frames(10);
  const after = (pane.pineScripts || []).length;
  return {
    fills: fills.length, painted, withCss, css, hidden, joined,
    bars: cols.length, pineBefore: before, pineAfter: after,
  };
}"""

# The dialog must not present built-ins as the user's own scripts.
DIALOG_JS = """() => {
  const A = window.__app;
  A.IndicatorsUI.openDialog();
  const list = document.querySelector('.ind-list');
  const secs = [...(list ? list.querySelectorAll('.st-sec') : [])].map((e) => (e.textContent || '').trim());
  const names = [...(list ? list.querySelectorAll('.ind-item-name') : [])].map((e) => (e.textContent || '').trim());
  const builtinNames = A.Indicators.all.map((d) => d.label);
  const rows = [];
  if (list) {
    let sec = '';
    for (const el of list.children) {
      if (el.classList.contains('st-sec')) sec = (el.textContent || '').trim();
      else if (el.classList.contains('ind-item')) {
        const nm = el.querySelector('.ind-item-name');
        rows.push({ sec, name: nm ? nm.textContent.trim() : '' });
      }
    }
  }
  const leaked = rows.filter((r) => r.sec === 'MY SCRIPTS' && builtinNames.indexOf(r.name) >= 0).map((r) => r.name);
  const dlg = document.querySelector('.ind-dialog');
  if (dlg) { const x = dlg.querySelector('.dlg-x'); if (x) x.click(); }
  return { sections: secs, hasMyScripts: secs.indexOf('MY SCRIPTS') >= 0, leaked, total: names.length, rows: rows.length };
}"""


# The settings dialog must drive the SCRIPT's inputs (the whole point of the
# conversion: one input system, not two).
SETTINGS_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 80; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };
  const out = {};
  const rec = A.IndicatorsUI.add(pane, 'bollinger');
  const inst = (pane.pineScripts || [])[pane.pineScripts.length - 1];
  await settle(inst.id);
  await frames(6);

  const row = pane.root.querySelector('.ind-row[data-iid="' + rec.id + '"]');
  out.row = !!row;
  const btns = row ? row.querySelectorAll('.ind-btns .ind-btn') : [];
  out.btnCount = btns.length;
  if (btns.length >= 2) btns[1].click();   // 0 = eye, 1 = gear, 2 = remove
  await frames(4);

  const dlg = document.querySelector('.ind-settings');
  out.dialogOpen = !!dlg;
  if (dlg) {
    out.tabs = [...dlg.querySelectorAll('.pine-tab')].map((t) => (t.textContent || '').trim());
    const inputs = [...dlg.querySelectorAll('.pine-inputs input, .pine-inputs select')];
    out.inputCount = inputs.length;
    const num = [...dlg.querySelectorAll('.pine-inputs input')].find((i) => i.value === '20');
    out.foundLength = !!num;
    if (num) {
      num.value = '50';
      num.dispatchEvent(new Event('input', { bubbles: true }));
      num.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const ok = dlg.querySelector('.ist-ok');
    if (ok) ok.click();
    await frames(10);
    await settle(inst.id);
    await frames(6);
    const cur = (pane.pineScripts || []).find((i) => i.id === inst.id);
    out.committedInputs = JSON.stringify(cur ? cur.inputs : {});
    out.legacyParams = JSON.stringify(rec.params || {});
    const row2 = pane.root.querySelector('.ind-row[data-iid="' + rec.id + '"]');
    out.rowTitle = row2 && row2.querySelector('.ind-title') ? row2.querySelector('.ind-title').textContent : null;
    out.dialogClosed = !document.querySelector('.ind-settings');
  }
  A.IndicatorsUI.remove(pane, rec.id);
  return out;
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        kill_proc(prov)
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1600, 'height': 950})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(1200)

            print('  -- 1. all 27 built-ins run on the Pine engine --')
            r = page.evaluate(ALL_JS)
            bad = []
            for row in r['out']:
                fine = (row.get('status') == 'ok' and (row.get('plots') or 0) >= 1 and row.get('rows') == 1)
                # a non-overlay indicator must own a sub-pane; an overlay one must not
                pane_ok = (row.get('sub') is True) if row.get('pane') == 'separate' else (row.get('sub') is False)
                if not fine or not pane_ok:
                    bad.append(row)
            check('27 indicators were exercised', len(r['out']) == 27, len(r['out']))
            check('every built-in runs on the engine and paints', not bad, bad[:4])
            check('an overlay indicator stays on the price pane',
                  all(not x.get('sub') for x in r['out'] if x.get('pane') == 'main'),
                  [x['type'] for x in r['out'] if x.get('pane') == 'main' and x.get('sub')][:4])
            check('a separate indicator gets its own pane',
                  all(x.get('sub') for x in r['out'] if x.get('pane') == 'separate'),
                  [x['type'] for x in r['out'] if x.get('pane') == 'separate' and not x.get('sub')][:4])
            check('no runtime is left behind', r['legacyLeft'] == 0 and r['pineLeft'] == 0,
                  'legacy=%s pine=%s' % (r['legacyLeft'], r['pineLeft']))
            fills = {x['type']: x.get('fills') for x in r['out'] if x.get('fills')}
            check('the three channels declare a fill band',
                  all((fills.get(t) or 0) >= 1 for t in ['bollinger', 'donchian', 'keltner']), fills)

            print('  -- 2. channel bands carry a real fill --')
            for kind in ['bollinger', 'donchian', 'keltner']:
                b = page.evaluate(BAND_JS, kind)
                page.wait_for_timeout(200)
                if b.get('error'):
                    check(kind + ': probe ran', False, b['error'])
                    continue
                check(kind + ': script declares exactly one band fill', b.get('fills') == 1, b.get('fills'))
                check(kind + ': the fill joins the upper and lower plots',
                      set(b.get('joined') or []) == {'Upper', 'Lower'}, b.get('joined'))
                check(kind + ': every bar is coloured (not na / transparent)',
                      (b.get('painted') or 0) > 1000 and b.get('painted') == b.get('bars'),
                      'painted=%s bars=%s' % (b.get('painted'), b.get('bars')))
                check(kind + ': the fill colour is a real rgba',
                      bool(b.get('css')) and 'rgba' in (b.get('css') or ''), b.get('css'))
                check(kind + ': the Style tab does not hide the fill', b.get('hidden') is False, b.get('hidden'))
                check(kind + ': removing it drops the runtime',
                      b.get('pineAfter') == b.get('pineBefore'),
                      '%s -> %s' % (b.get('pineBefore'), b.get('pineAfter')))

            print('  -- 3. built-ins are not listed as user scripts --')
            d = page.evaluate(DIALOG_JS)
            print('    ' + json.dumps(d)[:260])
            check('the dialog opened with the grouped built-in list', (d.get('total') or 0) >= 27, d.get('total'))
            check('no built-in leaks into MY SCRIPTS', not d.get('leaked'), d.get('leaked'))

            print('  -- 4. the settings dialog drives the script inputs --')
            s = page.evaluate(SETTINGS_JS)
            print('    ' + json.dumps(s)[:300])
            check('the legend gear opens a settings dialog', s.get('dialogOpen') is True, s.get('dialogOpen'))
            check('it has Inputs / Style / Visibility tabs',
                  s.get('tabs') == ['Inputs', 'Style', 'Visibility'], s.get('tabs'))
            check('every script input is rendered', (s.get('inputCount') or 0) >= 3, s.get('inputCount'))
            check('editing Length commits into the engine',
                  '"ig:10_1":50' in (s.get('committedInputs') or ''), s.get('committedInputs'))
            check('the legacy record mirrors the committed value',
                  (s.get('legacyParams') or '').find('"length":50') >= 0, s.get('legacyParams'))
            check('the legend title reflects the new value',
                  '(50, 2)' in (s.get('rowTitle') or ''), s.get('rowTitle'))

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND299: %d failed' % len(FAILS) if FAILS else 'ROUND299: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
