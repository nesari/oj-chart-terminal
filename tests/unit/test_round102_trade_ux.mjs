/**
 * ROUND102 — regression for the trading UX fixes that are pure logic.
 * Mirrors the shipped helpers (history.timeSpec / dock._sortRows) so the
 * coordinate + ordering rules stay pinned without a DOM.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } };

/* --- mirror of trade/history.js timeSpec ------------------------------- */
function timeSpec(times, t, tfSec) {
  if (!t || !times || !times.length) return null;
  if (t < times[0]) return null;
  let lo = 0, hi = times.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0) return null;
  const step = tfSec > 0 ? tfSec : 60;
  let frac = (t - times[idx]) / step;
  if (!(frac >= 0)) frac = 0;
  if (frac > 0.999) frac = 0.999;
  return { idx, frac };
}

/* ROUND127 rule: the mark sits at the CENTER of the bar containing the deal
   (the LWC logicalToCoordinate resolves (idx + .5) * barSpacing) — the same
   left/right spot on every timeframe. The intra-bar frac no longer shifts x. */
function xOf(times, t, tf, barSpacing, originX) {
  const s = timeSpec(times, t, tf);
  if (!s) return null;
  return originX + s.idx * barSpacing + barSpacing / 2;
}

const H1 = 3600;
const bars = [1000 * H1, 1001 * H1, 1002 * H1, 1003 * H1];

ok('deal before the window is dropped', timeSpec(bars, 999 * H1, H1) === null);
ok('deal on a bar open sits at frac 0', timeSpec(bars, 1001 * H1, H1).frac === 0);
ok('mid-bar deal interpolates', Math.abs(timeSpec(bars, 1001 * H1 + 1800, H1).frac - 0.5) < 1e-9);
ok('frac never reaches the next bar', timeSpec(bars, 1001 * H1 + H1 - 1, H1).frac < 1);
ok('deal past the last bar clamps to the last bar', timeSpec(bars, 1009 * H1, H1).idx === 3);

/* the same deal must land on the SAME bar center at any zoom — only scaled */
const t = 1002 * H1 + 900;
const x10 = xOf(bars, t, H1, 10, 0);
const x40 = xOf(bars, t, H1, 40, 0);
ok('x scales linearly with barSpacing', Math.abs(x40 - x10 * 4) < 1e-9);
ok('x sits at the candle CENTER (mid of the bar slot)', x10 === 2 * 10 + 5);
ok('center rule is timeframe-stable: same bar -> same center on any tf',
  xOf(bars, 1002 * H1 + 1, H1, 10, 0) === xOf(bars, 1002 * H1 + H1 - 1, H1, 10, 0));

/* gap-inclusive axis: the session whitespace rows shift the logical index —
   this is the ROUND102 root fix (compact axis put the mark ~2 bars left) */
const withGaps = [1000 * H1, 1001 * H1, 1001 * H1 + 1, 1001 * H1 + 2, 1002 * H1, 1003 * H1];
ok('compact axis resolves bar 2 for the deal', timeSpec(bars, 1002 * H1, H1).idx === 2);
ok('gap axis resolves bar 4 for the SAME deal', timeSpec(withGaps, 1002 * H1, H1).idx === 4);
ok('using the compact axis would shift it left', timeSpec(bars, 1002 * H1, H1).idx < timeSpec(withGaps, 1002 * H1, H1).idx);

/* --- mirror of dock._sortRows ----------------------------------------- */
function sortRows(rows, sort, pick) {
  if (!sort || !sort.col) return rows;
  const out = rows.slice();
  out.sort((a, b) => {
    const x = pick(a, sort.col), y = pick(b, sort.col);
    let c;
    if (typeof x === 'number' && typeof y === 'number') c = x - y;
    else c = String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    return sort.dir < 0 ? -c : c;
  });
  return out;
}
const rows = [
  { ticket: 3, symbol: 'XAUUSD', pl: -12.5 },
  { ticket: 1, symbol: 'EURUSD', pl: 40 },
  { ticket: 2, symbol: 'GBPUSD', pl: 0 },
];
const pick = (r, c) => (c === 'symbol' ? r.symbol : Number(r[c]));
ok('no sort keeps the broker order', sortRows(rows, null, pick)[0].ticket === 3);
ok('ascending P/L puts the loser first', sortRows(rows, { col: 'pl', dir: 1 }, pick)[0].ticket === 3);
ok('descending P/L puts the winner first', sortRows(rows, { col: 'pl', dir: -1 }, pick)[0].ticket === 1);
ok('symbol sorts as text', sortRows(rows, { col: 'symbol', dir: 1 }, pick)[0].symbol === 'EURUSD');
ok('sorting does not mutate the source', rows[0].ticket === 3);

console.log('\nround102 trade UX: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
