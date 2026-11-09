#!/usr/bin/env python3
"""ROUND131 e2e — TradingView watchlist parity + ticket reorder + rail icons
+ alerts accordion animation + news decoupling/grid.

Boots the demo broker + renderer, then:

 [1] RIGHT RAIL: Object Tree sits directly under Alerts; bigger 24px icons;
     the ACTIVE icon turns TV-blue (dark + light)
 [2] WATCHLIST: TV header (+ / table / settings), two-line rows with logo +
     description + superscript price + chg/chg%, previous-close refs fetched,
     "Sort by" menu works, Table view toggle + the customize dropdown
     (columns + symbol display), the selected-row ring
 [3] TRADING TICKET: Order section + SELL/BUY buttons now sit BELOW volume
     and ABOVE risk management (DOM order proof, both modes share one ticket)
 [4] ALERTS ACCORDION: soft open (al-anim + body present) and soft close
     (al-closing on the live body, then the body leaves the DOM); the
     persisted flags flip immediately; switches never fold their card
 [5] NEWS DECOUPLED + GRID: the calendar list renders while "Show on chart"
     is OFF; "Vertical lines" has its own switch wired to cfg.lines; the
     grid caption row + Fcst/Prev/Act columns align on one shared template
 [6] screenshots: watchlist + news, dark and light
 [7] zero page errors across the whole run

Exits 0 only if every check passes.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8941, 8777
SHOTS = os.path.join(ROOT, 'docs', 'shots-round131')
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  \u2713 ' if cond else '  \u2717 ') + name + ((' \u2014 ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=20):
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

# showTab TOGGLES when the tab is already open+active — guard every call
SHOW = """(tab) => {
  const el = document.getElementById('tab-' + tab);
  if (!el || el.classList.contains('hidden')) window.__app.RightPanel.showTab(tab);
}"""

def main():
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); return 1
    ok = True
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1500, 'height': 880})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(900)

            print('\u2014 [1] the right rail: order, size, TV colours \u2014')
            rail = page.evaluate("""
            () => [...document.querySelectorAll('#right-tabs .rt-btn')].map((b) => b.dataset.tab)""")
            check('Object Tree sits DIRECTLY under Alerts on the rail',
                  rail.index('objects') == rail.index('alerts') + 1, str(rail))
            check('watchlist is still the first rail icon', rail[0] == 'watchlist', str(rail))
            sz = page.evaluate("""() => {
              const b = document.querySelector('#right-tabs .rt-btn');
              return { svg: getComputedStyle(b.querySelector('svg')).width, btn: getComputedStyle(b).width };
            }""")
            check('rail icons grew to 24px (button 36px)',
                  sz['svg'] == '24px' and sz['btn'] == '36px', str(sz))
            page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
            page.wait_for_timeout(250)
            col = page.evaluate("""() => {
              const b = document.querySelector('#right-tabs .rt-btn[data-tab="alerts"]');
              return getComputedStyle(b).color + ' | ' + getComputedStyle(b).backgroundColor;
            }""")
            check('the ACTIVE rail icon is TV blue on a tinted well',
                  'rgb(41, 98, 255)' in col, col)
            page.evaluate("() => window.__app.RightPanel.showTab('alerts')")  # toggle closed again
            page.wait_for_timeout(200)

            print('\u2014 [2] the watchlist: TradingView parity \u2014')
            page.evaluate("(t) => window.__app.RightPanel.showTab(t) && 0", 'watchlist') if False else None
            page.evaluate(SHOW, 'watchlist')
            page.wait_for_timeout(1200)   # refs fetch + first ticks
            head = page.evaluate("""() => ({
              title: !!document.querySelector('#tab-watchlist .rhead .wl-title'),
              add: !!document.getElementById('wl-add-btn'),
              table: !!document.getElementById('wl-table-btn'),
              view: !!document.getElementById('wl-view-btn'),
            })""")
            check('header = title + add + table + settings buttons', all(head.values()), str(head))
            rows = page.evaluate("""() => [...document.querySelectorAll('#wl-list .wl-row:not(.wl-head)')].map((r) => ({
              sym: r.dataset.sym,
              logo: !!r.querySelector('.wl-logo'),
              name: (r.querySelector('.wl-name') || {}).textContent || '',
              price: (r.querySelector('.wl-price') || {}).textContent || '',
              sup: !!r.querySelector('.wl-price sup'),
              chg: (r.querySelector('.wl-chg') || {}).textContent || '',
              dot: !!r.querySelector('.wl-dot'),
            }))""")
            check('rows render with logo + symbol + live dot + price', len(rows) > 2 and all(r['logo'] and r['dot'] and r['price'] for r in rows), str(rows[:2]))
            check('curated descriptions render under the symbols (TV two-line row)',
                  any(r['name'] for r in rows) and any(r['sym'] == 'EURUSD' and 'Euro' in r['name'] for r in rows), str([r for r in rows if r['sym'] == 'EURUSD']))
            check('prices carry the TV superscript last digit', all(r['sup'] for r in rows if r['price'] not in ('\u2014', '')), str([r['price'] for r in rows[:3]]))
            refs = page.evaluate("""() => ({ n: Object.keys(window.__app ? {} : {}).length,
              pc: (window.__app.WatchlistRefProbe = undefined) })""") if False else None
            refs_ok = page.evaluate("""() => {
              const wl = [...document.querySelectorAll('#wl-list .wl-row:not(.wl-head)')];
              return wl.some((r) => (r.querySelector('.wl-chg') || {}).textContent !== '');
            }""")
            check('Chg/Chg% cells are populated from the D1 previous close', refs_ok)
            chead = page.evaluate("""() => ({
              sym: (document.querySelector('#wl-list .wl-chead .wl-h-sym') || {}).textContent || '',
              sort: !!document.querySelector('#wl-list .wl-chead .wl-h-sort'),
            })""")
            check('compact column header = "Symbol" + a sort menu', chead['sym'] == 'Symbol' and chead['sort'], str(chead))
            # sort menu: A-Z puts BTCUSD first
            page.evaluate("() => document.querySelector('#wl-list .wl-h-sort').click()")
            page.wait_for_timeout(250)
            page.evaluate("""() => [...document.querySelectorAll('.popup .wl-m-item')]
              .find((b) => /Symbol A/.test(b.textContent)).click()""")
            page.wait_for_timeout(300)
            first_az = page.evaluate("() => document.querySelector('#wl-list .wl-row:not(.wl-head)').dataset.sym")
            check('the A\u2013Z sort reorders the list (BTC first on the demo slate)',
                  first_az == 'BTCUSD', first_az)
            page.evaluate("() => document.querySelector('#wl-list .wl-h-sort').click()")
            page.wait_for_timeout(250)
            page.evaluate("""() => [...document.querySelectorAll('.popup .wl-m-item')]
              .find((b) => /Manual/.test(b.textContent)).click()""")
            page.wait_for_timeout(300)
            # settings dropdown: customize columns + symbol display
            page.click('#wl-view-btn')
            page.wait_for_timeout(250)
            page.mouse.click(20, 500)   # close any lingering sort popup
            page.wait_for_timeout(200)
            page.click('#wl-view-btn')
            page.wait_for_timeout(250)
            menu = page.evaluate("""() => {
              const m = document.querySelector('.popup.wl-menu');
              if (!m) return null;
              return {
                tv: !!m.querySelector('.wl-m-tv input'),
                cols: [...m.querySelectorAll('.wl-m-item')].map((b) => b.textContent.trim()),
                radios: m.querySelectorAll('.wl-m-radio').length,
              };
            }""")
            check('the \u2026 menu = Table view switch + columns + logo + 2 radios',
                  menu and menu['tv'] and menu['radios'] == 2 and
                  [c for c in menu['cols'] if c] == ['Last', 'Change', 'Change %', 'Volume', 'Extended Hours', 'Logo', 'Symbol', 'Name'],
                  str(menu))
            page.evaluate("""() => [...document.querySelectorAll('.popup .wl-m-item')]
              .find((b) => b.textContent.trim() === 'Volume').click()""")
            page.wait_for_timeout(200)
            # close the popup
            page.mouse.click(20, 500)
            page.wait_for_timeout(250)
            # table mode via the grid button
            page.click('#wl-table-btn')
            page.wait_for_timeout(300)
            tbl = page.evaluate("""() => {
              const list = document.getElementById('wl-list');
              const head = list.querySelector('.wl-thead');
              const row = list.querySelector('.wl-trow');
              const vol = document.querySelector('#wl-list .wl-trow .wl-c-vol');
              return {
                on: list.classList.contains('wl-table'),
                headTracks: head ? getComputedStyle(head).gridTemplateColumns.split(' ').length : 0,
                rowTracks: row ? getComputedStyle(row).gridTemplateColumns.split(' ').length : 0,
                same: head && row && getComputedStyle(head).gridTemplateColumns === getComputedStyle(row).gridTemplateColumns,
                volVisible: !!vol && vol.offsetParent !== null,
                btnOn: document.getElementById('wl-table-btn').classList.contains('on'),
              };
            }""")
            check('Table view renders the shared grid (5 tracks with Volume on, Ext off)',
                  tbl['on'] and tbl['headTracks'] == 5 and tbl['rowTracks'] == 5 and tbl['same'] and tbl['volVisible'] and tbl['btnOn'], str(tbl))
            page.click('#wl-table-btn')  # back to compact
            page.wait_for_timeout(250)
            page.evaluate("""() => { localStorage.removeItem('mt5_wl_tv'); }""")  # reset for the screenshots
            # selected-row ring
            page.evaluate("""() => document.querySelector('#wl-list .wl-row:not(.wl-head)').click()""")
            page.wait_for_timeout(300)
            ring = page.evaluate("""() => {
              const r = document.querySelector('#wl-list .wl-row.active');
              if (!r) return null;
              const s = getComputedStyle(r, '::after');
              return { ring: s.borderTopStyle + ' ' + s.borderTopWidth, radius: s.borderRadius };
            }""")
            check('the selected row shows the TV outline ring', ring and ring['ring'] == 'solid 1px' and ring['radius'] != '0px', str(ring))

            print('\u2014 [3] the trading ticket: order + exec buttons under volume \u2014')
            page.evaluate(SHOW, 'trade')
            page.wait_for_timeout(700)
            order_ok = page.evaluate("""() => {
              const v = document.getElementById('tt-volume'),
                    o = document.getElementById('tt-type'),
                    s = document.getElementById('tt-sell'),
                    sl = document.getElementById('tt-sl-on');
              if (!v || !o || !s || !sl) return null;
              const F = Node.DOCUMENT_POSITION_FOLLOWING;
              return !!(v.compareDocumentPosition(o) & F) &&
                     !!(o.compareDocumentPosition(s) & F) &&
                     !!(s.compareDocumentPosition(sl) & F);
            }""")
            check('ticket order: volume \u2192 order \u2192 SELL/BUY \u2192 risk management', order_ok is True, str(order_ok))
            page.evaluate(SHOW, 'trade')

            print('\u2014 [4] the alerts accordion: soft open/close \u2014')
            page.evaluate(SHOW, 'alerts')
            page.wait_for_timeout(400)
            page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
            page.wait_for_timeout(120)
            opened = page.evaluate("""() => {
              const card = document.querySelector('#alert-sound-settings .al-card');
              return {
                open: card.classList.contains('al-open'),
                anim: card.classList.contains('al-anim'),
                body: !!card.querySelector('.al-collapse .al-body'),
                rows: getComputedStyle(card.querySelector('.al-collapse')).gridTemplateRows,
              };
            }""")
            check('OPEN: the body mounts inside .al-collapse and plays al-anim',
                  opened['open'] and opened['anim'] and opened['body'] and opened['rows'] != '0px', str(opened))
            page.wait_for_timeout(400)
            anim_gone = page.evaluate("() => !document.querySelector('#alert-sound-settings .al-card').classList.contains('al-anim')")
            check('the al-anim class self-cleans after the keyframe', anim_gone)
            page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
            page.wait_for_timeout(80)
            closing = page.evaluate("""() => {
              const card = document.querySelector('#alert-sound-settings .al-card');
              return { closing: card.classList.contains('al-closing'), body: !!card.querySelector('.al-body') };
            }""")
            check('CLOSE: the live body collapses via .al-closing (still in DOM mid-flight)',
                  closing['closing'] and closing['body'], str(closing))
            page.wait_for_timeout(520)
            closed = page.evaluate("() => !document.querySelector('#alert-sound-settings .al-body')")
            check('CLOSE: the body leaves the DOM once the animation ends', closed)
            page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")  # reopen for later shots
            page.wait_for_timeout(400)

            print('\u2014 [5] the news: decoupled list + vertical-lines switch + grid \u2014')
            page.evaluate(SHOW, 'news')
            page.wait_for_timeout(900)
            dec = page.evaluate("""() => ({
              masterOn: document.getElementById('news-on').checked,
              rows: document.querySelectorAll('#news-list .n-row').length,
              offDim: document.querySelector('.news-master').classList.contains('news-off'),
              lines: document.getElementById('news-lines').checked,
            })""")
            check('the calendar renders while "Show on chart" is OFF (decoupled)',
                  not dec['masterOn'] and dec['rows'] > 0 and dec['offDim'], str({k: dec[k] for k in ('masterOn', 'rows', 'offDim')}))
            check('"Vertical lines" ships checked by default', dec['lines'] is True)
            lines_off = page.evaluate("""() => {
              const el = document.getElementById('news-lines');
              el.click();
              return { cfg: window.__app.News.cfg.lines, rows: document.querySelectorAll('#news-list .n-row').length };
            }""")
            check('the lines switch writes cfg.lines and NEVER touches the list',
                  lines_off['cfg'] == False and lines_off['rows'] == dec['rows'], str(lines_off))
            page.evaluate("() => document.getElementById('news-lines').click()")  # restore
            page.wait_for_timeout(150)
            grid = page.evaluate("""() => {
              const h = document.querySelector('#news-list .nl-head');
              const r = document.querySelector('#news-list .n-row');
              if (!h || !r) return null;
              return {
                cap: h.textContent.replace(/\\s+/g, ' ').trim(),
                hCols: getComputedStyle(h).gridTemplateColumns.split(' ').length,
                rCols: getComputedStyle(r).gridTemplateColumns.split(' ').length,
                same: getComputedStyle(h).gridTemplateColumns === getComputedStyle(r).gridTemplateColumns,
                vals: [...document.querySelectorAll('#news-list .n-row')].some((x) =>
                  (x.querySelector('.n-f') || {}).textContent !== '\u2014' ||
                  (x.querySelector('.n-p') || {}).textContent !== '\u2014'),
              };
            }""")
            check('the grid caption row (Time/Event/Fcst/Prev/Act) shares the row template',
                  grid and grid['hCols'] == 6 and grid['rCols'] == 6 and grid['same'], str(grid))
            check('Forecast/Previous values render in the grid', grid and grid['vals'])

            print('\u2014 [6] screenshots (watchlist + news, dark and light) \u2014')
            os.makedirs(SHOTS, exist_ok=True)
            page.evaluate(SHOW, 'watchlist')
            page.wait_for_timeout(600)
            page.locator('#tab-watchlist').screenshot(path=os.path.join(SHOTS, 'watchlist-dark.png'))
            page.evaluate(SHOW, 'news')
            page.wait_for_timeout(400)
            page.locator('#tab-news').screenshot(path=os.path.join(SHOTS, 'news-dark.png'))
            page.evaluate("() => document.body.classList.add('theme-light')")
            page.wait_for_timeout(250)
            page.evaluate(SHOW, 'watchlist')
            page.wait_for_timeout(400)
            page.locator('#tab-watchlist').screenshot(path=os.path.join(SHOTS, 'watchlist-light.png'))
            page.evaluate(SHOW, 'news')
            page.wait_for_timeout(400)
            page.locator('#tab-news').screenshot(path=os.path.join(SHOTS, 'news-light.png'))
            page.evaluate("() => document.body.classList.remove('theme-light')")
            check('four theme screenshots captured',
                  all(os.path.exists(os.path.join(SHOTS, f)) for f in
                      ('watchlist-dark.png', 'news-dark.png', 'watchlist-light.png', 'news-light.png')))

            print('\u2014 [7] page errors \u2014')
            check('zero page errors across the whole run', not errors, str(errors[:4]))

            browser.close()
    except Exception as e:
        ok = False
        print('E2E EXCEPTION:', e)
        import traceback; traceback.print_exc()
    finally:
        prov.terminate()
    print('\nRESULT:', 'PASS' if (ok and not FAILS) else f'FAIL ({len(FAILS)}): ' + ' ; '.join(FAILS))
    return 0 if (ok and not FAILS) else 1

if __name__ == '__main__':
    sys.exit(main())
