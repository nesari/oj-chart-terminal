#!/usr/bin/env python3
"""ROUND91 e2e — the user's follow-up on the Custom Session time axis:
«هر ناحیه رو زمانِ خودش رو دقیقا زیر خودِ ناحیه قرار بده» — each day region
must carry ITS OWN start and end times directly under it.

User's exact example: Custom Session 04:30–07:30 (Tehran) over ~12 days on a
GMT+3 demo broker. Asserts, at DOM level, on pane[0]:
  1. every fully-visible region's FIRST axis label == the window start
     (04:30) and is LEFT-anchored (grows right, inside its own region)
  2. every fully-visible region's LAST axis label == that region's own last
     bar time (07:29 on M1 / 07:25 on M5) and is RIGHT-anchored (grows left,
     inside its own region) — the window end edge is never left unlabelled
  3. no date/day-number pills anywhere (a non-straddle window shows pure
     in-window times); no label's VISUAL extent spills into a gap column
  4. equal-length fully-visible regions carry IDENTICAL label sequences
  5. the same holds after switching the pane to M5 (multi-timeframe)
  6. the same holds on a SECOND pane in the 2-column layout (multi-chart)
  7. turning the session OFF restores the normal continuous axis
Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8909, 8777
FAILS = []

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra is not None and extra != '' and not cond else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=15):
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

APPLY_JS = """(o) => {
  const a = window.__app;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: a.App.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = fmt.format(new Date()).split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
  a.SessionRange.openDialog();
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  set('cs-hfrom', o.hFrom); set('cs-mfrom', o.mFrom); set('cs-hto', o.hTo); set('cs-mto', o.mTo);
  set('cs-dfrom', iso(p[0], p[1], p[2] - 12)); set('cs-dto', iso(p[0], p[1], p[2] - 1));
  document.getElementById('cs-apply').click();
  return true;
}"""

# per-region axis audit for ONE pane — the heart of ROUND91
REGION_AUDIT_JS = """(paneIdx) => {
  const a = window.__app;
  const pane = a.App.panes[paneIdx];
  if (!pane || !pane.engine) return null;
  const eng = pane.engine;
  const gt = pane._sessWithGapTimes || [];
  const rs = pane._sessRegions || [];
  if (!gt.length || !rs.length) return null;
  /* the axis labels read the chart-tz WALL clock — stamp + SessionRange.shift
     (the same funnel the engine's TZ.tickLabel path displays) */
  const sh = a.SessionRange.shift();
  const hhmm = (t) => {
    const w = t + (sh ? sh(t) : 0);
    const d = new Date(w * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };
  const meta = rs.map((r) => ({ a: r.a, b: r.b, x0: eng._xOf(gt[r.a]), x1: eng._xOf(gt[r.b]),
                                startTxt: hhmm(gt[r.a]), endTxt: hhmm(gt[r.b]) }));
  const lr = pane.chart.timeScale().getVisibleLogicalRange();
  const spans = Array.from(pane.tax.querySelectorAll('span'));   // THIS pane's axis only (2-pane layout)
  const per = meta.map(() => []);
  for (const s of spans) {
    const txt = (s.textContent || '').trim();
    const x = parseFloat(s.style.left) || 0;
    const tf = s.style.transform || '';
    const w = txt.length * 6.4 + 6;
    const visual = tf.startsWith('translate(0') ? [x, x + w]
                 : tf.startsWith('translate(-100') ? [x - w, x]
                 : [x - w / 2, x + w / 2];
    for (let i = 0; i < meta.length; i++) {
      if (x >= meta[i].x0 - 2 && x <= meta[i].x1 + 2) { per[i].push({ txt, x, tf, visual }); break; }
    }
  }
  /* fully visible regions only */
  const vis = meta.map((m, i) => ({ m, i, labels: per[i] }))
    .filter((o) => o.m.a >= lr.from && o.m.b <= lr.to);
  const anchored = (lab, side) => side === 'l'
    ? Math.abs(lab.visual[0] - lab.x) < 2   // text grows RIGHT off its tick
    : Math.abs(lab.visual[1] - lab.x) < 2;  // text grows LEFT off its tick
  const edgeOk = vis.filter((o) => o.labels.length >= 2).every((o) => {
    const L = o.labels.slice().sort((p, q) => p.x - q.x);   // DOM order != visual order (pass 1 before pass 2)
    const first = L[0], last = L[L.length - 1];
    return first.txt === o.m.startTxt && anchored(first, 'l')
        && last.txt === o.m.endTxt && anchored(last, 'r');
  });
  const spill = [];
  for (const o of vis) {
    for (const lab of o.labels) {
      if (lab.visual[0] < o.m.x0 - 1.5 || lab.visual[1] > o.m.x1 + 1.5) spill.push([o.i, lab.txt, lab.visual, o.m.x0, o.m.x1]);
    }
  }
  for (const o of vis) o.labels.sort((p, q) => p.x - q.x);   // keep x order for the sequence compare
  const nonTime = vis.flatMap((o) => o.labels.map((l) => l.txt)).filter((t) => !/^\\d{2}:\\d{2}$/.test(t));
  let identical = true, detail = null, compared = 0;
  for (let x = 0; x < vis.length; x++) {
    for (let y = x + 1; y < vis.length; y++) {
      const A = vis[x], B = vis[y];
      if ((A.m.b - A.m.a) !== (B.m.b - B.m.a)) continue;
      compared++;
      const sa = A.labels.map((l) => l.txt), sb = B.labels.map((l) => l.txt);
      if (JSON.stringify(sa) !== JSON.stringify(sb)) { identical = false; detail = [sa, sb]; }
    }
  }
  return {
    nRegions: rs.length,
    visCount: vis.length,
    labelsPerRegion: vis.map((o) => o.labels.map((l) => l.txt)),
    edgeOk, spill, nonTime, identical, compared, detail,
  };
}"""

def wait_regions(pg, need, timeout=75):
    deadline = time.time() + timeout
    n = 0
    while time.time() < deadline:
        n = pg.evaluate("() => ((window.__app.App.panes[0]._sessRegions) || []).length")
        if n >= need:
            return n
        time.sleep(1.2)
    return n

def pin_view(pg, pane_idx, from_slot, to_slot, tries=8):
    for _ in range(tries):
        pg.evaluate(f"() => {{ const p = window.__app.App.panes[{pane_idx}]; p.chart.timeScale().setVisibleLogicalRange({{ from: {from_slot}, to: {to_slot} }}); }}")
        pg.wait_for_timeout(750)
        lr = pg.evaluate(f"() => {{ const l = window.__app.App.panes[{pane_idx}].chart.timeScale().getVisibleLogicalRange(); return l ? [l.from, l.to] : null; }}")
        if lr and abs(lr[0] - from_slot) <= 10 and abs(lr[1] - to_slot) <= 10:
            return True
    return False

def pin_two_regions(pg, pane_idx):
    view = pg.evaluate(f"""() => {{
      const pane = window.__app.App.panes[{pane_idx}];
      const rs = pane._sessRegions || [];
      return rs.length >= 6 ? {{ from: rs[3].a, to: rs[4].b + 4 }} : null;
    }}""")
    return bool(view) and pin_view(pg, pane_idx, view['from'], view['to'])

def audit_and_check(pg, tag, pane_idx=0, min_regions=1):
    aud = pg.evaluate(REGION_AUDIT_JS, pane_idx)
    check(f'[{tag}] audit returned', bool(aud) and aud['visCount'] >= min_regions, aud and aud['visCount'])
    if not aud:
        return
    check(f'[{tag}] every region STARTS with its own 04:30 (left-anchored)', aud['edgeOk'],
          aud['labelsPerRegion'][:3])
    check(f'[{tag}] no label spills outside its own region (visual extent)', not aud['spill'], aud['spill'][:4])
    check(f'[{tag}] pure in-window hh:mm labels (no date pills)', not aud['nonTime'], aud['nonTime'][:6])
    check(f'[{tag}] equal-length regions carry IDENTICAL sequences', aud['identical'] and aud['compared'] >= 1,
          aud['detail'] or aud['compared'])
    return aud

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py'), '--off', '10800'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900})
            errors = []
            pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[1] boot (GMT+3 demo), chart tz = Asia/Tehran')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(400)

            print('[2] the USER\'S exact example: 04:30–07:30 × 12 days')
            pg.evaluate(APPLY_JS, {'hFrom': '4', 'mFrom': '30', 'hTo': '7', 'mTo': '30'})
            pg.wait_for_timeout(800)
            check('session mode active', pg.evaluate("() => window.__app.SessionRange.isActive()"))
            n = wait_regions(pg, 8)
            check('session regions built (>=8 days)', n >= 8, n)

            print('[3] M1 — each region carries its own 04:30 … 07:29 under ITSELF')
            check('view pinned over two full regions (M1)', pin_two_regions(pg, 0))
            pg.wait_for_timeout(600)
            audit_and_check(pg, 'M1')

            print('[4] M5 (multi-timeframe) — same rule')
            pg.evaluate("() => { const a = window.__app; a.Manager.setTf(a.App.panes[0], 'M5'); }")
            deadline = time.time() + 40
            ok5 = False
            while time.time() < deadline:
                st = pg.evaluate("() => { const p = window.__app.App.panes[0]; return { tf: p.tf, gaps: !!(p._sessGapIdx && p._sessGapIdx.length), n: (p._sessRegions || []).length, len: p.barTimes.length }; }")
                if st['tf'] == 'M5' and st['gaps'] and st['n'] >= 8 and st['len'] >= 200:
                    ok5 = True
                    break
                time.sleep(1.2)
            check('M5 session series rebuilt', ok5)
            check('view pinned over two full regions (M5)', pin_two_regions(pg, 0))
            pg.wait_for_timeout(600)
            aud5 = audit_and_check(pg, 'M5')
            if aud5:
                ends = {seq[-1] for seq in aud5['labelsPerRegion'] if seq}
                check('M5 region end label == 07:25 (the 5m bar before 07:30)', ends == {'07:25'}, ends)

            print('[5] multi-chart (2 columns) — the SECOND pane obeys the same rule')
            pg.evaluate("() => window.__app.Manager.setLayout('2v', true)")
            deadline = time.time() + 50
            ok2 = False
            while time.time() < deadline:
                st = pg.evaluate("() => { const a = window.__app; const p = a.App.panes[1]; return { n2: a.App.panes.length, gaps: !!(p && p._sessGapIdx && p._sessGapIdx.length), r: p ? (p._sessRegions || []).length : 0 }; }")
                if st['n2'] >= 2 and st['gaps'] and st['r'] >= 8:
                    ok2 = True
                    break
                time.sleep(1.2)
            check('second pane stitched into the session', ok2)
            check('second pane view pinned over two full regions', pin_two_regions(pg, 1))
            pg.wait_for_timeout(600)
            audit_and_check(pg, 'pane2', pane_idx=1)

            print('[6] turn OFF — the normal continuous axis returns')
            pg.evaluate("() => window.__app.SessionRange.clear()")
            pg.wait_for_timeout(2500)
            off = pg.evaluate("""() => {
              const a = window.__app;
              const pane = a.App.panes[0];
              return { active: a.SessionRange.isActive(),
                       frameBack: pane.engine._timeArr() === pane.barTimes,
                       gaps: pane._sessGapIdx === null,
                       n: pane.barTimes.length };
            }""")
            check('session off + frame helpers back on barTimes', off['active'] is False and off['frameBack'] and off['gaps'] and off['n'] > 100, off)

            check('zero page errors', not errors, errors[:4])
            pg.screenshot(path='/home/z/my-project/scripts/shot91_final.png')
            b.close()
    finally:
        prov.terminate()

    print()
    if FAILS:
        print('FAILED CHECKS:')
        for f in FAILS:
            print('  - ' + f)
        sys.exit(1)
    print('ALL ROUND91 E2E CHECKS PASSED')

if __name__ == '__main__':
    main()
