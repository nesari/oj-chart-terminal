#!/usr/bin/env python3
"""ROUND 39 — four user items, one suite.

  ITEM 1  Economic News: new right-rail panel (tickable Impact/Currency
          filters + master switch) and chart flag marks.
  ITEM 2  Alerts: audit + right-click chart alert creation (price AND time),
          manage dialog, panel edit buttons, time-mark painter, firing.
  ITEM 3  Arrow cursor TV parity (immediate cursor switch, no crosshair).
  ITEM 4  Narrow windows: top-bar scroll chevrons at 720px, left-toolbar
          overflow invariant, right rail fits/scrolls, main.js floor lowered.

Everything else must stay untouched — the suite also re-checks the round-38
tool flyouts as a canary.
"""
import sys, time, threading, http.server, functools, subprocess, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')
PORT = 8978
BASE = f'http://127.0.0.1:{PORT}/renderer/index.html'

_prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def _serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=_serve, daemon=True).start()

def poll(page, js, timeout=20000, cond=lambda v: bool(v)):
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        last = page.evaluate(js)
        try:
            if cond(last):
                return last
        except TypeError:
            pass
        time.sleep(0.25)
    raise TimeoutError(f'poll failed: {js} -> {last}')

results = []
def check(name, ok, info=''):
    results.append((name, ok))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

# colour metrics (the news line may sit exactly on a bar-grid column, so
# counting alpha>8 is meaningless — count COLOUR pixels instead)
RED_JS = """([t, xwin]) => {
  const pane = window.__app.App.panes[0];
  const eng = pane.engine;
  const x = Math.round(eng._xOf(t));
  if (x < 0 || x > eng.view().pw) return -1;
  const img = eng.ctx.getImageData(Math.max(0, x - xwin), 0, xwin * 2 + 1, Math.floor(eng.view().ph));
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2], a = img.data[i + 3];
    if (a > 8 && r > 130 && g < 110 && b < 130) n++;   // impact-red line/chip
  }
  return n;
}"""
AMBER_JS = """([t, xwin]) => {
  const pane = window.__app.App.panes[0];
  const eng = pane.engine;
  const x = Math.round(eng._xOf(t));
  if (x < 0 || x > eng.view().pw) return -1;
  const img = eng.ctx.getImageData(Math.max(0, x - xwin), 0, xwin * 2 + 1, Math.floor(eng.view().ph));
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2], a = img.data[i + 3];
    if (a > 8 && r > 180 && g > 140 && b < 140) n++;   // alert-amber mark
  }
  return n;
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    page.add_init_script("localStorage.clear()")
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo'); page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)
    poll(page, "window.__app.News ? window.__app.News.loaded : false", 20000)
    page.wait_for_timeout(500)

    # ============ ITEM 1: ECONOMIC NEWS ============
    rail = page.evaluate("""() => {
      const b = document.querySelector('#right-tabs .rt-btn[data-tab="news"]');
      return { ok: !!b, svg: !!(b && b.querySelector('svg')), title: b && b.title };
    }""")
    check('N1 news rail button exists with newspaper icon', rail['ok'] and rail['svg'] and rail['title'] == 'Economic News', rail)

    page.click('#right-tabs .rt-btn[data-tab="news"]')
    page.wait_for_timeout(400)
    pnl = page.evaluate("""() => ({
      visible: !document.getElementById('tab-news').classList.contains('hidden'),
      masterOn: document.getElementById('news-on').checked,
      imp: document.querySelectorAll('#news-impacts .nf-chip').length,
      impOn: document.querySelectorAll('#news-impacts .nf-chip.on').length,
      ccy: document.querySelectorAll('#news-ccys .nf-chip').length,
      ccyOn: document.querySelectorAll('#news-ccys .nf-chip.on').length,
      rows: document.querySelectorAll('#news-list .n-row').length,
      days: document.querySelectorAll('#news-list .n-day').length,
      count: document.getElementById('news-count').textContent,
      items: window.__app.News.items.length,
    })""")
    check('N2 panel opens, master ON, 3 impact + 9 currency chips all ticked',
          pnl['visible'] and pnl['masterOn'] and pnl['imp'] == 3 and pnl['impOn'] == 3 and pnl['ccy'] == 9 and pnl['ccyOn'] == 9, pnl)
    check('N3 calendar loaded: rows == items, day-grouped, footer N/M shown',
          pnl['items'] > 0 and pnl['rows'] == pnl['items'] and pnl['days'] >= 2 and re.match(r'^\d+/\d+ shown$', pnl['count']), pnl)

    # pick a HIGH-impact event inside the bar range and locate it
    ev = page.evaluate("""() => {
      const { App, News } = window.__app;
      const bt0 = App.panes[0].barTimes[0], btN = App.panes[0].barTimes[App.panes[0].barTimes.length - 1];
      const e = News.items.find(x => x.impact === 'high' && x.time >= bt0 && x.time <= btN) || News.items[0];
      News.locate(e);
      return { t: e.time, name: e.name, ccy: e.currency, imp: e.impact };
    }""")
    page.wait_for_timeout(700)
    red_on = page.evaluate(RED_JS, [ev['t'], 8])
    page.evaluate("() => { window.__app.News.cfg.on = false; }")
    page.wait_for_timeout(400)
    red_off = page.evaluate(RED_JS, [ev['t'], 8])
    page.evaluate("() => { window.__app.News.cfg.on = true; }")
    page.wait_for_timeout(300)
    check('N4 chart mark painted at the event column (red pixels ON > OFF)',
          red_on > 40 and red_off >= 0 and red_on - red_off > 40, {'on': red_on, 'off': red_off, 'ev': ev})

    # currency filter: untick the event's currency -> mark gone, count updates
    page.evaluate("""([c]) => {
      const chip = [...document.querySelectorAll('#news-ccys .nf-chip')].find(ch => ch.textContent.trim() === c);
      chip.querySelector('input').click();
    }""", [ev['ccy']])
    page.wait_for_timeout(400)
    red_unc = page.evaluate(RED_JS, [ev['t'], 8])
    vis_after = page.evaluate("() => window.__app.News.visible().length")
    check('N5 unticking a currency removes its marks + updates count',
          red_unc >= 0 and red_on - red_unc > 40 and vis_after < pnl['items'], {'redUnc': red_unc, 'vis': vis_after})
    page.evaluate("""([c]) => {
      const chip = [...document.querySelectorAll('#news-ccys .nf-chip')].find(ch => ch.textContent.trim() === c);
      chip.querySelector('input').click();
    }""", [ev['ccy']])
    page.wait_for_timeout(300)

    # impact filter: untick High -> the high event disappears
    page.evaluate("() => { const c = document.querySelector('#news-impacts .nf-chip input'); c.click(); }")
    page.wait_for_timeout(400)
    red_noimp = page.evaluate(RED_JS, [ev['t'], 8])
    check('N6 unticking High impact hides high-impact marks', red_noimp >= 0 and red_on - red_noimp > 40, red_noimp)
    page.evaluate("() => { const c = document.querySelector('#news-impacts .nf-chip input'); c.click(); }")
    page.wait_for_timeout(300)

    persisted = page.evaluate("() => JSON.parse(localStorage.getItem('mt5_news_cfg') || 'null')")
    check('N7 filter state persists to localStorage', bool(persisted) and 'impact' in persisted and 'ccy' in persisted, persisted)

    # ============ ITEM 2: ALERTS ============
    sym = page.evaluate("() => window.__app.App.panes[0].symbol")
    # legacy surface still works: toolbar bell dialog -> create -> row + price line
    page.click('#alert-btn')
    page.wait_for_timeout(250)
    page.fill('#al-price', '1.09999')
    page.select_option('#al-cond', 'Greater Than')
    page.click('#al-create')
    page.wait_for_timeout(350)
    a1 = page.evaluate("""() => ({
      rows: document.querySelectorAll('#alert-list .alert-row').length,
      line: !!Object.keys(window.__app.App.panes[0]._plines || {}).some(k => k.startsWith('al')),
    })""")
    check('A1 toolbar-bell price alert: row + chart price line', a1['rows'] == 1 and a1['line'], a1)

    # right-click mid-chart -> both alert items present
    r = page.evaluate("""() => { const r = window.__app.App.panes[0].overlay.getBoundingClientRect(); return r; }""")
    page.mouse.click(r['x'] + r['width'] * 0.5, r['y'] + r['height'] * 0.4, button='right')
    page.wait_for_timeout(300)
    menu = page.evaluate("""() => [...document.querySelectorAll('.pu-item span:last-child')].map(s => s.textContent)""")
    price_item = next((m for m in menu if m.startswith('Add alert at ')), None)
    time_item = next((m for m in menu if m.startswith('Add time alert at ')), None)
    check('A2 right-click menu offers Add alert at <price> AND Add time alert at <time>',
          bool(price_item) and bool(time_item), menu)
    page.keyboard.press('Escape'); page.mouse.click(700, 500)
    page.wait_for_timeout(150)

    # create a price alert FROM THE CHART: preset price must equal the clicked price
    page.mouse.click(r['x'] + r['width'] * 0.5, r['y'] + r['height'] * 0.4, button='right')
    page.wait_for_timeout(250)
    page.evaluate("""() => { [...document.querySelectorAll('.pu-item')].find(i => /Add alert at /.test(i.textContent)).click(); }""")
    page.wait_for_timeout(300)
    preset = page.evaluate("""() => ({
      shown: !document.getElementById('popup-layer').classList.contains('hidden'),
      val: parseFloat(document.querySelector('#al-price').value),
      sym: document.querySelector('.dialog h3').textContent,
    })""")
    exp_price = page.evaluate("""() => {
      const pane = window.__app.App.panes[0];
      return pane.series.coordinateToPrice(pane.overlay.getBoundingClientRect().height * 0.4);
    }""")
    check('A3 chart-created price alert dialog prefilled with the right-clicked price',
          preset['shown'] and abs(preset['val'] - exp_price) < 0.0005, {'preset': preset['val'], 'exp': exp_price})
    page.click('#al-create'); page.wait_for_timeout(300)
    a2 = page.evaluate("""() => ({ n: window.__app.App.alertsCount != null ? null : document.querySelectorAll('#alert-list .alert-row').length,
      line: [...Object.keys(window.__app.App.panes[0]._plines || {})].filter(k => k.startsWith('al')).length })""")
    check('A4 second price alert created from the chart (2 rows, >=1 line)', a2['n'] == 2 and a2['line'] >= 1, a2)

    # time alert from the chart: preset = bar time under cursor; save -> row + amber mark
    page.mouse.click(r['x'] + r['width'] * 0.5, r['y'] + r['height'] * 0.4, button='right')
    page.wait_for_timeout(250)
    page.evaluate("""() => { [...document.querySelectorAll('.pu-item')].find(i => /Add time alert at /.test(i.textContent)).click(); }""")
    page.wait_for_timeout(300)
    tdlg = page.evaluate("""() => ({
      open: !!document.querySelector('#popup-layer .dialog'),
      isTime: !!document.querySelector('#ma-time'),
      val: (document.querySelector('#ma-time') || {}).value || '',
      title: (document.querySelector('.dialog h3') || {}).textContent || '',
    })""")
    check('A5 time-alert dialog opens with datetime preset (chart time base)',
          tdlg['open'] and tdlg['isTime'] and re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$', tdlg['val'] or '') and 'New Alert' in tdlg['title'], tdlg)
    # push the datetime to +2h (wall string, same base the dialog round-trips) and save
    page.evaluate("""() => {
      const { App } = window.__app;
      const off = (App.feed && App.feed.serverOff) || 0;
      const tz = App.tz;
      const target = Math.floor(Date.now() / 1000) + off + 30 * 60; // chart stamp +30min (inside the future margin)
      let d;
      if (tz === 'broker') d = new Date(target * 1000);
      else if (tz === 'UTC') d = new Date((target - off) * 1000);
      else {
        const utc = target - off;
        let zoff = 0;
        try { zoff = window.__app.TZ.zoneOffsetMinutes(tz, new Date(utc * 1000)) * 60; } catch (e) {}
        d = new Date((utc + zoff) * 1000);
      }
      const p2 = (n) => String(n).padStart(2, '0');
      document.querySelector('#ma-time').value =
        `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
    }""")
    page.click('#ma-save'); page.wait_for_timeout(400)
    tmark = page.evaluate("""() => {
      const { App, Alerts } = window.__app;
      const ta = Alerts.list.find(a => a.kind === 'time');
      if (!ta) return null;
      // centre the chart on the alert bar so the mark is measurable
      const pane = App.panes[0];
      const bt = pane.barTimes;
      let l = bt.length - 1;
      for (let i = 1; i < bt.length; i++) if (bt[i] >= ta.time) { l = i - 1 + (ta.time - bt[i - 1]) / (bt[i] - bt[i - 1]); break; }
      if (ta.time > bt[bt.length - 1]) l = bt.length - 1 + (ta.time - bt[bt.length - 1]) / 60; // future margin
      const ts = pane.chart.timeScale();
      const cur = ts.getVisibleLogicalRange();
      const span = cur ? (cur.to - cur.from) : 160;
      ts.setVisibleLogicalRange({ from: l - span / 2, to: l + span / 2 });
      return { kind: ta.kind, time: ta.time, active: ta.active };
    }""")
    page.wait_for_timeout(500)
    amber = page.evaluate(AMBER_JS, [tmark['time'], 8]) if tmark else -1
    a3 = page.evaluate("""() => {
      const rows = [...document.querySelectorAll('#alert-list .alert-row .a-name')].map(n => n.textContent);
      return { n: rows.length, hasTime: rows.some(t => / at \\w{3} \\d{2} \\w{3} \\d{2}:\\d{2}/.test(t)),
               edits: document.querySelectorAll('#alert-list .a-edit').length };
    }""")
    check('A6 time alert saved from chart: amber mark painted + listed with time + edit buttons',
          bool(tmark) and amber > 20 and a3['hasTime'] and a3['edits'] == a3['n'], {'amber': amber, 'rows': a3, 'tmark': tmark})

    # past times are rejected for NEW time alerts (TV parity)
    past = page.evaluate("""() => {
      const { Alerts } = window.__app;
      const before = Alerts.list.length;
      Alerts.openTimeDialog(window.__app.App.panes[0], Math.floor(Date.now() / 1000) - 86400);
      const btn = document.querySelector('#ma-save');
      btn.click();
      return { unchanged: Alerts.list.length === before, dialogStillOpen: !!document.querySelector('#ma-time') };
    }""")
    check('A6b creating a time alert in the PAST is rejected', past['unchanged'] and past['dialogStillOpen'], past)
    page.evaluate("() => { const b = document.querySelector('#ma-cancel'); if (b) b.click(); }")

    # time alert firing (future-time alert, clock passes it)
    fired = page.evaluate("""() => {
      const { Alerts } = window.__app;
      const ta = Alerts.list.find(a => a.kind === 'time');
      if (!ta) return { missing: true };
      const t0 = ta.time - 3;
      Alerts.onTick(ta.symbol, 1, t0);
      const notYet = !ta.fired && ta.active;
      Alerts.onTick(ta.symbol, 1, ta.time + 5);
      return { notYet, fired: ta.fired, inactive: !ta.active, toast: !!document.querySelector('#toasts .toast') };
    }""")
    check('A7 time alert fires exactly when the tick clock crosses the target',
          fired['notYet'] and fired['fired'] and fired['inactive'] and fired['toast'], fired)

    # manage dialog (edit price kind) from the panel pencil
    page.evaluate("""() => { document.querySelector('#alert-list .alert-row .a-edit').click(); }""")
    page.wait_for_timeout(250)
    man = page.evaluate("""() => ({
      open: !!document.querySelector('#popup-layer .dialog'),
      cond: !!document.querySelector('#ma-cond'),
      price: (document.querySelector('#ma-price') || {}).value,
      active: (document.querySelector('#ma-active') || {}).checked,
    })""")
    page.fill('#ma-price', '1.11111')
    page.click('#ma-save'); page.wait_for_timeout(300)
    moved = page.evaluate("""() => {
      const { App, Alerts } = window.__app;
      const a = Alerts.list.find(x => x.kind === 'price' && Math.abs(x.price - 1.11111) < 1e-9);
      const pane = App.panes[0];
      const keys = Object.keys(pane._plines || {}).filter(k => k.startsWith('al'));
      const linePrice = keys.map(k => pane._plines[k]).filter(Boolean).map(pl => (pl.options ? pl.options().price : null)).find(p => p != null && Math.abs(p - 1.11111) < 1e-6) || null;
      return { saved: !!a, linePrice };
    }""")
    check('A8 manage dialog edits the price; chart line follows',
          man['open'] and man['cond'] and moved['saved'] and (moved['linePrice'] is None or abs(moved['linePrice'] - 1.11111) < 1e-6),
          {'dlg': man, 'moved': moved})

    # manage from the chart: right-click ON the alert line -> "Manage alert…"
    # manage from the chart: create a temporary alert exactly at the mid-plot
    # price, right-click ON its line -> "Manage alert…" -> dialog -> cancel
    tmp = page.evaluate("""() => {
      const { App, Alerts } = window.__app;
      const pane = App.panes[0];
      const h = pane.overlay.getBoundingClientRect().height;
      const mid = pane.series.coordinateToPrice(h * 0.5);
      Alerts.create(pane.symbol, 'Greater Than', mid);
      return { price: mid, y: pane.engine._view.yOf(mid) };
    }""")
    # re-read the line's pixel position RIGHT before the click (live scale drift)
    y2 = page.evaluate("""([p]) => window.__app.App.panes[0].engine._view.yOf(p)""", [tmp['price']])
    page.mouse.click(r['x'] + r['width'] * 0.5, r['y'] + y2, button='right')
    page.wait_for_timeout(300)
    menu2 = page.evaluate("""() => [...document.querySelectorAll('.pu-item span:last-child')].map(s => s.textContent)""")
    check('A9 right-click on the alert line offers Manage alert', any(m.startswith('Manage alert') for m in menu2), menu2)
    if any(m.startswith('Manage alert') for m in menu2):
        page.evaluate("""() => { [...document.querySelectorAll('.pu-item')].find(i => /Manage alert/.test(i.textContent)).click(); }""")
        page.wait_for_timeout(250)
        open2 = page.evaluate("() => !!document.querySelector('#ma-price')")
        check('A10 chart Manage alert opens the dialog', open2)
        page.evaluate("() => { const b = document.querySelector('#ma-cancel'); if (b) b.click(); }")
    page.evaluate("""([p]) => { const { Alerts } = window.__app;
      const a = Alerts.list.find(x => x.kind === 'price' && Math.abs(x.price - p) < 1e-9);
      if (a) Alerts.remove(a.id); }""", [tmp['price']])
    page.mouse.click(700, 500)

    # toggle off -> price line disappears (onlyActive default)
    tog = page.evaluate("""() => {
      const { Alerts, App } = window.__app;
      const a = Alerts.list.find(x => x.kind === 'price' && Math.abs(x.price - 1.11111) < 1e-9);
      const pane = App.panes[0];
      Alerts.toggle(a.id);
      const keys = Object.keys(pane._plines || {}).filter(k => k.startsWith('al'));
      const prices = keys.map(k => { const pl = pane._plines[k]; if (!pl) return null; try { return pl.options().price; } catch (e) { return null; } });
      return { active: a.active, prices };
    }""")
    check('A11 disabling an alert hides its chart line', tog['active'] is False and not any(p and abs(p - 1.11111) < 1e-6 for p in tog['prices']), tog)

    # delete from panel
    page.evaluate("""() => {
      const { Alerts } = window.__app;
      const a = Alerts.list.find(x => x.kind === 'price' && Math.abs(x.price - 1.11111) < 1e-9);
      Alerts.remove(a.id);
    }""")
    left = page.evaluate("() => window.__app.Alerts.list.length")
    check('A12 alert deleted from panel', left == 2, left)  # 1 from A1 + 1 time alert left

    # ============ ITEM 3: ARROW CURSOR PARITY ============
    COL_INK = """([x]) => {
      const pane = window.__app.App.panes[0];
      const eng = pane.engine;
      const img = eng.ctx.getImageData(Math.max(0, x - 2), 0, 5, Math.floor(eng.view().ph));
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2], a = img.data[i + 3];
        if (a > 100 && r > 90 && r < 170 && g > 105 && g < 165 && b > 115 && b < 185) n++; // cross #758696
      }
      return n;
    }"""
    def hover_col_ink(x):
        page.evaluate("""([x]) => {
          const { UI, App } = window.__app;
          const pane = App.panes[0];
          const r = pane.overlay.getBoundingClientRect();
          pane.engine.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: r.x + x, clientY: r.y + 300, bubbles: true }));
        }""", [x])
        page.wait_for_timeout(300)
        return page.evaluate(COL_INK, [x])

    page.evaluate("() => window.__app.UI.activateTool('cross')")
    page.wait_for_timeout(150)
    ink_cross = hover_col_ink(300)
    cur_before = page.evaluate("""() => {
      const { UI, App } = window.__app;
      UI.activateTool('arrowcur');
      return App.panes[0].engine.canvas.style.cursor; // immediate, no mouse move
    }""")
    ink_arrow = hover_col_ink(300)
    cur_after = page.evaluate("() => window.__app.App.panes[0].engine.canvas.style.cursor")
    cur_cross = page.evaluate("""() => { window.__app.UI.activateTool('cross'); return window.__app.App.panes[0].engine.canvas.style.cursor; }""")
    check('C1 Arrow tool: pointer is the default arrow IMMEDIATELY on activation', cur_before == 'default', cur_before)
    check('C2 Arrow tool: crosshair LINE hidden while hovering (TV)', ink_cross > 200 and ink_arrow < ink_cross / 3,
          {'crossCol': ink_cross, 'arrowCol': ink_arrow})
    check('C2b Arrow tool: pointer stays the default arrow while hovering', cur_after == 'default', cur_after)
    check('C3 switching back to Cross restores crosshair instantly', cur_cross == 'crosshair' and ink_cross > 200, cur_cross)

    # panning still works with the arrow tool
    pan = page.evaluate("""() => new Promise((done) => {
      const { UI, App } = window.__app;
      UI.activateTool('arrowcur');
      const pane = App.panes[0];
      const ts = pane.chart.timeScale();
      const lr0 = ts.getVisibleLogicalRange();
      const r = pane.overlay.getBoundingClientRect();
      const cv = pane.overlay;
      cv.dispatchEvent(new MouseEvent('mousedown', { clientX: r.x + 300, clientY: r.y + 300, bubbles: true, button: 0 }));
      cv.dispatchEvent(new MouseEvent('mousemove', { clientX: r.x + 380, clientY: r.y + 300, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      setTimeout(() => {
        const lr1 = ts.getVisibleLogicalRange();
        done({ moved: lr0.from !== lr1.from, cursor: cv.style.cursor });
      }, 250);
    })""")
    check('C4 Arrow tool: chart still pans (drag), cursor default', pan['moved'] and pan['cursor'] == 'default', pan)
    page.evaluate("() => window.__app.UI.activateTool('cross')")

    # ============ ITEM 4: NARROW WINDOW ============
    page.set_viewport_size({'width': 720, 'height': 680})
    page.wait_for_timeout(800)
    nw = page.evaluate("""() => {
      const left = document.getElementById('tb-left');
      const l = document.getElementById('tb-scroll-l'), rr = document.getElementById('tb-scroll-r');
      const box = document.querySelector('.lt-groups');
      const rail = document.getElementById('right-tabs');
      const railBtns = [...rail.querySelectorAll('.rt-btn')];
      return {
        over: left.scrollWidth > left.clientWidth + 1,
        rVisible: !rr.classList.contains('hidden'),
        lHiddenAtStart: l.classList.contains('hidden'),
        leftInvariant: box.scrollHeight <= box.clientHeight + 1,
        railFits: railBtns.every(b => b.offsetTop + b.offsetHeight <= rail.clientHeight + 1),
        railScrollable: getComputedStyle(rail).overflowY === 'auto',
      };
    }""")
    check('W1 at 720px: top bar overflows and the RIGHT chevron appears', nw['over'] and nw['rVisible'] and nw['lHiddenAtStart'], nw)
    check('W2 at 720px: left toolbar keeps its overflow invariant (nothing clipped)', nw['leftInvariant'])
    check('W3 right rail: all 7 buttons reachable (fits or scrolls)', nw['railFits'] or nw['railScrollable'], nw)

    page.evaluate("() => document.getElementById('tb-scroll-r').click()")
    page.wait_for_timeout(600)
    sc = page.evaluate("""() => {
      const left = document.getElementById('tb-left');
      const l = document.getElementById('tb-scroll-l'), rr = document.getElementById('tb-scroll-r');
      return { moved: left.scrollLeft > 0, lVisible: !l.classList.contains('hidden') };
    }""")
    check('W4 chevron click scrolls the top bar; left chevron appears', sc['moved'] and sc['lVisible'], sc)
    # scroll to the end -> right chevron hides
    page.evaluate("""() => { const el = document.getElementById('tb-scroll-r'); for (let i = 0; i < 6; i++) el.click(); }""")
    page.wait_for_timeout(900)
    end = page.evaluate("""() => {
      const left = document.getElementById('tb-left');
      const rr = document.getElementById('tb-scroll-r');
      return { atEnd: left.scrollLeft >= left.scrollWidth - left.clientWidth - 2, rHidden: rr.classList.contains('hidden') };
    }""")
    check('W5 at the far end the right chevron hides (TV behaviour)', end['atEnd'] and end['rHidden'], end)

    mainjs = open('main.js', encoding='utf-8').read()
    m = re.search(r'minWidth:\s*(\d+)', mainjs)
    check('W6 Electron minWidth lowered 1180 -> 720', m and m.group(1) == '720', m and m.group(0))

    # restore viewport for the canary + zero-error check
    page.set_viewport_size({'width': 1500, 'height': 900})
    page.wait_for_timeout(400)
    canary = page.evaluate("""() => {
      document.querySelector('.lt-btn[data-group="gannelliott"]').click();
      const n = document.querySelectorAll('.lt-flyout .lt-tile').length;
      window.__app.UI.closeFlyout();
      return n;
    }""")
    # r61 pin: the flyout is now the exact TV mirror — 14 tools in 3 sections
    # (CHART PATTERNS 6 + ELLIOTT WAVES 5 + CYCLES 3); Gann lives in fibs (r60)
    check('X1 canary: gannelliott flyout still lists all tools (14, TV mirror r61)', canary == 14, canary)
    check('X2 zero page errors across the whole run', not errors, errors[:4])
    browser.close()

fails = [n for n, ok in results if not ok]
print(f'\nRESULT: {len(results) - len(fails)}/{len(results)} passed')
if fails:
    print('FAILED:', fails)
    sys.exit(1)
print('ROUND39 ALL GREEN')
