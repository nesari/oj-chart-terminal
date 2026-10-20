#!/usr/bin/env python3
"""ROUND90 e2e — the Custom Session TIME AXIS is CUT into the user's selected
ranges ("نوار زمان توی این حالت باید با توجه به اون محدوده های زمانی انتخاب
شده توسط کاربر بریده بریده باشه و فقط اون زمان هایی که انتخاب شده رو نمایش
بده").

Boots the demo provider with --off 10800 (a GMT+3 broker), applies Custom
Session 03:30–06:30 through the REAL merged Go-to-Date dialog with the chart
tz = Asia/Tehran, and asserts — at DOM level:
  1. every hh:mm label TEXT sits inside the selected window
  2. every label's PIXEL POSITION maps back (through the engine's gap-frame
     funnel) to a time INSIDE the window — no label may sit over a gap column
  3. the margins are BLANK: no label right of the last bar (the engine's
     future extrapolation used to print unselected times there)
  4. equal-length day regions carry IDENTICAL axis sequences (the axis reads
     the same under every region — per-region anchored cadence)
  5. vertical grid lines only inside the day regions
  6. a minute-precise window (03:30–06:15) re-cuts the axis the same way
  7. turning the session OFF restores the normal continuous axis and the
     engine's frame helpers fall back to the compact barTimes
Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8907, 8777
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

REGION_JS = """() => {
  const a = window.__app;
  const pane = a.App.panes[0];
  if (!pane || !pane.barTimes || pane.barTimes.length < 10) return null;
  const shift = a.SessionRange.shift();
  const out = [];
  let cur = null;
  for (const t of pane.barTimes) {
    const w = t + (shift ? shift(t) : 0);
    const d = Math.floor(w / 86400) * 86400;
    if (!cur || cur.d !== d) { cur = { d, first: t, last: t }; out.push(cur); }
    else cur.last = t;
  }
  return out;
}"""

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

AXIS_JS = """() => {
  const a = window.__app;
  const pane = a.App.panes[0];
  const eng = pane.engine;
  const spans = Array.from(document.querySelectorAll('.tax-ext span'));
  const shift = a.SessionRange.shift();
  const w = a.SessionRange.windowSec();
  const inWin = (t) => {
    if (!shift) return true;
    const wall = t + shift(t);
    const off = wall - Math.floor(wall / 86400) * 86400;
    return off >= w.sFrom && off < w.sTo;
  };
  const items = spans.map((s) => {
    const x = parseFloat(s.style.left) || 0;
    let t = null, win = null;
    try { t = eng._tOf(x + 0.5); win = inWin(t); } catch (e) {}
    return { txt: (s.textContent || '').trim(), x, t, win };
  });
  const gapTimes = pane._sessWithGapTimes || [];
  const lastT = gapTimes.length ? gapTimes[gapTimes.length - 1]
              : (pane.barTimes.length ? pane.barTimes[pane.barTimes.length - 1] : 0);
  const xLast = eng._xOf(lastT);
  const timeLbls = items.filter((it) => /^\\d{2}:\\d{2}$/.test(it.txt));
  return {
    count: items.length,
    texts: timeLbls.map((it) => it.txt),
    allPosInWin: timeLbls.length > 0 && timeLbls.every((it) => it.win === true),
    badPos: timeLbls.filter((it) => it.win !== true).map((it) => [it.txt, Math.round(it.x), it.t]),
    margin: items.filter((it) => it.x > xLast + 1).map((it) => it.txt),
    xLast: Math.round(xLast),
    regions: pane._sessRegions ? pane._sessRegions.length : 0,
    gapSlots: pane._sessGapIdx ? Array.from(pane._sessGapIdx).reduce((s, v) => s + v, 0) : -1,
  };
}"""

SEQ_JS = """() => {
  const a = window.__app;
  const pane = a.App.panes[0];
  const eng = pane.engine;
  const shift = a.SessionRange.shift();
  const gapTimes = pane._sessWithGapTimes || [];
  const regions = pane._sessRegions || [];
  if (!regions.length || !gapTimes.length) return null;
  /* wall-day + x interval per region */
  const meta = regions.map((r, i) => ({ i, a: r.a, b: r.b, first: gapTimes[r.a], last: gapTimes[r.b] }));
  for (const m of meta) { m.x0 = eng._xOf(m.first); m.x1 = eng._xOf(m.last); }
  const lr = pane.chart.timeScale().getVisibleLogicalRange();
  const spans = Array.from(document.querySelectorAll('.tax-ext span'));
  const seqs = meta.map(() => []);
  for (const s of spans) {
    const txt = (s.textContent || '').trim();
    if (!/^\\d{2}:\\d{2}$/.test(txt)) continue;          // day pills excluded
    const x = parseFloat(s.style.left) || 0;
    for (let i = 0; i < meta.length; i++) {
      if (x >= meta[i].x0 - 2 && x <= meta[i].x1 + 2) { seqs[i].push(txt); break; }
    }
  }
  /* fully visible regions only */
  const vis = meta.filter((m) => m.a >= lr.from && m.b <= lr.to);
  /* normalise: the chart's FIRST region renders its first tick as a TIME (no
     previous tick) and its LAST region carries the live pill — drop those */
  const norm = (seq, i) => {
    let s = seq.slice();
    if (i === 0) s = s.slice(1);
    if (i === meta.length - 1) s = s.slice(0, -1);
    return s;
  };
  let identical = true, detail = null, compared = 0;
  for (let x = 0; x < vis.length; x++) {
    for (let y = x + 1; y < vis.length; y++) {
      const A = vis[x], B = vis[y];
      if ((A.last - A.first) !== (B.last - B.first)) continue;   // different bar counts (weekend hole)
      compared++;
      const sa = norm(seqs[A.i], A.i), sb = norm(seqs[B.i], B.i);
      if (JSON.stringify(sa) !== JSON.stringify(sb)) { identical = false; detail = [sa, sb]; }
    }
  }
  return { nRegions: meta.length, visIdx: vis.map((m) => m.i),
           seqs: seqs.map((s) => s.length), identical, compared, detail,
           sample: seqs[vis.length ? vis[0].i : 0] };
}"""

GRID_JS = """() => {
  const a = window.__app;
  const pane = a.App.panes[0];
  const eng = pane.engine;
  const gx = eng._taxGrid || [];
  const shift = a.SessionRange.shift();
  const regions = [];
  let cur = null;
  for (const t of pane.barTimes) {
    const w = t + (shift ? shift(t) : 0);
    const d = Math.floor(w / 86400) * 86400;
    if (!cur || cur.d !== d) { cur = { d, first: t, last: t }; regions.push(cur); }
    else cur.last = t;
  }
  const ivs = regions.map((r) => [eng._xOf(r.first) - 1, eng._xOf(r.last) + 1]);
  const outside = gx.filter((x) => !ivs.some(([a0, b0]) => x >= a0 && x <= b0));
  return { n: gx.length, outside, ivs: ivs.slice(0, 3) };
}"""

def wait_regions(pg, need, timeout=75):
    deadline = time.time() + timeout
    n = 0
    while time.time() < deadline:
        n = pg.evaluate(f"() => (({REGION_JS})() || []).length")
        if n >= need:
            return n
        time.sleep(1.2)
    return n

def pin_view(pg, from_slot, to_slot, tries=8):
    """Set the visible logical range and make it STICK — the session's own
    loadPane re-range can land after a one-shot set, so poll-and-reapply."""
    for _ in range(tries):
        pg.evaluate(f"() => {{ const p = window.__app.App.panes[0]; p.chart.timeScale().setVisibleLogicalRange({{ from: {from_slot}, to: {to_slot} }}); }}")
        pg.wait_for_timeout(750)
        lr = pg.evaluate("() => { const l = window.__app.App.panes[0].chart.timeScale().getVisibleLogicalRange(); return l ? [l.from, l.to] : null; }")
        if lr and abs(lr[0] - from_slot) <= 10 and abs(lr[1] - to_slot) <= 10:
            return True
    return False

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

            print('[1] boot (demo broker = GMT+3), chart tz = Asia/Tehran')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(400)
            feed_off = pg.evaluate("() => (window.__app.App.feed && window.__app.App.feed.serverOff) || 0")
            check('feed measured the GMT+3 broker offset', feed_off == 10800, feed_off)

            print('[2] Custom Session 03:30–06:30 through the REAL dialog')
            pg.evaluate(APPLY_JS, {'hFrom': '3', 'mFrom': '30', 'hTo': '6', 'mTo': '30'})
            pg.wait_for_timeout(800)
            on = pg.evaluate("() => window.__app.SessionRange.isActive()")
            check('session mode active', on)
            n = wait_regions(pg, 8)
            check('session regions built (>=8 days)', n >= 8, n)

            print('[3] deterministic view (2 full regions) + the CUT axis (text level)')
            view = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const rs = pane._sessRegions || [];
              return rs.length >= 6 ? { from: rs[3].a, to: rs[4].b + 4 } : null;
            }""")
            check('region slots available for the view', bool(view), view)
            check('view pinned over two full day regions', pin_view(pg, view['from'], view['to']))
            pg.wait_for_timeout(600)
            ax = pg.evaluate(AXIS_JS)
            check('axis labels exist', ax['count'] >= 6, ax['count'])
            check('every hh:mm label TEXT inside 03:30–06:30 (Tehran)', all(
                210 <= int(t[:2]) * 60 + int(t[3:]) < 390 for t in ax['texts']), ax['texts'][:10])
            check('axis shows the window start 03:3x', any(t.startswith('03:') for t in ax['texts']), ax['texts'][:10])
            check('engine segmented the axis into day regions', ax['regions'] >= 8, ax['regions'])
            check('gap flags present on the pane', ax['gapSlots'] > 0, ax['gapSlots'])

            print('[4] POSITION level: no label over a gap column, margins blank')
            check('every label position maps INSIDE the selected window (gap frame funnel)',
                  ax['allPosInWin'], ax['badPos'][:6])
            check('no label right of the last bar (future margin blank)', not ax['margin'], ax['margin'])

            print('[5] identical axis sequence under fully-visible equal-length regions')
            seq = pg.evaluate(SEQ_JS)
            check('two full regions visible for the comparison', seq and len(seq['visIdx']) >= 2, seq and seq['visIdx'])
            check('both carry a real tick run (>= 8 labels each)', bool(seq) and all(
                seq['seqs'][i] >= 8 for i in seq['visIdx']), seq and seq['seqs'])
            check('equal-length regions carry IDENTICAL hh:mm sequences',
                  bool(seq) and seq['identical'] and seq['compared'] >= 1, (seq or {}).get('detail') or (seq or {}).get('compared'))

            print('[6] vertical grid only inside the regions')
            grid = pg.evaluate(GRID_JS)
            check('grid lines exist', grid['n'] >= 4, grid['n'])
            check('no grid line inside a gap column / margin', not grid['outside'], grid['outside'][:6])

            print('[7] minute-precise window 03:30–06:15 re-cuts the axis')
            pg.evaluate(APPLY_JS, {'hFrom': '3', 'mFrom': '30', 'hTo': '6', 'mTo': '15'})
            pg.wait_for_timeout(900)
            n2 = wait_regions(pg, 8)
            check('regions rebuilt for the minute window', n2 >= 8, n2)
            view2 = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const rs = pane._sessRegions || [];
              return rs.length >= 6 ? { from: rs[3].a, to: rs[4].b + 4 } : null;
            }""")
            check('minute view pinned', bool(view2) and pin_view(pg, view2['from'], view2['to']))
            pg.wait_for_timeout(600)
            ax2 = pg.evaluate(AXIS_JS)
            check('labels inside 03:30–06:15 (text)', all(
                210 <= int(t[:2]) * 60 + int(t[3:]) < 375 for t in ax2['texts']), ax2['texts'][:10])
            check('labels inside 03:30–06:15 (position)', ax2['allPosInWin'], ax2['badPos'][:6])
            check('minute window: margins still blank', not ax2['margin'], ax2['margin'])

            print('[8] turn OFF — the normal continuous axis returns')
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
            check('normal axis view pinned', pin_view(pg, off['n'] - 120, off['n'] + 10))
            pg.wait_for_timeout(600)
            ax3 = pg.evaluate(AXIS_JS)
            check('normal axis labels present again', ax3['count'] >= 5, ax3['count'])

            check('zero page errors', not errors, errors[:4])
            b.close()
    finally:
        prov.terminate()

    print()
    if FAILS:
        print('FAILED CHECKS:')
        for f in FAILS:
            print('  - ' + f)
        sys.exit(1)
    print('ALL ROUND90 E2E CHECKS PASSED')

if __name__ == '__main__':
    main()
