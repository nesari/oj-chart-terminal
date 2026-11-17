#!/usr/bin/env python3
"""R302 — the 14 sub-pane indicators never painted because a PAINT CYCLE is
all-or-nothing on the shared pine canvas.

THE BUG (user report: "a bunch of indicators just don't draw — RSI, MACD,
Stochastic ... show nothing; the pane is there but empty"):
  `pane._pineCanvases.fg/bg` are shared by EVERY script instance on the pane,
  and the FIRST painter of a paint generation clears the whole canvas
  (ROUND141 generational clear). Each adapter then decided ON ITS OWN whether
  it had to repaint (`key === _lastPaintKey -> skip`). So any cycle in which
  only one script's key changed ended with that one script clearing the canvas
  and drawing itself, while every sibling stayed skipped — their pixels were
  erased and nothing dirtied them again until their own key moved (a new bar,
  or a pan). With one indicator on the chart it is invisible; with two or more
  the result is blank panes that come back and vanish as the chart ticks. That
  is exactly the "sometimes draws, sometimes does not" measurement in
  docs/INDICATOR-BUGS-R302.md.

THE FIX: the decision belongs to the SET, not to the adapter. framePane()
asks every adapter whether it needs paint; if ANY does, the whole set is
forced (which is what the forced path already did). Idle frames still cost
nothing.

tested here: add four separate-pane indicators, then assert every one of them
has pixels inside ITS OWN band — at rest, after a zoom, after a scroll, and
after scrolling back to real time.

Run with the other e2e suites:
  python tests/archive/e2e/e2e_round302_subpane_paint.py
"""
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP = 9061
PORT_WS = int(os.environ.get('MT5_WS_PORT', '8777'))
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)


def wait_port(port, timeout=30):
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


# Add the indicators, then report per-pane geometry + row placement at four
# chart states. The pixel measurement itself happens in Python against a real
# screenshot (see INK_JS) — a canvas-alpha count cannot see native `columns`
# series, and would not catch a compositing/z-order problem either.
PAINT_JS = """async (kinds) => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 240; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };
  await frames(10);
  const recs = kinds.map((k) => A.IndicatorsUI.add(pane, k));
  for (const inst of (pane.pineScripts || [])) await settle(inst.id);
  await frames(40);

  const band = () => {
    const out = [];
    let i = 0;
    for (const [id, sub] of (pane._subs || new Map())) {
      const r = sub.host.getBoundingClientRect();
      const row = [...pane.root.querySelectorAll('.ind-row')].find((el) => el.closest('.sub-pane') === sub.host);
      out.push({ pid: String(id), kind: kinds[i], h: Math.round(r.height),
                 rowInPane: !!row,
                 rowButtons: row ? row.querySelectorAll('.ind-btns .ind-btn').length : 0 });
      i++;
    }
    return out;
  };
  const states = { rest: band() };
  try { pane.chart.timeScale().setVisibleLogicalRange({ from: 100, to: 400 }); } catch (e) {}
  await frames(25);
  states.zoomed = band();
  try { pane.chart.timeScale().scrollToPosition(600, false); } catch (e) {}
  await frames(25);
  states.scrolled = band();
  try { pane.chart.timeScale().scrollToRealTime(); } catch (e) {}
  await frames(30);
  states.live = band();
  const ids = (pane.pineScripts || []).map((i) => i.id);
  return { states, ids, recIds: recs.map((r) => r && r.id) };
}"""

CLEAN_JS = """() => {
  const A = window.__app; const p = A.App.activePane;
  for (const r of [...(p.indicators || [])]) A.IndicatorsUI.remove(p, r.id);
}"""

# Reproduce the ROUND302 paint race DETERMINISTICALLY.
#
# The shared pine canvas is cleared by the first painter of a cycle, so a cycle
# in which only ONE script's key changed used to end with that one script
# cleared+drawn and every sibling SKIPPED (its pixels erased, never redrawn
# until its own key moved). That is why the bug read as "draws sometimes,
# blank other times" and was invisible with a single indicator.
#
# This makes exactly that condition: invalidate ONE adapter's cached paint key,
# run ONE frame, and check the canvas still carries every pane's pixels.
RACE_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  await frames(20);
  const dbg = A.PineUI.debug(pane).filter((s) => s.adapter && s.rt);
  if (dbg.length < 2) return { error: 'need at least 2 scripts' };
  const victims = dbg.slice(1);
  for (const st of victims) st.adapter._lastPaintKey = 'stale|' + Math.random();
  /* one cycle only — the manager's own frame path */
  A.PineUI.framePane(pane);
  await frames(2);
  const pr = pane.root.getBoundingClientRect();
  const fg = pane.root.querySelector('.pine-fg-canvas');
  const dpr = window.devicePixelRatio || 1;
  const out = [];
  let i = 0;
  for (const [id, sub] of (pane._subs || new Map())) {
    const r = sub.host.getBoundingClientRect();
    let n = -1;
    try {
      const y0 = Math.max(0, Math.round((r.top - pr.top) * dpr));
      const hh = Math.max(1, Math.round(r.height * dpr));
      const d = fg.getContext('2d').getImageData(0, y0, fg.width, hh).data;
      n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k] > 8) n++;
    } catch (e) { n = -2; }
    out.push({ idx: i, px: n });
    i++;
  }
  return { panes: out, scripts: dbg.length, invalidated: victims.length };
}"""

GEOM_JS = """() => {
  const A = window.__app; const p = A.App.activePane;
  const pr = p.root.getBoundingClientRect();
  const subs = [];
  for (const [id, sub] of (p._subs || new Map())) {
    const r = sub.host.getBoundingClientRect();
    const row = [...p.root.querySelectorAll('.ind-row')].find((el) => el.closest('.sub-pane') === sub.host);
    subs.push({ id: String(id), x: Math.round(r.left - pr.left), y: Math.round(r.top - pr.top),
                w: Math.round(r.width), h: Math.round(r.height),
                rowInPane: !!row, rowButtons: row ? row.querySelectorAll('.ind-btns .ind-btn').length : 0,
                bottom: Math.round(r.bottom - pr.top) });
  }
  return { subs, paneH: Math.round(pr.height), origin: { x: Math.round(pr.left), y: Math.round(pr.top) } };
}"""

# Count pixels on a real screenshot that are NOT the panel background - i.e.
# what a person actually sees in that band. Native LWC series, the hand-painted
# canvas and any compositing problem all land in this number, which a
# canvas-only probe cannot see.
# `sat` counts COLOURED pixels only (max-min channel >= 40). The chart grid and
# the legend text are neutral grays (max-min ~15), while every oscillator line
# is saturated (RSI purple 171,71,188; MACD blue/orange; ATR pink; volume
# green/red). That separates "the indicator drew something" from "the pane is
# there and the grid is showing through".
INK_JS = """async function (arg) {
  const { b64 } = arg;
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const hist = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let bg = null, bgN = -1;
  for (const [k, n] of hist) if (n > bgN) { bgN = n; bg = k; }
  const [br, bgc, bb] = bg.split(',').map(Number);
  let ink = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dr = Math.abs((d[i] >> 3) - br), dg = Math.abs((d[i + 1] >> 3) - bgc), db = Math.abs((d[i + 2] >> 3) - bb);
    if (dr + dg + db > 3) ink++;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx - mn >= 40) sat++;
  }
  return { ink, sat, total: cv.width * cv.height, bg: bg };
}"""


def main():
    kinds = ['rsi', 'macd', 'stochastic', 'atr', 'volume', 'obv']
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_port(PORT_WS):
        print('provider did not start'); kill_proc(prov); return 1
    threading.Thread(target=serve_http, daemon=True).start()
    if not wait_port(PORT_HTTP):
        print('http server did not start'); kill_proc(prov); return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=True)
            except Exception:
                browser = pw.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1500, 'height': 900})
            page.add_init_script("localStorage.clear()")
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_selector('#login-screen', timeout=15000)
            page.click('#card-demo')
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=25000)
            for _ in range(250):
                if page.evaluate("window.__app && window.__app.App.panes[0] && window.__app.App.panes[0].bars.length > 100"):
                    break
                time.sleep(0.2)
            page.wait_for_timeout(2500)

            r = page.evaluate(PAINT_JS, kinds)
            print('  -- six separate-pane indicators, four chart states --')
            import base64 as _b64
            for label, arr in r['states'].items():
                # Screenshot each pane and count what a PERSON sees there. A
                # canvas-alpha probe cannot tell a native `columns` series (which
                # paints off-canvas) from a blank pane, and it also cannot see a
                # compositing/z-order problem — which is what the earlier
                # diagnosis suspected. This is the honest measurement.
                geo = page.evaluate(GEOM_JS)
                by_id = {g['id']: g for g in geo['subs']}
                measured = []
                for x in arr:
                    g = by_id.get(x['pid'])
                    ink = 0
                    sat = 0
                    if g and g['w'] > 4 and g['h'] > 4:
                        crop = page.screenshot(clip={'x': geo['origin']['x'] + g['x'],
                                                     'y': geo['origin']['y'] + g['y'],
                                                     'width': g['w'], 'height': g['h']})
                        m = page.evaluate(INK_JS, {'b64': _b64.b64encode(crop).decode('ascii')})
                        ink = m['ink']; sat = m['sat']
                    measured.append((x, g, ink, sat))
                print('    %-9s %s' % (label, [(x['kind'], s) for x, g, i, s in measured]))
                check(f'{label}: every indicator pane built', len(arr) == len(kinds), len(arr))
                for x, g, ink, sat in measured:
                    # `scrolled` parks the viewport in the forward margin where
                    # only a handful of bars exist, so the honest assertion
                    # there is "the indicator is drawn", not a pixel budget.
                    need = 3 if label == 'scrolled' else 40
                    check(f'{label}: {x["kind"]} is VISIBLE in its own pane',
                          sat >= need, {'colouredPx': sat, 'pane': g})
                    check(f'{label}: {x["kind"]} legend row is in its own pane',
                          x['rowInPane'] and x['rowButtons'] == 3, x)

            # the price legend must not carry the separate indicators' rows
            priceRows = page.evaluate("""() => {
              const A = window.__app; const p = A.App.activePane;
              return [...p.root.querySelectorAll('.ind-row')]
                .filter((r) => !r.closest('.sub-pane'))
                .map((r) => (r.textContent || '').trim().slice(0, 24));
            }""")
            check('no separate indicator row leaked into the price legend',
                  len(priceRows) == 0, priceRows)

            # the paint cycle must be all-or-nothing (the blank-pane race)
            race = page.evaluate(RACE_JS)
            print('  -- one stale adapter key, one paint cycle --')
            print('     panes:', race.get('panes'), 'scripts:', race.get('scripts'))
            check('the race repro needs several scripts', not race.get('error'), race.get('error'))
            for p_ in race.get('panes') or []:
                check('a single stale adapter cannot blank its siblings',
                      p_['px'] > 200, p_)

            errs = page.evaluate("""() => {
              const L = window.__app.Log;
              const all = (L && L.entries) ? L.entries() : [];
              return all.filter((e) => e && e.level === 'error').map((e) => String(e.message || '').slice(0, 90));
            }""")
            check('no error logged while adding the set', len(errs) == 0, errs[:3])

            page.evaluate(CLEAN_JS)
            page.wait_for_timeout(600)
            left = page.evaluate("() => (window.__app.App.activePane.pineScripts || []).length")
            check('removing them leaves no orphan runtime', left == 0, left)
            browser.close()
    finally:
        kill_proc(prov)

    print()
    if FAILS:
        print(f'ROUND302: {len(FAILS)} FAILED')
        for f in FAILS:
            print('  - ' + f)
        return 1
    print('ROUND302: all green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
