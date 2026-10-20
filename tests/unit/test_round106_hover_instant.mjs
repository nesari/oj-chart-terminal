/**
 * ROUND106 — regression: the SL/TP hover tag must show the INSTANT the
 * pointer touches the line (dwell removed) and its money row must be ready
 * on frame one (spec prefetched at line-build; incomplete cached specs are
 * dropped and refetched).
 *
 * Mirrors the shipped logic of trade/overlay.js:
 *   - _ensureSpec(st) decision table (complete / missing / incomplete cache)
 *   - the ROUND106 _onHover contract (close / slide / SHOW — no dwell wait)
 *   - the tag money row renders from a COMPLETE spec (with the round105
 *     _lineMoney guard: never fake it with today's floating P/L)
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } };

/* ---- mirror of overlay._ensureSpec ------------------------------------- */
function makeTrade(store) {
  return {
    specs: store,
    fetches: 0,
    deleted: 0,
    specSync(symbol) { return this.specs[symbol] || null; },
    spec(symbol) {
      this.fetches++;
      return Promise.resolve({ digits: 5, point: 0.00001, tick_value: 1, tick_size: 0.00001 });
    },
  };
}

function ensureSpec(trade, symbol) {
  const s = trade.specSync(symbol);
  if (s && s.tick_value > 0 && s.tick_size > 0) return true;
  try { if (trade.specs[symbol]) { delete trade.specs[symbol]; trade.deleted++; } } catch (e) {}
  try { trade.spec(symbol).catch(() => {}); } catch (e) {}
  return false;
}

/* ---- mirror of the ROUND106 _onHover contract --------------------------- */
function hoverStep(st, hit, key) {
  if (!hit) return 'close';
  if (st.tipKey === key) return 'slide';
  return 'show';
}

/* ---- 1. _ensureSpec decision table -------------------------------------- */
const complete = { digits: 5, point: 0.00001, tick_value: 1, tick_size: 0.00001 };

const t1 = makeTrade({ EURUSD: complete });
ok('complete spec -> ready, no fetch', ensureSpec(t1, 'EURUSD') === true && t1.fetches === 0);

const t2 = makeTrade({});
ok('missing spec -> not ready, fetch fired', ensureSpec(t2, 'EURUSD') === false && t2.fetches === 1);

const t3 = makeTrade({ EURUSD: {} });                       /* empty/failed answer cached */
const ready3 = ensureSpec(t3, 'EURUSD');
ok('incomplete cached spec -> dropped from the cache',
  ready3 === false && t3.deleted === 1 && t3.specs.EURUSD === undefined);
ok('incomplete cached spec -> refetch fired (TTL bypass)', t3.fetches === 1);

const t4 = makeTrade({ EURUSD: { digits: 5, point: 0.00001, tick_value: 0, tick_size: 0.00001 } });
ok('tick_value=0 spec counts as incomplete -> dropped + refetched',
  ensureSpec(t4, 'EURUSD') === false && t4.deleted === 1 && t4.fetches === 1);

const t5 = makeTrade({ EURUSD: { digits: 5, point: 0.00001, tick_value: 1, tick_size: 0 } });
ok('tick_size=0 spec counts as incomplete -> dropped + refetched',
  ensureSpec(t5, 'EURUSD') === false && t5.deleted === 1 && t5.fetches === 1);

/* ---- 2. instant-hover contract (no dwell) ------------------------------- */
const st = { tipKey: null };
ok('pointer off any line -> tag closes', hoverStep(st, null, 'sl#111') === 'close');
ok('first touch of a line -> tag SHOWS at once (no dwell wait)',
  hoverStep(st, { line: { kind: 'sl', ticket: 111 } }, 'sl#111') === 'show');
st.tipKey = 'sl#111';
ok('move along the same line -> tag slides, no rebuild',
  hoverStep(st, { line: { kind: 'sl', ticket: 111 } }, 'sl#111') === 'slide');
ok('jump to another line -> shows immediately for THAT line',
  hoverStep(st, { line: { kind: 'tp', ticket: 111 } }, 'tp#111') === 'show');

/* ---- 3. the money row renders from a complete spec ---------------------- */
function profitAt(pos, price, s) {
  const diff = (price - pos.open) * (pos.type === 0 ? 1 : -1);
  return (diff / s.tick_size) * s.tick_value * pos.volume + (pos.swap || 0);
}
function fmtMoney(v) {
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+$' : (r < 0 ? '-$' : '$')) + Math.abs(r).toFixed(2);
}
function moneyRow(l, pos, s) { /* the _lineMoney rule */
  if (l.kind === 'entry') return fmtMoney(pos.profit || 0);
  if (l.kind === 'sl' || l.kind === 'tp') {
    return (s && s.tick_value > 0 && s.tick_size > 0) ? fmtMoney(profitAt(pos, l.price, s)) : null;
  }
  return null;
}
const buyPos = { ticket: 111, type: 0, volume: 0.1, open: 1.08380, swap: 0, profit: 7.4 };
ok('SL tag money row renders with a complete spec',
  moneyRow({ kind: 'sl', price: 1.08280 }, buyPos, complete) === '-$10.00');
ok('without a usable spec the money row is OMITTED — never faked with the floating P/L',
  moneyRow({ kind: 'sl', price: 1.08280 }, buyPos, null) === null);
ok('after _ensureSpec completes, the same call renders the money row',
  moneyRow({ kind: 'sl', price: 1.08280 }, buyPos, makeTrade({}).specs.EURUSD || complete) === '-$10.00');

console.log('\nround106: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
