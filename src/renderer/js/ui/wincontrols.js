/**
 * ROUND125 (user request) — the frameless TradingView-Desktop window shell.
 *
 * The OS title bar is GONE (main.js boots every window with frame:false, the
 * detached ones included): the app name bar the user used to see above the
 * tabs no longer exists. The tab strip is now the TOPMOST bar of the window,
 * and — exactly like TradingView Desktop for Windows —
 *
 *   · its EMPTY area is the window drag surface (double-click there toggles
 *     maximize, native frameless behaviour of any -webkit-app-region: drag
 *     area — no code needed),
 *   · its right end carries the integrated window buttons:
 *       Minimize · Maximize/Restore · Close.
 *
 * This module only WIRES the buttons (index.html ships the markup in two
 * places: #win-controls inside #tab-strip and the slim #login-titlebar that
 * covers the window before / during login, where no strip exists yet).
 * Every call is routed by main.js to the SENDING window, so the host and
 * each detached (solo) window control themselves — a solo closing itself
 * just docks nothing and goes away, Chrome-style.
 *
 * The maximize button flips between the maximize and restore glyphs through
 * the 'win:max-state' push channel + a boot-time isMax() read; the state is
 * mirrored on <body> as .is-max so CSS picks the glyph in BOTH bars.
 *
 * No window.mt5Win (plain-browser test harness / http shell) → silent no-op,
 * the buttons simply do nothing there.
 */

function wire(root) {
  const min = root.querySelector('.wc-min');
  const max = root.querySelector('.wc-max');
  const close = root.querySelector('.wc-close');
  if (min) min.addEventListener('click', () => { try { window.mt5Win.minimize(); } catch (e) {} });
  if (max) max.addEventListener('click', () => { try { window.mt5Win.maxToggle(); } catch (e) {} });
  if (close) close.addEventListener('click', () => { try { window.mt5Win.close(); } catch (e) {} });
}

const WinControls = {
  init() {
    /* F6.1: macOS boots with native traffic lights (main.js windowChrome),
       so the custom Windows-style buttons are hidden by CSS (.mac) and the
       strip reserves room for the lights on the left. */
    try {
      if (/Macintosh|Mac OS X/.test(navigator.userAgent || '')) document.documentElement.classList.add('mac');
    } catch (e) {}
    if (!window.mt5Win) return; // test harness / no preload — keep the OS frame behaviour
    document.querySelectorAll('.win-controls').forEach(wire);

    /* maximize ⇄ restore glyph: push channel + one boot read (the push may
       have fired before this line when Windows restores a maximized session) */
    const apply = (m) => { try { document.body.classList.toggle('is-max', !!m); } catch (e) {} };
    window.mt5Win.onMaxState(apply);
    try {
      window.mt5Win.isMax()
        .then((r) => { apply(!!(r && r.max)); })
        .catch(() => {});
    } catch (e) {}
  },
};

export { WinControls };
