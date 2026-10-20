/**
 * ROUND105 — regression for the SL/TP hover tag + drag money preview.
 * Mirrors the shipped helpers of trade/overlay.js (_dist / _stopsWarn /
 * fmtMoney / chip label / _tipHtml rules) with injected deps so the
 * MT5-parity rules stay pinned without a DOM or a live provider:
 *   - the hover tag names the SYMBOL (user round 105: money + points +
 *     symbol, like MetaTrader)
 *   - SL/TP drag chip shows the MONEY the level would lock + points/pips
 *     from the open — and OMITS money without a spec (never today's
 *     floating P/L in its place — the ROUND99 rule)
 *   - pending orders measure from their own fill price
 *   - the stops-level "too close" warning fires strictly INSIDE the gap
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } };

/* ---- mirrors of trade/overlay.js (keep in sync) ----------------------- */
function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+$' : (r < 0 ? '-$' : '$')) + Math.abs(r).toFixed(2);
}

function profitAt(pos, price, s) {
  if (!s || !(s.tick_value > 0) || !(s.tick_size > 0) || !(price > 0)) return null;
  const diff = (price - pos.open) * (pos.type === 0 ? 1 : -1);
  return (diff / s.tick_size) * s.tick_value * pos.volume + (pos.swap || 0);
}

function distTxt(s, open, price) {
  const dg = (s && s.digits) || 5;
  const pt = (s && s.point > 0) ? s.point : Math.pow(10, -dg);
  if (!(pt > 0) || !(open > 0) || !(price > 0)) return null;
  const pts = Math.abs(price - open) / pt;
  const isFrac = (dg === 3 || dg === 5);
  const pips = isFrac ? pts / 10 : null;
  const f1 = (x) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));
  return f1(pts) + ' points' + (isFrac ? ' · ' + f1(pips) + ' pips' : '');
}

function stopsWarn(s, pos, price, quote) {
  if (!s || !(s.stops_level > 0) || !(s.point > 0) || !pos) return '';
  const px = pos.type === 0 ? (quote.bid || s.bid) : (quote.ask || s.ask);
  if (!(px > 0) || Math.abs(price - px) >= s.stops_level * s.point) return '';
  return ' · too close';
}

/* the ROUND105 drag-chip label for sl/tp kinds */
function sltpChipLabel(kind, price, ref, s, quote) {
  const dg = s ? s.digits : 5; /* real code: const dg = s ? s.digits : 5; */
  const m = (ref && s && s.tick_value > 0 && s.tick_size > 0) ? profitAt(ref, price, s) : null;
  const dist = ref ? distTxt(s, ref.open, price) : null;
  const warn = stopsWarn(s, ref, price, quote);
  return (kind === 'sl' ? 'SL' : 'TP') + ' ' + price.toFixed(dg) +
    (m != null ? '  ' + fmtMoney(m) : '') +
    (dist ? '  ·  ' + dist : '') + warn;
}

/* the ROUND105 SL/TP tag rules (content assertions, _tipHtml mirror) */
function sltpTipHtml({ kind, price, sym, pos, ord, s }) {
  const dg = (s && s.digits) || 5;
  const ref = pos || (ord ? { open: ord.price, volume: ord.volume, type: ord.type >= 2 ? (ord.type % 2 === 0 ? 0 : 1) : ord.type, swap: 0 } : null);
  const v = (ref && s && s.tick_value > 0) ? profitAt(ref, price, s) : null;
  const d = ref ? distTxt(s, ref.open, price) : null;
  const ctx = pos
    ? (pos.type === 0 ? 'BUY' : 'SELL') + ' ' + pos.volume + ' → ' + Number(pos.open).toFixed(dg)
    : (ord ? (ord.type === 2 ? 'Buy Limit' : 'Order') + ' ' + ord.volume + ' → ' + Number(ord.price).toFixed(dg) : '');
  return {
    head: kind.toUpperCase() + ' ' + Number(price).toFixed(dg) + ' · ' + sym,
    ticket: pos ? '#' + pos.ticket : 'pending',
    money: v != null ? fmtMoney(v) : null,
    dist: d,
    ctx,
    hint: '↕ drag to move',
  };
}

/* ---- fixtures ---------------------------------------------------------- */
const EURUSD = { digits: 5, point: 0.00001, tick_value: 1, tick_size: 0.00001, stops_level: 30 };
const XAUUSD = { digits: 2, point: 0.01, tick_value: 1, tick_size: 0.01, stops_level: 0 };
const JPY = { digits: 3, point: 0.001, tick_value: 0.9, tick_size: 0.001 }; /* 3-digit: pip rule too */
const quote = { bid: 1.08500, ask: 1.08502 };

const buyPos = { ticket: 111, type: 0, volume: 0.1, open: 1.08380, swap: 0 };   /* long from 1.08380 */
const sellPos = { ticket: 222, type: 1, volume: 0.5, open: 1.08620, swap: 0 };  /* short from 1.08620 */

/* ---- 1. distance readout ---------------------------------------------- */
ok('120 points above open -> "120 points · 12 pips"',
  distTxt(EURUSD, 1.08380, 1.08500) === '120 points · 12 pips');
ok('distance is absolute (SL below open reads the same)',
  distTxt(EURUSD, 1.08380, 1.08260) === '120 points · 12 pips');
ok('2-digit gold has no pips row', distTxt(XAUUSD, 2400, 2415.5) === '1550 points');
ok('3-digit symbols get the pip split', distTxt(JPY, 155.000, 155.250) === '250 points · 25 pips');
ok('bad open -> no distance', distTxt(EURUSD, 0, 1.085) === null);
ok('bad price -> no distance', distTxt(EURUSD, 1.0838, null) === null);

/* ---- 2. money the level locks (MT5 sign rules) ------------------------- */
ok('BUY TP above open locks a profit',
  fmtMoney(profitAt(buyPos, 1.08500, EURUSD)) === '+$12.00');
ok('BUY SL below open locks a loss',
  fmtMoney(profitAt(buyPos, 1.08280, EURUSD)) === '-$10.00');
ok('SELL SL above open locks a loss',
  fmtMoney(profitAt(sellPos, 1.08620 + 0.00060, EURUSD)) === '-$30.00');
ok('SELL TP below open locks a profit',
  fmtMoney(profitAt(sellPos, 1.08620 - 0.00040, EURUSD)) === '+$20.00');
ok('volume scales the money',
  Math.abs(profitAt({ ...buyPos, volume: 1 }, 1.08500, EURUSD) - 120) < 1e-9);

/* ---- 3. drag chip label ------------------------------------------------ */
const slLabel = sltpChipLabel('sl', 1.08280, buyPos, EURUSD, quote);
ok('chip starts with the level + price', slLabel.startsWith('SL 1.08280'));
ok('chip carries the locked money', slLabel.includes('-$10.00'));
ok('chip carries the points distance', slLabel.includes('100 points · 10 pips'));
ok('chip warns strictly INSIDE the stops gap',
  sltpChipLabel('sl', 1.08498, buyPos, EURUSD, quote).includes('too close'));
/* exact binary numbers: point .5 × stops_level 4 = 2.0 gap below bid 100 */
const BIN = { digits: 1, point: 0.5, tick_value: 1, tick_size: 0.5, stops_level: 4 };
const binPos = { ticket: 7, type: 0, volume: 0.1, open: 97, swap: 0 };
ok('chip silent exactly AT the stops boundary (>= gap passes)',
  !stopsWarn(BIN, binPos, 98, { bid: 100, ask: 100 }));
ok('chip warns just inside it', stopsWarn(BIN, binPos, 99, { bid: 100, ask: 100 }) === ' · too close');
ok('no spec -> money omitted, price+distance kept (default 5-digit point)',
  sltpChipLabel('tp', 1.08600, buyPos, null, quote) === 'TP 1.08600  ·  220 points · 22 pips');
ok('no stops_level spec -> never warns',
  !sltpChipLabel('sl', 1.08498, buyPos, XAUUSD, quote).includes('too close'));

/* ---- 4. hover tag content (symbol, context, pending) ------------------- */
const posTag = sltpTipHtml({ kind: 'sl', price: 1.08280, sym: 'EURUSD', pos: buyPos, s: EURUSD });
ok('tag names the SYMBOL', posTag.head === 'SL 1.08280 · EURUSD');
ok('tag shows the ticket', posTag.ticket === '#111');
ok('tag shows the locked money', posTag.money === '-$10.00');
ok('tag shows the points distance', posTag.dist === '100 points · 10 pips');
ok('tag shows the trade context (side · volume → open)', posTag.ctx === 'BUY 0.1 → 1.08380');
ok('tag invites the drag', posTag.hint === '↕ drag to move');

const pendTag = sltpTipHtml({ kind: 'tp', price: 1.09000, sym: 'EURUSD',
  ord: { ticket: 9, type: 2, volume: 0.5, price: 1.08600 }, s: EURUSD });
ok('pending order tag marks "pending"', pendTag.ticket === 'pending');
ok('pending tag context names the order type', pendTag.ctx === 'Buy Limit 0.5 → 1.08600');
ok('pending distance measures from the ORDER price',
  pendTag.dist === '400 points · 40 pips');

/* ---- 5. stops-level guard details -------------------------------------- */
ok('guard needs a spec', stopsWarn(null, buyPos, 1.08498, quote) === '');
ok('guard needs a position-ish ref', stopsWarn(EURUSD, null, 1.08498, quote) === '');
ok('BUY measures against bid', stopsWarn(EURUSD, buyPos, 1.08480, quote) === ' · too close');
ok('SELL measures against ask',
  stopsWarn(EURUSD, sellPos, 1.08520, quote) === ' · too close');

console.log('\nround105: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
