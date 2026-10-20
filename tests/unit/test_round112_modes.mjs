#!/usr/bin/env node
/**
 * ROUND112 tests — the Demo/Live switch (merged Trading tab) + the panel in
 * three modes + the demo cash ledger + the icon fixes.
 *
 * Two layers, the repo's established style:
 *  A) MIRRORS of the pure rules — mode normalisation/persistence, the cash
 *     ledger (deposit/withdrawal records), the demo price-source split,
 *     availability gating, the leverage margin scaling (real demo-math),
 *     the break-even snap of the demo risk-free action.
 *  B) SOURCE CONTRACTS against the real files — route.js facade + merged
 *     tab wiring, replaytrade delegate API + persistence + auto-switch,
 *     oneclick routing, index.html structure (no replaytrade tab), app.css
 *     switch styles, trade.css icon fixes (grip/pin/lock/minus/½/🛡/×).
 *
 * Exit 0 only when every check passes.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { demoMargin } from '../../src/core/demo-math.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}
const eq = (a, b) => a === b;

const routejs = read('src/renderer/js/trade/route.js');
const replayjs = read('src/renderer/js/trade/replaytrade.js');
const oneclick = read('src/renderer/js/trade/oneclick.js');
const indexhtml = read('src/renderer/index.html');
const ticketjs = read('src/renderer/js/trade/ticket.js');
const appjs = read('src/renderer/js/app.js');
const appcss = read('src/renderer/css/app.css');
const tradecss = read('src/renderer/css/trade.css');

/* ---------------- A) mirrors ---------------- */
console.log('A) mirrors of the pure rules');

/* A1 — mode normalisation + persistence (route.set/init shape) */
function norm(v) { return v === 'demo' ? 'demo' : 'live'; }
check('mode normalises to live|demo only', norm('demo') === 'demo' && norm('live') === 'live' && norm('x') === 'live' && norm(undefined) === 'live');

/* A2 — the cash ledger: every balance edit records deposit/withdrawal
   (num() semantics: a non-finite entry falls back to the current balance) */
function num(v, def, min, max) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}
function applyBalance(balance, newVal) {
  const nb = num(newVal, balance, 0, 1e12);
  const delta = Math.round((nb - balance) * 100) / 100;
  const tx = [];
  if (delta !== 0) {
    balance = Math.round((balance + delta) * 100) / 100;
    tx.push({ kind: delta > 0 ? 'dep' : 'with', amount: Math.round(Math.abs(delta) * 100) / 100, balance });
  }
  return { balance, tx };
}
let r1 = applyBalance(10000, 10500);
check('a higher balance records a DEPOSIT of the exact delta', r1.tx.length === 1 && r1.tx[0].kind === 'dep' && eq(r1.tx[0].amount, 500) && eq(r1.balance, 10500));
let r2 = applyBalance(10500, 10150.5);
check('a lower balance records a WITHDRAWAL (negative delta, exact cents)', r2.tx[0].kind === 'with' && eq(r2.tx[0].amount, 349.5) && eq(r2.balance, 10150.5));
let r3 = applyBalance(1000, 1000);
check('a no-op balance edit records nothing', r3.tx.length === 0 && eq(r3.balance, 1000));
let r4 = applyBalance(1000, 'abc');
check('an unparsable balance edit falls back to the current balance (no tx)', eq(r4.balance, 1000) && r4.tx.length === 0);
let r5 = applyBalance(1000, -50);
check('a negative entry clamps to 0 and withdraws the whole balance', eq(r5.balance, 0) && r5.tx[0].kind === 'with' && eq(r5.tx[0].amount, 1000));

/* A3 — the demo price-source split (quoteOf/priceOf shape) */
const ReplayLike = (on) => ({ isActive: () => on });
function priceOf(replay, tradeQuote, chartClose) {
  if (!replay.isActive()) {
    const q = tradeQuote;
    if (q && q.bid > 0) return q.bid;
  }
  return chartClose;
}
function quoteOf(replay, tradeQuote, chartClose, spreadPts, point) {
  if (!replay.isActive()) {
    const q = tradeQuote;
    if (q && q.bid > 0 && q.ask > 0) return { bid: q.bid, ask: q.ask };
  }
  const p = chartClose;
  if (!(p > 0)) return null;
  const spr = (!replay.isActive()) ? 0 : ((spreadPts > 0 && point > 0) ? spreadPts * point : 0);
  return { bid: p, ask: p + spr };
}
const R_OFF = ReplayLike(false), R_ON = ReplayLike(true);
check('REPLAY source: price = the chart close + the synthetic spread', (() => {
  const q = quoteOf(R_ON, { bid: 9, ask: 9 }, 3300.5, 20, 0.01);
  return eq(q.bid, 3300.5) && eq(q.ask, 3300.7);
})());
check('REPLAY source with spread 0: ask == chart price', (() => {
  const q = quoteOf(R_ON, null, 1.0834, 0, 0.00001);
  return eq(q.bid, 1.0834) && eq(q.ask, 1.0834);
})());
check('LIVE source: the real tick bid/ask win (no synthetic spread)', (() => {
  const q = quoteOf(R_OFF, { bid: 4336.25, ask: 4336.89 }, 3300.5, 20, 0.01);
  return eq(q.bid, 4336.25) && eq(q.ask, 4336.89);
})());
check('LIVE source fallback: without a tick quote the chart close still prices', (() => {
  const q = quoteOf(R_OFF, null, 1.0834, 0, 0);
  return q != null && eq(q.bid, 1.0834);
})());
check('priceOf prefers the live bid when replay is off, the chart close when on',
  eq(priceOf(R_OFF, { bid: 4336.25, ask: 4336.89 }, 3300.5), 4336.25) &&
  eq(priceOf(R_ON, { bid: 4336.25, ask: 4336.89 }, 3300.5), 3300.5));

/* A4 — availability gating (the demo delegate guard) */
function available(isDemo, replayOn, quote) {
  if (!isDemo) return { ok: false, reason: 'off' };
  if (replayOn) return { ok: true };
  if (quote && quote.bid > 0 && quote.ask > 0) return { ok: true };
  return { ok: false, reason: 'no source' };
}
check('available: replay on → tradeable even without ticks', available(true, true, null).ok === true);
check('available: replay off + live quote → tradeable (demo on live market)', available(true, false, { bid: 1, ask: 1.1 }).ok === true);
check('available: replay off + no quote → blocked with a reason', available(true, false, null).ok === false);
check('available: demo mode off → blocked (live mode owns the account)', available(false, true, null).ok === false);

/* A5 — leverage REALLY scales the margin (the user: "بخش لوریج باید محاسبه درست داشته باشه") */
const specXAU = { contract: 100 };
const pos1 = { volume: 1, open: 4336 };
check('margin 1:100 for 1 lot XAUUSD ≈ $4336 (volume×contract/leverage×rate)',
  Math.abs(demoMargin(specXAU, pos1, 100, 4336) - 4336) < 1e-6);
check('margin 1:500 is exactly 5× smaller than 1:100',
  Math.abs(demoMargin(specXAU, pos1, 500, 4336) * 5 - demoMargin(specXAU, pos1, 100, 4336)) < 1e-6);
check('margin 1:1000 is exactly 10× smaller than 1:100',
  Math.abs(demoMargin(specXAU, pos1, 1000, 4336) * 10 - demoMargin(specXAU, pos1, 100, 4336)) < 1e-6);
check('margin never crosses free margin: 0.01 lot at 1:100 ≈ $43.36',
  Math.abs(demoMargin(specXAU, { volume: 0.01 }, 100, 4336) - 43.36) < 1e-6);

/* A6 — the break-even snap of the demo risk-free action (opts.be: no
   distance window — the snap always honours the risk-free intent, landing
   one point BEYOND stops_level from the close price: ref ∓ (stops+1)pt) */
function snapTest(type, ref, sl, point, stopsPts, beMode) {
  let err = null;
  const buy = type === 0;
  const slBad = buy ? sl >= ref : sl <= ref;
  if (sl > 0 && slBad) err = 'SL must be below the price';
  const gap = stopsPts > 0 ? stopsPts * point + point : point;
  if (err && (beMode || Math.abs(sl - ref) <= point * 3)) {
    sl = Number((buy ? ref - gap : ref + gap).toFixed(5));
    err = null;
  }
  if (sl > 0 && (buy ? ref - sl < stopsPts * point : sl - ref < stopsPts * point)) err = 'SL too close';
  return { sl, err };
}
check('BUY risk-free at open(ask)=2000.50, bid=2000.45, stops 15 → SL snaps to bid−16pt (LEGAL BE)',
  (() => { const s = snapTest(0, 2000.45, 2000.50, 0.01, 15, true); return eq(s.sl, 2000.29) && s.err == null; })());
check('SELL risk-free at open(bid)=2000.45, ask=2000.50, stops 15 → SL snaps to ask+16pt',
  (() => { const s = snapTest(1, 2000.50, 2000.45, 0.01, 15, true); return eq(s.sl, 2000.66) && s.err == null; })());
check('a non-BE SL on the wrong side, outside the 3pt courtesy window, still rejects', (() => {
  const s = snapTest(0, 2000.45, 2001.0, 0.01, 15, false); return s.err != null;
})());

/* A7 — the mode switch semantics of the route (set → persist → notify) */
function mkRoute() {
  const store = {};
  const route = {
    mode: 'live', demo: null, onChange: [],
    set(m, silent) {
      m = norm(m);
      if (m === route.mode) return;
      route.mode = m; store.mt5_trade_mode = m;
      route.onChange.forEach((f) => f());
    },
  };
  return { route, store };
}
let rr = mkRoute(); let fired = 0;
rr.route.onChange.push(() => fired++);
rr.route.set('demo');
check('set(demo) persists + fires onChange once', rr.store.mt5_trade_mode === 'demo' && fired === 1);
rr.route.set('demo');
check('setting the SAME mode is a no-op (no spurious repaints)', fired === 1);
rr.route.set('live');
check('back to live fires onChange again', rr.store.mt5_trade_mode === 'live' && fired === 2);

/* ---------------- B) source contracts ---------------- */
console.log('B) source contracts');

/* route.js — the facade + the merged-tab wiring */
check('route.js: the persisted mode key is mt5_trade_mode', /K_MODE = 'mt5_trade_mode'/.test(routejs));
check('route.js: the demo broker is an INJECTED delegate (no import cycle)',
  /setDemoDelegate\(d\)/.test(routejs) && !/from '\.\/replaytrade\.js'/.test(routejs));
check('route.js: quote routes to the delegate in demo, Trade otherwise',
  /quote\(symbol\)\s*\{[\s\S]*?this\.demo\.quoteOf\(symbol\)[\s\S]*?return Trade\.quote\(symbol\);/.test(routejs));
check('route.js: equity routes to the delegate account, Trade.liveEquity otherwise',
  /this\.demo\.equity\(\)/.test(routejs) && /Trade\.liveEquity\(\)/.test(routejs));
check('route.js: positions + profitOf route to the active account',
  /this\.demo\.positions\(\)/.test(routejs) && /this\.demo\.profitOf\(pos\)/.test(routejs) &&
  /Trade\.positions/.test(routejs) && /Trade\.profitOf\(pos\)/.test(routejs));
check('route.js: canTrade guards the live bridge (online + AutoTrading) and the demo availability',
  /if\s*\(!Trade\.online\)\s*\{[^}]*Trading bridge is offline[^}]*\}/.test(routejs) &&
  /trade_allowed\s*===\s*false/.test(routejs) && /this\.demo\.available\(\)/.test(routejs));
check('route.js: sendOrder sends pendings to placePendingOrder, markets to placeMarketOrder',
  /p\.pend\s*\?\s*this\.demo\.placePendingOrder\(p\)\s*:\s*this\.demo\.placeMarketOrder\(p\)/.test(routejs));
check('route.js: the live path keeps the MT5 retcode contract (RC_OK) — ROUND120 passes stoplimit/typeTime/expiration through',
  /const RC_OK = \[10008, 10009, 10010\];/.test(routejs) && /stoplimit:\s*p\.stoplimit \|\| 0,/.test(routejs) &&
  /typeTime:\s*p\.typeTime,\s*expiration:\s*p\.expiration \|\| 0,/.test(routejs));
check('route.js: close/modifySLTP wrap the demo {ok} result into promises',
  /close\(ticket,\s*volume\)/.test(routejs) && /modifySLTP\(ticket,\s*sl,\s*tp\)/.test(routejs) &&
  /Promise\.reject/.test(routejs));
check('route.js: the merged tab wiring — #tr-mode buttons switch the mode',
  /_wireUI[\s\S]*?getElementById\('tr-mode'\)[\s\S]*?querySelectorAll\('\.tr-modeb\[data-m\]'\)[\s\S]*?this\.set\(b\.dataset\.m\)/.test(routejs));
check('route.js: _paintUI shows exactly one body (tr-demo / tr-live) and the gear follows demo',
  /getElementById\('tr-live'\)/.test(routejs) && /getElementById\('tr-demo'\)/.test(routejs) &&
  /getElementById\('rtt-gear'\)/.test(routejs));

/* replaytrade.js — live-market source + cash ledger + delegate API */
check('replaytrade: the account snapshot persists (mt5_rp_demo_acct) with balance/seq/tx/history',
  /K_ACCT = 'mt5_rp_demo_acct'/.test(replayjs) &&
  /balance:\s*D\.balance,\s*seq:\s*D\.seq,\s*tx:\s*D\.tx\.slice\(-500\),\s*history:\s*D\.history\.slice\(0,\s*200\)/.test(replayjs));
check('replaytrade: loadAcct restores balance + tx + history, fresh accounts start at the deposit',
  /function loadAcct\(\)/.test(replayjs) && /D\.balance = num\(a\.balance, D\.cfg\.deposit, 0, 1e12\)/.test(replayjs));
check('replaytrade: recordTx stamps kind dep/with + amount + balance + replay flag',
  /function recordTx\(delta\)/.test(replayjs) &&
  /const kind = delta > 0 \? 'dep' : 'with';/.test(replayjs) &&
  /balance:\s*Math\.round\(D\.balance \* 100\) \/ 100/.test(replayjs) &&
  /replay:\s*Replay\.isActive\(\)/.test(replayjs));
check('replaytrade: Apply records the balance delta as a cash movement (deposit OR withdrawal)',
  /const delta = Math\.round\(\(nb - D\.balance\) \* 100\) \/ 100;/.test(replayjs) &&
  /if \(delta !== 0\) \{[\s\S]*?recordTx\(delta\);/.test(replayjs));
check('replaytrade: the Balance field replaced Deposit (rtt-balance, id kept for tests)',
  /id="rtt-balance"/.test(replayjs) && !/id="rtt-deposit"/.test(replayjs));
check('replaytrade: quoteOf uses the LIVE tick stream when replay is off',
  /function quoteOf\(symbol\)\s*\{\s*\n\s*if \(!Replay\.isActive\(\)\) \{[\s\S]*?const q = Trade\.quote\(symbol\);/.test(replayjs));
check('replaytrade: the synthetic spread applies in REPLAY only (live quotes carry their own)',
  /function spreadOf\(symbol\)\s*\{\s*\n\s*if \(!Replay\.isActive\(\)\) return 0;/.test(replayjs));
check('replaytrade: available() gates on demo mode + (replay | live quote)',
  /function available\(\)\s*\{[\s\S]*?if \(!TradeRoute\.isDemo\(\)\)/.test(replayjs) &&
  /if \(Replay\.isActive\(\)\) return \{ ok: true \};/.test(replayjs));
check('replaytrade: market/placePending route through available() (no more Replay-only gate)',
  /const av = available\(\);\s*\n\s*if \(!av\.ok\) return \{ ok: false, error: av\.reason \};[\s\S]*?function placePending/.test(replayjs) ||
  (/function market\(symbol[\s\S]*?const av = available\(\);/.test(replayjs) &&
   /function placePending\([\s\S]*?const av = available\(\);/.test(replayjs)));
check('replaytrade: the live-market engine evaluates on a timer (SL/TP fire without replay frames)',
  /LIVE_EVAL_MS = 300/.test(replayjs) && /if \(Replay\.isActive\(\)\) return;[\s\S]*?if \(!TradeRoute\.isDemo\(\)\) return;/.test(replayjs));
check('replaytrade: the route delegate API is exposed (quoteOf/positions/profitOf/equity/available/order wrappers)',
  /ReplayTrade\.quoteOf = \(symbol\) => quoteOf\(symbol\);/.test(replayjs) &&
  /ReplayTrade\.positions = \(\) => D\.positions\.slice\(\);/.test(replayjs) &&
  /ReplayTrade\.profitOf = \(pos\) => floatingOf\(pos\);/.test(replayjs) &&
  /ReplayTrade\.equity = \(\) => account\(\)\.equity;/.test(replayjs) &&
  /ReplayTrade\.available = \(\) => available\(\);/.test(replayjs) &&
  /ReplayTrade\.placeMarketOrder = \(p\) =>/.test(replayjs) &&
  /ReplayTrade\.placePendingOrder = \(p\) =>/.test(replayjs) &&
  /ReplayTrade\.sourceOf = \(\) => sourceOf\(\);/.test(replayjs));
check('replaytrade: the break-even snap lets risk-free succeed on a spread quote',
  /beMode \|\| Math\.abs\(slReq - ref\) <= pt \* 3/.test(replayjs) &&
  /pos\.type === 0 \? ref - gap : ref \+ gap/.test(replayjs) &&
  /const gap = stopsGap > 0 \? stopsGap \+ pt : pt;/.test(replayjs));
check('replaytrade: starting Bar Replay auto-switches the merged tab to Demo (backtest account)',
  /if \(Replay\.isActive\(\) && !TradeRoute\.isDemo\(\)\) \{[\s\S]*?TradeRoute\.set\('demo', true\);[\s\S]*?Bar Replay — switched to Demo trading/.test(replayjs));
check('replaytrade: the cash ledger lists deposits/withdrawals (ROUND120 — moved out of the tabs into the demo extras block)',
  /TX_TAG = \{ dep: 'DEPOSIT', with: 'WITHDRAW' \}/.test(replayjs) &&
  /bal ' \+ fmtUsd\(t\.balance\)/.test(replayjs) &&
  /id="rtt-cash"/.test(replayjs));
check('replaytrade: the status line names the price source (REPLAY / LIVE MARKET)',
  /REPLAY — demo prices follow the Bar Replay cursor/.test(replayjs) &&
  /LIVE MARKET — demo account on live prices/.test(replayjs));
check('replaytrade: demo lines draw whenever DEMO mode is on (not only in replay)',
  /if \(!TradeRoute\.isDemo\(\)\) \{[\s\S]*?this\._clear\(pane, st\);/.test(replayjs));
check('replaytrade: reset clears the cash ledger too and re-funds from the deposit',
  /D\.tx = \[\];/.test(replayjs) && /D\.balance = D\.cfg\.deposit;/.test(replayjs) && /saveAcct\(\);/.test(replayjs));

/* oneclick.js — the panel in all three modes */
check('oneclick: imports TradeRoute', /import\s*\{\s*TradeRoute\s*\}\s*from\s*'\.\/route\.js'/.test(oneclick));
check('oneclick: every quote/equity read goes through the route',
  !/Trade\.quote\(/.test(oneclick) && !/Trade\.liveEquity\(\)/.test(oneclick) &&
  /TradeRoute\.quote\(st\.sym\)/.test(oneclick) && /TradeRoute\.equity\(\)/.test(oneclick));
check('oneclick: the send path gates on TradeRoute.canTrade() and sends via TradeRoute.sendOrder',
  /const gate = TradeRoute\.canTrade\(\);/.test(oneclick) &&
  /TradeRoute\.sendOrder\(\{/.test(oneclick) && !/Trade\.placeOrder\(/.test(oneclick));
check('oneclick: the toast carries the DEMO tag in demo mode',
  /const tag = TradeRoute\.isDemo\(\) \? 'DEMO ' : '';/.test(oneclick));
check('oneclick: the mode switch cancels stale drafts (ROUND113: the confirm arm is gone)',
  /_onRouteChange\(\)\s*\{[\s\S]*?this\._draftCancelAll\(\);/.test(oneclick) &&
  !/this\._disarmAll\(\);/.test(oneclick) &&
  /TradeRoute\.onChange\.push/.test(oneclick));
check('oneclick: the positions list follows the ACTIVE account (sig includes the route mode)',
  /const sig = TradeRoute\.mode \+ '#' \+ positions\.map/.test(oneclick) &&
  /const positions = TradeRoute\.positions\(\);/.test(oneclick));
check('oneclick: position actions route through TradeRoute (close/half/risk-free)',
  /TradeRoute\.close\(ticket,\s*0\)/.test(oneclick) &&
  /TradeRoute\.close\(ticket,\s*vol\)/.test(oneclick) &&
  /TradeRoute\.modifySLTP\(p\.ticket,\s*be,\s*p\.tp \|\| 0,\s*\{\s*be:\s*true\s*\}\)/.test(oneclick));
check('oneclick: the LIVE/DEMO badge paints on every tick (oc-mbadge)',
  /const badgeTxt = demo \? 'DEMO' : 'LIVE';/.test(oneclick) &&
  /st\.modeBadge\.classList\.toggle\('demo', demo\)/.test(oneclick));
check('oneclick: demo mode ignores the market-closed chip in REPLAY (backtest trades history)',
  /const replayOn = demo && TradeRoute\.demo && TradeRoute\.demo\.sourceOf && TradeRoute\.demo\.sourceOf\(\) === 'replay';/.test(oneclick) &&
  /const on = demo\s*\n\s*\?\ !!\(haveQ && \(replayOn \|\| !closed\)\)/.test(oneclick));
check('oneclick: _dbg exposes the route (E2E hook)', /route:\s*TradeRoute\.mode,/.test(oneclick));

/* index.html — the merged tab */
check('index.html: the Trading tab hosts the Demo/Live switch (#tr-mode, data-m demo/live)',
  /id="tr-mode"[\s\S]*?data-m="demo"[\s\S]*?data-m="live"/.test(indexhtml));
check('index.html: the replaytrade tab is GONE (merged), the old rail button removed',
  !/data-tab="replaytrade"/.test(indexhtml) && !/id="tab-replaytrade"/.test(indexhtml));
check('index.html: both mode bodies live in tab-trade (tr-demo first; the ONE unified ticket is created/re-homed by ticket.js — ROUND120)',
  /id="tr-demo" class="hidden"><\/div>/.test(indexhtml) &&
  /id="tr-live" class="hidden"><\/div>/.test(indexhtml) &&
  !/id="rtt-body"/.test(indexhtml) &&
  /getElementById\('trade-ticket'\)[\s\S]*insertBefore/.test(ticketjs));
check('index.html: the demo gear moved into the merged header',
  /id="rtt-gear"[\s\S]*?Demo account settings/.test(indexhtml));

/* app.js — boot + legacy tab mapping */
check('app.js: boots the route AFTER the demo broker init (delegate first)',
  /ReplayTrade\.init\(\);[\s\S]*?TradeRoute\.setDemoDelegate\(ReplayTrade\);[\s\S]*?TradeRoute\.init\(\);/.test(appjs));
check('app.js: the saved tab replaytrade maps to trade (upgrade path)',
  /const savedTab = savedTabRaw === 'replaytrade' \? 'trade' : savedTabRaw;/.test(appjs));
check('app.js: the rail icons map has no replaytrade entry',
  !/replaytrade:\s*'positions'/.test(appjs));
check('app.js: __app exposes TradeRoute + Replay (test facade)',
  /TradeRoute,\s*ReplayTrade,\s*Replay,/.test(appjs));

/* app.css — the switch styles */
check('app.css: the segmented switch styles exist (tr-mode / tr-modeb / .on)',
  /\.tr-mode\s*\{/.test(appcss) && /\.tr-modeb\s*\{/.test(appcss) && /\.tr-modeb\.on\s*\{\s*background:\s*var\(--blue\);/.test(appcss));
check('app.css: DEMO switch state is amber (distinct from LIVE blue)',
  /\.tr-modeb\.on\[data-m="demo"\]\s*\{\s*background:\s*#ff9800;\s*\}/.test(appcss));
check('app.css: the merged header button cluster aligns right',
  /#tab-trade \.rhead \.wl-head-btns\s*\{\s*margin-left:\s*auto;/.test(appcss));

/* trade.css — the icon fixes (user screenshots) */
check('trade.css: the chrome chips grew to 20px and moved to -10px (bigger icons)',
  /\.oc-chrome\s*\{[^}]*top:\s*-10px;[^}]*height:\s*20px;/.test(tradecss));
check('trade.css: the grip chip is bigger + full-contrast (24px chip, 12px glyph, var(--text))',
  /\.oc-grip\s*\{[^}]*flex:\s*0 0 24px;/.test(tradecss) &&
  /\.oc-grip\s*\{[^}]*color:\s*var\(--text\);/.test(tradecss) &&
  /\.oc-grip svg\s*\{\s*width:\s*12px;\s*height:\s*12px;\s*\}/.test(tradecss));
check('trade.css: the pin/lock/minus buttons grew (20px hit area, 12px glyphs, var(--text))',
  /\.oc-cbtn\s*\{[^}]*width:\s*20px;/.test(tradecss) &&
  /\.oc-cbtn svg\s*\{\s*width:\s*12px;\s*height:\s*12px;\s*\}/.test(tradecss) &&
  /\.oc-cbtn\s*\{[^}]*color:\s*var\(--text\);/.test(tradecss));
check('trade.css: the position actions grew and gained identity colours (½ blue · 🛡 green · × red)',
  /\.oc-pact\s*\{[^}]*width:\s*22px;\s*height:\s*22px;/.test(tradecss) &&
  /\.oc-pact svg\s*\{\s*width:\s*11\.5px;\s*height:\s*11\.5px;\s*\}/.test(tradecss) &&
  /\.oc-pact\.oc-half\s*\{\s*color:\s*var\(--blue\);/.test(tradecss) &&
  /\.oc-pact\.oc-rf\s*\{\s*color:\s*var\(--green\);/.test(tradecss) &&
  /\.oc-pact\.oc-x\s*\{\s*color:\s*var\(--red\);/.test(tradecss));
check('trade.css: the action hover fills keep white glyphs (readable on both themes)',
  /\.oc-pact\.oc-half:hover:not\(:disabled\)\s*\{\s*background:\s*var\(--blue\);[^}]*color:\s*#ffffff;/.test(tradecss) &&
  /\.oc-pact\.oc-rf:hover:not\(:disabled\)\s*\{\s*background:\s*var\(--green\);[^}]*color:\s*#ffffff;/.test(tradecss));
check('trade.css: the LIVE/DEMO badge styles exist (blue default, amber demo)',
  /\.oc-mbadge\s*\{[^}]*background:\s*var\(--blue\);/.test(tradecss) &&
  /\.oc-mbadge\.demo\s*\{\s*background:\s*#ff9800;\s*\}/.test(tradecss));
check('trade.css: the light theme keeps an edge under the floating chrome',
  /body\.theme-light \.oc-grip,/.test(tradecss));

/* safety invariants preserved */
check('safety: the demo path NEVER touches Trade.placeOrder (real broker isolation)',
  !/Trade\.placeOrder/.test(replayjs));
check('safety: the round-107 visibility rule survives (no inline display:"")',
  !/\.style\.display\s*=\s*''/.test(oneclick) && !/\.style\.display\s*=\s*''/.test(routejs));

console.log(`\nround112 modes: ${N - BAD} passed, ${BAD} failed`);
process.exit(BAD ? 1 : 0);
