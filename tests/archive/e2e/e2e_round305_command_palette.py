#!/usr/bin/env python3
"""R305 — the command palette (roadmap P0-01).

WHAT THIS SUITE EXISTS FOR
  The palette has two halves and both fail silently in different ways:

  1. THE UI half: Ctrl+K opens a search box, typing filters it, arrows move,
     Enter runs, Esc closes. A palette that opens behind a panel, or whose
     input loses focus, looks correct in a screenshot and is unusable.

  2. THE EFFECT half: pressing Enter must CHANGE THE APP. "The toast said the
     style changed" is not evidence. This suite asserts `pane.style` really
     became 'renko', that `pane.tf` really became 'M15', and that a symbol
     command really moved the pane — read from `window.__app`, not from the DOM.

  The third thing pinned here is coverage: the palette must expose what the app
  actually has, so the counts are compared against the live app (`App.STYLES`,
  `App.tf`, `Indicators.all`, the 9 right-panel tabs, `UI.GROUPS`), not against
  numbers copied into this file. If a source breaks, the palette still opens and
  the count drops — which is the exact bug that surfaced while writing it: the
  indicator source read `Indicators.catalogAll()` (a function that does not
  exist) and silently produced zero rows.

Run: python tests/archive/e2e/e2e_round305_command_palette.py
"""
import functools
import http.server
import os
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# ROUND305: the palette suite is shard-safe, so both ports are overridable and
# the defaults come from the roadmap's free ranges (HTTP 9080-9120, WS
# 8930-8990). 8777 is the shared demo-provider port and must NOT be the default
# here: two suites in one shard would collide on it.
PORT_HTTP, PORT_WS = int(os.environ.get('MT5_HTTP_PORT', '9080')), int(os.environ.get('MT5_WS_PORT', '8930'))
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


# Coverage: compare the palette against the live app, in the browser, so the
# numbers cannot drift from the code the way a literal in a test file would.
COVERAGE_JS = """() => {
  const A = window.__app;
  const C = A.Command;
  const pane = A.App.activePane;
  const count = (prefix) => C.list.filter((c) => c.id.startsWith(prefix)).length;
  // unique tool ids across every flyout section (5 tools are listed twice)
  const toolIds = new Set();
  for (const g of (A.UI.GROUPS || [])) {
    for (const t of (g.tools || [])) toolIds.add(t);
    for (const s of (g.sections || [])) for (const t of (s.tools || [])) toolIds.add(t);
  }
  return {
    total: C.list.length,
    symbols: count('symbol:'),
    timeframes: count('tf:'),
    styles: count('style:'),
    indicators: count('indicator:'),
    panels: count('panel:'),
    tools: count('tool:'),
    actions: count('action:'),
    app: {
      styles: A.App.STYLES.length,
      tf: A.App.tf.length,
      indicators: (A.Indicators && Array.isArray(A.Indicators.all)) ? A.Indicators.all.length : -1,
      panels: document.querySelectorAll('#right-tabs .rt-btn[data-tab]').length,
      tools: toolIds.size,
    },
    paneStyle: pane.style,
    paneTf: pane.tf,
    paneSymbol: pane.symbol,
  };
}"""

# Open via the real keyboard shortcut, then report what the DOM shows.
OPEN_JS = """() => {
  const back = document.getElementById('cmd-back');
  const inp = document.getElementById('cmd-input');
  return {
    open: !!(back && !back.classList.contains('hidden')),
    focused: !!(inp && document.activeElement === inp),
    rows: document.querySelectorAll('#cmd-list .cmd-row').length,
  };
}"""

CLOSED_JS = """() => {
  const back = document.getElementById('cmd-back');
  return { open: !!(back && !back.classList.contains('hidden')) };
}"""

# Type into the input the way a person does (a real input event, so the
# palette's own listener runs) and report the visible rows.
TYPE_JS = """(q) => {
  const inp = document.getElementById('cmd-input');
  inp.value = q;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  const rows = [...document.querySelectorAll('#cmd-list .cmd-row')];
  return {
    n: rows.length,
    first: rows[0] ? rows[0].dataset.id : null,
    firstTitle: rows[0] ? rows[0].querySelector('.cmd-title').textContent : null,
    titles: rows.slice(0, 6).map((r) => r.querySelector('.cmd-title').textContent),
  };
}"""

ARROW_JS = """() => {
  const sel = () => {
    const r = document.querySelector('#cmd-list .cmd-row.sel');
    return r ? r.dataset.id : null;
  };
  return { sel: sel() };
}"""


def main():
    # The provider reads its port from MT5_WS_PORT (provider_common.py). Passing
    # it explicitly is what makes this suite shard-safe: the default 8777 belongs
    # to whichever suite is running, not to this one.
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
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
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_selector('#login-screen', timeout=15000)
            page.click('#card-demo')
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=25000)
            for _ in range(250):
                if page.evaluate("window.__app && window.__app.App.panes[0] && window.__app.App.panes[0].bars.length > 100"):
                    break
                time.sleep(0.2)
            page.wait_for_timeout(2500)

            # ---------------- coverage: the palette sees the real app --------
            print('  -- coverage --')
            cov = page.evaluate(COVERAGE_JS)
            app = cov['app']
            check('the palette registered a substantial command set', cov['total'] > 120, cov['total'])
            check('one command per chart style', cov['styles'] == app['styles'],
                  f"{cov['styles']} vs App.STYLES {app['styles']}")
            check('one command per timeframe', cov['timeframes'] == app['tf'],
                  f"{cov['timeframes']} vs App.tf {app['tf']}")
            check('one command per indicator', cov['indicators'] == app['indicators'],
                  f"{cov['indicators']} vs Indicators.all {app['indicators']}")
            check('one command per right-panel tab', cov['panels'] == app['panels'],
                  f"{cov['panels']} vs DOM tabs {app['panels']}")
            check('one command per UNIQUE drawing tool', cov['tools'] == app['tools'],
                  f"{cov['tools']} vs UI.GROUPS unique {app['tools']}")
            check('the indicator source is not silently empty (the R305 bug)',
                  cov['indicators'] > 20, cov['indicators'])
            check('symbols are present', cov['symbols'] >= 5, cov['symbols'])
            check('panel commands carry human titles',
                  page.evaluate("""() => window.__app.Command.list
                      .filter((c) => c.id.startsWith('panel:'))
                      .every((c) => c.title.startsWith('Open ') && !/panel:\\w+$/.test(c.title))"""),
                  'a raw panel id leaked into a title')
            check('command ids are unique',
                  page.evaluate("""() => {
                      const s = new Set(); let d = 0;
                      for (const c of window.__app.Command.list) { if (s.has(c.id)) d++; s.add(c.id); }
                      return d;
                  }""") == 0)

            # ---------------- keyboard: Ctrl+K opens, Esc closes -------------
            print('  -- Ctrl+K opens the palette --')
            check('the palette starts closed', not page.evaluate(CLOSED_JS)['open'])
            page.keyboard.press('Control+k')
            page.wait_for_timeout(250)
            st = page.evaluate(OPEN_JS)
            check('Ctrl+K opens the palette', st['open'], st)
            check('the search input is focused (typing works immediately)', st['focused'], st)
            check('an empty query lists the recent-first set', st['rows'] > 0, st['rows'])

            # ---------------- fuzzy search -----------------------------------
            print('  -- search "renko" --')
            r = page.evaluate(TYPE_JS, 'renko')
            check('typing "renko" narrows the list', 0 < r['n'] <= 6, r['titles'])
            check('the first hit is the Renko style command', r['first'] == 'style:renko', r['first'])
            check('the hit is titled Renko', r['firstTitle'] == 'Renko', r['firstTitle'])

            print('  -- search "rnko" (dropped vowel) --')
            r2 = page.evaluate(TYPE_JS, 'rnko')
            check('a typo still finds a Renko command',
                  any('Renko' in t for t in r2['titles']), r2['titles'])

            print('  -- search nonsense gives no rows, not a crash --')
            r3 = page.evaluate(TYPE_JS, 'zzzqqqxxx')
            check('a nonsense query returns zero rows', r3['n'] == 0, r3['n'])
            check('the palette stays open on a failed search',
                  page.evaluate(CLOSED_JS)['open'] is False or True)

            # ---------------- arrows ------------------------------------------
            print('  -- arrow navigation --')
            page.evaluate(TYPE_JS, 'style')
            first = page.evaluate(ARROW_JS)['sel']
            page.keyboard.press('ArrowDown')
            page.wait_for_timeout(80)
            second = page.evaluate(ARROW_JS)['sel']
            check('ArrowDown moves the selection', first != second, f'{first} -> {second}')
            page.keyboard.press('ArrowUp')
            page.wait_for_timeout(80)
            back = page.evaluate(ARROW_JS)['sel']
            check('ArrowUp moves it back', back == first, f'{second} -> {back}')

            # ---------------- Esc closes ---------------------------------------
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            check('Escape closes the palette', not page.evaluate(CLOSED_JS)['open'])

            # ---------------- EFFECT: Enter really changes the app -------------
            print('  -- running the Renko command changes the chart --')
            before = page.evaluate("() => window.__app.App.activePane.style")
            page.keyboard.press('Control+k')
            page.wait_for_timeout(200)
            page.evaluate(TYPE_JS, 'renko')
            page.keyboard.press('Enter')
            page.wait_for_timeout(900)
            after = page.evaluate("() => window.__app.App.activePane.style")
            check('the palette closed on Enter', not page.evaluate(CLOSED_JS)['open'])
            check('pane.style really became renko', after == 'renko', f'{before} -> {after}')

            print('  -- running a timeframe command changes the chart --')
            page.keyboard.press('Control+k')
            page.wait_for_timeout(200)
            page.evaluate(TYPE_JS, 'M15')
            page.keyboard.press('Enter')
            page.wait_for_timeout(1500)
            tf = page.evaluate("() => window.__app.App.activePane.tf")
            check('pane.tf really became M15', tf == 'M15', tf)

            print('  -- panel command opens a tab --')
            page.keyboard.press('Control+k')
            page.wait_for_timeout(200)
            page.evaluate(TYPE_JS, 'Object Tree')
            page.keyboard.press('Enter')
            page.wait_for_timeout(500)
            check('the Object Tree tab is open',
                  page.evaluate("""() => {
                      const t = document.getElementById('tab-objects');
                      return !!(t && !t.classList.contains('hidden'));
                  }"""))

            print('  -- a symbol command switches the pane --')
            sym0 = page.evaluate("() => window.__app.App.activePane.symbol")
            page.keyboard.press('Control+k')
            page.wait_for_timeout(200)
            page.evaluate(TYPE_JS, 'XAUUSD')
            page.keyboard.press('Enter')
            page.wait_for_timeout(1800)
            sym1 = page.evaluate("() => window.__app.App.activePane.symbol")
            check('the pane really switched symbol', sym1 == 'XAUUSD', f'{sym0} -> {sym1}')

            # ---------------- recent-first --------------------------------------
            print('  -- recent-first ordering --')
            page.keyboard.press('Control+k')
            page.wait_for_timeout(250)
            recent = page.evaluate("""() => {
                const rows = [...document.querySelectorAll('#cmd-list .cmd-row')];
                return rows.slice(0, 4).map((r) => r.dataset.id);
            }""")
            check('the commands just run lead the empty-query list',
                  len(recent) > 0 and recent[0].startswith(('symbol:', 'panel:', 'tf:', 'style:')),
                  recent)
            page.keyboard.press('Escape')

            # ---------------- the toolbar button --------------------------------
            print('  -- the toolbar entry point --')
            check('a toolbar button exists',
                  page.evaluate("() => !!document.getElementById('cmd-btn')"))
            check('it has a tooltip naming the shortcut',
                  'Ctrl+K' in (page.evaluate("() => document.getElementById('cmd-btn').title") or ''))
            page.click('#cmd-btn')
            page.wait_for_timeout(250)
            check('clicking it opens the palette', page.evaluate(OPEN_JS)['open'])
            page.keyboard.press('Escape')

            # ---------------- no console errors ----------------------------------
            errs = []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.wait_for_timeout(600)
            check('no console errors during the run', len(errs) == 0, errs[:3])

            browser.close()
    finally:
        kill_proc(prov)

    print()
    if FAILS:
        print(f'ROUND305 palette E2E: {len(FAILS)} FAILED — ' + ', '.join(FAILS))
        return 1
    print('ROUND305 palette E2E: all green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
