/* ROUND117 — pendings set by the user are visible in the ACTIVE account
   everywhere (dock Positions grid + Orders tab + account bar), and the DEMO
   chart overlay self-heals across chart-type switches.

   The user's bug: pendings placed via the floating panel (Demo mode) lived
   only inside the client-side demo engine — the dock read the live wire
   (Trade.positions/Trade.orders) exclusively, so a demo pending appeared
   NOWHERE: not in the grid, not on the chart after a style switch (the demo
   overlay lacked the ROUND116 series self-heal). Source contracts + behavior
   mirrors, same style as earlier rounds. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};

const routeSrc = fs.readFileSync('src/renderer/js/trade/route.js', 'utf8');
const rtSrc = fs.readFileSync('src/renderer/js/trade/replaytrade.js', 'utf8');
const dockSrc = fs.readFileSync('src/renderer/js/trade/dock.js', 'utf8');

console.log('— ROUND117a: route facade serves the ACTIVE account\u2019s pendings —');
ok(/orders\(\) \{\s*\n\s*if \(this\.isDemo\(\) && this\.demo\) \{[\s\S]*?this\.demo\.orders\(\)[\s\S]*?return Trade\.orders;\s*\n\s*\},/.test(routeSrc),
  'route.orders(): demo → engine rows, live → Trade.orders');
ok(routeSrc.includes('cancel(ticket)') && routeSrc.includes('this.demo.cancelOrder(ticket)') &&
   routeSrc.includes('return Trade.cancelOrder(ticket);'),
  'route.cancel(): demo → engine cancel, live → broker order_cancel');
ok(routeSrc.includes('modifyOrder(ticket, price, sl, tp, typeTime, expiration)') &&
   routeSrc.includes('this.demo.modifyOrder(ticket, price, sl, tp)') &&
   routeSrc.includes('return Trade.modifyOrder(ticket, price, sl, tp, typeTime, expiration);'),
  'route.modifyOrder(): demo → engine modify, live → broker order_modify');
ok(routeSrc.includes('account()') && routeSrc.includes('margin_free: a.free') &&
   routeSrc.includes('margin_level: a.level') && routeSrc.includes('trade_allowed: true') &&
   routeSrc.includes('demo: true'),
  'route.account(): demo row mapped into the live wire\u2019s shape (demo flag set)');
ok(routeSrc.includes('if (d && d.onEngineChange) d.onEngineChange(() => this._fireChange());'),
  'setDemoDelegate: the engine\u2019s changed() reaches route.onChange');
ok(routeSrc.includes('_fireChange() {') &&
   routeSrc.includes('for (const f of this.onChange) { try { f(); } catch (e) {} }'),
  'route fires its listeners on demo state changes (mode flip already did)');

console.log('— ROUND117b: demo engine exposes its change list + heals its lines —');
ok(rtSrc.includes('ReplayTrade.onEngineChange = (fn) => { D.onChange.push(fn); };'),
  'replaytrade: onEngineChange facade (route subscribes through it)');
ok(rtSrc.includes('st.series !== pane.series') && rtSrc.includes('st.series = pane.series;'),
  'replaytrade overlay: rebuild when the series INSTANCE changed (style swap heals — the same fix ROUND116 gave trade/overlay.js)');
ok(rtSrc.includes("{ symbol: null, series: null, key: '', lines: [], dragReady: false, hlTicket: null }"),
  'replaytrade overlay: per-pane state carries the series ref');

console.log('— ROUND117c: the dock grids read the ACTIVE account —');
ok(dockSrc.includes("import { TradeRoute } from './route.js';"),
  'dock: TradeRoute imported (no cycle — route never imports dock)');
ok(dockSrc.includes('TradeRoute.onChange.push(() => {') &&
   dockSrc.includes('this._render();'),
  'dock: re-renders on demo state changes (place/activate/cancel/modify — ROUND120 wrapper also drops the stale-mode history cache)');
ok(dockSrc.includes('const posRows = TradeRoute.positions();') &&
   dockSrc.includes('const ordRows = TradeRoute.orders();'),
  'dock: Positions grid lists the ACTIVE account\u2019s positions + pendings');
ok(dockSrc.includes('TradeRoute.quote(p.symbol)') && dockSrc.includes('TradeRoute.profitOf(p)'),
  'dock: position vm routes quote + floating P/L (demo math in demo mode)');
ok(dockSrc.includes('TradeRoute.quote(o.symbol)'),
  'dock: pending vm rides the route quote too');
ok(dockSrc.includes('const pos = TradeRoute.positions().find((p) => p.ticket === t);') &&
   dockSrc.includes('const ord = TradeRoute.orders().find((o) => o.ticket === t);') &&
   dockSrc.includes('const v = TradeRoute.profitOf(pos);'),
  'dock: the 600ms live pass updates ACTIVE-account rows');
ok(dockSrc.includes("const n = b.dataset.t === 'positions' ? TradeRoute.positions().length") &&
   dockSrc.includes(": b.dataset.t === 'orders' ? TradeRoute.orders().length : 0;"),
  'dock: tab badges count the ACTIVE account');
ok(dockSrc.includes('const acc = TradeRoute.account();') &&
   dockSrc.includes("e.status.textContent = acc.demo ? 'demo' : (Trade.online ? 'live' : '…');"),
  'dock: account bar shows the ACTIVE account (demo chip in demo mode)');
ok(dockSrc.includes('const ords = TradeRoute.orders();') &&
   dockSrc.includes('TradeRoute.cancel(t.ticket)') &&
   dockSrc.includes('TradeRoute.modifyOrder(o.ticket,'),
  'dock: Orders tab lists + manages ACTIVE-account pendings (cancel/edit)');
ok(dockSrc.includes('TradeRoute.close(p.ticket, Math.min(half, p.volume))') &&
   dockSrc.includes('TradeRoute.close(p.ticket, 0)') &&
   dockSrc.includes('TradeRoute.modifySLTP(p.ticket, sl2, tp2)'),
  'dock: Manage buttons (50% / close / SL-TP editor) route to the ACTIVE account');
ok(!dockSrc.includes('Trade.cancelOrder(') && !dockSrc.includes('Trade.closePosition(') &&
   !dockSrc.includes('Trade.modifyOrder(') && !dockSrc.includes('Trade.modifySLTP(') &&
   !dockSrc.includes('.concat(Trade.orders.map') && !dockSrc.includes('for (const p of Trade.positions)'),
  'dock: no direct live-wire trade reads/actions left in the tables');

console.log('— ROUND117d: behavior mirrors —');
/* mirror 1: demo order row (no current/comment) → _orderVm shape */
const OT_NAME = { 2: 'Buy Limit', 3: 'Sell Limit', 4: 'Buy Stop', 5: 'Sell Stop' };
const routeQuote = { bid: 1.0849, ask: 1.0851 };           /* what TradeRoute.quote returns */
const orderVm = (o) => {
  const dir = (o.type >= 2) ? (o.type % 2 === 0 ? 0 : 1) : (o.type === 0 ? 0 : 1);
  const cur = Number(dir === 0 ? (routeQuote.bid || o.current) : (routeQuote.ask || o.current)) ||
    o.current || o.price || 0;
  return {
    pending: true, p: null, ticket: o.ticket, symbol: o.symbol, dir,
    type: o.type, vol: o.volume, open: o.price, openT: o.time, cur,
    sl: o.sl || 0, tp: o.tp || 0, swap: null, pl: null, comment: o.comment || '',
    value: (dir === 0 ? 1 : -1) * (o.price || 0) * (o.volume || 0),
    change: (o.price > 0 && cur > 0) ? ((cur - o.price) / o.price) * 100 * (dir === 0 ? 1 : -1) : 0,
  };
};
{
  /* the exact row ReplayTrade.orders() hands the dock for a demo pending */
  const demoOrder = { ticket: 500002, time: 1758500000, type: 2, volume: 0.05,
    price: 1.0800, sl: 0, tp: 0 };                        /* NO current, NO comment */
  const vm = orderVm(demoOrder);
  ok(vm.pending === true && vm.ticket === 500002 && vm.type === 2 && vm.dir === 0,
    'demo pending (buy limit) rides the grid vm: pending flag + MT5 type');
  ok(vm.cur === routeQuote.bid, 'demo row\u2019s Current falls back to the route quote (no wire current)');
  ok(vm.comment === '' && vm.pl === null && vm.swap === null, 'honest empties survive the demo shape');
  ok(OT_NAME[vm.type] === 'Buy Limit', 'Type cell name resolves for the demo row');
  const sell = orderVm({ ticket: 500003, time: 1758500001, type: 5, volume: 0.02, price: 1.0900, sl: 0, tp: 0 });
  ok(sell.cur === routeQuote.ask && sell.dir === 1, 'sell-side pending quotes off ask');
}

/* mirror 2: demo engine account() → route.account() mapping */
{
  const demoAcc = { balance: 10000, equity: 10123.45, margin: 200, floating: 123.45,
    free: 9923.45, level: 5061.7 };
  const mapped = {
    balance: demoAcc.balance || 0, equity: demoAcc.equity || 0, profit: demoAcc.floating || 0,
    margin: demoAcc.margin || 0, margin_free: demoAcc.free, margin_level: demoAcc.level,
    trade_allowed: true, currency: 'USD', demo: true,
  };
  ok(mapped.margin_free === demoAcc.free && mapped.margin_level === demoAcc.level,
    'account mapping: free/level renamed to the wire names the bar reads');
  ok(mapped.demo === true && mapped.trade_allowed === true,
    'account mapping: demo flag + AutoTrading guard bypassed (demo never blocks)');
  ok(mapped.profit === demoAcc.floating, 'account mapping: floating P/L rides as profit');
}

/* mirror 3: mode switch flips the populations the dock reads */
{
  const live = { positions: [{ ticket: 11 }], orders: [{ ticket: 21 }] };
  const demo = { positions: [{ ticket: 31 }], orders: [{ ticket: 41 }] };
  const mkRoute = (mode) => ({
    isDemo: () => mode === 'demo',
    demo,
    positions() { return this.isDemo() && this.demo ? this.demo.positions : live.positions; },
    orders() { return this.isDemo() && this.demo ? this.demo.orders : live.orders; },
  });
  const r = mkRoute('live');
  ok(r.orders()[0].ticket === 21 && r.positions()[0].ticket === 11, 'LIVE mode: wire rows');
  r.isDemo = () => true;
  ok(r.orders()[0].ticket === 41 && r.positions()[0].ticket === 31,
    'DEMO mode: engine rows — a demo pending is now IN the grid\u2019s source');
}

/* mirror 4: engine changed() → route passthrough → dock re-render */
{
  const D = { onChange: [] };
  const onChangeUI = [];
  const engineChanged = () => { for (const f of D.onChange) { try { f(); } catch (e) {} } };
  const onEngineChange = (fn) => D.onChange.push(fn);
  const fireChange = () => { for (const f of onChangeUI) { try { f(); } catch (e) {} } };
  onEngineChange(fireChange);                             // setDemoDelegate passthrough
  onChangeUI.push(() => onChangeUI.rendered = (onChangeUI.rendered || 0) + 1);
  engineChanged();                                        // demo place/activate/cancel
  ok(onChangeUI.rendered === 1, 'demo place → engine changed() → route → dock re-render (the missing link before)');
  engineChanged();
  ok(onChangeUI.rendered === 2, 'demo activation re-renders: the pending row morphs in place');
}

/* mirror 5: the demo overlay\u2019s series self-heal (1:1 with _syncPane) */
{
  const mkSt = () => ({ symbol: null, series: null, key: '', lines: ['dead-line'] });
  let rebuilt = 0;
  const syncPane = (pane, st) => {
    if (st.symbol !== pane.symbol) { st.symbol = pane.symbol; st.key = ''; }
    if (st.series !== pane.series) { st.series = pane.series; st.key = ''; }
    const key = 'rows:' + pane.symbol;                    // structural key — unchanged by a style swap
    if (key === st.key) return;
    st.key = key; st.lines = []; rebuilt++;               // _clear + redraw on the NEW series
  };
  const pane = { symbol: 'EURUSD', series: { id: 'candle' } };
  const st = mkSt();
  syncPane(pane, st);
  ok(rebuilt === 1 && st.lines.length === 0, 'first sync builds the demo lines');
  syncPane(pane, st);
  ok(rebuilt === 1, 'same series: structural key short-circuits (no churn)');
  pane.series = { id: 'line' };                           // Manager.setStyle swapped the series
  syncPane(pane, st);
  ok(rebuilt === 2, 'chart-type switch: series-instance change forces the rebuild the old code never did');
  pane.series = { id: 'renko' };
  syncPane(pane, st);
  ok(rebuilt === 3, 'renko: demo pending lines live on every chart type');
}

console.log('\nROUND117: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
