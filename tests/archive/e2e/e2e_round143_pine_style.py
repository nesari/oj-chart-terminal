#!/usr/bin/env python3
"""ROUND143 e2e — Pine Settings Style/Visibility tabs (TV parity).

Boots demo feed + renderer, adds Supertrend, then:
  [1] settings dialog has Inputs/Style/Visibility tabs; Style rows cover
      every plot+shape+fill; Visibility rows cover the TF ladder;
      Indicator Timeframe row present (Chart default).
  [2] real DOM path: Style tab -> first plot eye off -> Ok -> its pixels
      leave the canvas, zero page errors.
  [3] style funnel: uniform color override repaints (magenta pixels appear);
      precision:0 trims legend decimals; visTF off clears canvas+legend;
      restore brings everything back.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8953, 8881
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
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

SETUP_JS = """async () => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const res = await fetch('assets/pine-samples/sample-Supertrend.pine');
  const rec = A.PineScriptsStore.create('E2E143', await res.text());
  const inst = A.PineUI.add(pane, rec.id);
  return inst.id;
}"""

TABS_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  A.PineUI.openSettingsDialog(pane, inst);
  const tabs = [...document.querySelectorAll('.pine-tab')].map((t) => t.textContent);
  const styleRows = document.querySelectorAll('.pine-style-row').length;
  const visRows = document.querySelectorAll('.pine-vis .pine-inp').length;
  const tfRow = !!document.querySelector('.pine-tf-row');
  const defBtn = !!document.querySelector('.ist-defaults');
  const initHidden = getComputedStyle(document.querySelector('.pine-style')).display === 'none'
    && getComputedStyle(document.querySelector('.pine-vis')).display === 'none';
  return { tabs, styleRows, visRows, tfRow, defBtn, initHidden };
}"""

EYE_OFF_JS = """() => {
  document.querySelector('.pine-tab[data-tab="style"]').click();
  const eyes = document.querySelectorAll('.pine-style-row .pine-eye-btn');
  const before = document.querySelectorAll('.pine-style-row').length;
  if (eyes.length) eyes[0].click();
  document.querySelector('.ist-ok').click();
  return before;
}"""

COLORED_JS = """() => {
  const pane = window.__app.App.panes[0];
  const pc = pane._pineCanvases;
  if (!pc || !pc.fg || !pc.fg.width) return -1;
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, pc.fg.height).data;
  let n = 0;
  for (let i = 0; i < img.length; i += 16) {
    if (img[i+3] < 40) continue;
    if (Math.max(img[i], img[i+1], img[i+2]) - Math.min(img[i], img[i+1], img[i+2]) > 30) n++;
  }
  return n;
}"""

MAGENTA_SET_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  const st = A.PineUI.debug(pane)[0];
  const key = st && st.rt ? st.rt.out.plotsOrder[0] : null;
  if (!key) return null;
  inst.style = Object.assign({}, inst.style, { plots: Object.assign({}, (inst.style||{}).plots, { [key]: { color: '#FF00FF' } }) });
  return key;
}"""

MAGENTA_GO_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  A.Manager.recomputePine(pane);
  const pc = pane._pineCanvases;
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, pc.fg.height).data;
  let n = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (img[i+3] > 120 && img[i] > 150 && img[i+1] < 110 && img[i+2] > 150) n++;
  }
  return n;
}"""

VISTF_OFF_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  pane.pineScripts[0].visTF = { [pane.tf]: false };
}"""

VISTF_ON_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  pane.pineScripts[0].visTF = null;
}"""

FG_ALPHA_JS = """() => {
  const pane = window.__app.App.panes[0];
  const pc = pane._pineCanvases;
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, pc.fg.height).data;
  let n = 0;
  for (let i = 3; i < img.length; i += 16) if (img[i] > 10) n++;
  return n;
}"""

PREC_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  inst.style = Object.assign({}, inst.style, { precision: 0 });
  A.Manager.recomputePine(pane);
  const st = A.PineUI.debug(pane)[0];
  const leg = st && st.adapter && st.adapter.legEl ? st.adapter.legEl.textContent : null;
  inst.style = Object.assign({}, inst.style, { precision: 'default' });
  A.Manager.recomputePine(pane);
  return leg;
}"""

RESET_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  A.PineUI.openSettingsDialog(pane, inst);
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const findInp = (txt) => qa('.pine-inputs .pine-inp').find((r) => ((r.querySelector('span') || {}).textContent || '') === txt);
  // mutate three tabs: ATR -> 99, first vis box off, first style eye off
  const atrInp = findInp('ATR Period').querySelector('input');
  atrInp.value = '99';
  atrInp.dispatchEvent(new Event('change', { bubbles: true }));
  const visBox = q('.pine-vis input[type=checkbox]');
  visBox.checked = false;
  visBox.dispatchEvent(new Event('change', { bubbles: true }));
  q('.pine-style-row .pine-eye-btn').click();
  // Defaults -> Reset (first menu item)
  q('.ist-defaults').click();
  qa('.pine-def-item')[0].click();
  // read back with fresh queries (Reset re-rendered every body)
  const atrAfter = findInp('ATR Period').querySelector('input').value;
  const visAfter = q('.pine-vis input[type=checkbox]').checked;
  const eyeOff = q('.pine-style-row .pine-eye-btn').classList.contains('off');
  const tfAfter = q('.pine-tf-row select').value;
  q('.ist-ok').click();
  return { atrAfter, visAfter, eyeOff, tfAfter };
}"""

RESET_ASSERT_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  const st = A.PineUI.debug(pane)[0];
  const atrDef = (st.inputDefs || []).find((d) => d.title === 'ATR Period');
  return {
    atrInput: atrDef ? inst.inputs[atrDef.id] : 'NO-DEF',
    visTF: inst.visTF,
    stylePlots: inst.style ? inst.style.plots : 'NO-STYLE',
    tf: inst.timeframe,
  };
}"""

MTF_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  inst.style = {};
  inst.timeframe = 'H1';
  A.Manager.recomputePine(pane);
  return true;
}"""

MTF_PROBE_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane)[0];
  if (!st || !st.rt) return { err: 'no rt' };
  const rt = st.rt;
  const out = rt.viewOut || rt.out; // ROUND144b: rendered (chart-frame) output
  const key = out.plotsOrder[0];
  const p = out.plots.get(key);
  const n = pane.bars.length;
  let changes = 0, last = null, shapeHits = 0;
  for (let i = 0; i < n; i++) {
    const v = p.values[i];
    if (v != null && isFinite(v) && (last == null || Math.abs(v - last) > 1e-9)) { changes++; last = v; }
  }
  for (const [, sh] of out.shapes) {
    for (let i = 0; i < n; i++) if (sh.ys[i] != null) shapeHits++;
  }
  const pc = pane._pineCanvases;
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, pc.fg.height).data;
  let px = 0;
  for (let i = 0; i < img.length; i += 16) {
    if (img[i+3] < 40) continue;
    if (Math.max(img[i], img[i+1], img[i+2]) - Math.min(img[i], img[i+1], img[i+2]) > 30) px++;
  }
  return { tfSec: rt.env.tfSec, n, plotLen: p.values.length, changes, shapeHits, px };
}"""

LOC_UI_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = pane.pineScripts[0];
  A.PineUI.openSettingsDialog(pane, inst);
  document.querySelector('.pine-tab[data-tab="style"]').click();
  const rows = [...document.querySelectorAll('.pine-style-row')];
  // location selects exist only on plotshape/plotchar rows (not arrows)
  const locSels = rows.map((r) => r.querySelectorAll('select.pine-style-sel'))
    .map((ss) => [...ss]).flat().filter((s) => ['absolute','abovebar','belowbar','top','bottom'].includes(s.value));
  const out = { rows: rows.length, locSels: locSels.length };
  if (locSels.length) {
    locSels[0].value = 'top';
    locSels[0].dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.querySelector('.ist-ok').click();
  const st = A.PineUI.debug(pane)[0];
  let locSet = 0;
  if (st && st.rt) {
    for (const [key, sh] of st.rt.out.shapes) {
      const ov = inst.style && inst.style.shapes && inst.style.shapes[key];
      if (ov && ov.loc === 'top') locSet++;
    }
  }
  out.locSet = locSet;
  return out;
}"""

TOPSTRIP_JS = """() => {
  const pane = window.__app.App.panes[0];
  const pc = pane._pineCanvases;
  const h = Math.floor(pc.fg.height * 0.08);
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, h).data;
  let n = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i+3] > 40) n++;
  return n;
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            page.evaluate(SETUP_JS)
            page.wait_for_timeout(4000)
            c0 = page.evaluate(COLORED_JS)
            check('supertrend paints', c0 > 10000, c0)
            t = page.evaluate(TABS_JS)
            check('three tabs', t['tabs'] == ['Inputs', 'Style', 'Visibility'], t['tabs'])
            check('style rows cover plots+shapes+fills', t['styleRows'] >= 7, t['styleRows'])
            check('visibility rows cover TF ladder', t['visRows'] >= 15, t['visRows'])
            check('timeframe row present', t['tfRow'] is True, t['tfRow'])
            check('defaults pinned next to remove', t['defBtn'] is True, t['defBtn'])
            check('style/vis bodies hidden on open (CSP-safe)', t['initHidden'] is True, t['initHidden'])
            nrows = page.evaluate(EYE_OFF_JS)
            page.wait_for_timeout(2500)
            c1 = page.evaluate(COLORED_JS)
            check('dialog eye-off removes a plot', c1 < c0 * 0.9, f'{c0} -> {c1} (rows {nrows})')
            mg = page.evaluate(MAGENTA_SET_JS)
            # stale guard: recomputePine skips fresh states, so outlive the
            # 1500ms freshness window before forcing the styled re-run
            page.wait_for_timeout(1800)
            page.evaluate(MAGENTA_GO_JS)
            page.wait_for_timeout(4000)
            mg = page.evaluate(MAGENTA_GO_JS)
            page.wait_for_timeout(500)
            check('color override repaints', mg is not None and mg > 50, mg)
            page.evaluate(VISTF_OFF_JS)
            page.wait_for_timeout(900)
            vt_off = page.evaluate(FG_ALPHA_JS)
            page.evaluate(VISTF_ON_JS)
            page.wait_for_timeout(900)
            vt_on = page.evaluate(FG_ALPHA_JS)
            vt = {'off': vt_off, 'on': vt_on}
            check('tf-visibility off clears canvas', vt['off'] < 500, vt)
            check('tf-visibility restore repaints', vt['on'] > 10000, vt)
            leg = page.evaluate(PREC_JS)
            page.wait_for_timeout(1500)
            check('precision:0 trims legend decimals', leg is not None and '.' not in (leg or ''), repr(leg))
            top0 = page.evaluate(TOPSTRIP_JS)
            loc = page.evaluate(LOC_UI_JS)
            page.wait_for_timeout(4000)
            top1 = page.evaluate(TOPSTRIP_JS)
            check('location selects on shape rows', loc['locSels'] >= 2, loc)
            check('dialog location persists to inst.style', loc['locSet'] >= 1, loc)
            check('loc=top moves markers to the top strip', top1 > top0 + 100, {'top0': top0, 'top1': top1})
            page.evaluate(MTF_JS)
            page.wait_for_timeout(5000)
            mt = page.evaluate(MTF_PROBE_JS)
            check('mtf runs in HTF frame', mt.get('tfSec') == 3600, mt)
            check('mtf output remapped to chart length', mt.get('plotLen') == mt.get('n'), mt)
            check('mtf plot steps per bucket (not per bar)', mt.get('changes', 999999) < mt.get('n', 0) / 10, mt)
            check('mtf paints on canvas', mt.get('px', 0) > 5000, mt)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND143: %d failed' % len(FAILS) if FAILS else 'ROUND143: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
