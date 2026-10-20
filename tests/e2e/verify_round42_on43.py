#!/usr/bin/env python3
"""ROUND42 verification: the timezone menu (tz-btn popup) now
(1) shows each zone's UTC offset right-aligned on its row,
(2) is 250px wide (was 330px) with no clipped / overflowing rows.
Boots the app from THIS work copy against the demo provider."""
import os, re, sys
sys.path.insert(0, '/home/z/my-project/work/mt5-round43/scripts')
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/work/shots43-r42'
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:400] if detail != '' else ''))

OFF_RE = re.compile(r'^UTC[+-]\d{2}:\d{2}$')

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    page.wait_for_timeout(600)

    # ---- open the timezone menu (same trigger as the user's window) ----
    page.click('#tz-btn')
    page.wait_for_selector('.popup', timeout=5000)
    page.wait_for_timeout(300)

    # ================= T1: width 250px =================
    w = page.evaluate("""() => {
      const p = document.querySelector('.popup');
      return { cw: p.clientWidth, style: p.style.width, sw: p.scrollWidth,
               box: p.getBoundingClientRect().width };
    }""")
    check('T1 popup width is 250px (was 330px)',
          w['style'] == '250px' and abs(w['box'] - 250) <= 1 and w['sw'] <= w['cw'], w)

    # ================= T2: every row carries a UTC offset =================
    rows = page.evaluate("""() => [...document.querySelectorAll('.popup .pu-item')].map(it => ({
      label: it.querySelector('span').textContent.trim(),
      last: it.lastElementChild ? it.lastElementChild.textContent.trim() : '',
      overflow: it.scrollWidth > it.clientWidth,
    }))""")
    expect_zones = page.evaluate("() => window.__app.TZ ? window.__app.TZ.sortedZones().length : null") \
        or page.evaluate("""() => {
          /* TZ not exposed? fall back: count rows rendered */
          return document.querySelectorAll('.popup .pu-item').length;
        }""")
    all_off = all(OFF_RE.match(r['last']) for r in rows)
    no_clip = not any(r['overflow'] for r in rows)
    check('T2 EVERY row shows a right-aligned "UTC±HH:MM" offset',
          len(rows) > 90 and all_off, f"rows={len(rows)} bad={[r for r in rows if not OFF_RE.match(r['last'])][:4]}")
    check('T2-2 no row overflows / clips at 250px', no_clip,
          [r for r in rows if r['overflow']][:4])

    # ================= T3: spot-check known offsets (Sept 2026) =================
    def off_of(label):
        for r in rows:
            if r['label'] == label:
                return r['last']
        return None
    tehran = off_of('Asia/Tehran')
    kath   = off_of('Asia/Kathmandu')
    hono   = off_of('Pacific/Honolulu')
    utc0   = off_of('UTC')
    nyse   = off_of('America/New York')
    chath  = off_of('Pacific/Chatham')
    check('T3 Tehran = UTC+03:30 (Iran has no DST since 2022)', tehran == 'UTC+03:30', tehran)
    check('T3 Kathmandu = UTC+05:45', kath == 'UTC+05:45', kath)
    check('T3 Honolulu = UTC-10:00', hono == 'UTC-10:00', hono)
    check('T3 New York = UTC-04:00 (September = EDT)', nyse == 'UTC-04:00', nyse)
    check('T3 Chatham = UTC+12:45 (before NZ DST switch)', chath == 'UTC+12:45', chath)
    check('T3 the "UTC" row itself = UTC+00:00', utc0 == 'UTC+00:00', utc0)

    # broker row = live server offset from the feed (same source as the button label)
    broker = page.evaluate("""() => {
      const off = (window.__app.App.feed && window.__app.App.feed.serverOff) || 0;
      const m = Math.round(off / 60);
      const a = Math.abs(m);
      const s = 'UTC' + (m < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
      const row = [...document.querySelectorAll('.popup .pu-item')]
        .find(it => it.textContent.indexOf('Broker time (auto)') >= 0);
      return { want: s, got: row && row.lastElementChild ? row.lastElementChild.textContent.trim() : null };
    }""")
    check('T3 broker row = live server offset (same as shortLabel)',
          broker['want'] == broker['got'], broker)
    page.screenshot(path=f'{OUT}/01-tz-menu-offsets.png')

    # ================= T4: search still filters (regression) =================
    page.fill('.popup input.al-search', 'Teh')
    page.wait_for_timeout(300)
    rows2 = page.evaluate("""() => [...document.querySelectorAll('.popup .pu-item')].map(it => ({
      label: it.querySelector('span').textContent.trim(),
      last: it.lastElementChild ? it.lastElementChild.textContent.trim() : '',
    }))""")
    check('T4 search "Teh" -> only Tehran, offset still shown',
          len(rows2) == 1 and rows2[0]['label'] == 'Asia/Tehran' and rows2[0]['last'] == 'UTC+03:30', rows2)
    page.screenshot(path=f'{OUT}/02-tz-search-filtered.png')

    # ================= T5: selection still applies (regression) =================
    page.click('.popup .pu-item')
    page.wait_for_timeout(400)
    label = page.evaluate("() => (document.getElementById('tz-label')||{}).textContent || ''")
    check('T5 clicking a zone still applies it (bottom-bar label = Tehran)', label == 'Tehran', label)

    # switch back to broker so later expectations stay unchanged
    page.click('#tz-btn')
    page.wait_for_selector('.popup', timeout=5000)
    page.evaluate("""() => {
      const row = [...document.querySelectorAll('.popup .pu-item')]
        .find(it => it.textContent.indexOf('Broker time (auto)') >= 0);
      row.click();
    }""")
    page.wait_for_timeout(300)

    # ================= R: no page errors =================
    errs = page.evaluate("() => window.__errs || []")
    check('R1 no page errors during the run', not errs, errs[:3])

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n==== ROUND42 VERIFY: {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
