/* ROUND114 — pure-logic checks for the Positions MT5 grid + shared column
   menu + dynamic width split + the pinned-pill restore bug.
   Runs source contracts (same style as test_round113) + math mirrors. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};

const dockSrc = fs.readFileSync('src/renderer/js/trade/dock.js', 'utf8');
const ocSrc = fs.readFileSync('src/renderer/js/trade/oneclick.js', 'utf8');

/* ---- mirrors of the pure functions (kept in sync with the sources) ---- */
const POS_COLS_IDS = ['time', 'symbol', 'ticket', 'type', 'volume', 'oprice', 'sl', 'tp',
  'cprice', 'value', 'swap', 'profit', 'change', 'comment', 'manage'];
const POS_W = { time: 122, symbol: 70, ticket: 78, type: 50, volume: 56, oprice: 76,
  sl: 76, tp: 76, cprice: 76, value: 70, swap: 56, profit: 70, change: 62, comment: 100, manage: 130 };
const gridTracks = (vis) => vis.map((c) => 'minmax(' + c.w + 'px,' + c.w + 'fr)').join(' ');
const gridMin = (vis) => vis.reduce((s, c) => s + c.w, 0);
const fmtPlain = (v) => (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2);
const fmtChg = (v) => (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2) + '%';

console.log('— ROUND114a: pinned pill restores (trade panel minimize bug) —');
ok(ocSrc.includes("this._drag = { kind, st, moved: false, frozen: true }"),
  'pinned pill press records an inert (frozen) drag');
ok(ocSrc.includes('if (!d || d.frozen) return'),
  'frozen drag never moves the widget');
ok(ocSrc.includes('if (d.moved && !d.frozen)'),
  'a frozen clean press cannot be persisted as a move');
ok(ocSrc.includes("} else if (d.kind === 'pill') {\n      this._setMin(false);"),
  'clean press on the pill still restores the panel');
/* simulate the old dead path: pin + press + release must reach _setMin */
{
  const drag = { kind: 'pill', moved: false, frozen: true };
  const restore = (d) => (d.kind === 'pill' && !(d.moved && !d.frozen)) || false;
  ok(restore(drag) === true, 'sim: pinned+minimized pill click -> restore fires');
  ok(restore({ kind: 'pill', moved: true, frozen: false }) === false, 'sim: a real drag does not restore');
}

console.log('— ROUND114b: Positions grid (same columns as History) —');
ok(dockSrc.includes("pcols: 'mt5_tr_pos_cols'"), 'dock: positions column persistence key');
ok(dockSrc.includes('_posLoad()') && dockSrc.includes('_posSave()') && dockSrc.includes('_posVisible()'),
  'dock: positions column-state trio exists');
ok(dockSrc.includes("const POS_COLS = [") && dockSrc.includes("const POS_SORT = {"),
  'dock: POS_COLS + POS_SORT defined');
ok(dockSrc.includes("id: 'manage'") && dockSrc.includes('this._manageButtons('),
  'dock: Manage survives as its own toggleable column');
ok(dockSrc.includes("e.pos.addEventListener('contextmenu'"),
  'dock: right-click on the Positions section opens the menu');
ok(dockSrc.includes("_openColMenu(ev.clientX, ev.clientY, 'hist')") &&
   dockSrc.includes("_openColMenu(ev.clientX, ev.clientY, 'pos')"),
  'dock: one target-aware menu serves both sections');
ok(dockSrc.includes('menu.dataset.target = target') && dockSrc.includes("const pos = target === 'pos';") && dockSrc.includes("const ord = target === 'ord';"),
  'dock: toggle acts on the section it was opened from (ROUND119: three grids)');
ok(dockSrc.includes("if (pos && this._tab === 'positions') this._renderPositions()"),
  'dock: toggling re-renders the Positions grid only (menu stays open)');
ok(dockSrc.includes("case 'cprice': cell.textContent = this._fmtP(t.symbol, t.cur); cell.classList.add('td-cur')"),
  'dock: Current Price is a live cell');
ok(dockSrc.includes("'td-h2row td-h2total', grid") && dockSrc.includes("'Total · '"),
  'dock: sticky MT5 Total bar with rollup');
ok(dockSrc.includes("td-chg") && dockSrc.includes("(cur - pos.open) / pos.open"),
  'dock: Change cell rides the live quote');

console.log('— ROUND114c: dynamic width split (no dead space) —');
ok(dockSrc.includes("minmax(' + c.w + 'px,' + c.w + 'fr)')"),
  'grid tracks are minmax(natural px, natural fr) — proportional fill');
ok(dockSrc.includes('const tpl = this._gridTracks(vis);') &&
   (dockSrc.match(/const tpl = this\._gridTracks\(vis\);/g) || []).length === 3,
  'all three grids (History + Positions + Orders) use the same dynamic track list');
ok(dockSrc.match(/const total = this\._gridMin\(vis\);/g || []).length === 3,
  'all three grids keep min-width = Σ natural widths (narrow dock scrolls)');
{
  const vis = POS_COLS_IDS.map((id) => ({ id, w: POS_W[id] }));
  const tpl = gridTracks(vis);
  ok(/^minmax\(\d+px,\d+fr\)( minmax\(\d+px,\d+fr\))+$/.test(tpl), 'track string shape');
  const half = vis.filter((c) => !['comment', 'change', 'value', 'swap'].includes(c.id));
  const sumAll = gridMin(vis), sumHalf = gridMin(half);
  /* fr weights re-derive from the VISIBLE set -> toggle redistributes */
  ok(sumAll === 1168 && sumHalf === 880, 'min sum follows the visible set (' + sumAll + ' → ' + sumHalf + ')');
  const before = (vis[0].w / sumAll) * 1400, after = (half[0].w / sumHalf) * 1400;
  ok(Math.round(after) === 194 && after - before > 0,
    'share of a column grows when others are hidden (' + Math.round(before) + 'px → ' + Math.round(after) + 'px)');
}

console.log('— ROUND114d: position view-model math —');
{
  const p = { ticket: 108553900, time: 1, type: 1, volume: 0.02, open: 4322.96,
    sl: 4325.01, tp: 0, current: 4326.18, swap: -0.4, profit: -5.9, symbol: 'xauusd', comment: '' };
  const dir = p.type === 0 ? 0 : 1;
  const cur = p.current;
  const value = (dir === 0 ? 1 : -1) * (p.open || 0) * (p.volume || 0);
  const change = (p.open > 0 && cur > 0) ? ((cur - p.open) / p.open) * 100 * (dir === 0 ? 1 : -1) : 0;
  const pl = p.profit + p.swap;   // Trade.profitOf semantics
  ok(fmtPlain(value) === '-86.46', 'Value = ±open×vol → ' + fmtPlain(value));
  ok(fmtChg(change) === '-0.07%', 'Change = Δ% × (−1 sell) → ' + fmtChg(change));
  ok(fmtPlain(pl) === '-6.30', 'Profit = profitOf (profit+swap) → ' + fmtPlain(pl));
  ok(fmtPlain(0) === '0.00', 'zero fee/swap-safe shaping kept (ROUND113b)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
