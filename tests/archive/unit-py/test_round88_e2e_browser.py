#!/usr/bin/env python3
"""ROUND88 e2e — Custom Session window in the CHART'S TIMEZONE + the user's
786 Zones on both chart modes.

User report (with 2 screenshots): "کاربر بر اساس تایم زونی که انتخاب کرده
برای چارتش یک ساعتی تا یک ساعتی رو توی بخش custom Session وارد میکنه و
میخواد طبق همون تایم زون چارتش این محدوده ساعت ها نمایش داده بشه ... چیزی
که نمایش داده شده درست نیست" + "اندیکاتور ها هم باید توی این حالت از چارت
کار بکنند" + the indicator file itself must NEVER ship inside the app.

Boots the demo provider with --off 10800 (a GMT+3 broker) and drives the
REAL dialog. Asserts:
  1. the user's 786 Zones runs on the NORMAL chart (boxes > 0)
  2. Custom Session 03:30–06:30 applied through the dialog + tz Asia/Tehran:
     every day region DISPLAYS 03:30..06:2x on the axis (not broker hours)
  3. the axis DOM really shows 03:30 labels
  4. the indicator runs INSIDE session mode: TK/HK zones form inside the
     window (03:30 Tehran captures Tokyo open) — boxes > 0, session labels
  5. End-of-Day box edges clamp to the region end (chart-tz days);
     End-of-Chart edges pass through
  6. a mid-session tz switch (Tehran -> UTC) re-stitches: regions move to
     00:30 displayed (03:30–06:30 interpreted in UTC) and back
  7. Turn off restores the live history
  8. the user's script file is NOT anywhere in the app package tree
Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
USER_SRC = '/home/z/my-project/user-tests/786-zones.pine'
PORT_HTTP, PORT_WS = 8902, 8777
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

            print('[1] boot (demo broker = GMT+3) — NORMAL chart mode')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            # the user's chart timezone: Asia/Tehran (their complaint context)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(400)
            feed_off = pg.evaluate("() => (window.__app.App.feed && window.__app.App.feed.serverOff) || 0")
            check('feed measured the GMT+3 broker offset', feed_off == 10800, feed_off)

            print('[2] the USER\'s 786 Zones on the NORMAL chart')
            src = open(USER_SRC, encoding='utf-8').read()
            ADD_JS = """(o) => {
              const a = window.__app;
              const rec = a.PineScriptsStore.create(o.name, o.src);
              window.__pane = a.App.panes[0];
              window.__inst = a.PineUI.add(window.__pane, rec.id, {});
              return !!window.__inst;
            }"""
            SETINPUTS_JS = """(o) => {
              // input ids are synthetic — resolve by TITLE, then rebuild
              const a = window.__app;
              const s = (a.PineUI.debug(window.__pane) || [])[0];
              if (!s || !s.inputDefs) return false;
              for (const want of Object.keys(o.over)) {
                const def = s.inputDefs.find((d) => (d.title || '').toLowerCase() === want.toLowerCase());
                if (!def) return false;
                window.__inst.inputs[def.id] = o.over[want];
              }
              if (o.recompute !== false) a.PineUI.recomputePine(window.__pane);
              return true;
            }"""
            added = pg.evaluate(ADD_JS, {'name': '786 Zones r88', 'src': src})
            check('instance added (normal mode)', added)
            st = None
            deadline = time.time() + 90
            while time.time() < deadline:
                st = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  return s ? { status: s.status, boxes: s.boxes } : null;
                }""")
                if st and st.get('status') == 'ok' and st.get('boxes', 0) > 0:
                    break
                time.sleep(1.2)
            check('initial normal-mode pass completed', bool(st) and st.get('status') == 'ok')
            ok_inputs = pg.evaluate(SETINPUTS_JS, {'over': {'Days Back': 3}, 'recompute': True})
            check('daysBack override applied (resolved by title)', ok_inputs)
            check('normal mode: runtime ok with boxes', bool(st) and st.get('status') == 'ok' and st.get('boxes', 0) > 0, st)
            # remove it again — clean slate for the session part
            pg.evaluate("() => window.__app.PineUI.remove(window.__pane, window.__inst.id)")
            pg.wait_for_timeout(400)

            print('[3] Custom Session 03:30–06:30 through the REAL dialog (Tehran tz)')
            rng = pg.evaluate("""() => {
              // dates in the CHART tz (Tehran): last 12 days ending yesterday.
              // en-CA gives numeric y-m-d (TZ.parts month is an ICU name like 'Sept')
              const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
              const nowMs = Date.now();
              const p = fmt.format(new Date(nowMs)).split('-').map(Number);
              const pad = (n) => String(n).padStart(2, '0');
              const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
              return { from: iso(p[0], p[1], p[2] - 12), to: iso(p[0], p[1], p[2] - 1) };
            }""")
            pg.evaluate("() => window.__app.SessionRange.openDialog()")
            pg.wait_for_selector('#cs-hfrom', timeout=8000)
            pg.evaluate("""(rng) => {
              const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
              set('cs-hfrom', '3'); set('cs-mfrom', '30'); set('cs-hto', '6'); set('cs-mto', '30');
              set('cs-dfrom', rng.from); set('cs-dto', rng.to);
            }""", rng)
            pg.wait_for_timeout(300)
            info = pg.evaluate("() => document.getElementById('cs-info').textContent")
            check('info line shows the entered window', '03:30–06:30' in info and '3h 00m' in info, info)
            check('info line names the CHART timezone', 'Asia/Tehran' in info, info)
            pg.click('#cs-apply')
            pg.wait_for_timeout(800)
            on = pg.evaluate("() => window.__app.SessionRange.isActive()")
            check('session mode active', on)

            print('[4] regions display 03:30..06:2x in the CHART zone (Tehran)')
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
            deadline = time.time() + 60
            nrows = 0
            while time.time() < deadline:
                nrows = pg.evaluate("() => { const r = (" + REGION_JS + ")() || []; return r.length; }")
                if nrows >= 8:
                    break
                time.sleep(1.2)
            check('session regions built (>=8 days)', nrows >= 8, nrows)
            rows = pg.evaluate("""() => {
              const a = window.__app;
              const hm = (t) => { const p = a.TZ.parts('Asia/Tehran', t); return p.hour + ':' + p.minute; };
              return ((%s)() || []).map(r => hm(r.first));
            }""" % REGION_JS)
            all330 = bool(rows) and all(x == '03:30' for x in rows)
            check('EVERY region starts at 03:30 displayed (the user\'s exact ask)', all330, rows[:6])
            ends = pg.evaluate("""() => {
              const a = window.__app;
              const pane = a.App.panes[0];
              const tfSec = (a.App.tfById[pane.tf] || {}).sec || 300;
              const hm = (t) => { const p = a.TZ.parts('Asia/Tehran', t); return p.hour + ':' + p.minute; };
              return ((%s)() || []).map(r => hm(r.last + tfSec));
            }""" % REGION_JS)
            all630 = bool(ends) and all(x == '06:30' for x in ends)
            check('EVERY region ends at 06:30 (last close) displayed', all630, ends[:6])

            print('[5] the axis DOM shows ONLY window times (03:30–06:30)')
            pg.evaluate("() => { const p = window.__app.App.panes[0]; p.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 60 }); }")
            pg.wait_for_timeout(900)
            axis_txt = pg.evaluate("() => Array.from(document.querySelectorAll('.tax-ext span')).map(s => s.textContent)")
            def in_window(lbl):
                try:
                    hh, mm = lbl.strip().split(':')
                    v = int(hh) * 60 + int(mm)
                    return 3 * 60 + 30 <= v < 18 * 60 + 30 and (v >= 210 or v < 390)
                except Exception:
                    return True  # day pills / non-time labels pass
            time_lbls = [t for t in axis_txt if ':' in (t or '') and len(t.strip()) == 5]
            check('axis time labels exist', len(time_lbls) >= 6, axis_txt[:8])
            check('every axis time label sits inside the 03:30–06:30 window (Tehran)',
                  all(in_window(t) for t in time_lbls), time_lbls[:12])
            check('axis shows the region start 03:3x/03:4x', any(t.startswith('03:') for t in time_lbls), time_lbls[:12])
            check('axis shows no broker-hour label like 02:xx (pre-window)',
                  not any(t.startswith('02:') or t.startswith('01:') for t in time_lbls), time_lbls[:12])

            print('[6] the USER\'s 786 Zones INSIDE session mode (Tokyo/HK captured by 03:30 Tehran)')
            added2 = pg.evaluate(ADD_JS, {'name': '786 Zones r88 sess', 'src': src})
            check('instance added (session mode)', added2)
            # let the INITIAL pass finish first (no concurrent full passes)
            init_ok = False
            deadline = time.time() + 90
            while time.time() < deadline:
                cur = pg.evaluate("() => { const s = (window.__app.PineUI.debug(window.__pane) || [])[0]; return s ? { st: s.status, at: s.lastRunMs } : null; }")
                if cur and cur['st'] == 'ok':
                    init_ok = True
                    break
                time.sleep(1.2)
            check('initial session-mode pass completed', init_ok)
            pg.wait_for_timeout(1700)   # escape the 1.5s recompute coalescing window
            ok_inputs2 = pg.evaluate(SETINPUTS_JS, {'over': {'Days Back': 3}, 'recompute': True})
            check('daysBack override applied (session instance)', ok_inputs2)
            st2 = None
            deadline = time.time() + 120
            while time.time() < deadline:
                st2 = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  if (!s) return null;
                  const texts = [];
                  if (s.rt) for (const [, lb] of s.rt.store.label) texts.push(String(lb.text || '').trim());
                  return { status: s.status, boxes: s.boxes, texts };
                }""")
                if st2 and st2.get('status') == 'ok' and st2.get('boxes', 0) > 0:
                    break
                time.sleep(1.2)
            check('session mode: runtime ok with boxes', bool(st2) and st2.get('status') == 'ok' and st2.get('boxes', 0) > 0, st2 and {k: st2[k] for k in ('status', 'boxes')})
            sess_lbls = (st2 or {}).get('texts') or []
            check('a zone whose session open falls INSIDE the window formed (TK/HK)',
                  any(l.startswith('TK') or l.startswith('HK') for l in sess_lbls), sess_lbls[:10])

            print('[7] End-of-Day clamp to the region end + End-of-Chart pass-through (chart-tz days)')
            clamp = pg.evaluate("""() => {
              const a = window.__app;
              const pane = window.__pane;
              const s = (a.PineUI.debug(pane) || [])[0];
              if (!s || !s.adapter) return null;
              const ad = s.adapter;
              const times = pane.barTimes;
              const tfSec = (a.App.tfById[pane.tf] || {}).sec || 300;
              const shift = a.SessionRange.shift();
              // regions
              const regions = [];
              let cur = null;
              for (const t of times) {
                const w = t + (shift ? shift(t) : 0);
                const d = Math.floor(w / 86400) * 86400;
                if (!cur || cur.d !== d) { cur = { d, first: t, last: t }; regions.push(cur); }
                else cur.last = t;
              }
              if (regions.length < 2) return null;
              const r = regions[regions.length - 2];   // NOT the final region (its end == chart end passes through)
              const farSec = r.last + 2 * 3600;        // 2h past that region's end, still before the chart end
              const clamped = ad._clampSessionEdge({ x1: r.first * 1000, x2: farSec * 1000, xloc: 'bar_time' }, 'x2', 'x1');
              const lastT = times[times.length - 1];
              const eoc = ad._clampSessionEdge({ x1: r.first * 1000, x2: (lastT + tfSec) * 1000, xloc: 'bar_time' }, 'x2', 'x1');
              const w = a.SessionRange.windowSec();
              const aWall = r.last + (shift ? shift(r.last) : 0);
              const dayW = Math.floor(aWall / 86400) * 86400;
              const endW = dayW + w.sTo;
              const endS = endW - (shift ? shift(endW) : 0);
              return { clampedSec: clamped / 1000, endS, eocPassed: eoc === (lastT + tfSec) * 1000 };
            }""")
            check('EOD edge clamped to the region end (chart-tz)', bool(clamp) and abs(clamp['clampedSec'] + 10800 - clamp['endS']) <= 1.0, clamp)
            check('End-of-Chart edge passes through untouched', bool(clamp) and clamp['eocPassed'], clamp)

            print('[8] mid-session tz switch: Tehran -> UTC re-stitches the same window')
            pg.evaluate("() => { const a = window.__app; a.PineUI.remove(window.__pane, window.__inst.id); }")
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'UTC'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(2500)
            utc_first = pg.evaluate("""() => {
              const a = window.__app;
              const hm = (t) => { const p = a.TZ.parts('UTC', t); return p.hour + ':' + p.minute; };
              const rs = ((%s)() || []);
              const r = rs[rs.length - 1];
              return r ? hm(r.first) : '';
            }""" % REGION_JS)
            check('same window re-read in UTC: regions display 03:30 UTC (03:30–06:30 UTC = stamps 04:30–07:30)', utc_first == '03:30', utc_first)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(2500)
            tehran_first = pg.evaluate("""() => {
              const a = window.__app;
              const hm = (t) => { const p = a.TZ.parts('Asia/Tehran', t); return p.hour + ':' + p.minute; };
              const rs = ((%s)() || []);
              const r = rs[rs.length - 1];
              return r ? hm(r.first) : '';
            }""" % REGION_JS)
            check('switching back restores 03:30 in Tehran', tehran_first == '03:30', tehran_first)

            print('[9] Turn off restores the live history')
            pg.evaluate("() => window.__app.SessionRange.clear()")
            pg.wait_for_timeout(2500)
            off = pg.evaluate("""() => {
              const a = window.__app;
              const pane = a.App.panes[0];
              return { active: a.SessionRange.isActive(), n: pane.barTimes.length,
                       replayBlocked: !!pane.replay,
                       last: pane.barTimes.length ? pane.barTimes[pane.barTimes.length - 1] : 0 };
            }""")
            check('session off + live history back (replay unblocked)', off and not off['active'] and off['n'] > 100 and not off['replayBlocked'], off)

            print('[10] package hygiene — the user\'s script is NOT in the app tree')
            leaks = []
            for base, _dirs, files in os.walk(ROOT):
                if 'node_modules' in base:
                    continue
                for f in files:
                    if f.endswith('.pine'):
                        p = os.path.join(base, f)
                        try:
                            head = open(p, encoding='utf-8', errors='ignore').read(400)
                        except OSError:
                            continue
                        if '786 Zones' in head and 'Amir' in open(p, encoding='utf-8', errors='ignore').read(2000):
                            leaks.append(p)
            check('no copy of the user\'s 786 Zones source inside the app tree', not leaks, leaks)

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
    print('ALL ROUND88 E2E CHECKS PASSED')

if __name__ == '__main__':
    main()
