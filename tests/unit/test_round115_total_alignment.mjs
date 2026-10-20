/* ROUND115 — the Total-bar alignment fix (History + Positions).
   User report: the total profit/loss in the Total bar did not sit exactly
   under the Profit column. Root cause: the spanning rollup cell pushed every
   auto-placed sum cell right by firstSum/firstMoney tracks.
   This suite pins the source contract AND mirrors the placement math. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};

const dockSrc = fs.readFileSync('src/renderer/js/trade/dock.js', 'utf8');

console.log('— ROUND115a: source contracts (both Total bars) —');
ok((dockSrc.match(/cell\.style\.gridColumn = String\(i \+ 1\);/g) || []).length === 3,
  'all three Total bars pin every cell to its own explicit grid track');
ok(dockSrc.includes('if (firstSum < 0 || i < firstSum) continue;') &&
   dockSrc.includes('if (firstMoney < 0 || i < firstMoney) continue;'),
  'cells under the rollup span are not created (no auto-placement, no overlap)');
ok(dockSrc.includes('Math.max(firstSum + 1, 2)') && dockSrc.includes('Math.max(firstMoney + 1, 2)'),
  'rollup span survives the degenerate first-column sum (no 1/1 empty range)');
ok((dockSrc.match(/U\.el\('span', 'td-h2c', tot\)/g) || []).length === 3,
  'generic total cells are created only past the rollup span (ROUND119: three bars)');
ok(dockSrc.includes('cell.textContent = fmtPlain(sums.volume);') &&
   dockSrc.includes('cell.textContent = fmtPlain(sums[c.id]);') &&
   dockSrc.includes('cell.textContent = fmtPlain(money[c.id]);'),
  'Volume / Swap / Profit + History money sums keep their content wiring');
ok(dockSrc.includes("cell.style.gridColumn = '1 / ' + (firstSum < 0 ? vis.length + 1 :") &&
   dockSrc.includes("cell.style.gridColumn = '1 / ' + (firstMoney < 0 ? vis.length + 1 :"),
  'rollup still spans the leading columns (MT5 rollup look kept)');

console.log('— ROUND115b: placement mirror (exactly as the code places cells) —');
const HIST_IDS = ['time', 'symbol', 'ticket', 'type', 'volume', 'oprice', 'sl', 'tp', 'ctime',
  'cprice', 'value', 'comm', 'fee', 'swap', 'profit', 'change', 'magic', 'comment'];
const POS_IDS = ['time', 'symbol', 'ticket', 'type', 'volume', 'oprice', 'sl', 'tp',
  'cprice', 'value', 'swap', 'profit', 'change', 'comment', 'manage'];

/* NEW placement — mirrors the ROUND115 code 1:1 */
const placeNew = (vis, isSum) => {
  const cells = [];
  const firstSum = vis.findIndex(isSum);
  for (let i = 0; i < vis.length; i++) {
    if (i === 0) {
      cells.push({ kind: 'rollup', span: [1, firstSum < 0 ? vis.length + 1 : Math.max(firstSum + 1, 2)] });
      continue;
    }
    if (firstSum < 0 || i < firstSum) continue;
    cells.push({ kind: isSum(vis[i]) ? 'sum' : 'filler', id: vis[i].id, track: i + 1 });
  }
  return cells;
};
/* OLD placement — pre-ROUND115 auto-placement (the bug), for detection */
const placeOld = (vis, isSum) => {
  const cells = [];
  const firstSum = vis.findIndex(isSum);
  for (let i = 0; i < vis.length; i++) {
    if (i === 0) cells.push({ kind: 'rollup', span: [1, firstSum < 0 ? vis.length + 1 : firstSum + 1] });
    else cells.push({ kind: isSum(vis[i]) ? 'sum' : 'filler', id: vis[i].id, track: firstSum + i });
  }
  return cells;
};
const ownTrack = (vis, id) => vis.findIndex((c) => c.id === id) + 1;
const sumsUnderTheirColumns = (cells, vis, sumIds) =>
  sumIds.every((id) => {
    const cell = cells.find((c) => c.kind === 'sum' && c.id === id);
    return cell && cell.track === ownTrack(vis, id);
  });
const noOverlapNoGap = (cells, vis) => {
  const tracks = cells.filter((c) => c.kind !== 'rollup').map((c) => c.track);
  const uniq = new Set(tracks);
  const rollup = cells.find((c) => c.kind === 'rollup');
  const covered = [];
  for (let t = rollup.span[0]; t < rollup.span[1]; t++) covered.push(t);
  return uniq.size === tracks.length &&                       /* no two cells on one track */
    tracks.every((t) => !covered.includes(t)) &&              /* nothing under the rollup */
    Math.min(...tracks) === rollup.span[1] &&                 /* first cell right after the rollup */
    Math.max(...tracks) === vis.length;                       /* lines run to the last column */
};

const POS_SUM = ['volume', 'swap', 'profit'];
const HIST_SUM = ['comm', 'fee', 'swap', 'profit'];

{
  const vis = POS_IDS.map((id) => ({ id }));
  const cells = placeNew(vis, (c) => POS_SUM.includes(c.id));
  ok(sumsUnderTheirColumns(cells, vis, POS_SUM),
    'Positions (all 15 cols): Volume/Swap/Profit totals sit under their own columns');
  ok(cells.find((c) => c.id === 'profit').track === ownTrack(vis, 'profit'),
    'Positions: the profit total is exactly under Profit (track ' + ownTrack(vis, 'profit') + ')');
  ok(noOverlapNoGap(cells, vis), 'Positions: no overlap, no dead track, lines to the last column');
}
{
  /* the e2e toggle set: hide Comment + Value -> sums must STILL align */
  const vis = POS_IDS.filter((id) => id !== 'comment' && id !== 'value').map((id) => ({ id }));
  const cells = placeNew(vis, (c) => POS_SUM.includes(c.id));
  ok(sumsUnderTheirColumns(cells, vis, POS_SUM) && noOverlapNoGap(cells, vis),
    'Positions (Comment+Value hidden): alignment re-derived for the new visible set');
}
{
  const vis = HIST_IDS.map((id) => ({ id }));
  const cells = placeNew(vis, (c) => HIST_SUM.includes(c.id));
  ok(sumsUnderTheirColumns(cells, vis, HIST_SUM),
    'History (all 18 cols): Commission/Fee/Swap/Profit sums under their own columns');
  ok(cells.find((c) => c.id === 'profit').track === ownTrack(vis, 'profit'),
    'History: the profit total is exactly under Profit (track ' + ownTrack(vis, 'profit') + ')');
  ok(noOverlapNoGap(cells, vis), 'History: no overlap, no dead track, lines to the last column');
}
{
  /* plausible user subset: hide comm/fee/magic -> first money column moves */
  const vis = HIST_IDS.filter((id) => !['comm', 'fee', 'magic'].includes(id)).map((id) => ({ id }));
  const cells = placeNew(vis, (c) => HIST_SUM.includes(c.id));
  ok(sumsUnderTheirColumns(cells, vis, ['swap', 'profit']) && noOverlapNoGap(cells, vis),
    'History (Comm/Fee/Magic hidden): Swap/Profit still exactly under their columns');
}
{
  /* degenerate: every sum column hidden -> rollup alone owns the row */
  const vis = POS_IDS.filter((id) => !POS_SUM.includes(id)).map((id) => ({ id }));
  const cells = placeNew(vis, (c) => POS_SUM.includes(c.id));
  ok(cells.length === 1 && cells[0].kind === 'rollup' && cells[0].span[1] === vis.length + 1,
    'no sum column visible: the rollup cleanly spans the whole row');
}
{
  /* degenerate: Volume is the FIRST visible column -> rollup spans track 1 only */
  const vis = ['volume', 'cprice', 'swap', 'profit', 'manage'].map((id) => ({ id }));
  const cells = placeNew(vis, (c) => POS_SUM.includes(c.id));
  const rollup = cells.find((c) => c.kind === 'rollup');
  ok(rollup.span[0] === 1 && rollup.span[1] === 2 &&
     sumsUnderTheirColumns(cells, vis, ['swap', 'profit']),
    'sum column first: rollup shrinks to one track, other sums stay aligned');
}

console.log('— ROUND115c: the old behavior is detected as broken (bug documentation) —');
{
  const vis = POS_IDS.map((id) => ({ id }));
  const oldCells = placeOld(vis, (c) => POS_SUM.includes(c.id));
  ok(oldCells.find((c) => c.id === 'profit').track === ownTrack(vis, 'manage'),
    'OLD placement put the profit total under Manage (track ' + ownTrack(vis, 'manage') + '), the report');
  ok(!sumsUnderTheirColumns(oldCells, vis, POS_SUM), 'OLD placement fails the alignment contract');
}
{
  const vis = HIST_IDS.map((id) => ({ id }));
  const oldCells = placeOld(vis, (c) => HIST_SUM.includes(c.id));
  const profit = oldCells.find((c) => c.id === 'profit');
  ok(profit.track > vis.length,
    'OLD History placement pushed the profit total past the template (implicit track ' + profit.track + ')');
  ok(!sumsUnderTheirColumns(oldCells, vis, HIST_SUM), 'OLD History placement fails the alignment contract');
}

console.log('\nROUND115: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
