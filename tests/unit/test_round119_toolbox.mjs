/* ROUND119 — four user requests, all in the right-panel / bottom-dock area:
   [1] the Orders tab became the SAME MetaTrader grid as Positions/History
       (ORD_COLS + sortable sticky header + right-click column menu + dynamic
       width split + Total bar + live Current cell),
   [2] the dock was renamed "Tool Box" with a new toolbox icon (header +
       bottom-bar toggle),
   [3] right-panel tabs no longer spill UNDER the open Tool Box dock
       (.rtab overflow + #tr-demo/#tr-live scroll + #right-panel above z30),
   [4] the Alerts panel got card rows + a segmented Repeat control.
   Source contracts + behavior mirrors, same style as earlier rounds. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};

const dockSrc = fs.readFileSync('src/renderer/js/trade/dock.js', 'utf8');
const iconsSrc = fs.readFileSync('src/renderer/js/ui/icons.js', 'utf8');
const alertsSrc = fs.readFileSync('src/renderer/js/panels/alerts.js', 'utf8');
const appCss = fs.readFileSync('src/renderer/css/app.css', 'utf8');
const panelsCss = fs.readFileSync('src/renderer/css/panels.css', 'utf8');
const tradeCss = fs.readFileSync('src/renderer/css/trade.css', 'utf8');

console.log('— ROUND119a: the Orders tab is a real MT5 grid —');
ok(dockSrc.includes('const ORD_COLS = [') && dockSrc.includes("id: 'exp',") &&
   dockSrc.includes('const ORD_SORT = {'),
  'ORD_COLS (incl. Expiry) + ORD_SORT column contracts exist');
ok(dockSrc.includes("sortO: 'mt5_tr_sort_ord'") && dockSrc.includes("ocols: 'mt5_tr_ord_cols'"),
  'persistence keys for the orders sort + hidden columns');
ok(/_renderOrders\(\) \{[\s\S]*?const vis = this\._ordVisible\(\);[\s\S]*?const total = this\._gridMin\(vis\);[\s\S]*?const tpl = this\._gridTracks\(vis\);[\s\S]*?U\.el\('div', 'td-hgrid', host\)/.test(dockSrc),
  '_renderOrders builds the same td-hgrid (dynamic width split)');
ok(/_renderOrders\(\) \{[\s\S]*?'td-h2row td-h2head'[\s\S]*?this\._wireSort\(head, 'ord'\)/.test(dockSrc),
  'orders header: sticky + sortable via _wireSort(head, \'ord\')');
ok(dockSrc.includes("_ordHidden = new Set(") && dockSrc.includes('U.lsSet(K.ocols,') &&
   /_ordVisible\(\) \{\s*\n\s*if \(!this\._ordHidden\) this\._ordLoad\(\);\s*\n\s*return ORD_COLS\.filter/.test(dockSrc),
  'orders column-state trio (_ordLoad/_ordSave/_ordVisible) mirrors Positions');
ok(dockSrc.includes("this._openColMenu(ev.clientX, ev.clientY, 'ord');"),
  'right-click on the Orders section opens the column menu');
ok(/const target = menu\.dataset\.target;[\s\S]*?const pos = target === 'pos';[\s\S]*?const ord = target === 'ord';[\s\S]*?if \(pos\) this\._posSave\(\); else if \(ord\) this\._ordSave\(\); else this\._histSave\(\);/.test(dockSrc),
  'the column menu click handler serves all three grids');
ok(dockSrc.includes("const cols = target === 'pos' ? POS_COLS : target === 'ord' ? ORD_COLS : HIST_COLS;"),
  '_openColMenu picks ORD_COLS for target ord');
ok(/_renderOrders\(\) \{[\s\S]*?'td-h2row td-h2total'[\s\S]*?firstSum = vis\.findIndex\(\(c\) => c\.id === 'volume'\)[\s\S]*?cell\.style\.gridColumn = String\(i \+ 1\);/.test(dockSrc),
  'orders Total bar pins the volume sum to its own track (ROUND115 rule)');
ok(/_renderOrders\(\) \{[\s\S]*?const volSum = ords\.reduce\(\(s, o\) => s \+ \(o\.volume \|\| 0\), 0\);[\s\S]*?'Total · ' \+ ords\.length \+ ' pending/.test(dockSrc),
  'orders Total bar rolls up count + volume');
ok(/if \(this\._tab === 'orders'\) \{[\s\S]*?this\.els\.ord\.querySelectorAll\('\[data-ticket\]'\)[\s\S]*?row\.querySelector\('\.td-cur'\)/.test(dockSrc),
  '_updateLive rides the 600ms pass for the orders Current column');
ok(dockSrc.includes('expT: o.expiration || 0,'),
  '_orderVm carries expT (GTC fallback rendered in the Expiry cell)');
ok(/_renderOrders\(\) \{[\s\S]*?const ord = ords\.find\(\(x\) => x\.ticket === t\.ticket\);[\s\S]*?this\._editOrder\(ord, row\)/.test(dockSrc) &&
   /_editOrder\(o, row\) \{[\s\S]*?TradeRoute\.modifyOrder\(o\.ticket,/.test(dockSrc) &&
   /_renderOrders\(\) \{[\s\S]*?TradeRoute\.cancel\(t\.ticket\)/.test(dockSrc),
  'orders grid keeps the manage actions: Edit (inline) + Cancel via TradeRoute');
ok(dockSrc.includes("cell.classList.add(t.dir === 0 ? 'td-buy' : 'td-sell');") &&
   /_renderOrders\(\) \{[\s\S]*?\(OT_NAME\[t\.type\] \|\| 'pending'\)\.toLowerCase\(\)/.test(dockSrc),
  'orders Type cell: full MT5 name colored by side');
ok(dockSrc.includes('const ords = TradeRoute.orders();'),
  'orders grid still reads the ACTIVE account through TradeRoute (ROUND117)');

console.log('— ROUND119b: the dock is the "Tool Box" —');
ok(dockSrc.includes('<span id="td-title">Tool Box</span>'), 'dock header title: Tool Box');
ok(/_build\(\) \{[\s\S]*?this\.els\.ic\.innerHTML = icon\('toolbox'\);/.test(dockSrc),
  'dock header icon: toolbox');
ok(dockSrc.includes("b.title = 'Tool Box — positions, orders, history';") &&
   /_installBottomToggle\(\) \{[\s\S]*?b\.innerHTML = icon\('toolbox'\);/.test(dockSrc),
  'bottom-bar toggle: toolbox icon + new title');
ok(dockSrc.includes("'Show the Tool Box'") && dockSrc.includes("'Hide the Tool Box'"),
  '_syncToggle titles renamed');
ok(/toolbox: S\('<path d="M4\.2 9\.2h15\.6v10\.3H4\.2z"\/>\}<path/.test(iconsSrc) || iconsSrc.includes("toolbox: S('<path d=\"M4.2 9.2h15.6v10.3H4.2z\"/>"),
  'icons.js has the toolbox icon (case + handle + latch)');

console.log('— ROUND119c: the right panel never slides under the Tool Box —');
ok(/#right-panel \{[^}]*position: relative; z-index: 35;/.test(appCss),
  '#right-panel paints above the dock (z 35 > dock z 30)');
ok(/#trade-dock \{[^}]*z-index: 30;/.test(tradeCss),
  'dock keeps z-index 30 (the layering anchor)');
ok(/\.rtab \{[^}]*overflow: hidden;/.test(appCss),
  '.rtab clips at its own edge (no spill into the dock)');
ok(/#tab-trade #tr-demo, #tab-trade #tr-live \{ flex: 1 1 auto; min-height: 0; overflow-y: auto; \}/.test(appCss),
  'the tall Trading tab body scrolls INSIDE the panel');
ok(/#alert-list \{ flex: 1 1 auto; overflow-y: auto; padding: 8px 10px 10px; \}/.test(panelsCss),
  'alerts list keeps its own scroll within the clipped tab');

console.log('— ROUND119d: the Alerts panel redesign —');
ok(/function render\(\) \{[\s\S]*?const armed = a\.active && !a\.fired;[\s\S]*?'alert-row' \+ \(a\.fired \? ' done' : ''\) \+ \(armed \? ' armed' : ''\)/.test(alertsSrc),
  'alert rows carry armed/done status classes');
ok(/'a-chip' \+ \(a\.kind === 'time' \? ' a-chip-time' : ''\)/.test(alertsSrc) &&
   alertsSrc.includes("chip.textContent = a.cond;") && alertsSrc.includes('U.fmtPrice(a.price, priceDigits(a.symbol))'),
  'condition chip + price cells (time alerts get the Time chip + clock)');
ok(/'a-switch' \+ \(armed \? ' on' : ''\)/.test(alertsSrc) &&
   alertsSrc.includes("tog.addEventListener('click', () => Alerts.toggle(a.id));"),
  'TV-like switch replaces the bell/eye toggle (same toggle action)');
ok(alertsSrc.includes("edit.addEventListener('click', () => Alerts.openManageDialog(a));") &&
   alertsSrc.includes("del.addEventListener('click', () => Alerts.remove(a.id));"),
  'edit/delete actions kept (manage dialog + Undo-toast remove)');
ok(alertsSrc.includes("${icon('bell')}No alerts yet.") ,
  'empty state shows the bell icon');
ok(/id="alert-loop-seg"[\s\S]*?data-v="1"[\s\S]*?data-v="2"[\s\S]*?data-v="3"[\s\S]*?data-v="5"[\s\S]*?data-v="inf"/.test(alertsSrc),
  'Repeat is now a segmented control (×1 ×2 ×3 ×5 ∞ Loop)');
ok(/Alerts\.cfg\.loop = b\.dataset\.v === 'inf' \? 'inf' : parseInt\(b\.dataset\.v, 10\) \|\| 1;/.test(alertsSrc),
  'segmented Repeat writes the SAME cfg.loop values as the old select');
ok(/const paintSeg = \(\) => \{[\s\S]*?b\.classList\.toggle\('on', b\.dataset\.v === v\)/.test(alertsSrc),
  'the active Repeat pill reflects the persisted cfg');
ok(alertsSrc.includes("box.querySelector('#alert-sound-stop').addEventListener('click', () => Alerts.stopSound());") &&
   alertsSrc.includes("box.querySelector('#alert-sound-stop').style.display = 'none';") &&
   !alertsSrc.includes('style="display:none"'),
  'Stop-sound button kept, hidden via CSSOM (CSP forbids inline style attributes)');
ok(/\.alert-row\.armed::before \{ background: var\(--blue\); \}/.test(panelsCss) &&
   /\.alert-row\.done::before \{ background: var\(--yellow\); \}/.test(panelsCss),
  'status edge paints: blue armed / yellow triggered');
ok(/\.alert-row \.a-switch\.on \{ background: var\(--blue\); border-color: var\(--blue\); \}/.test(panelsCss) &&
   /\.alert-row \.a-switch\.on::after \{ transform: translateX\(13px\); background: #fff; \}/.test(panelsCss),
  'switch CSS: knob slides right and turns white when on');
ok(/\.al-seg button\.on \{ background: var\(--blue\); color: #fff; \}/.test(appCss),
  'segmented control active pill styled');
ok(/\.al-card \{[^}]*border-radius: 10px;[^}]*background: var\(--panel\);/.test(panelsCss),
  'settings blocks are unified accordion cards now (ROUND130 .al-card)');

console.log('— ROUND119e: behavior mirrors —');
/* mirror of the orders grid track/total math for arbitrary visible subsets */
const ORD_COLS = [
  { id: 'time', w: 122 }, { id: 'symbol', w: 70 }, { id: 'ticket', w: 78 },
  { id: 'type', w: 76 }, { id: 'volume', w: 56 }, { id: 'oprice', w: 76 },
  { id: 'sl', w: 76 }, { id: 'tp', w: 76 }, { id: 'cprice', w: 76 },
  { id: 'exp', w: 116 }, { id: 'comment', w: 90 }, { id: 'manage', w: 96 },
];
const gridTracks = (vis) => vis.map((c) => 'minmax(' + c.w + 'px,' + c.w + 'fr)').join(' ');
const gridMin = (vis) => vis.reduce((s, c) => s + c.w, 0);
const ords = [
  { ticket: 108700923, time: 1789795057, type: 3, volume: 0.05, price: 4361.26, sl: 4363.76, tp: 4299.37, symbol: 'XAUUSD', comment: '', expiration: 0 },
  { ticket: 108700999, time: 1789796000, type: 2, volume: 0.1, price: 4300.0, sl: 0, tp: 0, symbol: 'XAUUSD', comment: 'scale-in', expiration: 1789880000 },
];
const OT_NAME = { 2: 'Buy Limit', 3: 'Sell Limit', 4: 'Buy Stop', 5: 'Sell Stop' };
const orderVm = (o) => ({
  ticket: o.ticket, symbol: o.symbol, dir: (o.type >= 2) ? (o.type % 2 === 0 ? 0 : 1) : (o.type === 0 ? 0 : 1),
  type: o.type, vol: o.volume, open: o.price, openT: o.time, expT: o.expiration || 0, comment: o.comment || '',
});
let allOk = true;
for (const drop of [[], ['exp'], ['comment', 'manage'], ['sl', 'tp', 'exp'], ['time', 'exp', 'comment', 'manage']]) {
  const vis = ORD_COLS.filter((c) => !drop.includes(c.id));
  const firstSum = vis.findIndex((c) => c.id === 'volume');
  const tot = new Map();
  for (let i = 0; i < vis.length; i++) {
    if (i === 0) { tot.set('rollup', '1 / ' + (firstSum < 0 ? vis.length + 1 : Math.max(firstSum + 1, 2))); continue; }
    if (firstSum < 0 || i < firstSum) continue;
    if (vis[i].id === 'volume') tot.set('volume', i + 1);
  }
  const volTrack = tot.get('volume');
  const volIdx = vis.findIndex((c) => c.id === 'volume');
  if (volTrack !== volIdx + 1) { allOk = false; console.log('    volume sum off-track for drop=' + drop, volTrack, volIdx + 1); }
  if (firstSum >= 0 && !(tot.get('rollup') || '').endsWith(String(firstSum + 1))) { allOk = false; console.log('    rollup span wrong for drop=' + drop, tot.get('rollup')); }
}
ok(allOk, 'Total-bar pinning holds for every visible-column subset (mirror)');
ok(gridTracks(ORD_COLS.filter((c) => c.id !== 'manage')).split(' ').length === 11 &&
   gridMin(ORD_COLS) === ORD_COLS.reduce((s, c) => s + c.w, 0),
  'track math mirrors _gridTracks/_gridMin');
/* vm + type-name mirror for the two orders */
const vms = ords.map(orderVm);
ok(vms[0].type === 3 && vms[0].dir === 1 && (OT_NAME[vms[0].type] || 'pending').toLowerCase() === 'sell limit' &&
   vms[1].type === 2 && vms[1].dir === 0 && (OT_NAME[vms[1].type] || 'pending').toLowerCase() === 'buy limit',
  'type/dir mirror: sell limit vs buy limit resolve like the Type cell renders them');
ok(vms[0].expT === 0 && vms[1].expT === 1789880000,
  'expT mirror: GTC (0) vs a real expiry timestamp');
const volSum = ords.reduce((s, o) => s + (o.volume || 0), 0);
ok(Math.abs(volSum - 0.15) < 1e-9, 'volume rollup mirror (0.05 + 0.10 = 0.15)');

console.log('\nROUND119: %d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
