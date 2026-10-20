/**
 * ROUND122 — TV-style live tab labels + Chrome-style tab undock/dock-back:
 *   · every tab shows SYMBOL + live price + ▲/▼ + session change % (TV tab)
 *   · prices ride the Watchlist tick seam (App.onTickHooks); each tab holds
 *     ONE ref-counted feed sub for its first pane symbol, reconciled on a
 *     1.2s diff (Manager.acquireSub/releaseSub — the BUG-013 bookkeeping)
 *   · session baseline = previous DAILY close via one D1 bars_req / 5 min;
 *     the "is the newest bar today?" test runs in broker-wall time (serverOff)
 *   · dragging a tab below the strip / out of the window UNDOCKS it into its
 *     own OS window (main.js 'tabs:undock' -> index.html#solo=<id>); dropping
 *     the last tab out closes the source window (Chrome)
 *   · detached (solo) windows: own strip + persistence key (mt5_tab_solo_<id>),
 *     NO trade stack (shared demo ledger), provider attached by identity
 *     (never restarted), dock-back via handoff keys + ack, self-promotion
 *     when no host window is left (Chrome: last window standing)
 *
 * Source contracts + small behavioral mirrors, the same style as the
 * round-102..121 suites.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const tabs = read('src/renderer/js/chart/tabs.js');
const app = read('src/renderer/js/app.js');
const login = read('src/renderer/js/ui/login.js');
const main = read('main.js');
const preload = read('preload.js');
const icons = read('src/renderer/js/ui/icons.js');
const html = read('src/renderer/index.html');
const css = read('src/renderer/css/app.css');
/* comments may mention APIs; behavioural scans run on code only */
const code = tabs.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND122 · live TV-style labels —');
check('tab labels ride the Watchlist tick seam (App.onTickHooks, arrow-wrapped receiver — ROUND123 fix)',
  /\(App\.onTickHooks = App\.onTickHooks \|\| \[\]\)\.push\(\(symbol, price\) => Tabs\.onTick\(symbol, price\)\);/.test(code) &&
  !/push\(Tabs\.onTick\);/.test(code));
check('onTick never dereferences `this` (hooks are invoked receiver-less by the feed)',
  /onTick\(symbol, price\) \{[\s\S]*?const prev = Tabs\.q\[symbol\];[\s\S]*?Tabs\.q\[symbol\] = \{ price, dir, at: Date\.now\(\) \};/.test(tabs));
check('each tab holds ONE ref-counted label sub (Manager.acquireSub/releaseSub diff)',
  /_reconcileSubs\(\) \{[\s\S]*?Manager\.releaseSub\(sym\);[\s\S]*?Manager\.acquireSub\(sym\);/.test(tabs));
check('label subs reconcile the FIRST pane symbol of every tab (inactive tabs tick too)',
  /_reconcileSubs\(\) \{[\s\S]*?for \(const t of this\.list\) \{[\s\S]*?const panes = this\.panesOf\(t\);[\s\S]*?const sym = panes\[0\] && panes\[0\]\.symbol;/.test(tabs));
check('session baseline = previous DAILY close via one D1 bars_req per symbol',
  /App\.feed\.bars\(sym, 'D1', 4\)/.test(tabs));
check('the newest D1 bar is "today" only in broker-wall time (feed.serverOff)',
  /_refreshBases\(\) \{[\s\S]*?const off = Math\.round\(Number\(App\.feed\.serverOff\) \|\| 0\);[\s\S]*?const nowDay = Math\.floor\(\(Date\.now\(\) \/ 1000 \+ off\) \/ 86400\);[\s\S]*?const lastDay = Math\.floor\(\(last\.time \+ off\) \/ 86400\);[\s\S]*?b = lastDay >= nowDay \? bars\[bars\.length - 2\]\.close : last\.close;/.test(tabs));
check('prices format through the central priceDigits helper (provider digits win)',
  /import \{ priceDigits \} from '\.\.\/\.\.\/\.\.\/core\/feed\.js';/.test(tabs) &&
  /U\.fmtPrice\(qq\.price, priceDigits\(sym\)\)/.test(tabs));
check('quote painter: text writes ONLY on real changes + qsym reset on symbol change',
  /_paintQuotes\(\) \{[\s\S]*?if \(el\.dataset\.qsym !== sym\) \{[\s\S]*?\}[\s\S]*?if \(pxEl\.textContent !== ps\) \{[\s\S]*?void pxEl\.offsetWidth;/.test(tabs));
check('tab label carries the ▲/▼ arrow + signed change %',
  /\\u25B2 \+'|'\\u25BC -'/.test(tabs) || /\\u25B2/.test(tabs));
check('every rendered tab has .t-quote with .t-px + .t-chg cells',
  /const quote = U\.el\('span', 't-quote', el\);/.test(tabs) &&
  /U\.el\('span', 't-px', quote\)/.test(tabs) && /U\.el\('span', 't-chg', quote\)/.test(tabs));
check('quote + change colors come from the theme vars (--green/--red), tabular numerals',
  /\.t-px\.up \{ color: var\(--green\);/.test(css) && /\.t-px\.down \{ color: var\(--red\);/.test(css) &&
  /\.t-chg\.up \{ color: var\(--green\); \}/.test(css) && /font-variant-numeric: tabular-nums;/.test(css));

console.log('— ROUND122 · undock (host -> detached window) —');
check('drag-out: tab dragged BELOW the strip (+36px) or ABOVE it undocks (capture phase)',
  /document\.addEventListener\('dragover', \(e\) => \{[\s\S]*?if \(e\.clientY > r\.bottom \+ 36 \|\| e\.clientY < r\.top - 8\) \{[\s\S]*?this\.undockTab\(id\);/.test(tabs));
check('drag-out: leaving the WINDOW entirely undocks (dragleave, relatedTarget null)',
  /document\.addEventListener\('dragleave', \(e\) => \{[\s\S]*?if \(!this\._dragId \|\| e\.relatedTarget\) return;[\s\S]*?this\.undockTab\(id\);/.test(tabs));
check('undock gestures are HOST-only (a solo never re-detaches onto itself)',
  /if \(!SOLO_ID && window\.mt5Tabs && window\.mt5Tabs\.undock\) \{/.test(tabs) &&
  /if \(SOLO_ID != null\) return; \/\/ a solo never re-detaches onto itself/.test(tabs));
check('undockTab hands the LIVE record through its own mt5_tab_solo_<id> key',
  /U\.lsSet\('mt5_tab_solo_' \+ soloId, \{ v: K\.v, tabs: \[rec\], active: rec\.id, ts: Date\.now\(\) \}\);/.test(tabs));
check('the source tab is removed only AFTER the window exists — full rollback on failure',
  /let r = null;[\s\S]*?await window\.mt5Tabs\.undock\(\{ soloId, mode, rec \}\);[\s\S]*?if \(!r \|\| !r\.ok\) \{[\s\S]*?this\.list\.splice\(idx, 0, rec\);[\s\S]*?this\._persist\(\);[\s\S]*?this\.render\(\);/.test(tabs));
check('Chrome parity: undocking the LAST tab closes the source window',
  /if \(!this\.list\.length\) \{[\s\S]*?U\.lsSet\(K\.key, \{ v: K\.v, tabs: \[\], active: null \}\);[\s\S]*?window\.close\(\);/.test(tabs));
check('undocked geometry comes from the SOURCE window (never renderer-supplied)',
  /const src = BrowserWindow\.fromWebContents\(e\.sender\);/.test(main) &&
  /const b = \(src && !src\.isDestroyed\(\)\) \? src\.getBounds\(\) :/.test(main));
check('main opens the solo window as index.html#solo=<id> with the SAME data mode',
  /win\.loadFile\(path\.join\(__dirname, 'src', 'renderer', 'index\.html'\),[\s\S]*?\{ search: 'mode=' \+ mode, hash: 'solo=' \+ soloId \}\);/.test(main));
check('solo windows inherit the round-28 security posture (secureWindow shared)',
  /function secureWindow\(win\) \{/.test(main) && /secureWindow\(mainWindow\);/.test(main) && /secureWindow\(win\);/.test(main) &&
  /setWindowOpenHandler/.test(main) && /will-navigate/.test(main));
check('IPC payloads are validated (soloId shape + length, mode whitelist)',
  /if \(!\/\^\(\[\\w-\]\+\)\$\/\.test\(soloId\)\) \{ badPayload\('tabs:undock'/.test(main) &&
  /badPayload\('tabs:dockback'/.test(main) && /badPayload\('tabs:dock-ack'/.test(main));

console.log('— ROUND122 · detached (solo) window mode —');
check('solo mode parses #solo=<id>; the strip persists to mt5_tab_solo_<id> (never mt5_tabs)',
  /const SOLO_ID = \(\(\) => \{[\s\S]*?\/solo=\(\[\\w-\]\+\)\/\.exec\(location\.hash \|\| ''\)/.test(tabs) &&
  /const STORE_KEY = SOLO_ID \? 'mt5_tab_solo_' \+ SOLO_ID : K\.key;/.test(tabs));
check('a detached window with a lost handoff key ADOPTS the live chart (never blank)',
  /this\.list = \[this\._adoptRec\(\)\];/.test(tabs));
check('ROUND124: detached windows boot the chart-side FLOAT trade panel (solo branch)',
  /const SOLO_MODE = \/solo=\[\\w-\]\+\/\.test\(location\.hash \|\| ''\);/.test(app) &&
  /\} else \{[\s\S]*?Trade\.init\(\);\s*\n\s*TradeOverlay\.init\(\);\s*\n\s*OneClick\.init\(\);\s*\n\s*ReplayTrade\.init\(\);[\s\S]*?TradeRoute\.init\(\);[\s\S]*?\n    \}/.test(app) &&
  /ReplayTrade\.init\(\);[\s\S]*?TradeRoute\.setDemoDelegate\(ReplayTrade\);/.test(app));
check('solo right-panel falls back to watchlist when the saved tab was trade',
  /const effTab = SOLO_MODE && savedTab === 'trade' \? 'watchlist' : savedTab;/.test(app));
check('body.solo hides the Trading rail button (right-panel tab stays host-only)',
  /body\.solo #right-tabs \.rt-btn\[data-tab="trade"\] \{ display: none; \}/.test(css));
check('solo auto-login attaches to the RUNNING provider identity (never a restart)',
  /if \(window\.mt5Tabs && window\.mt5Tabs\.providerIdentity\) id = await window\.mt5Tabs\.providerIdentity\(\);/.test(login) &&
  /a = ACC\.accounts\.find\(\(z\) => z\.mode === 'mt5' && String\(z\.login\) === String\(id\.login\)/.test(login));
check('solo demo identity synthesizes the demo account (no restart either)',
  /\} else if \(id && id\.mode === 'demo'\) \{[\s\S]*?a = \{ mode: 'demo', login: '', server: '', path: '', pw: '' \};/.test(login));
check('no resolvable identity -> the login screen stays (manual credentials)',
  /if \(!a\) return; \/\/ login screen stays for manual credentials/.test(login));
check('server re-point (provider restart) is BLOCKED in a solo window',
  /window\.addEventListener\('mt5-switch-server', \(e\) => \{[\s\S]*?if \(SOLO\) return;/.test(login));
check('solo account menu: no add / logout / forget rows (account stays the host\u2019s)',
  /if \(!SOLO\) menu\.appendChild\(add\);/.test(login) &&
  /if \(!SOLO\) menu\.appendChild\(logout\);/.test(login) &&
  /if \(!SOLO\) menu\.appendChild\(forget\);/.test(login));

console.log('— ROUND122 · dock-back (solo -> host) —');
check('dockbackTab sends the record INSIDE the dockback payload + dims the tab (ROUND123: IPC, not localStorage)',
  /window\.mt5Tabs\.dockback\(\{ soloId: SOLO_ID, rec: copy \}\)/.test(tabs) &&
  !/U\.lsSet\('mt5_tab_dockback_'/
    .test(tabs) &&
  /rec\._docking = true;/.test(tabs) && /\.tab-item\.docking \{ opacity: \.4; pointer-events: none; \}/.test(css));
check('no host window standing -> the solo PROMOTES itself (mt5_tabs + hash cleared + reload)',
  /U\.lsSet\(K\.key, \{ v: K\.v, tabs: remain, active: rec\.id \}\);[\s\S]*?localStorage\.removeItem\(STORE_KEY\);[\s\S]*?location\.hash = '';[\s\S]*?setTimeout\(\(\) => location\.reload\(\), 30\);/.test(tabs));
check('dock-back requests time out (5s) — the tab un-dims and stays',
  /this\._dockTO = setTimeout\(\(\) => \{[\s\S]*?delete t\._docking;[\s\S]*?\}, 5000\);/.test(tabs));
check('the host absorbs the record from the REQUEST PAYLOAD, activates it, acks (ROUND123)',
  /_acceptDock\(p\) \{[\s\S]*?const rec = \(p && p\.rec && validRec\(p\.rec\)\) \? p\.rec : null;[\s\S]*?this\.activeId = rec\.id;[\s\S]*?await window\.mt5Tabs\.dockAck\(\{ soloId, ids: \[rec\.id\] \}\);/.test(tabs));
check('the solo drops its copy ONLY on the ack; empty strip closes the window (Chrome)',
  /_onDockAck\(p\) \{[\s\S]*?if \(i >= 0\) this\.list\.splice\(i, 1\);[\s\S]*?if \(!this\.list\.length\) \{[\s\S]*?window\.close\(\);/.test(tabs));
check('main routes dockback (with the record) to the host strip and acks back to the solo by id',
  /host\.webContents\.send\('tabs:dock-request', \{ soloId, rec \}\);/.test(main) &&
  /const win = soloWins\.get\(soloId\);[\s\S]*?win\.webContents\.send\('tabs:dock-ack', \{ soloId,/.test(main));
check('main reports no-host so the solo can promote (never a silent tab loss)',
  /return \{ ok: false, error: 'no-host' \};/.test(main));
check('context menu: host gets "Move to new window", solo gets "Move to main window" + "Close window"',
  /\['Move to new window', \(\) => this\.undockTab\(id\)\]/.test(tabs) &&
  /\['Move to main window', \(\) => this\.dockbackTab\(id\)\]/.test(tabs) &&
  /\['Close window', \(\) => \{ try \{ localStorage\.removeItem\(STORE_KEY\); \} catch \(e\) \{\} window\.close\(\); \}\]/.test(tabs));
check('closing the LAST tab of a solo window closes the window (fallback keeps the grid alive)',
  /if \(!this\.list\.length && SOLO_ID && window\.close\) \{[\s\S]*?window\.close\(\);[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?if \(window\.closed\) return;/.test(tabs));
check('solo strip shows the dock-back button (icon dock), hidden in the host',
  /dockBtn\.innerHTML = icon\('dock'\);/.test(tabs) && /body\.solo \.tab-dock \{ display: flex; \}/.test(css) &&
  /<button class="tab-dock" id="tab-dock-btn"/.test(html));
check('preload exposes the mt5Tabs bridge (renderer stays sandboxed)',
  /exposeInMainWorld\('mt5Tabs', \{[\s\S]*?undock:[\s\S]*?claimTab:[\s\S]*?dockback:[\s\S]*?dockAck:[\s\S]*?providerIdentity:[\s\S]*?onDockRequest:[\s\S]*?onDockAck:[\s\S]*?\}\);/.test(preload));
check('icons: undock + dock added additively',
  /undock: S\(/.test(icons) && /dock: S\(/.test(icons));

console.log('— ROUND122 · behavioral mirrors —');
/* mirror of the baseline day-boundary rule */
{
  const off = 3 * 3600; // broker wall = UTC+3
  const bars = [
    { time: 1758624000, close: 2640.5 },  // two days ago
    { time: 1758710400, close: 2655.0 },  // yesterday (completed)
    { time: 1758796800, close: 2661.2 },  // today (forming)
  ];
  const baselineFor = (lastBarList, nowSec) => {
    const last = lastBarList[lastBarList.length - 1];
    const nowDay = Math.floor((nowSec + off) / 86400);
    const lastDay = Math.floor((last.time + off) / 86400);
    return lastDay >= nowDay ? lastBarList[lastBarList.length - 2].close : last.close;
  };
  const nowSameDay = bars[2].time + 3600; // still "today" in broker wall
  const nowNextDay = bars[2].time + 86400 * 2; // two days later: bar 3 completed
  check('mirror: forming daily bar -> baseline is the PREVIOUS close (2655)',
    baselineFor(bars, nowSameDay) === 2655.0);
  check('mirror: completed last bar (market closed for days) -> baseline is THAT close (2661.2)',
    baselineFor(bars, nowNextDay) === 2661.2);
}
/* mirror of the change label text */
{
  const fmt = (price, base) => {
    const pct = ((price - base) / base) * 100;
    return (pct >= 0 ? '\u25B2 +' : '\u25BC -') + Math.abs(pct).toFixed(2) + '%';
  };
  check('mirror: ▲ +x.xx% above the baseline, ▼ -x.xx% below it',
    fmt(2670, 2655) === '\u25B2 +0.56%' && fmt(2600, 2655) === '\u25BC -2.07%');
}
/* mirror of the label-sub reconciler diff */
{
  function reconcile(held, want, log) {
    for (const sym of Object.keys(held)) {
      if (!want.has(sym)) { delete held[sym]; log.push('release ' + sym); }
    }
    for (const sym of want) {
      if (!held[sym]) { held[sym] = true; log.push('acquire ' + sym); }
    }
    return held;
  }
  let held = { EURUSD: true, XAUUSD: true };
  const log = [];
  held = reconcile(held, new Set(['XAUUSD', 'BTCUSD']), log);
  check('mirror: reconciler releases dropped symbols and acquires new ones exactly once',
    log.join('|') === 'release EURUSD|acquire BTCUSD' && held.XAUUSD && held.BTCUSD && !held.EURUSD);
}
/* mirror of the dockback handoff ordering (ROUND123: the record rides the
   IPC payload — no localStorage hop between live renderers) */
{
  // solo: build copy + send {soloId, rec} -> main validates + forwards ->
  // host absorbs into its strip -> ack -> solo drops the record
  const rec = { id: 'r1', layout: '1', panes: [{ symbol: 'XAUUSD' }] };
  const payload = { soloId: 's1', rec: JSON.parse(JSON.stringify(rec)) };
  const forwarded = payload.rec && /^([\w-]+)$/.test(payload.rec.id); // validDockRec shape
  const hostList = [];
  if (forwarded) hostList.push(payload.rec);
  const acked = forwarded;
  const soloList = [rec, { id: 'r2', layout: '1', panes: [{ symbol: 'EURUSD' }] }];
  if (acked) { const i = soloList.findIndex((t) => t.id === payload.rec.id); if (i >= 0) soloList.splice(i, 1); }
  check('mirror: record rides the payload once, host absorbs it, solo drops on ack, keeps the rest',
    forwarded && hostList.length === 1 && hostList[0].id === 'r1' &&
    soloList.length === 1 && soloList[0].id === 'r2');
}

console.log(`\nROUND122: ${N} checks, ${BAD} failed`);
process.exit(BAD ? 1 : 0);
