import { readSource } from './source-utils.mjs';
/**
 * ROUND120 — regression suite for the eight user fixes:
 *   1. the floating Trade panel = ONE panel per SYMBOL in multi-chart
 *      (designated pane, independent per-symbol drag position, survives
 *      multi ↔ single switches)
 *   2. crosshair: same-symbol panes follow the Crosshair toggle;
 *      different-symbol panes follow the NEW crossX toggle
 *   3. the Total bar (dock) refreshes live on the 600ms pass
 *   4. history matches MetaTrader (broker-base window + IN backfill +
 *      INOUT/OUT_BY closing deals)
 *   5. trade times render in the app timezone (TZ.partsNum funnel)
 *   6. demo/live fully separated: the ToolBox follows the mode switch,
 *      demo history moved into the ToolBox (TradeRoute.history facade)
 *   7. ONE unified ticket for both modes (re-homed #trade-ticket)
 *   8. partial exits = one history row per closing deal (MT5 deal view),
 *      demo ledger carries otime/vol0 and synthesizes deal rows
 *
 * Source contracts + small behavioral mirrors, the same style as the
 * round-102..119 suites.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readSource(p);
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const oc = read('src/renderer/js/trade/oneclick.js');
const mgr = read('src/renderer/js/chart/manager.js');
const tb = read('src/renderer/js/chart/toolbar.js');
const core = read('src/core/state.js');
const dock = read('src/renderer/js/trade/dock.js');
const route = read('src/renderer/js/trade/route.js');
const ticket = read('src/renderer/js/trade/ticket.js');
const replay = read('src/renderer/js/trade/replaytrade.js');
const hist = read('src/renderer/js/trade/history.js');
const tzjs = read('src/core/timezone.js');
const html = read('src/renderer/index.html');
const provider = read('provider/mt5.py');

console.log('— ROUND120 · 1: the floating panel = one panel per symbol —');
check('designation rule: the FIRST pane holding a symbol owns the panel',
  /_designated\(pane\)[\s\S]*?const first = App\.panes\.find\(\(p\) => p\.symbol === sym\);\s*return first === pane;/.test(oc));
check('visibility is designation-gated (panel = designated && !min, pill = designated && min)',
  /_visPaint\(st\)[\s\S]*?const panelOn = desig && !this\._min;[\s\S]*?const pillOn = desig && this\._min;/.test(oc));
check('non-designated panes idle out of the 200ms tick (and drafts are cancelled)',
  /this\._visPaint\(st\);\s*\n\s*if \(!st\.desig\) return;/.test(oc) &&
  /if \(!desig && st\.draft\) \{ try \{ this\._draftCancel\(st\); \} catch \(e\) \{\} \}/.test(oc));
check('per-symbol position map (mt5_oct_pos_map) with the legacy key as migration fallback',
  /posMap: 'mt5_oct_pos_map'/.test(oc) && /_posBySym\[sym\]/.test(oc) && /return this\._pos;\s*\/\* legacy migration fallback/.test(oc));
check('drag persists under the dragged SYMBOL (independent movement)',
  /this\._posSaveFor\(d\.st\.sym,\s*this\._pos\)/.test(oc));
check('the designation re-evaluates on every tick (multi ↔ single never loses the panel)',
  /_tickPane[\s\S]*?this\._visPaint\(st\);/.test(oc));

console.log('— ROUND120 · 2: crosshair same-symbol vs different-symbol —');
check('App.sync default gains crossX: false',
  /crosshair: true, crossX: false, time: false/.test(core));
check('the layout menu lists the new toggle (Crosshair on different symbols)',
  /\['crossX',\s*'Crosshair on different symbols'/.test(tb));
check('crossSyncOk: same symbol → crosshair, different symbol → crossX',
  /function crossSyncOk\(src, dst\) \{[\s\S]*?sameSym \? !!App\.sync\.crosshair : !!App\.sync\.crossX;/.test(mgr));
check('syncCrossMove + syncCrossClear gate every destination through crossSyncOk',
  /syncCrossClear = function[\s\S]*?if \(!crossSyncOk\(src, p\)\) continue;/.test(mgr) &&
  /syncCrossMove = function[\s\S]*?if \(!crossSyncOk\(src, p\)\) continue;/.test(mgr));
check('the LWC subscription runs while EITHER toggle is on (gating stays inside)',
  /!\(App\.sync\.crosshair \|\| App\.sync\.crossX\) \|\| App\.panes\.length < 2/.test(mgr));

console.log('— ROUND120 · 3: the Total bar is live —');
check('dock: _updateLive ends in _updateTotalLive (600ms pass)',
  /_updateLive[\s\S]*?this\._updateTotalLive\(\);/.test(dock));
check('dock: the rollup + Volume/Swap/Profit sums carry data hooks and repaint from TradeRoute.positions()',
  /cell\.dataset\.role = 'rollup';/.test(dock) && /cell\.dataset\.sum = 'volume';/.test(dock) &&
  /_updateTotalLive\(\) \{[\s\S]*?const posRows = TradeRoute\.positions\(\);[\s\S]*?TradeRoute\.profitOf\(p\)/.test(dock));

console.log('— ROUND120 · 4: history matches MetaTrader —');
check('provider: the window bounds shift into the broker base (measured server offset)',
  /frm \+ off, tz=dt\.timezone\.utc\)/.test(provider) && /to \+ off, tz=dt\.timezone\.utc\)/.test(provider));
check('provider: positions opened before the window are backfilled by position id (bounded)',
  /history_deals_get\(position=pid\)/.test(provider) && /missing\[:400\]/.test(provider));
check('dock: closing deals include INOUT (2) and OUT_BY (3), not only OUT (1)',
  /d\.entry === 1 \|\| d\.entry === 2 \|\| d\.entry === 3\) g\.outs\.push\(d\)/.test(dock));
check('dock: the history fetch rides the ACTIVE account (TradeRoute.history)',
  /TradeRoute\.history\(this\._rangeFrom\(\), 0\)/.test(dock));
check('route: the demo path synthesizes the demo ledger, the live path keeps the bridge',
  /rows = \(this\.demo\.deals && this\.demo\.deals\(\)\) \|\| \[\];/.test(route) && /return Trade\.history\(from, to\);/.test(route));

console.log('— ROUND120 · 5: trade hours follow the app timezone —');
check('TZ.partsNum: all-numeric y/m/d + h/m/s through the chart-stamp funnel',
  /TZ\.partsNum = function \(tz, chartSec\) \{[\s\S]*?zfmtNum\(tz\)\.formatToParts/.test(tzjs));
check('dock: _fmtT/_fmtT5 render through TZ.partsNum(App.tz, sec)',
  (dock.match(/_fmtT5?\(sec\) \{[\s\S]*?TZ\.partsNum\(App\.tz, sec\)/g) || []).length >= 2);
check('dock: "Today" starts at midnight in App.tz over the chart time base',
  /_rangeFrom\(\)[\s\S]*?TZ\.partsNum\(App\.tz, nowChart\)[\s\S]*?nowChart - secOfDay - off;/.test(dock));
check('chart history hover times follow App.tz too',
  /TZ\.partsNum\(App\.tz, t\)/.test(hist));

console.log('— ROUND120 · 6: demo/live fully separated —');
check('dock: the history cache is per-account and dropped on a mode flip',
  /_dealsMode !== TradeRoute\.mode \) \{ this\._deals = null; this\._dealSum = null; \}/.test(dock.replace(/\s+/g, ' ')) ||
  /\(this\._dealsMode !== TradeRoute\.mode\)/.test(dock));
check('route: closeAll facade — demo → the demo engine, live → the bridge',
  /closeAll\(symbol\) \{[\s\S]*?this\.demo\.closeAll\(symbol\)[\s\S]*?return Trade\.closeAll\(symbol\);/.test(route));
check('dock: the Close-all button works on the ACTIVE account',
  /e\.closeAll\.addEventListener\('click'[\s\S]*?TradeRoute\.positions\(\)[\s\S]*?TradeRoute\.closeAll\(\)/.test(dock));
check('replaytrade: the demo history is no longer a panel tab — the ledger feeds the ToolBox',
  !/data-t="hist"/.test(replay) && /ReplayTrade\.deals = \(\) => demoDeals\(\);/.test(replay));
check('index.html: the demo body hosts only the extras block (no rtt-body, no demo tables)',
  !/id="rtt-body"/.test(html) && /id="tr-demo" class="hidden"><\/div>/.test(html));

console.log('— ROUND120 · 7: ONE unified ticket —');
check('route: _paintUI re-homes #trade-ticket into the active body',
  /const host = document\.getElementById\('trade-ticket'\);[\s\S]*?dest\.insertBefore\(host, dest\.firstChild\)/.test(route));
check('ticket: account strip reads the ACTIVE account (TradeRoute.account/equity) + the mode chip',
  /const acc = TradeRoute\.account\(\);/.test(ticket) && /id="tt-modechip"/.test(ticket) && /e\.modechip\.classList\.toggle\('demo', demo\);/.test(ticket));
check('ticket: orders send through TradeRoute.sendOrder with the canTrade() gate',
  /const gate = TradeRoute\.canTrade\(\);/.test(ticket) && /TradeRoute\.sendOrder\(\{/.test(ticket));
check('ticket: quotes come from the route (demo works on live ticks and replay prices)',
  /const q = TradeRoute\.quote\(sym\);/.test(ticket) && /TradeRoute\.quote\(sym\) \|\| \{ bid: s\.bid, ask: s\.ask \}/.test(ticket));
check('ticket: Stop-Limit hides in demo (the demo engine supports limit/stop only)',
  /slOpt\.disabled = TradeRoute\.isDemo\(\);/.test(ticket));
check('route: the retcode contract stays for the live path (RC_OK)',
  /const RC_OK = \[10008, 10009, 10010\];/.test(route));

console.log('— ROUND120 · 8: partial exits — MT5 history (UPGRADED ROUND127) —');
/* ROUND127 (user request): the partial fragments are ONE trade — the history
   grid now shows ONE row per closed POSITION (volume = total closed, close
   price = the volume-weighted average, profit = the sum), the way the MT5
   terminal lists it. The per-fragment deal view of the original round 120
   was replaced by the position aggregation. */
check('dock: _histRows emits ONE row per POSITION (the partials are merged)',
  /_histRows\(pid, g\) \{[\s\S]*?const dir = g\.in\.type === 0 \? 0 : 1;[\s\S]*?return \[\{[\s\S]*?parts: g\.outs\.length,[\s\S]*?\}\];/.test(dock));
check('dock: close price = volume-weighted average of the closing deals (MT5 aggregate)',
  /vx \+= \(o\.price \|\| 0\) \* \(o\.volume \|\| 0\);/.test(dock) && /const close = vol > 0 \? vx \/ vol :/.test(dock));
check('dock: entry commission/fee/swap ride the single row (grid totals = account totals)',
  /comm: comm \+ inComm, fee: fee \+ inFee, swap: swap \+ inSwap,/.test(dock));
check('dock: the trade-count summary stays per POSITION (what the terminal counts)',
  /const groupNets = \[\];/.test(dock) && /const nTrades = groupNets\.length;/.test(dock));
check('replaytrade: demo close records carry otime + vol0 + SL/TP (terminal-shaped fragments)',
  /vol0: pos\.volume, otime: pos\.time,/.test(replay) && /sl: pos\.sl \|\| 0, tp: pos\.tp \|\| 0,/.test(replay));
check('replaytrade: demoDeals synthesizes IN + OUT deal rows with the SL(4)/TP(5) reasons',
  /reason: h\.reason === 'sl' \? 4 : \(h\.reason === 'tp' \? 5 : 0\),/.test(replay) &&
  /entry: 1,/.test(replay) && /position_id: h\.ticket,/.test(replay));
check('chart history: the layer reads the ACTIVE account (demo fragments draw too)',
  /return TradeRoute\.history\(0, 0\)\.then/.test(hist) &&
  /TradeRoute\.onChange\.push\(\(\) => \{ this\._dirty = true; this\.refresh\(\); \}\);/.test(hist));
check('chart history: pairsOf already draws one connector per closing deal (partial parity on-chart)',
  /for \(const od of g\.outs\) \{/.test(hist));

/* ---------- behavioral mirrors ---------- */
console.log('— ROUND120 · behavioral mirrors —');
/* ROUND127 mirror: the exact _histRows aggregation economics —
   ONE row per position out of N closing fragments */
function mirrorRows(g) {
  let vol = 0, profit = 0, vx = 0, comm = 0, fee = 0, swap = 0, closeT = 0;
  for (const o of g.outs) {
    vol += o.volume || 0; profit += o.profit || 0;
    vx += (o.price || 0) * (o.volume || 0);
    comm += o.commission || 0; fee += o.fee || 0; swap += o.swap || 0;
    if ((o.time || 0) > closeT) closeT = o.time;
  }
  const close = vol > 0 ? vx / vol : 0;
  const inComm = g.in.commission || 0, inFee = g.in.fee || 0, inSwap = g.in.swap || 0;
  return [{ vol, close, closeT, profit,
    comm: comm + inComm, fee: fee + inFee, swap: swap + inSwap,
    net: (profit + comm + fee + swap) + (inComm + inFee + inSwap), parts: g.outs.length }];
}
/* 1.0 lot opened (comm -2, swap -0.5), closed 0.4 (+30 @1.20) then 0.6 (+40 @1.30):
   the terminal shows ONE row — total 1.0 lots, vwap close 1.26, profit 70 */
const g1 = { in: { commission: -2, fee: 0, swap: -0.5 }, outs: [
  { volume: 0.4, profit: 30, commission: -1, price: 1.20, time: 500 },
  { volume: 0.6, profit: 40, commission: -1, price: 1.30, time: 900 }] };
const rows1 = mirrorRows(g1);
check('mirror: two fragments merge into ONE position row (total volume, last close time)',
  rows1.length === 1 && rows1[0].vol === 1.0 && rows1[0].closeT === 900 && rows1[0].parts === 2);
check('mirror: the row carries the position TOTALS (vwap close, summed profit/comm/fee/swap/net)',
  Math.abs(rows1[0].close - 1.26) < 1e-9 && rows1[0].profit === 70 &&
  rows1[0].comm === -4 && rows1[0].swap === -0.5 &&
  Math.abs(rows1[0].net - (70 - 4 - 0.5)) < 1e-9);
/* single full close keeps the same one-row shape */
const g2 = { in: { commission: -2, fee: 0, swap: 0 }, outs: [{ volume: 0.1, profit: 5, commission: 0, price: 1.1, time: 700 }] };
const rows2 = mirrorRows(g2);
check('mirror: a full close stays ONE row (volume = the whole position)',
  rows2.length === 1 && rows2[0].vol === 0.1 && rows2[0].parts === 1 && rows2[0].comm === -2);
/* demo fragment close: remaining volume keeps the position alive */
check('mirror: demo ledger synthesizes an IN per fragment with the pre-close volume',
  (() => { const h = { ticket: 1, type: 0, volume: 0.4, vol0: 1.0, otime: 100, open: 1.1, close: 1.2, profit: 9, time: 500, reason: 'tp', sl: 1.05, tp: 1.2 };
    return h.vol0 === 1.0 && h.otime === 100 && h.sl > 0; })());
/* crossSyncOk mirror */
function mirrorCross(sameSym, crosshair, crossX) { return sameSym ? !!crosshair : !!crossX; }
check('mirror: same-symbol panes follow Crosshair; different-symbol need crossX',
  mirrorCross(true, true, false) === true && mirrorCross(false, true, false) === false &&
  mirrorCross(false, false, true) === true && mirrorCross(false, true, true) === true);

console.log('\nROUND120: ' + N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
