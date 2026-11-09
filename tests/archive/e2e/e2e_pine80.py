#!/usr/bin/env python3
"""Round 80 e2e — six user reports in one pass (demo broker GMT+3, --off 10800).

[A] BUG (clip): Pine boxes/lines/labels must NEVER paint over the price
    scale (or the time scale) — TV parity with the app's own rectangles.
    A synthetic green box whose right edge extends 120 bars into the FUTURE
    is injected into the live runtime; green pixels are counted on the pine
    fg canvas in the axis region (x >= plotW) at rest AND mid-pan — must be
    zero, with a control column inside the plot proving the box is painted.
[B] FEAT (perf/correctness on TF switch): a TF switch must REBUILD the Pine
    runtime (fresh env.tfSec + clean var state) — asserted via rt.env.tfSec
    per timeframe — and record lastRunMs per TF (perf evidence).
[C] FEAT (countdown on ALL TFs + broker close parity): the countdown must be
    visible on every timeframe (D1/W1/MN included — the old build hid them)
    and its seconds must match (bucketEndFor(last bar) - server-now) within
    tolerance; bucket math must bracket every loaded bar (close times agree
    with the broker's own bar boundaries).
[D] FEAT (TV-merged price label + countdown): .pv-stack rows must be flush
    (cd.top == pv.bottom) and one column (equal widths); the Symbol-mode
    matrix (hidden/name/value/line/line_value/name_value/name_value_line)
    must show exactly (value-row, name-chip) visibility per mode.
[E] Themes: the stack renders correctly in dark AND light (visibility +
    geometry re-asserted after Theme.apply('light')).
[F] FEAT (magnet): four strengths (off/weak/medium/strong) with pixel radii
    0/7/17/inf verified through engine.snap() below a bar's LOW, plus the
    LIVE crosshair magnet (hover pill pane._paxPrice locks onto the OHLC).
Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FIXTURE = os.path.join(ROOT, 'fixtures', 'pine', 'corpus', '786-zones.pine')
PORT_HTTP, PORT_WS = 8899, 8777
SHOTS = os.path.join(ROOT, 'docs', 'shots-legacy')
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra and not cond else ''))
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

INJECT_JS = r"""() => {
  /* synthetic OPAQUE-GREEN test box whose RIGHT edge runs 120 bars into the
     future — without the plot clip it paints straight across the price
     scale. Ticks are muted, so the realtime rollback cannot wipe it. */
  const pane = window.__pane;
  const dbg = window.__app.PineUI.debug(pane)[0];
  const rt = dbg && dbg.rt;
  if (!rt) return { error: 'no runtime' };
  const n = pane.barTimes.length;
  const tfSec = window.__app.App.tfById[pane.tf].sec;
  const c2p = (y) => pane.series.coordinateToPrice(y);
  const o = {
    __pineObj: true, kind: 'box', id: 800001,
    left: pane.barTimes[Math.max(0, n - 80)] * 1000,
    right: (pane.barTimes[n - 1] + 120 * tfSec) * 1000,
    top: c2p(150), bottom: c2p(330),
    xloc: 'bar_time', extend: 'none',
    bgcolor: { css: () => 'rgba(0,220,0,0.85)' },
    border_color: { css: () => 'rgba(0,255,0,1)' },
    border_width: 2, border_style: 'solid',
    text: '', text_size: 'small',
    deleted: false, bornBar: rt.barIndex, __testBox: true,
  };
  rt.store.add('box', o);
  return { id: o.id };
}"""

CLIP_JS = r"""() => {
  /* count GREEN pixels in the price-scale region vs a control column inside
     the plot, on the box's own y band */
  const pane = window.__pane;
  const cv = pane._pineCanvases && pane._pineCanvases.fg;
  if (!cv) return { error: 'no fg canvas' };
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const row = ctx.getImageData(0, 0, W, H).data;
  const PX = (x, y) => { const i = ((y | 0) * W + (x | 0)) * 4; return (i >= 0 && i + 3 < row.length) ? [row[i], row[i + 1], row[i + 2], row[i + 3]] : [0, 0, 0, 0]; };
  const GREEN = (x, y) => { const p = PX(x, y); return p[3] > 10 && p[1] > 180 && p[0] < 90 && p[2] < 90; };
  let axisW = 62;
  try { axisW = pane.chart.priceScale('right').width() || axisW; } catch (e) {}
  const plotW = pane.host.clientWidth - axisW;
  const yT = pane.series.priceToCoordinate(window.__testTop), yB = pane.series.priceToCoordinate(window.__testBot);
  if (yT == null || yB == null) return { error: 'no box y band' };
  const y0 = Math.max(0, Math.round(Math.min(yT, yB)) - 2), y1 = Math.min(H - 1, Math.round(Math.max(yT, yB)) + 2);
  let over = 0;
  for (let x = Math.round(plotW) + 2; x <= W - 2; x += 2)
    for (let y = y0; y <= y1; y += 4) if (GREEN(x, y)) over++;
  let ctrl = 0;
  const cx = Math.round(plotW) - 25;
  for (let y = y0; y <= y1; y += 2) if (cx > 0 && GREEN(cx, y)) ctrl++;
  return { plotW: Math.round(plotW), W, over, ctrl };
}"""

MUTE_JS = r"""() => {
  const App = window.__app.App;
  if (!App.feed || !Array.isArray(App.feed.onTick)) return -1;
  if (!window.__savedTicks) { window.__savedTicks = App.feed.onTick.slice(); App.feed.onTick.length = 0; }
  return window.__savedTicks.length;
}"""
UNMUTE_JS = r"""() => {
  const App = window.__app.App;
  if (window.__savedTicks && Array.isArray(App.feed.onTick)) { App.feed.onTick.push(...window.__savedTicks); window.__savedTicks = null; return 1; }
  return 0;
}"""

STACK_JS = r"""() => {
  /* geometry of the [VALUE][COUNTDOWN] stack + visibility of the pieces */
  const pane = window.__pane;
  const pv = pane.pv, cd = pane.cd, chip = pane.chip;
  if (!pv || !cd) return { error: 'missing elements' };
  const vis = (el) => !!(el && el.style.display !== 'none' && el.getBoundingClientRect().height > 0);
  const out = { pv: vis(pv), cd: vis(cd), chip: vis(chip) };
  if (out.pv && out.cd) {
    const r1 = pv.getBoundingClientRect(), r2 = cd.getBoundingClientRect();
    out.gap = r2.top - r1.bottom;
    out.dw = Math.abs(r1.width - r2.width);
  }
  if (out.pv) {
    out.pvTxt = pv.textContent;
    out.bg = pv.style.background || getComputedStyle(pv).backgroundColor;
    out.color = getComputedStyle(pv).color;
  }
  try { out.priceLineVisible = pane.series.options().priceLineVisible; out.lastValueVisible = pane.series.options().lastValueVisible; } catch (e) {}
  return out;
}"""

CD_JS = r"""() => {
  /* countdown text + the engine's own close-time math for THIS pane */
  const pane = window.__pane;
  const app = window.__app;
  const cd = pane.cd;
  const txt = (cd && cd.style.display !== 'none') ? cd.textContent : null;
  const tf = app.App.tfById[pane.tf];
  const off = (app.App.feed && app.App.feed.serverOff) || 0;
  const bars = pane.bars;
  if (!tf || !bars || !bars.length) return { error: 'no bars', txt };
  const t0 = bars[Math.floor(bars.length / 2)].time;
  const bs0 = app.Manager.bucketStartFor(tf, t0);
  const be0 = app.Manager.bucketEndFor(tf, t0);
  let bracket = true, monthOk = null;
  const samples = Math.min(40, bars.length);
  for (let k = 0; k < samples; k++) {
    const t = bars[Math.floor(k * bars.length / samples)].time;
    const bs = app.Manager.bucketStartFor(tf, t), be = app.Manager.bucketEndFor(tf, t);
    if (!(bs <= t && t < be)) { bracket = false; break; }
  }
  if (tf.id === 'MN1') {
    // ROUND214: engine buckets live in the server-label (pseudo-UTC) frame
    // (round-84 doctrine — MT5 stamps are server-wall readings), so the next
    // month start is the plain UTC calendar number, NOT + off (the old + off
    // double-shifted and could never match with --off 10800).
    const d = new Date((t0 - off) * 1000);
    const next = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
    monthOk = (be0 === next);
  }
  const lastT = bars[bars.length - 1].time;
  const closeSrv = app.Manager.bucketEndFor(tf, lastT);
  const nowSrv = Math.floor(Date.now() / 1000 + off);
  return { txt, tfSec: tf.sec, tfId: tf.id, bucketLen: be0 - bs0, bracket, monthOk,
           expectRem: closeSrv - nowSrv, bars: bars.length, serverOff: off };
}"""

MAGNET_JS = r"""(li) => {
  /* pick the bar, compute host-space anchors and the OHLC pixel ladder */
  const pane = window.__pane;
  const n = pane.barTimes.length;
  if (li == null) li = n - 60;
  const x = pane.chart.timeScale().logicalToCoordinate(li);
  const b = pane.bars[li];
  const yOf = (p) => pane.series.priceToCoordinate(p);
  return { x, yLow: yOf(b.low), yClose: yOf(b.close), low: b.low, close: b.close,
           high: b.high, open: b.open, plotH: pane._mainPlotH || pane.host.clientHeight - 30 };
}"""

SNAP_JS = r"""([x, y]) => {
  const pane = window.__pane;
  const r = pane.engine.snap(x, y);
  const raw = pane.series.coordinateToPrice(y);
  return { p: r.p, raw, snapped: r.p !== raw };
}"""

def parse_rem(txt):
    txt = (txt or '').strip()
    days = 0
    if 'd ' in txt:
        d, txt = txt.split('d ', 1)
        try: days = int(d)
        except ValueError: return None
    try:
        parts = [int(p) for p in txt.split(':')]
    except ValueError:
        return None
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts
    return days * 86400 + h * 3600 + m * 60 + s

def wait_pine_ok(pg, timeout=90, want_boxes=True, env_tf=None):
    deadline = time.time() + timeout
    st = None
    while time.time() < deadline:
        st = pg.evaluate("""() => {
          const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
          return s ? { status: s.status, boxes: s.boxes, bars: s.bars, ms: s.lastRunMs,
                       envTf: (s.rt && s.rt.env && s.rt.env.tfSec) || null } : null;
        }""")
        env_ok = (env_tf is None) or (st and st['envTf'] == env_tf)  # stale old-state guard
        if st and st['status'] == 'ok' and st['bars'] > 0 and (not want_boxes or st['boxes'] > 0) and env_ok:
            return st
        time.sleep(0.8)
    return st

def wait_cd(pg, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        txt = pg.evaluate("""() => { const c = window.__pane.cd; return (c && c.style.display !== 'none') ? c.textContent : null; }""")
        if txt:
            return txt
        time.sleep(0.5)
    return None

def main():
    os.makedirs(SHOTS, exist_ok=True)
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py'), '--off', '10800', '--tick-interval', '1.0'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                b = pw.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900, 'deviceScaleFactor': 1})
            errors = []
            pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[1] boot (demo broker GMT+3) + add the REAL 786 Zones on M15')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1200)
            pg.evaluate("""() => {
              window.__pane = window.__app.App.panes[0];
              window.__app.Manager.setTf(window.__pane, 'M15');
            }""")
            pg.wait_for_timeout(2200)
            src = open(FIXTURE, encoding='utf-8').read()
            added = pg.evaluate("""(src) => {
              const { PineScriptsStore, PineUI } = window.__app;
              const rec = PineScriptsStore.create('786 Zones r80', src);
              return !!PineUI.add(window.__pane, rec.id, {});
            }""", src)
            check('instance added', added)
            st = wait_pine_ok(pg, env_tf=900)
            check('runtime ok with boxes (M15)', st and st['status'] == 'ok' and st['boxes'] > 0, st)
            check('M15 runtime env.tfSec = 900', st and st['envTf'] == 900, st and st['envTf'])

            print('[2][A] CLIP — future-extending green test box must stop at the plot edge')
            muted = pg.evaluate(MUTE_JS)
            check('feed ticks muted', muted and muted > 0, muted)
            pg.evaluate("""() => {
              const pane = window.__pane;
              window.__testTop = pane.series.coordinateToPrice(150);
              window.__testBot = pane.series.coordinateToPrice(330);
            }""")
            inj = pg.evaluate(INJECT_JS)
            check('test box injected', 'id' in inj, inj)
            pg.wait_for_timeout(400)
            clip = pg.evaluate(CLIP_JS)
            check('control: box painted INSIDE the plot near the edge', clip.get('ctrl', 0) >= 5, clip)
            check('rest: ZERO green pixels over the price scale', clip.get('over') == 0, clip)

            print('[3][A] pan RIGHT 240px (content pushes toward the axis) — HOLD, re-scan')
            rect = pg.evaluate("""() => {
              const r = window.__pane.host.getBoundingClientRect();
              return { x: r.left + r.width * 0.4, y: r.top + r.height * 0.45 };
            }""")
            pg.mouse.move(rect['x'], rect['y'])
            pg.mouse.down()
            pg.mouse.move(rect['x'] + 240, rect['y'], steps=14)
            pg.wait_for_timeout(150)
            clip2 = pg.evaluate(CLIP_JS)
            check('mid-pan: box still measurable inside the plot', clip2.get('ctrl', 0) >= 3, clip2)
            check('mid-pan: ZERO green pixels over the price scale', clip2.get('over') == 0, clip2)
            pg.mouse.up()
            pg.wait_for_timeout(350)
            clip3 = pg.evaluate(CLIP_JS)
            check('settled: still zero over the price scale', clip3.get('over') == 0, clip3)
            pg.screenshot(path=f'{SHOTS}/r80-clip.png')
            pg.evaluate(UNMUTE_JS)
            pg.wait_for_timeout(1200)

            print('[4][B] TF switches rebuild the runtime (fresh env.tfSec) + perf table')
            perf = []
            for tf, sec in [('M1', 60), ('M5', 300), ('H1', 3600)]:
                t0 = time.time()
                pg.evaluate("""(tf) => window.__app.Manager.setTf(window.__pane, tf)""", tf)
                stt = wait_pine_ok(pg, timeout=90, env_tf=sec)
                wall = time.time() - t0
                check(f'{tf}: runtime ok with boxes', stt and stt['status'] == 'ok' and stt['boxes'] > 0, stt)
                check(f'{tf}: env.tfSec rebuilt to {sec}', stt and stt['envTf'] == sec, stt and stt['envTf'])
                perf.append((tf, stt.get('bars') if stt else -1, stt.get('ms') if stt else -1, round(wall, 1)))
                check(f'{tf}: countdown row visible', wait_cd(pg) is not None)

            print('[5][C] countdown on EVERY timeframe + close-time parity vs the broker')
            for tf, sec in [('M15', 900), ('H1', 3600), ('D1', 86400), ('W1', 604800), ('MN1', 2592000)]:
                pg.evaluate("""(tf) => window.__app.Manager.setTf(window.__pane, tf)""", tf)
                pg.wait_for_timeout(1200)
                txt = wait_cd(pg, timeout=30)
                check(f'{tf}: countdown visible (was hidden on D1/W1/MN before r80)', txt is not None)
                cd = pg.evaluate(CD_JS)
                rem = parse_rem(txt)
                check(f'{tf}: countdown text parses ({txt})', rem is not None, txt)
                if rem is not None and cd.get('expectRem') is not None:
                    check(f'{tf}: countdown matches broker bar close (|Δ| ≤ 6s)',
                          abs(rem - cd['expectRem']) <= 6, {'rem': rem, 'expect': cd['expectRem']})
                check(f'{tf}: every bar sits inside its [open, close) bucket', cd.get('bracket') is True, cd)
                exp_len = sec if tf != 'MN1' else None
                if exp_len:
                    check(f'{tf}: bucket length == tf.sec', cd.get('bucketLen') == exp_len, cd.get('bucketLen'))
                if tf == 'MN1':
                    check('MN1: close lands on the next calendar month start (server label)', cd.get('monthOk') is True, cd)
                if tf in ('D1', 'W1', 'MN1'):
                    pg.screenshot(path=f'{SHOTS}/r80-cd-{tf.lower()}.png')

            print('[6][D] TV-merged [VALUE][COUNTDOWN] stack + Symbol-mode matrix')
            pg.evaluate("""() => window.__app.Manager.setTf(window.__pane, 'M15')""")
            pg.wait_for_timeout(1800)
            wait_cd(pg)
            s = pg.evaluate(STACK_JS)
            check('value row visible (default mode)', s.get('pv') is True, s)
            check('countdown row visible', s.get('cd') is True, s)
            check('rows are FLUSH (gap ≈ 0)', s.get('gap') is not None and abs(s['gap']) <= 1.5, s.get('gap'))
            check('rows share ONE column width (|Δw| ≤ 1.5px)', s.get('dw') is not None and s['dw'] <= 1.5, s.get('dw'))
            check('value row shows the last close digits', (s.get('pvTxt') or '').strip() != '', s.get('pvTxt'))
            check('native LWC last-value label retired', s.get('lastValueVisible') is False, s.get('lastValueVisible'))
            pg.screenshot(path=f'{SHOTS}/r80-stack-dark.png')

            matrix = [('hidden', False, False), ('name', False, True), ('value', True, False),
                      ('line', False, False), ('line_value', True, False),
                      ('name_value', True, True), ('name_value_line', True, True)]
            for mode, want_pv, want_chip in matrix:
                pg.evaluate("""(m) => window.__app.Settings.set('symLabel', m)""", mode)
                pg.wait_for_timeout(320)
                s = pg.evaluate(STACK_JS)
                check(f"mode '{mode}': pv={want_pv} chip={want_chip}",
                      s.get('pv') == want_pv and s.get('chip') == want_chip, s)
            pg.evaluate("""() => window.__app.Settings.set('symLabel', 'name_value_line')""")
            pg.wait_for_timeout(300)

            print('[7][E] light theme — the stack must stay correct')
            pg.evaluate("""() => window.__app.Theme.apply('light')""")
            pg.wait_for_timeout(700)
            wait_cd(pg)
            s = pg.evaluate(STACK_JS)
            check('light: value row visible', s.get('pv') is True, s)
            check('light: countdown row visible', s.get('cd') is True, s)
            check('light: rows still flush', s.get('gap') is not None and abs(s['gap']) <= 1.5, s.get('gap'))
            check('light: rows share one width', s.get('dw') is not None and s['dw'] <= 1.5, s.get('dw'))
            pg.screenshot(path=f'{SHOTS}/r80-stack-light.png')
            pg.evaluate("""() => window.__app.Theme.apply('dark')""")
            pg.wait_for_timeout(500)

            print('[8][F] magnet — four strengths + live crosshair snap')
            pg.evaluate("""() => { window.__app.Manager.setTf(window.__pane, 'M5'); window.__app.App.tool = 'arrowcur'; }""")
            pg.wait_for_timeout(1800)
            mg = pg.evaluate(MAGNET_JS, None)
            check('magnet probe bar available', mg and mg.get('x') is not None and mg.get('yLow') is not None, mg)

            def snap_at(dy):
                y = mg['yLow'] + dy
                if y >= mg['plotH'] - 6:
                    return None
                return pg.evaluate(SNAP_JS, [mg['x'], y])

            cases = [
                ('off',    5,  False), ('off',   25, False),
                ('weak',   5,  True),  ('weak',  12, False),
                ('medium', 12, True),  ('medium', 25, False),
                ('strong', 25, True),  ('strong', 40, True),
            ]
            for mode, dy, want in cases:
                pg.evaluate("""(m) => { window.__app.App.magnetMode = m; }""", mode)
                r = snap_at(dy)
                oknow = (r is not None and r.get('snapped') == want)
                check(f'snap {mode} @+{dy}px below low → snapped={want}', oknow,
                      r if r is not None else 'off-plot')

            print('[8b][F] live crosshair magnet — the hover pill locks onto OHLC')
            rect = pg.evaluate("""() => {
              const r = window.__pane.engine.canvas.getBoundingClientRect(); // the OVERLAY is the event target
              return { l: r.left, t: r.top };
            }""")
            pg.evaluate("""(m) => { window.__app.App.magnetMode = m; }""", 'medium')
            pg.evaluate("""() => {
              const eng = window.__pane.engine;
              window.__moves = [];
              if (!eng.__r80wrap) {
                const orig = eng.move.bind(eng);
                eng.move = (x, y) => {
                  const pre = { x, y, mode: eng.mode, downPt: !!eng.downPt,
                                magnet: window.__app.App.magnetMode, alt: window.__app.App.altDown,
                                areg: eng._axisRegion(x, y), mainH: null, snapY: null };
                  try { pre.mainH = eng.view().mainH; } catch (e) {}
                  try { pre.snapY = eng._magnetSnapY(x, y); } catch (e) { pre.snapY = 'throw:' + e; }
                  window.__moves.push(pre);
                  orig(x, y);
                };
                eng.__r80wrap = true;
              }
            }""")
            y_off = mg['yLow'] + 12
            if y_off < mg['plotH'] - 6:
                pg.mouse.move(rect['l'] + mg['x'], rect['t'] + mg['yLow'] + 60, steps=4)
                pg.mouse.move(rect['l'] + mg['x'], rect['t'] + y_off, steps=8)
                pg.wait_for_timeout(220)
                got = pg.evaluate("""([x, y]) => {
                  const eng = window.__pane.engine;
                  return { pax: window.__pane._paxPrice, mouse: eng.mouse, cross: eng._cross,
                           mode: eng.mode, downPt: !!eng.downPt, magnet: window.__app.App.magnetMode,
                           alt: window.__app.App.altDown, snapY: eng._magnetSnapY(x, y),
                           areg: eng._axisRegion(x, y), mainH: eng.view().mainH,
                           moves: (window.__moves || []).slice(-4) };
                }""", [mg['x'], y_off])
                check('hover: engine received the pointer', got and got.get('mouse') and abs(got['mouse']['y'] - y_off) <= 2, got)
                check('hover: crosshair state carries the snapped y',
                      got and got.get('cross') and got['cross'].get('y') is not None and got.get('snapY') is not None and abs(got['cross']['y'] - got['snapY']) <= 2,
                      {k: got.get(k) for k in ('mode', 'magnet', 'alt', 'areg', 'snapY', 'cross', 'moves')})
                check('hover: crosshair price locked to the bar LOW (medium, 12px)',
                      got and got.get('pax') is not None and abs(got['pax'] - mg['low']) < 1e-6 * max(1, abs(mg['low'])),
                      {'got': got and got.get('pax'), 'low': mg['low']})
            pg.evaluate("""(m) => { window.__app.App.magnetMode = m; }""", 'off')
            if y_off < mg['plotH'] - 6:
                pg.mouse.move(rect['l'] + mg['x'], rect['t'] + mg['yLow'] + 60, steps=4)
                pg.mouse.move(rect['l'] + mg['x'], rect['t'] + y_off, steps=8)
                pg.wait_for_timeout(220)
                got = pg.evaluate("""() => window.__pane._paxPrice""")
                check('hover: magnet OFF leaves the raw cursor price', got is not None and abs(got - mg['low']) > 1e-9, {'got': got, 'low': mg['low']})
            pg.evaluate("""() => { window.__app.App.tool = null; }""")

            print('[9] perf table (evidence, informational)')
            for row in perf:
                print(f"    TF {row[0]:>4}: {row[1]} bars, full pass {row[2]}ms, reload {row[3]}s (incl. fetch)")

            print('[10] final error audit')
            real_errors = [e for e in errors if 'favicon' not in e]
            check('zero page/console errors across the session', not real_errors, real_errors[:5])
            pg.screenshot(path=f'{SHOTS}/r80-final.png')
            b.close()
    finally:
        prov.terminate()

    print('=' * 40)
    print(f"RESULT: {len(FAILS)} failed" if FAILS else "RESULT: ALL E2E CHECKS PASSED")
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
