/**
 * ROUND124 — three user-reported fixes around tabs / undock:
 *
 *  FIX A (undocking a new tab stripped the float Trade panel):
 *      The trade stack was gated behind `if (!SOLO_MODE)`, so a detached
 *      window had NO float panel (trade management + risk management). The
 *      chart-side surface now boots in solo windows too — Trade (live
 *      bridge state: read-only polls + quotes + specs), TradeOverlay,
 *      OneClick (THE float panel), ReplayTrade (the demo engine) and
 *      TradeRoute (+ a refreshMode watcher so a Demo/Live flip made in the
 *      main window reaches detached windows). Still host-only: TradeAlerts,
 *      TradeTicket, TradeDock, TradeHistory (right-panel / bottom-dock
 *      surfaces a solo window does not show).
 *      The per-symbol one-panel rule (OneClick._designated: first pane per
 *      symbol) applies per window, so:
 *        · multi-chart, same symbols          -> ONE panel (first chart)
 *        · multi-chart -> single chart        -> the same ONE panel
 *        · new tab, same symbol               -> one panel suffices
 *        · new tab, different symbol          -> its own panel on its chart
 *        · undocked, different symbol         -> panel in BOTH windows
 *        · the new tab turns multi-chart      -> same rules re-evaluated
 *
 *  FIX B (the shared demo ledger vs two engines):
 *      Open demo positions/orders are window-local (memory-only), but the
 *      balance/history/tx snapshot is SHARED localStorage. A blind write
 *      from window B would stomp window A's newer closes. saveAcct is now a
 *      MERGE: balance = on-disk + MY delta since my last write
 *      (D._shadowBal), history/tx = union (dedup by ticket / wall+amount),
 *      seq = max; a FORCED write (reset) replaces absolutely. Tickets
 *      re-read the on-disk seq before allocating (syncSeqFromDisk).
 *
 *  FIX C (the tab's ▲/▼ arrow + change % vanished after a symbol change):
 *      The change baseline (previous D1 close) for a freshly entered symbol
 *      waited for the 5-minute _refreshBases cadence — undocking "fixed" it
 *      only because a solo boots with an immediate fetch. _reconcileSubs now
 *      triggers _refreshBases() the moment a NEW symbol joins the label
 *      subscriptions (symbol change / new tab / dock-back / restore).
 *
 *  FIX D (drag the detached tab back onto the main window — Chrome):
 *      The solo strip gained the mirror image of the host's undock gestures:
 *      dragging a tab BELOW the detached strip or OUT of the window sends it
 *      back through the same tabs:dockback IPC the "Move to main window"
 *      menu item uses; in-strip drops still reorder.
 *
 * Source contracts + behavioral mirrors, the same style as rounds 102-123.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const app = read('src/renderer/js/app.js');
const tabs = read('src/renderer/js/chart/tabs.js');
const route = read('src/renderer/js/trade/route.js');
const replay = read('src/renderer/js/trade/replaytrade.js');
const oneclick = read('src/renderer/js/trade/oneclick.js');
const css = read('src/renderer/css/app.css');
/* behavioural scans run on code with block comments stripped */
const appCode = app.replace(/\/\*[\s\S]*?\*\//g, '');
const tabsCode = tabs.replace(/\/\*[\s\S]*?\*\//g, '');
const replayCode = replay.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND124 · FIX A: the float Trade panel boots in detached windows —');
check('the solo branch boots Trade (live bridge state) + TradeOverlay + OneClick',
  /Trade\.init\(\);\s*\n\s*TradeOverlay\.init\(\);\s*\n\s*OneClick\.init\(\);\s*\n\s*ReplayTrade\.init\(\);/.test(appCode));
check('the solo branch wires the demo delegate + route facade AFTER the engine',
  /TradeOverlay\.init\(\);[\s\S]{0,400}?ReplayTrade\.init\(\);\s*\n\s*TradeRoute\.setDemoDelegate\(ReplayTrade\);\s*\n\s*TradeRoute\.init\(\);/.test(appCode));
check('the solo branch watches the persisted Demo/Live switch (refreshMode)',
  /setInterval\(\(\) => \{ try \{ TradeRoute\.refreshMode\(\); \} catch \(e\) \{\} \}, 2500\);/.test(appCode));
check('host-only surfaces stay out of the solo branch (no ticket/dock/alerts/history)',
  (() => {
    const m = /\} else \{[\s\S]*?Trade\.init\(\);[\s\S]*?\n    \}/.exec(appCode);
    if (!m) return false;
    const solo = m[0];
    return !/TradeTicket\.init\(\)|TradeDock\.init\(\)|TradeAlerts\.init\(\)|TradeHistory\.init\(\)/.test(solo);
  })());
check('the host branch still boots the FULL stack (unchanged)',
  /if \(!SOLO_MODE\) \{[\s\S]*?Trade\.init\(\);[\s\S]*?TradeAlerts\.init\(\);[\s\S]*?TradeTicket\.init\(\);[\s\S]*?TradeDock\.init\(\);[\s\S]*?TradeOverlay\.init\(\);[\s\S]*?OneClick\.init\(\);[\s\S]*?TradeHistory\.init\(\);[\s\S]*?ReplayTrade\.init\(\);[\s\S]*?TradeRoute\.init\(\);/.test(appCode));
check('the float panel per-symbol rule is intact (first pane per symbol shows it)',
  /_designated\(pane\) \{[\s\S]*?const first = App\.panes\.find\(\(p\) => p\.symbol === sym\);[\s\S]*?return first === pane;/.test(oneclick));
check('solo CSS does NOT hide the float panel or its pill',
  !/body\.solo[^{]*\.oc-panel/.test(css) && !/body\.solo[^{]*\.oc-pill/.test(css));
check('solo CSS still hides the Trading rail button (right panel stays host-only)',
  /body\.solo #right-tabs \.rt-btn\[data-tab="trade"\] \{ display: none; \}/.test(css));

console.log('— ROUND124 · FIX B: the shared demo ledger is merge-safe across windows —');
check('saveAcct re-reads the on-disk snapshot before writing (merge, not stomp)',
  /let cur = null;\s*\n\s*try \{ cur = JSON\.parse\(U\.lsGet\(K_ACCT, 'null'\)\); \} catch \(e\) \{ cur = null; \}/.test(replayCode));
check('balance applies MY delta since my last write (D._shadowBal), additively',
  /const myDelta = Math\.round\(\(D\.balance - \(isFinite\(D\._shadowBal\) \? D\._shadowBal : D\.balance\)\) \* 100\) \/ 100;/.test(replayCode) &&
  /const mergedBal = Math\.round\(\(Number\(cur\.balance\) \+ myDelta\) \* 100\) \/ 100;/.test(replayCode));
check('history merges as a union by ticket (the other window\'s rows survive)',
  /const seen = new Set\(hist\.map\(\(h\) => String\(h && h\.ticket\)\)\);/.test(replayCode) &&
  /hist\.sort\(\(a, b\) => \(\(b && b\.time\) \|\| 0\) - \(\(a && a\.time\) \|\| 0\)\);/.test(replayCode));
check('cash tx merge as a union by identity (wall + amount)',
  /const tseen = new Set\(txs\.map\(\(t\) => \(\(t && t\.wall\) \|\| 0\) \+ '\|' \+ \(\(t && t\.amount\) \|\| 0\)\)\);/.test(replayCode));
check('seq merges as max(mine, on-disk) and is adopted back into the engine',
  /const mergedSeq = Math\.max\(Number\(cur\.seq\) \|\| 0, D\.seq\);/.test(replayCode) &&
  /if \(mergedSeq > D\.seq\) D\.seq = mergedSeq;/.test(replayCode));
check('the shadow baseline re-bases after every write path (forced + merged)',
  /D\._shadowBal = D\.balance;\s*\n\s*D\._forceSave = false;/.test(replayCode) &&
  /D\._shadowBal = mergedBal;/.test(replayCode));
check('loadAcct initializes the shadow baseline to the loaded balance',
  /if \(a && typeof a === 'object'\) \{[\s\S]*?\} else \{\s*\n\s*D\.balance = D\.cfg\.deposit;   \/\/ fresh account starts at the deposit\s*\n\s*\}\s*\n\s*D\._shadowBal = D\.balance;/.test(replayCode));
check('reset() FORCES an absolute write (a reset replaces the shared ledger)',
  /D\.balance = D\.cfg\.deposit;\s*\n\s*D\._forceSave = true;\s*\n\s*saveAcct\(\);/.test(replayCode));
check('a forced/absent-snapshot write replaces the snapshot and clears the flag',
  /if \(D\._forceSave \|\| !cur \|\| typeof cur !== 'object' \|\| !isFinite\(Number\(cur\.balance\)\)\) \{[\s\S]*?D\._shadowBal = D\.balance;\s*\n\s*D\._forceSave = false;\s*\n\s*return;/.test(replayCode));
check('tickets adopt the on-disk counter before allocation (unique across windows)',
  /function syncSeqFromDisk\(\) \{[\s\S]*?Number\(a\.seq\) > D\.seq[\s\S]*?\}/.test(replayCode) &&
  (replayCode.match(/syncSeqFromDisk\(\);/g) || []).length === 2);

console.log('— ROUND124 · FIX C: the ▲/▼ arrow + change % survive a symbol change —');
check('_reconcileSubs counts freshly acquired label subs',
  /let added = 0;[\s\S]*?try \{ Manager\.acquireSub\(sym\); added\+\+; \} catch \(e\) \{ delete this\._labelSubs\[sym\]; \}/.test(tabsCode));
check('a new symbol triggers the D1 baseline fetch IMMEDIATELY (no 5-minute wait)',
  /if \(added\) this\._refreshBases\(\);/.test(tabsCode));
check('the baseline fetch still guards fresh/busy symbols (cheap on repeat calls)',
  /if \(this\.baseBusy\[sym\]\) continue;/.test(tabs) &&
  /if \(age < 4 \* 60000 && this\.base\[sym\] != null\) continue;/.test(tabs));
check('the quote painter still resets the cells when a tab\'s symbol changes (data-qsym)',
  /if \(el\.dataset\.qsym !== sym\) \{[\s\S]*?el\.dataset\.qsym = sym;[\s\S]*?pxEl\.textContent = '\\u2014';/.test(tabs));

console.log('— ROUND124 · FIX D: drag the detached tab back (Chrome dock-back gesture) —');
check('the dock-back gesture lives in SOLO windows only (mirror of the host gesture)',
  /if \(SOLO_ID && window\.mt5Tabs && window\.mt5Tabs\.dockback\) \{/.test(tabsCode) &&
  /if \(!SOLO_ID && window\.mt5Tabs && window\.mt5Tabs\.undock\) \{/.test(tabsCode));
check('dragging BELOW the detached strip (or above it) docks the tab back',
  /if \(SOLO_ID && window\.mt5Tabs && window\.mt5Tabs\.dockback\) \{[\s\S]*?if \(e\.clientY > r\.bottom \+ 36 \|\| e\.clientY < r\.top - 8\) \{[\s\S]*?this\.dockbackTab\(id\);/.test(tabsCode));
check('dragging OUT of the detached window (relatedTarget null) docks the tab back',
  /if \(SOLO_ID && window\.mt5Tabs && window\.mt5Tabs\.dockback\) \{[\s\S]*?document\.addEventListener\('dragleave', \(e\) => \{\s*\n\s*if \(!this\._dragId \|\| e\.relatedTarget\) return;[\s\S]*?this\.dockbackTab\(id\);/.test(tabsCode));
check('the gesture clears stale drop hints before handing the tab over',
  /const id = this\._dragId;\s*\n\s*this\._dragId = null;\s*\n\s*this\._clearDropHints\(\);\s*\n\s*this\.dockbackTab\(id\);/.test(tabsCode));
check('the gesture rides the SAME dockback path as the "Move to main window" item',
  /async dockbackTab\(id\) \{[\s\S]*?window\.mt5Tabs\.dockback\(\{ soloId: SOLO_ID, rec: copy \}\)/.test(tabs));
check('in-strip drops still reorder (the per-tab drop handler is untouched)',
  /el\.addEventListener\('drop', \(e\) => \{[\s\S]*?this\._reorder\(this\._dragId, t\.id, before\);/.test(tabsCode));
check('the host ack path still closes the emptied solo window (Chrome)',
  /_onDockAck\(p\) \{[\s\S]*?if \(!this\.list\.length\) \{[\s\S]*?window\.close\(\);/.test(tabsCode));

console.log('— ROUND124 · route facade —');
check('refreshMode adopts a persisted flip SILENTLY (no toast, no write)',
  /refreshMode\(\) \{[\s\S]*?const next = m === 'demo' \? 'demo' : 'live';[\s\S]*?if \(next === this\.mode\) return;[\s\S]*?this\.mode = next;\s*\n\s*this\._paintUI\(\);/.test(route) &&
  !/refreshMode\(\) \{[\s\S]*?U\.lsSet/.test(route));
check('set() still persists + toasts (the main-window switch is untouched)',
  /set\(mode, silent\) \{[\s\S]*?try \{ U\.lsSet\(K_MODE, m\); \} catch \(e\) \{\}[\s\S]*?UI\.toast/.test(route));

console.log('');
console.log(N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
