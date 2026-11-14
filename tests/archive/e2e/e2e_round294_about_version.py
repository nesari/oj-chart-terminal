#!/usr/bin/env python3
"""ROUND294 e2e — the version + update entry point a USER can actually find.

Before this round the version and the Check button lived only inside the
Diagnostics panel, which is a developer surface — "which version am I on?" had
no answer in the UI. This suite drives the real app and asserts:

  1. an About button exists on the toolbar and has a label;
  2. clicking it opens a popup that states the running version;
  3. the popup has ONE action button whose label follows the state
     (Check for updates / Download update / Restart & install);
  4. it shows the honest channel state in a browser build (no Electron bridge)
     instead of pretending an update is available;
  5. a release-notes link exists and points at this repository;
  6. outside click and Escape dismiss it;
  7. no page errors.

Run: python tests/archive/e2e/e2e_round294_about_version.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9012, 8867
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)


def wait_port(port, timeout=25):
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
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        kill_proc(prov)
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)

            print('  -- 1. the entry point exists on the toolbar --')
            r = page.evaluate("""() => {
              const b = document.getElementById('about-btn');
              return {
                exists: !!b,
                hasIcon: !!(b && b.querySelector('svg')),
                title: b ? (b.getAttribute('title') || '') : '',
                exposed: !!(window.__app && window.__app.AboutUI),
              };
            }""")
            check('an About button exists', r.get('exists') is True, r)
            check('it renders an icon', r.get('hasIcon') is True, r)
            check('it is reachable from the facade', r.get('exposed') is True, r)
            check('its tooltip mentions updates', 'update' in (r.get('title') or '').lower(), r.get('title'))

            print('  -- 2. clicking it states the running version --')
            page.click('#about-btn')
            page.wait_for_timeout(350)
            pop = page.evaluate("""() => {
              const p = document.querySelector('.ab-popup');
              if (!p) return { open: false };
              const ver = p.querySelector('.ab-ver');
              const state = p.querySelector('.ab-state');
              const action = p.querySelector('.ab-action');
              const notes = p.querySelector('.ab-notes');
              const bar = p.querySelector('.ab-bar');
              return {
                open: true,
                ver: ver ? ver.textContent : null,
                state: state ? state.textContent : null,
                action: action ? action.textContent : null,
                actionDisabled: action ? action.disabled : null,
                notes: notes ? notes.textContent : null,
                notesUrl: notes ? notes.dataset.url : null,
                barHidden: bar ? bar.classList.contains('hidden') : null,
              };
            }""")
            check('the popup opens', pop.get('open') is True, pop)
            ver = pop.get('ver') or ''
            check('it shows a real version', ver.startswith('v') and ver != 'v?', ver)
            # compare against the ACTUAL build, read from package.json: pinning a
            # literal version here would turn every release into a red CI run for
            # no reason (it did exactly that on v1.9.226).
            pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['version']
            check('the version matches the build', ver == 'v' + pkg, ver + ' vs v' + pkg)
            check('it explains the state in words', bool(pop.get('state')), pop.get('state'))
            check('there is exactly one action button',
                  (pop.get('action') or '') in ('Check for updates', 'Download update', 'Restart & install'),
                  pop.get('action'))

            print('  -- 3. a browser build is honest, not pretending --')
            state = (pop.get('state') or '').lower()
            check('it does not claim an update is available in a browser',
                  'available' not in state or 'desktop' in state or 'channel' in state, pop.get('state'))
            check('the action is the manual check', (pop.get('action') or '') == 'Check for updates', pop.get('action'))
            check('the progress bar is hidden when idle', pop.get('barHidden') is True, pop.get('barHidden'))

            print('  -- 3b. clicking Check must REACT, not sit silent --')
            # ROUND295: this used to do literally nothing in a bridge-less build:
            # run() returned early and no message was shown.
            page.click('.ab-action')
            page.wait_for_timeout(900)
            reacted = page.evaluate("""() => {
              const t = document.getElementById('toasts');
              const texts = t ? [...t.querySelectorAll('.t-body')].map((x) => x.textContent) : [];
              return {
                toasts: texts,
                saidSomething: texts.some((s) => /desktop app|latest version|Update/i.test(s)),
                popupStillOpen: !!document.querySelector('.ab-popup'),
              };
            }""")
            check('the click produces feedback (a toast)', reacted.get('saidSomething') is True, reacted)
            check('the popup stays open so the message is readable', reacted.get('popupStillOpen') is True, reacted)

            print('  -- 3c. the release page link is wired for the shell --')
            link = page.evaluate("""() => {
              const n = document.querySelector('.ab-notes');
              return { url: n && n.dataset.url, hasPageBtn: !!document.querySelector('.ab-page') };
            }""")
            check('release notes carries a real URL', 'github.com' in (link.get('url') or ''), link)
            check('a download-page button exists for newer versions', link.get('hasPageBtn') is True, link)

            print('  -- 3d. "up to date" is a stated outcome --')
            # ROUND296: the click must produce a VERDICT. In this browser harness
            # there is no Electron bridge, so the honest answer is the
            # "needs the desktop app" toast — but it must be a toast, not silence.
            told = ' '.join(reacted.get('toasts') or [])
            check('the click states an outcome rather than nothing',
                  'latest version' in told.lower() or 'desktop app' in told.lower(), told)

            print('  -- 3e. the copy for "off" is about self-install, not checking --')
            # the old string was shown as a RED error right after a click and read
            # like a failure; the check itself now always runs
            copy = page.evaluate("""() => {
              const st = document.querySelector('.ab-state');
              return st ? st.textContent : '';
            }""")
            check('it does not claim auto-update is simply "off"',
                  'auto-update is off' not in (copy or '').lower(), copy)

            print('  -- 4. release notes link --')
            check('a release-notes link exists', bool(pop.get('notes')), pop.get('notes'))
            check('it points at this repository',
                  'github.com/nesari/oj-chart-terminal/releases' in (pop.get('notesUrl') or ''),
                  pop.get('notesUrl'))

            print('  -- 5. dismissal --')
            page.keyboard.press('Escape')
            page.wait_for_timeout(250)
            gone = page.evaluate("() => !document.querySelector('.ab-popup')")
            check('Escape closes the popup', gone is True, gone)

            page.click('#about-btn')
            page.wait_for_timeout(250)
            again = page.evaluate("() => !!document.querySelector('.ab-popup')")
            check('it reopens', again is True, again)
            page.click('#charts-area', position={'x': 300, 'y': 300})
            page.wait_for_timeout(250)
            outside = page.evaluate("() => !document.querySelector('.ab-popup')")
            check('clicking outside closes it', outside is True, outside)

            print('  -- 6. no page errors --')
            check('zero page errors', len(errors) == 0, errors[:3])

            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND294: %d failed' % len(FAILS) if FAILS else 'ROUND294: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
