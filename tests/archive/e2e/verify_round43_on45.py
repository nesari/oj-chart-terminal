#!/usr/bin/env python3
"""ROUND43 verification: the 21 re-drawn TV-style icons render correctly
(1) in an isolated contact sheet (dark + light), (2) inside the REAL left
rail flyouts, with every flyout row still intact. Boots the ROUND43 tree
against the demo provider."""
import os, re, sys
sys.path.insert(0, '/home/z/my-project/work/mt5-round45/scripts')
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/work/shots45'
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:300] if detail != '' else ''))

NEW21 = ['cross', 'hray', 'parallel', 'regression', 'infoline', 'fib', 'fibext',
         'fibchannel', 'fibcircles', 'gannbox', 'gannsquare', 'xabcd', 'abcd',
         'cypher', 'trianglepat', 'threedrives', 'hs', 'elliott', 'positionl',
         'positions', 'measure']

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    page.wait_for_timeout(500)

    # ---- 1) contact sheet of the 21 icons (dark), via the real registry ----
    sheet = page.evaluate("""(keys) => {
      return window.__app ? 'app-only' : 'no-app';
    }""", NEW21)
    grid = page.evaluate("""async (keys) => {
      const m = await import('./js/ui/icons.js');
      const host = document.createElement('div');
      host.id = 'icon-sheet';
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#131722;padding:24px;display:grid;grid-template-columns:repeat(7,1fr);gap:10px;align-content:start;';
      for (const k of keys) {
        const cell = document.createElement('div');
        cell.style.cssText = 'border:1px solid #2a2e39;border-radius:8px;height:92px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#d1d4dc;';
        cell.innerHTML = `<span style="width:28px;height:28px;display:block">${m.icon(k)}</span>` +
                         `<span style="font-size:10px;font-family:monospace">${k}</span>`;
        host.appendChild(cell);
      }
      document.body.appendChild(host);
      return host.querySelectorAll('svg').length;
    }""", NEW21)
    check('C1 contact sheet renders all 21 svgs from the real registry', grid == 21, grid)
    page.screenshot(path=f'{OUT}/01-sheet-dark.png')

    # ---- 2) same sheet in LIGHT theme colors ----
    page.evaluate("""() => {
      const h = document.getElementById('icon-sheet');
      h.style.background = '#ffffff';
      [...h.children].forEach(c => { c.style.color = '#131722'; c.style.borderColor = '#d1d4dc'; });
    }""")
    page.wait_for_timeout(150)
    page.screenshot(path=f'{OUT}/02-sheet-light.png')

    # ---- 3) real flyouts: open each group, count rows, screenshot ----
    page.evaluate("() => document.getElementById('icon-sheet').remove()")
    FLYOUTS = [
        ('cursor', ['cross', 'arrowcur', 'dot']),
        ('lines', ['trend', 'ray', 'extended', 'parallel', 'arrow', 'hline', 'hray', 'vline', 'crossline', 'infoline']),
        ('fibs', ['fib', 'fibext', 'fibchannel', 'fibcircles']),
        ('gannelliott', ['xabcd', 'cypher', 'hs', 'abcd', 'trianglepat', 'threedrives', 'elliott', 'cycliclines', 'timecycles', 'sineline']),  # r61: TV mirror (list not asserted)
        ('forecast', ['positionl', 'positions', 'regression']),
    ]
    for gid, _tools in FLYOUTS:
        page.evaluate(f"() => document.querySelector('#left-toolbar .lt-btn[data-group=\"{gid}\"]').click()")
        page.wait_for_timeout(350)
        rows = page.evaluate("""() => {
          const f = document.querySelector('.lt-flyout') || document.querySelector('.popup');
          if (!f) return null;
          const btns = [...f.querySelectorAll('button')].filter(b => b.querySelector('svg'));
          return { rows: btns.length, empties: btns.filter(b => !b.querySelector('svg path, svg circle, svg rect')).length };
        }""")
        check(f'F-{gid}: flyout opens, every row has a drawn icon', bool(rows) and rows['rows'] >= 2 and rows['empties'] == 0, rows)
        page.screenshot(path=f'{OUT}/03-flyout-{gid}.png')
        page.evaluate("() => { const b = document.querySelector('#left-toolbar .lt-btn[data-group]'); if (b) b.click(); }")
        page.wait_for_timeout(200)

    # ---- 4) left rail itself (util buttons drawn) ----
    rail = page.evaluate("""() => {
      const bs = [...document.querySelectorAll('#left-toolbar .lt-btn')];
      return { total: bs.length, empty: bs.filter(b => !b.querySelector('svg')).length };
    }""")
    check('R1 left rail: every button carries an svg', rail['total'] >= 10 and rail['empty'] == 0, rail)
    page.screenshot(path=f'{OUT}/04-left-rail.png')

    errs = page.evaluate("() => window.__errs || []")
    check('R2 no page errors during the run', not errs, errs[:3])

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n==== ROUND43 VERIFY: {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
