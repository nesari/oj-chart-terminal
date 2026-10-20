/* ROUND116 — pendings everywhere + chart-type-proof trade lines + the 2s
   hover hold + no hover through the floating panel.
   Source contracts (same style as earlier rounds) + behavior mirrors. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};

const ovSrc = fs.readFileSync('src/renderer/js/trade/overlay.js', 'utf8');
const dockSrc = fs.readFileSync('src/renderer/js/trade/dock.js', 'utf8');
const cssSrc = fs.readFileSync('src/renderer/css/trade.css', 'utf8');

console.log('— ROUND116a: trade lines survive every chart type —');
ok(ovSrc.includes('st.series !== pane.series') && ovSrc.includes('st.series = pane.series;'),
  'overlay: rebuild when the series INSTANCE changed (style swap heals)');
ok(ovSrc.includes("series: null, dwell: null, lastX: 0, lastY: 0"),
  'overlay: per-pane state carries the series ref + hold timer');

console.log('— ROUND116b: 2-second hover hold (no tag on crossing) —');
ok(/const TIP_DWELL_MS = 2000;/.test(ovSrc), 'hold duration = 2000ms');
ok(ovSrc.includes('this._armDwell(pane, st, key);') && ovSrc.includes('_fireDwell(pane, st, key)'),
  'hover arms a hold instead of showing the tag instantly');
{
  /* the fire path must NOT re-verify the pointer (the ROUND106 live-chart
     lesson: scale re-fits move the line's Y away from a parked cursor) */
  const fire = ovSrc.slice(ovSrc.indexOf('_fireDwell(pane, st, key) {'));
  const fireBody = fire.slice(0, fire.indexOf('\n  },'));
  ok(!fireBody.includes('this._hit('), 'fire path never re-hits the pointer position');
}
ok(ovSrc.includes('if (st.dwell) { try { clearTimeout(st.dwell.timer); } catch (e) {} st.dwell = null; }'),
  'leaving the lines cancels the running hold');
ok(ovSrc.includes("if (st.dwell && st.dwell.key === key) return;"),
  're-arming the SAME line keeps its hold alive (60Hz jitter cannot reset it)');

console.log('— ROUND116c: no hover through the floating panel —');
ok(ovSrc.includes("e.target.closest('.oc-panel, .oc-pill')"),
  'the trade panel + pill are excluded from the hover path');
ok(ovSrc.includes('const over = !onFloat && pane.root && pane.root.contains(e.target);'),
  'pointer on the floating widget reads as off-chart (cursor/tag/hold dropped)');

console.log('— ROUND116d: pendings ride the Positions grid —');
ok(dockSrc.includes('_orderVm(o)') && /_orderVm\(o\)/.test(dockSrc),
  'dock: order view-model exists');
ok(dockSrc.includes('.concat(ordRows.map((o) => this._orderVm(o)))'),
  'dock: Positions grid lists positions THEN pending orders (ROUND117: of the ACTIVE account)');
ok(dockSrc.includes('if (!posRows.length && !ordRows.length) {'),
  'dock: pendings-only account still renders the grid');
ok(dockSrc.includes("(OT_NAME[t.type] || 'pending').toLowerCase()") &&
   dockSrc.includes("cell.classList.add('td-pend')"),
  'dock: Type cell names the order (buy limit …) with the pending class');
ok(dockSrc.includes("cell.textContent = t.pl == null ? '—' : fmtPlain(t.pl);"),
  'dock: a resting order shows an honest — for Profit');
ok(dockSrc.includes("if (t.pending) this._cancelButton(t, cell);") &&
   dockSrc.includes("actionLabel: 'Cancel order'"),
  'dock: cancel goes through the inline-confirm toast');
ok(dockSrc.includes('TradeRoute.cancel(t.ticket)'),
  'dock: cancel routes to the ACTIVE account (ROUND117 — demo pendings cancel too)');
ok(dockSrc.includes('const ord = TradeRoute.orders().find((o) => o.ticket === t);'),
  'dock: live pass keeps pending rows fresh (Current + Change, no fake profit)');
ok(cssSrc.includes('.td-h2item .td-pend'), 'css: pending orange style exists');

console.log('— ROUND116e: behavior mirrors —');
/* pending view-model mirror (1:1 with _orderVm) */
const OT_NAME = { 2: 'Buy Limit', 3: 'Sell Limit', 4: 'Buy Stop', 5: 'Sell Stop', 6: 'Buy Stop Limit', 7: 'Sell Stop Limit' };
const orderVm = (o) => {
  const dir = (o.type >= 2) ? (o.type % 2 === 0 ? 0 : 1) : (o.type === 0 ? 0 : 1);
  const cur = o.current || o.price || 0;
  return {
    pending: true, p: null, ticket: o.ticket, symbol: o.symbol, dir, type: o.type,
    vol: o.volume, open: o.price, openT: o.time, cur, sl: o.sl || 0, tp: o.tp || 0,
    swap: null, pl: null, comment: o.comment || '',
    value: (dir === 0 ? 1 : -1) * (o.price || 0) * (o.volume || 0),
    change: (o.price > 0 && cur > 0) ? ((cur - o.price) / o.price) * 100 * (dir === 0 ? 1 : -1) : 0,
  };
};
{
  const cases = [[2, 0], [3, 1], [4, 0], [5, 1], [6, 0], [7, 1]];
  ok(cases.every(([t, d]) => orderVm({ type: t, price: 1.1, volume: 0.1, current: 1.1 }).dir === d),
    'order side mapping: limit/stop/stop-limit buy=2,4,6 sell=3,5,7');
  const vm = orderVm({ ticket: 7, symbol: 'EURUSD', type: 2, volume: 0.02, price: 1.0800, current: 1.0850, time: 100, comment: 'r116' });
  ok(vm.pl === null && vm.swap === null, 'resting order carries no floating P/L / swap');
  ok(vm.value >= 0 && Math.abs(vm.value - 1.08 * 0.02) < 1e-9, 'Value = ±price·volume (buy: positive)');
  ok(Math.abs(vm.change - 0.4629629629629629) < 1e-9, 'Change = distance from the order price (live)');
  ok(OT_NAME[2] === 'Buy Limit' && OT_NAME[5] === 'Sell Stop', 'MT5 order names for the Type cell');
}
/* dwell mirror (1:1 with _armDwell/_fireDwell/_clearDwell) */
{
  const TIP_DWELL_MS = 2000;
  const mk = () => ({ dwell: null, tipKey: null, tipShown: false });
  let now = 0;
  const pending = [];
  const setTimeout = (fn, ms) => { const t = { at: now + ms, fn, cleared: false }; pending.push(t); return t; };
  const clearTimeout = (t) => { t.cleared = true; };
  const runDue = () => { for (const t of pending) if (!t.cleared && now >= t.at) { t.cleared = true; t.fn(); } };
  const arm = (st, key) => {
    if (st.dwell && st.dwell.key === key) return;
    if (st.dwell) clearTimeout(st.dwell.timer);
    st.dwell = { key, timer: setTimeout(() => fire(st, key), TIP_DWELL_MS) };
  };
  const fire = (st, key) => { st.dwell = null; st.tipKey = key; st.tipShown = true; };
  const clear = (st) => { if (st.dwell) clearTimeout(st.dwell.timer); st.dwell = null; st.tipKey = null; st.tipShown = false; };

  const st = mk();
  arm(st, 'sl#1'); now = 400; runDue();
  ok(!st.tipShown, 'hold 0.4s on the line: NO tag yet');
  now = 1500; runDue();
  ok(!st.tipShown, 'hold 1.5s: still NO tag');
  arm(st, 'sl#1');                                   // jitter re-arm, same key
  now = 2000; runDue();
  ok(st.tipShown && st.tipKey === 'sl#1', 'hold 2.0s (with same-key re-arms): tag shows');
  clear(st);
  ok(!st.tipShown && !st.dwell, 'leave cancels everything');

  const s2 = mk();                                   // the user's sweep case
  arm(s2, 'entry#1'); now += 300; runDue();
  arm(s2, 'sl#1'); now += 300; runDue();             // crossed to another line
  arm(s2, 'tp#1'); now += 600; runDue();
  ok(!s2.tipShown, 'sweeping across three lines (1200ms total): nothing flashes');
  arm(s2, 'tp#1'); now += 2000; runDue();
  ok(s2.tipShown && s2.tipKey === 'tp#1', 'parked on the last line for 2s: its tag shows');
}

console.log('\nROUND116: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
