#!/usr/bin/env python3
"""ROUND89 e2e — Custom Session must survive a REAL weekend broker's offset
estimator (the user's 3rd report: the displayed region sat at the wrong
hours and a region past the selected dates appeared).

Boots the demo provider with a RUNTIME-drivable offset (test_round89_provider.py),
attaches the user's 786 Zones, applies 03:30–06:30 (chart tz = Asia/Tehran)
through the REAL dialog, then re-measures the broker offset into the states a
real weekend produces and asserts the chart heals WITHOUT a refetch:
  1. srv = +10800 (EEST Friday): regions 03:30->06:30, exactly the cfg days
  2. srv -> -36540 (the Saturday 'friday_bar - now' garbage): SAME displayed
     hours, SAME day count, NO region past dTo (the clip), pane/series consistent
  3. srv -> 0 (estimate never measured / rejected by the guard): SAME
  4. srv -> +10800 again: SAME
  5. Turn off restores the live history
Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, os, json, socket, signal, functools, http.server, threading

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8927, 8777
CTRL = '/tmp/round89_off.json'
USER_SRC = '/home/z/my-project/user-tests/786-zones.pine'
FAILS = []

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra != '' else ''))
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

def set_off(v):
    with open(CTRL, 'w') as f:
        json.dump({'off': v}, f)

AUDIT = """() => {
  const a = window.__app; const p = a.App.panes[0];
  const hm = (t) => { const q = a.TZ.parts('Asia/Tehran', t); return q.dow + ' ' + q.day + ' ' + q.hour + ':' + q.minute; };
  const bt = p.barTimes || [];
  const shift = a.SessionRange.shift();
  const regs = []; let cur = null;
  for (const t of bt) {
    const w = t + (shift ? shift(t) : 0);
    const d = Math.floor(w / 86400) * 86400;
    if (!cur || cur.d !== d) { cur = { d, first: t, last: t, n: 1 }; regs.push(cur); }
    else { cur.last = t; cur.n++; }
  }
  let sLast = null;
  try { const sd = p.series.data(); sLast = sd.length ? sd[sd.length-1].time : null; } catch (e) { sLast = null; }
  const pLast = bt.length ? bt[bt.length-1] : null;
  const dayNum = (d) => new Date(d * 1000).toISOString().slice(0, 10);   // wall-day epoch -> ISO (numeric, ICU-name-proof)
  return {
    srv: (a.App.feed && a.App.feed.serverOff) || 0,
    n: bt.length,
    regions: regs.map(r => ({ first: hm(r.first), last: hm(r.last), n: r.n, day: dayNum(r.d) })),
    startsAll330: regs.length > 0 && regs.every(r => hm(r.first).endsWith('03:30')),
    endsAll630: regs.length > 0 && regs.every(r => hm(r.last).endsWith('06:25')),
    consistent: (typeof sLast === 'number' && pLast != null) ? sLast >= pLast : false,
  };
}"""

def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever(), daemon=True).start()
    set_off(10800)
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'scripts', 'test_round89_provider.py'),
                             '--off', '10800', '--port', str(PORT_WS)],
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
            print('[1] boot (Tehran, XAUUSD, 5m) + the user\'s 786 Zones')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1200)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.evaluate("() => { const a = window.__app; const p = a.App.panes[0]; if (p.symbol !== 'XAUUSD') a.Manager.setSymbol(p, 'XAUUSD'); }")
            pg.wait_for_timeout(500)
            pg.evaluate("""() => { const a = window.__app; const p = a.App.panes[0];
              const id = Object.keys(a.App.tfById || {}).find(k => a.App.tfById[k] && a.App.tfById[k].sec === 300);
              if (id && p.tf !== id) a.Manager.setTf(p, id); }""")
            pg.wait_for_timeout(2000)
            src = open(USER_SRC, encoding='utf-8').read()
            added = pg.evaluate("""(o) => {
              const a = window.__app;
              const rec = a.PineScriptsStore.create(o.name, o.src);
              window.__pane = a.App.panes[0];
              window.__inst = a.PineUI.add(window.__pane, rec.id, {});
              return !!window.__inst;
            }""", {'name': '786 Zones r89', 'src': src})
            check('786 Zones instance added', added)
            pg.evaluate("() => window.__app.PineUI.remove(window.__pane, window.__inst.id)")
            pg.wait_for_timeout(300)

            print('[2] apply 03:30-06:30 Sep 1-18 via the REAL dialog')
            pg.evaluate("() => window.__app.SessionRange.openDialog()")
            pg.wait_for_selector('#cs-hfrom', timeout=8000)
            pg.evaluate("""() => { const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));};
              set('cs-hfrom','3');set('cs-mfrom','30');set('cs-hto','6');set('cs-mto','30');
              set('cs-dfrom','2026-09-05');set('cs-dto','2026-09-18'); }""")
            pg.wait_for_timeout(150)
            info = pg.evaluate("() => document.getElementById('cs-info').textContent")
            check('info line names the chart tz', 'Asia/Tehran' in info, info)
            pg.click('#cs-apply')
            pg.wait_for_timeout(4500)

            def audit(tag):
                d = pg.evaluate(AUDIT)
                print(f'   [{tag}] srv={d["srv"]} regions={len(d["regions"])} consistent={d["consistent"]}')
                return d

            d = audit('srv=+10800')
            check('baseline: feed measured the GMT+3 offset', d['srv'] == 10800, d['srv'])
            check('baseline: every region starts 03:30 displayed', d['startsAll330'], d['regions'][:2])
            check('baseline: every region ends 06:25 displayed', d['endsAll630'])
            check('baseline: exactly 14 day regions (Sep 5..18)', len(d['regions']) == 14, len(d['regions']))
            check('baseline: no region past Sep 18', all(r['day'] <= '2026-09-18' for r in d['regions']), [r['day'] for r in d['regions']][-2:])
            check('baseline: pane/series consistent', d['consistent'])

            print('[3] the Saturday offset garbage (-36540) lands mid-session')
            set_off(-36540)
            pg.wait_for_timeout(1200)
            deadline = time.time() + 20
            while time.time() < deadline:
                d = audit('srv=-36540')
                if d['srv'] == -36540 and d['startsAll330'] and len(d['regions']) == 14 \
                        and all(r['day'] <= '2026-09-18' for r in d['regions']):
                    break
                time.sleep(1.0)
            check('garbage: feed now carries -36540 (the real weekend state)', d['srv'] == -36540, d['srv'])
            check('garbage: every region STILL starts 03:30 displayed', d['startsAll330'], d['regions'][:2])
            check('garbage: every region STILL ends 06:25 displayed', d['endsAll630'])
            check('garbage: still exactly 14 day regions', len(d['regions']) == 14, len(d['regions']))
            check('garbage: NO region past Sep 18 (the clip)', all(r['day'] <= '2026-09-18' for r in d['regions']), [r['day'] for r in d['regions']][-2:])
            check('garbage: pane/series consistent', d['consistent'])

            print('[4] the never-measured state (0) lands mid-session')
            set_off(0)
            pg.wait_for_timeout(1200)
            deadline = time.time() + 20
            while time.time() < deadline:
                d = audit('srv=0')
                if d['srv'] == 0 and d['startsAll330'] and len(d['regions']) == 14 \
                        and all(r['day'] <= '2026-09-18' for r in d['regions']):
                    break
                time.sleep(1.0)
            check('zero: feed now carries 0', d['srv'] == 0, d['srv'])
            check('zero: every region STILL starts 03:30 displayed', d['startsAll330'], d['regions'][:2])
            check('zero: still exactly 14 day regions', len(d['regions']) == 14, len(d['regions']))
            check('zero: NO region past Sep 18', all(r['day'] <= '2026-09-18' for r in d['regions']))
            check('zero: pane/series consistent', d['consistent'])

            print('[5] the offset heals back to +10800')
            set_off(10800)
            pg.wait_for_timeout(1200)
            deadline = time.time() + 20
            while time.time() < deadline:
                d = audit('srv=+10800 again')
                if d['srv'] == 10800 and d['startsAll330'] and len(d['regions']) == 14:
                    break
                time.sleep(1.0)
            check('healed: every region STILL starts 03:30 displayed', d['startsAll330'], d['regions'][:2])
            check('healed: still exactly 14 day regions', len(d['regions']) == 14, len(d['regions']))
            check('healed: pane/series consistent', d['consistent'])

            print('[6] turn off restores live history')
            pg.evaluate("() => window.__app.SessionRange.clear()")
            pg.wait_for_timeout(3000)
            on = pg.evaluate("() => window.__app.SessionRange.isActive()")
            n = pg.evaluate("() => window.__app.App.panes[0].barTimes.length")
            check('session off', not on)
            check('live history restored (>= 3000 bars)', n >= 3000, n)

            b.close()
            check('zero page errors', len(errors) == 0, errors[:3])
    finally:
        try:
            prov.send_signal(signal.SIGTERM)
        except Exception:
            pass
    print('FAILS:', FAILS)
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
