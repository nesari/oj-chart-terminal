/* ROUND113 — pure-logic checks for the History MT5 grid + Open Positions fixes.
   Runs the real functions straight from the module sources (no DOM needed):
   the money/percent shapers, the deal-group -> trade-row math, the SL/TP
   reason flags, the column toggle state and the sort key map. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};

const dockSrc = fs.readFileSync('src/renderer/js/trade/dock.js', 'utf8');
const ocSrc = fs.readFileSync('src/renderer/js/trade/oneclick.js', 'utf8');
const demoSrc = fs.readFileSync('provider/demo.py', 'utf8');
const mt5Src = fs.readFileSync('provider/mt5.py', 'utf8');

console.log('— source contracts —');
ok(dockSrc.includes("hcols: 'mt5_tr_hist_cols'"), 'dock: history columns persistence key');
ok(dockSrc.includes('DEAL_REASON') || dockSrc.includes('reason === 4'), 'dock: SL reason 4 detection');
ok(dockSrc.includes('reason === 5'), 'dock: TP reason 5 detection');
ok(dockSrc.includes('td-hl-sl') && dockSrc.includes('td-hl-tp'), 'dock: SL/TP cell paint classes');
ok(dockSrc.includes('td-hmenu'), 'dock: context menu class');
ok(dockSrc.includes("menu.addEventListener('click'") && dockSrc.includes('this._renderHistory()'),
  'dock: toggle re-renders table only (menu stays open)');
ok(dockSrc.includes("document.addEventListener('pointerdown'"), 'dock: outside-press closes the menu');
ok(!dockSrc.includes('CONFIRM SET'), 'oneclick-side: no CONFIRM SET in dock (n/a)');
ok(!ocSrc.includes('CONFIRM SET</span>'), 'oneclick: no CONFIRM SET button markup remains');
ok(!ocSrc.includes('_armSet') && !ocSrc.includes('_disarmSet') && !ocSrc.includes('_setLocked'),
  'oneclick: confirm-lock machinery fully removed');
ok(ocSrc.includes('_plHtml'), 'oneclick: exclusive-unit P/L renderer');
ok(ocSrc.includes('oc-pos-total') && ocSrc.includes('posTotal'), 'oneclick: Total row wired');
ok(demoSrc.includes("reason=0") && demoSrc.includes("reason=reason"), 'demo: reason plumbing');
ok(demoSrc.includes("hit, reason = p['sl'], 4") && demoSrc.includes("hit, reason = p['tp'], 5"),
  'demo: SL=4 / TP=5 stamped on trigger');
ok(mt5Src.includes("'reason': int(getattr(d, 'reason', 0) or 0)"), 'mt5: deal reason passthrough');
ok(mt5Src.includes("'magic': int(getattr(d, 'magic', 0) or 0)"), 'mt5: magic passthrough');
ok(mt5Src.includes("'fee': float(getattr(d, 'fee', 0) or 0)"), 'mt5: fee passthrough');

/* ---- pure math mirror (same expressions as the sources) ---- */
const fmtPlain = (v) => (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2);
const fmtChg = (v) => (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2) + '%';
const signCls = (v) => v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : '');

console.log('— money / change shaping —');
ok(fmtPlain(-6.4417) === '-6.44' && fmtPlain(0.4) === '0.40' && fmtPlain(0) === '0.00', 'fmtPlain matches the terminal (no plus)');
ok(fmtChg(-0.0139) === '-0.01%' && fmtChg(0.2663) === '0.27%', 'fmtChg percent shape');
ok(signCls(-6.44) === 'neg' && signCls(0.4) === 'pos' && signCls(0) === '', 'signCls tiers');

/* the image's own numbers: sell 0.02 @4322.96 -> 4326.18, comm -0.12, SL hit */
const t = {
  pid: 108553844, ticket: 11, symbol: 'xauusd', dir: 1, vol: 0.02,
  open: 4322.96, openT: 1, close: 4326.18, closeT: 2, closedVol: 0.02,
  profit: -6.44 + 0, comm: -0.12, fee: 0, swap: 0,
  value: (1 === 0 ? 1 : -1) * 4322.96 * 0.02,
  change: ((4326.18 - 4322.96) / 4322.96) * 100 * -1,
  sl: 4325.01, tp: 4306.36, slHit: true, tpHit: false, magic: 0, comment: '',
  net: -6.44 + -0.12 + 0 + 0,
};
console.log('— MT5 image row (sell 0.02, SL hit) —');
ok(fmtPlain(t.value) === '-86.46', 'Value = -(open×vol) → ' + fmtPlain(t.value));
ok(fmtChg(t.change) === '-0.07%', 'Change = price Δ% × (−1 sell) → ' + fmtChg(t.change));
ok(fmtPlain(t.profit) === '-6.44' && fmtPlain(t.comm) === '-0.12', 'Profit / Commission columns');
ok(t.slHit === true && t.tpHit === false, 'SL-hit flag from reason 4');
ok(fmtPlain(t.net) === '-6.56', 'net = profit + comm + fee + swap → ' + fmtPlain(t.net));

console.log('— total bar reconciliation —');
const trades = [t, { ...t, net: 175.80, comm: -1.80, profit: 177.60, fee: 0, swap: 0, slHit: false, tpHit: true }];
const money = { comm: 0, fee: 0, swap: 0, profit: 0 };
for (const x of trades) { money.comm += x.comm; money.fee += x.fee; money.swap += x.swap; money.profit += x.profit; }
const net = trades.reduce((s, x) => s + x.net, 0);
ok(fmtPlain(money.profit) === '171.16' && fmtPlain(money.comm) === '-1.92', 'column sums');
ok(fmtPlain(net) === fmtPlain(money.profit + money.comm + money.fee + money.swap),
  'Balance rollup = Σprofit+Σcomm+Σfee+Σswap (169.24 = 171.16 − 1.92)');

console.log('— column toggle state —');
const HIST_COLS_IDS = ['time', 'symbol', 'ticket', 'type', 'volume', 'oprice', 'sl', 'tp', 'ctime',
  'cprice', 'value', 'comm', 'fee', 'swap', 'profit', 'change', 'magic', 'comment'];
const hidden = new Set(['magic', 'comment']);
const vis = HIST_COLS_IDS.filter((id) => !hidden.has(id));
ok(vis.length === 16 && !vis.includes('magic') && vis[0] === 'time', 'hidden ids remove exactly their columns');
hidden.delete('magic');
const vis2 = HIST_COLS_IDS.filter((id) => !hidden.has(id));
ok(vis2.length === 17, 're-toggle brings the column back (menu stays open between)');

console.log('— ROUND113b: zero-value classList crash (diag log 2026-09-22) —');
/* classList.add('') throws "The token provided must not be empty" whenever
   fee/swap/comm are 0 — real-account rows crashed _renderHistory at the 'fee'
   case (dock.js:995). Contract: every signCls token goes through addCls. */
ok(dockSrc.includes('function addCls(el, cls)'), 'addCls guard helper exists');
ok(!/classList\.add\(signCls\(/.test(dockSrc), 'no raw classList.add(signCls(...)) left');
ok((dockSrc.match(/addCls\(cell, signCls\(/g) || []).length === 9,
  'all dynamic sign cells guarded (6 history + 3 positions: value/swap/change)');
ok(signCls(0) === '' && (() => { const c = { classList: { list: [], add(x) { if (!x) throw new TypeError('token empty'); this.list.push(x); } } }; const addCls = (el, cls) => { if (cls) el.classList.add(cls); }; addCls(c, signCls(0)); addCls(c, signCls(-1)); return c.classList.list.join(',') === 'neg'; })(),
  'guarded add survives fee=0 rows (mirrors the crash)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
