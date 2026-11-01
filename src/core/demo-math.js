/**
 * ROUND86 (user request) — pure math for the Replay demo broker: a fully
 * client-side SIMULATED account that lets the user trade on Bar Replay
 * history (backtest) with a customisable deposit ("margin") and leverage.
 *
 * The formulas mirror the real trade bridge (trade/state.js profitAt and
 * the provider engines): P/L = (close-open)/tick_size * tick_value * volume
 * with BUY closing on BID and SELL on ASK. The simulator never touches the
 * real trading path.
 *
 * DOM-free and import-free so Node tests can load it directly.
 *
 * @module core/demo-math
 */

function mround(v, step) {
  if (!(step > 0)) step = 0.01;
  return Math.round(Math.round(v / step) * step * 1e8) / 1e8;
}

/* clamp `v` into the symbol's volume limits (spec may be null) */
function clampVol(spec, v) {
  const min = spec && spec.vol_min > 0 ? spec.vol_min : 0.01;
  const max = spec && spec.vol_max > 0 ? spec.vol_max : 100;
  const step = spec && spec.vol_step > 0 ? spec.vol_step : 0.01;
  return Math.max(min, Math.min(max, mround(v, step)));
}

/* floating P/L of `pos` if it closed at `price` right now.
   pos: {open, type (0=BUY/1=SELL), volume}; volume defaults to pos.volume.
   Returns 0 when the spec is unusable (mirrors the real bridge fallback). */
function demoProfit(spec, pos, price, volume) {
  const v = volume != null ? volume : (pos ? pos.volume : 0);
  if (!spec || !(spec.tick_value > 0) || !(spec.tick_size > 0) || !(price > 0) || !(v > 0)) return 0;
  const diff = (price - pos.open) * (pos.type === 0 ? 1 : -1);
  return (diff / spec.tick_size) * spec.tick_value * v;
}

/* margin for one position in ACCOUNT currency (USD), 1:`leverage`.
   margin = volume * contract_size / leverage  (base-currency amount)
            * (base->USD rate). Falls back to contract 100000 and rate 1
   when the spec/current price is unavailable — documented simulator
   approximation for exotic crosses. */
function demoMargin(spec, pos, leverage, baseUsd) {
  const contract = spec && spec.contract > 0 ? spec.contract : 100000;
  const lev = leverage > 0 ? leverage : 100;
  const v = pos && pos.volume > 0 ? pos.volume : 0;
  const base = (v * contract) / lev;
  return base * (baseUsd > 0 ? baseUsd : 1);
}

/* base-currency -> USD rate approximation from the symbol name:
   XXXUSD -> the symbol's own price; USDXXX -> 1; crosses -> the cached
   spec of BASEUSD (or 1 / USDBASE) when available; else 1.
   specGet(symbol) -> spec row or null. */
function baseUsdRate(symbol, price, specGet) {
  const s = String(symbol || '').toUpperCase();
  if (s.length >= 6) {
    const b = s.slice(0, 3), q = s.slice(3, 6);
    if (q === 'USD') return price > 0 ? price : 1;
    if (b === 'USD') return 1;
    const s1 = specGet ? specGet(b + 'USD') : null;
    if (s1 && s1.bid > 0) return s1.bid;
    const s2 = specGet ? specGet('USD' + q) : null;
    if (s2 && s2.bid > 0) return 1 / s2.bid;
  }
  return 1;
}

/* pending-order trigger check against the CURRENT bid/ask (MT5 sides):
   buy-side orders watch ASK, sell-side watch BID.
   types: 2 Buy Limit, 3 Sell Limit, 4 Buy Stop, 5 Sell Stop. */
function pendingTriggered(o, bid, ask) {
  if (!o || !(o.price > 0)) return false;
  switch (o.type) {
    case 2: return ask > 0 && ask <= o.price;
    case 3: return bid > 0 && bid >= o.price;
    case 4: return ask > 0 && ask >= o.price;
    case 5: return bid > 0 && bid <= o.price;
    default: return false;
  }
}

/* SL/TP touch check of a COMPLETED bar (used to catch intrabar touches the
   frame loop never saw). Conservative: when both levels sit inside one
   bar the SL fires FIRST (worst-case reading). */
function barStopsHit(pos, bar) {
  const hit = { sl: false, tp: false };
  if (!pos || !bar || !isFinite(bar.high) || !isFinite(bar.low)) return hit;
  if (pos.type === 0) {
    if (pos.sl > 0 && bar.low <= pos.sl) hit.sl = true;
    else if (pos.tp > 0 && bar.high >= pos.tp) hit.tp = true;
  } else {
    if (pos.sl > 0 && bar.high >= pos.sl) hit.sl = true;
    else if (pos.tp > 0 && bar.low <= pos.tp) hit.tp = true;
  }
  return hit;
}

/* live SL/TP touch at the current price — BUY on BID, SELL on ASK
   (exactly the provider engine rule, demo.py SL/TP trigger). */
function priceStopsHit(pos, bid, ask) {
  const hit = { sl: false, tp: false };
  if (!pos) return hit;
  if (pos.type === 0) {
    if (pos.sl > 0 && bid > 0 && bid <= pos.sl) hit.sl = true;
    else if (pos.tp > 0 && bid > 0 && bid >= pos.tp) hit.tp = true;
  } else {
    if (pos.sl > 0 && ask > 0 && ask >= pos.sl) hit.sl = true;
    else if (pos.tp > 0 && ask > 0 && ask <= pos.tp) hit.tp = true;
  }
  return hit;
}

/* SL/TP placement validation. `ref` = the anchor price (market fill for a
   market order, the ORDER price for a pending order). Returns an error
   string or null. Honours spec.stops_level (points) when provided. */
function stopsCheck(spec, type, ref, sl, tp) {
  if (!(ref > 0)) return 'No reference price';
  const pt = spec && spec.point > 0 ? spec.point : 0;
  const minDist = (spec && spec.stops_level > 0 && pt > 0) ? spec.stops_level * pt : 0;
  /* ROUND267: the order types are paired (0/2/4/6 buy, 1/3/5/7 sell). The
     old list stopped at 4, so a BUY STOP LIMIT (6) was validated as a SELL —
     every legal stop-limit was rejected with "SL must be above the price". */
  const buy = (type % 2) === 0;
  const chk = (v, cond, msg) => (v > 0 && cond ? msg : null);
  let m = null;
  if (buy) {
    m = chk(sl, sl >= ref, 'SL must be below the price')
     || chk(tp, tp <= ref, 'TP must be above the price')
     || chk(sl, ref - sl < minDist, 'SL too close to the price')
     || chk(tp, tp - ref < minDist, 'TP too close to the price');
  } else {
    m = chk(sl, sl <= ref, 'SL must be above the price')
     || chk(tp, tp >= ref, 'TP must be below the price')
     || chk(sl, sl - ref < minDist, 'SL too close to the price')
     || chk(tp, ref - tp < minDist, 'TP too close to the price');
  }
  return m;
}

/* ROUND268: clamp a dragged SL/TP to the legal side of `ref` (the price the
   level is validated against) with the broker's minimum distance. `type` is
   the ORDER type (even = buy: 0 BUY, 2 BUY_LIMIT, 4 BUY_STOP, 6 BUY_STOP_LIMIT).
   MT5 sticks the line at the boundary instead of sending an invalid stop. */
function clampStopPrice(spec, type, ref, kind, price) {
  if (!(ref > 0) || !(price > 0)) return price;
  const pt = spec && spec.point > 0 ? spec.point : 0;
  const gap = Math.max((spec && spec.stops_level > 0 && pt > 0) ? spec.stops_level * pt : 0, pt);
  if (!(gap > 0)) return price;
  const dg = spec && spec.digits != null ? spec.digits : 5;
  const buy = (type % 2) === 0;
  const below = kind === 'sl' ? buy : !buy;      // SL: buy below / sell above
  if (below) { if (price > ref - gap) price = ref - gap; }
  else if (price < ref + gap) price = ref + gap;
  return Number(price.toFixed(dg));
}

export { mround, clampVol, demoProfit, demoMargin, baseUsdRate, pendingTriggered, barStopsHit, priceStopsHit, stopsCheck, clampStopPrice };
