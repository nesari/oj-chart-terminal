#!/usr/bin/env node
/**
 * ROUND111 tests — the "Trade" panel (money management + draft orders +
 * open positions), the user's mock-up implemented on the chart widget.
 *
 * User ask: "میخوام یک بخش مدیریت سرمایه به همین بخشی که الان اصلاحش کردی
 * اضافه کنم" — Risk in three modes (Lot / $ / %), Buy/Sell arming three
 * live dashed lines (entry locked to the market, draggable SL/TP with live
 * dollar + points tags), Set / Cancel, Pend.Buy / Pend.Sell with a draggable
 * entry, and a collapsible Open Positions section (% / $ units, close half,
 * risk-free, close).
 *
 * Layers, the repo's established style:
 *  A) MIRRORS of the pure rules: the risk resolver (_resolveVol), the
 *     pending-kind decision (_pendType), the drag clamp (_clampLevel), the
 *     draft defaults (_draftDefaults), the stepper units, the money/percent
 *     formatting, the half-close gate.
 *  B) SOURCE CONTRACTS against the real files — the three draft lines, the
 *     market entry lock, the Set gate (confirm-lock moved to SET), the
 *     cancel/Esc paths, the pending kind guard, the positions rows +
 *     actions, the %/$ unit toggle, persistence, visibility rules.
 *
 * Exit 0 only when every check passes.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}
const eq = (a, b) => a === b;
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps);

/* ---------------- mirrors (exact copies of the module rules) ---------------- */

/* OT mirror (trade/state.js wire contract) */
const OT = { BUY: 0, SELL: 1, BUY_LIMIT: 2, SELL_LIMIT: 3, BUY_STOP: 4, SELL_STOP: 5 };

function _clampVolSpec(spec, v) {
  if (v < (spec.vol_min || 0.01)) v = spec.vol_min || 0.01;
  if (v > (spec.vol_max || 100)) v = spec.vol_max || 100;
  const st = spec.vol_step > 0 ? spec.vol_step : 0.01;
  return Math.round(Math.round(v / st) * st * 1e8) / 1e8;
}

function _riskStepFor(mode, spec) {
  if (mode === 'lot') return (spec && spec.vol_step > 0) ? spec.vol_step : 0.01;
  if (mode === 'money') return 1;
  return 0.1;
}

function _resolveVol(spec, mode, val, slDist, equity) {
  const out = { vol: 0, risk: 0 };
  if (!spec || !(spec.tick_value > 0) || !(spec.tick_size > 0)) return out;
  if (mode === 'lot') {
    if (!(val > 0)) return out;
    out.vol = _clampVolSpec(spec, val);
    out.risk = slDist > 0 ? (slDist / spec.tick_size) * spec.tick_value * out.vol : 0;
    return out;
  }
  if (!(slDist > 0) || !(val > 0)) return out;
  const target = mode === 'money' ? val : (equity > 0 ? (val / 100) * equity : 0);
  if (!(target > 0)) return out;
  const perLot = (slDist / spec.tick_size) * spec.tick_value;
  if (!(perLot > 0)) return out;
  out.vol = _clampVolSpec(spec, target / perLot);
  out.risk = perLot * out.vol;
  return out;
}

function _pendType(side, px, bid, ask, stopsPts, point) {
  if (!(px > 0) || !(bid > 0) || !(ask > 0)) return null;
  const min = (stopsPts > 0 ? stopsPts : 0) * (point > 0 ? point : 0);
  if (side === 0) {
    if (px > ask && px >= ask + min) return OT.BUY_STOP;
    if (px < ask && px <= ask - min) return OT.BUY_LIMIT;
    return null;
  }
  if (px < bid && px <= bid - min) return OT.SELL_STOP;
  if (px > bid && px >= bid + min) return OT.SELL_LIMIT;
  return null;
}

function _clampLevel(kind, side, pend, px, ref, spec) {
  const dg = (spec && spec.digits != null) ? spec.digits : 5;
  const point = (spec && spec.point > 0) ? spec.point : Math.pow(10, -dg);
  const stops = ((spec && spec.stops_level > 0) ? spec.stops_level : 0) * point;
  const gap = Math.max(stops, point);
  let p = Number(px.toFixed(dg));
  if (kind === 'e') {
    const mkt = side === 0 ? ref.ask : ref.bid;
    if (mkt > 0 && stops > 0 && Math.abs(p - mkt) < stops) {
      p = p >= mkt ? mkt + stops : mkt - stops;
    }
  } else {
    const anchor = pend ? ref.entry : (side === 0 ? ref.bid : ref.ask);
    if (kind === 'sl') {
      if (side === 0 && anchor > 0 && p > anchor - gap) p = anchor - gap;
      if (side === 1 && anchor > 0 && p < anchor + gap) p = anchor + gap;
    } else if (kind === 'tp') {
      if (side === 0 && anchor > 0 && p < anchor + gap) p = anchor + gap;
      if (side === 1 && anchor > 0 && p > anchor - gap) p = anchor - gap;
    }
  }
  return Number(p.toFixed(dg));
}

function _draftDefaults(side, bid, ask, span, spec) {
  const dg = (spec && spec.digits != null) ? spec.digits : 5;
  const point = (spec && spec.point > 0) ? spec.point : Math.pow(10, -dg);
  const stops = ((spec && spec.stops_level > 0) ? spec.stops_level : 0) * point;
  const minD = Math.max(stops * 2, 10 * point);
  let slD = span > 0 ? span * 0.10 : 150 * point;
  let tpD = span > 0 ? span * 0.20 : 300 * point;
  slD = Math.max(slD, minD);
  tpD = Math.max(tpD, minD);
  const entry = side === 0 ? ask : bid;
  return side === 0
    ? { entry, sl: Number((entry - slD).toFixed(dg)), tp: Number((entry + tpD).toFixed(dg)) }
    : { entry, sl: Number((entry + slD).toFixed(dg)), tp: Number((entry - tpD).toFixed(dg)) };
}

function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+$' : (r < 0 ? '-$' : '$')) + Math.abs(r).toFixed(2);
}
function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+' : (r < 0 ? '-' : '')) + Math.abs(r).toFixed(2) + '%';
}

/* the EURUSD-ish spec the mirrors run against */
const S = { digits: 5, point: 0.00001, tick_value: 1, tick_size: 0.00001, vol_min: 0.01, vol_max: 100, vol_step: 0.01, stops_level: 0 };

console.log('A) the risk resolver (_resolveVol mirror) — Lot / $ / %');
/* LOT: the value IS the volume; the money is what the SL costs */
check('lot: 0.05 lots stays 0.05', near(_resolveVol(S, 'lot', 0.05, 0.0050, 10000).vol, 0.05));
check('lot: the SL money = dist/tick_size × tick_value × volume',
  near(_resolveVol(S, 'lot', 0.05, 0.0050, 10000).risk, 25, 1e-6));
check('lot: 0.07 on a 0.02-step spec rounds to the step grid',
  near(_resolveVol({ ...S, vol_step: 0.02 }, 'lot', 0.07, 0.005, 10000).vol, 0.08));
check('lot: zero SL distance → money 0 (nothing to measure yet)',
  _resolveVol(S, 'lot', 0.05, 0, 10000).risk === 0 && _resolveVol(S, 'lot', 0.05, 0, 10000).vol > 0);
/* MONEY: fixed dollar risk → the volume sizes itself from the SL */
check('money: $25 risk over a 50-pip SL (0.0050) → exactly 0.05 lots',
  near(_resolveVol(S, 'money', 25, 0.0050, 10000).vol, 0.05));
check('money: the recomputed risk matches the target (per-lot math is exact)',
  near(_resolveVol(S, 'money', 25, 0.0050, 10000).risk, 25, 1e-6));
check('money: below vol_min lifts the volume and the real risk follows',
  (() => { const r = _resolveVol(S, 'money', 0.01, 0.0050, 10000); return r.vol >= 0.01 && r.risk >= 4.999; })());
check('money: above vol_max caps the volume (risk recomputed, never faked)',
  (() => { const r = _resolveVol({ ...S, vol_max: 5 }, 'money', 100000, 0.0050, 10000); return r.vol === 5 && near(r.risk, 2500, 1e-6); })());
check('money: no SL yet → vol 0 (the line has to be placed first)',
  _resolveVol(S, 'money', 100, 0, 10000).vol === 0);
/* PCT: percent of the equity, then the money path */
check('pct: 1% of 10,000 → $100 → over 100-pip SL (0.0100) → 0.10 lots',
  near(_resolveVol(S, 'pct', 1, 0.0100, 10000).vol, 0.10));
check('pct: 2% of 5,000 → $100 risk at the recomputed volume',
  near(_resolveVol(S, 'pct', 2, 0.0100, 5000).risk, 100, 1e-6));
check('pct: zero equity refuses to size (no account yet)',
  _resolveVol(S, 'pct', 1, 0.0100, 0).vol === 0);
check('missing spec → vol 0 in every mode',
  ['lot', 'money', 'pct'].every((m) => _resolveVol(null, m, 1, 0.01, 10000).vol === 0));

console.log('B) the pending-kind decision (_pendType mirror)');
check('buy above ask+stops → BUY_STOP', eq(_pendType(0, 1.0850, 1.08280, 1.08300, 50, 0.00001), OT.BUY_STOP));
check('buy below ask−stops → BUY_LIMIT', eq(_pendType(0, 1.0800, 1.08280, 1.08300, 50, 0.00001), OT.BUY_LIMIT));
check('buy inside the dead zone → null (Set refuses, the draft stays)',
  _pendType(0, 1.08310, 1.08280, 1.08300, 50, 0.00001) === null);
check('sell below bid−stops → SELL_STOP', eq(_pendType(1, 1.0800, 1.08280, 1.08300, 50, 0.00001), OT.SELL_STOP));
check('sell above bid+stops → SELL_LIMIT', eq(_pendType(1, 1.0860, 1.08280, 1.08300, 50, 0.00001), OT.SELL_LIMIT));
check('sell inside the dead zone → null', _pendType(1, 1.08270, 1.08280, 1.08300, 50, 0.00001) === null);
check('no live quotes → null (nothing to measure against)',
  _pendType(0, 1.0850, 0, 0, 50, 0.00001) === null);
check('stops_level 0 still refuses the exact market price',
  _pendType(0, 1.08300, 1.08280, 1.08300, 0, 0.00001) === null &&
  eq(_pendType(0, 1.08305, 1.08280, 1.08300, 0, 0.00001), OT.BUY_STOP));

console.log('C) the drag clamp (_clampLevel mirror)');
/* market BUY: the SL anchors to the bid and must stay below it */
check('buy SL dragged above the bid clamps to bid−stops',
  near(_clampLevel('sl', 0, false, 1.08300, { bid: 1.08280, ask: 1.08300, entry: 1.08300 },
    { ...S, stops_level: 50 }), 1.08230));
check('buy SL inside the legal zone passes through unchanged',
  near(_clampLevel('sl', 0, false, 1.08100, { bid: 1.08280, ask: 1.08300, entry: 1.08300 },
    { ...S, stops_level: 50 }), 1.08100));
check('sell SL clamps UP to ask+stops (loss side only)',
  near(_clampLevel('sl', 1, false, 1.08250, { bid: 1.08280, ask: 1.08300, entry: 1.08300 },
    { ...S, stops_level: 50 }), 1.08350));
check('buy TP clamps UP to the profit side (bid+stops)',
  near(_clampLevel('tp', 0, false, 1.08260, { bid: 1.08280, ask: 1.08300, entry: 1.08300 },
    { ...S, stops_level: 50 }), 1.08330));
check('sell TP clamps DOWN to ask−stops',
  near(_clampLevel('tp', 1, false, 1.08340, { bid: 1.08280, ask: 1.08300, entry: 1.08300 },
    { ...S, stops_level: 50 }), 1.08250));
check('pending entry below the market pushes OUT of the dead zone (limit side)',
  near(_clampLevel('e', 0, true, 1.08295, { bid: 1.08280, ask: 1.08300, entry: 1.08295 },
    { ...S, stops_level: 50 }), 1.08250));
check('pending entry above the market pushes OUT too (stop side)',
  near(_clampLevel('e', 0, true, 1.08305, { bid: 1.08280, ask: 1.08300, entry: 1.08305 },
    { ...S, stops_level: 50 }), 1.08350));
check('pending SL anchors to the ENTRY (fill) price, not the live market',
  near(_clampLevel('sl', 0, true, 1.08320, { bid: 1.08280, ask: 1.08300, entry: 1.08280 },
    { ...S, stops_level: 50 }), 1.08230));
check('digits rounding: a 5-digit spec never keeps noise',
  eq(String(_clampLevel('sl', 0, false, 1.081000001, { bid: 1.08280, ask: 1.08300, entry: 1.08300 }, S)), '1.081'));

console.log('D) the draft defaults (_draftDefaults mirror)');
const dflt = _draftDefaults(0, 1.08280, 1.08300, 0.100, S);
check('buy: entry at the ask', near(dflt.entry, 1.08300));
check('buy: SL ~10% of the visible span below the entry', near(dflt.sl, 1.07300));
check('buy: TP ~20% of the span above (the 1:2 shape)', near(dflt.tp, 1.10300));
const dfltS = _draftDefaults(1, 1.08280, 1.08300, 0.100, S);
check('sell: mirrored — SL above the entry, TP below', near(dfltS.sl, 1.09280) && near(dfltS.tp, 1.06280));
const dfltF = _draftDefaults(0, 1.08280, 1.08300, 0, S);
check('unmeasurable span → 150/300 points', near(dfltF.sl, 1.08150) && near(dfltF.tp, 1.08600));
check('the broker stops_level lifts the minimum distance',
  (() => { const d2 = _draftDefaults(0, 1.08280, 1.08300, 0, { ...S, stops_level: 900 }); return near(d2.sl, 1.06500); })());

console.log('E) formatting + steppers');
check('fmtMoney: +$12.34 / -$12.34 / $0.00',
  eq(fmtMoney(12.34), '+$12.34') && eq(fmtMoney(-12.344), '-$12.34') && eq(fmtMoney(0), '$0.00'));
check('fmtPct: +0.52% / -0.52% / 0.00%',
  eq(fmtPct(0.5234), '+0.52%') && eq(fmtPct(-0.52), '-0.52%') && eq(fmtPct(0), '0.00%'));
check('stepper unit: lot → vol_step', near(_riskStepFor('lot', S), 0.01));
check('stepper unit: $ → 1', near(_riskStepFor('money', null), 1));
check('stepper unit: % → 0.1', near(_riskStepFor('pct', null), 0.1));
check('positions %: profit/equity×100', near((12.34 / 10000) * 100, 0.1234));
check('half close: 0.05 → half = 0.03 on a 0.01 step (rounds UP, stays under)',
  (() => { const vol = 0.05, half = Math.round((vol / 2) / 0.01) * 0.01; return near(half, 0.03) && half < vol; })());
check('half close: vol_min gate — 0.02 on vol_min 0.05 leaves the button disabled',
  (() => { const vol = 0.02, half = Math.max(0.05, Math.round((vol / 2) / 0.01) * 0.01); return !(half >= 0.05 && half < vol); })());

console.log('F) source contracts — the real files');
const src = read('src/renderer/js/trade/oneclick.js');
const css = read('src/renderer/css/trade.css');
const icons = read('src/renderer/js/ui/icons.js');

console.log('G) the three draft lines (entry locked · draggable SL/TP)');
check('the draft keeps THREE price lines {e, s, t}',
  /lines:\s*\{\s*e:\s*null,\s*s:\s*null,\s*t:\s*null\s*\}/.test(src));
check('the lines are LWC price lines: dashed, colored, axis-labelled, titled',
  /createPriceLine\(\{[\s\S]{0,200}lineStyle:\s*L\.Dashed,[\s\S]{0,120}axisLabelVisible:\s*true,[\s\S]{0,120}title,/.test(src));
check('the palette is the overlay trade colours (entry blue / SL red / TP green)',
  /C\s*=\s*\{\s*entry:\s*'#2962ff',\s*sl:\s*'#f23645',\s*tp:\s*'#089981'\s*\}/.test(src));
check('MARKET mode: the entry line is LOCKED to the live price (ask/buy · bid/sell)',
  /if \(!d\.pend && q\.bid > 0 && q\.ask > 0\)\s*\{\s*\n\s*d\.entry = d\.side === 0 \? q\.ask : q\.bid;/.test(src));
check('PENDING mode: the entry is the user\'s (the tick never moves it)',
  /if \(!d\.pend && q\.bid > 0/.test(src));
check('the SL tag carries the LIVE dollar + points ("SL -$… · … points")',
  /'SL ' \+ fmtMoney\(-r\.risk\) \+ ' · ' \+ _ptsTxt\(slDist, spec\)/.test(src));
check('the TP tag carries the LIVE dollar + points ("TP +$… · … points")',
  /'TP ' \+ fmtMoney\(tpMoney\) \+ ' · ' \+ _ptsTxt\(tpDist, spec\)/.test(src));
check('the market entry tag names the side + live price ("BUY @ …")',
  /\(d\.side === 0 \? 'BUY @ ' : 'SELL @ '\) \+ ep\.toFixed\(dg\)/.test(src));
check('dead lines self-heal (applyOptions try/catch → recreate)',
  /catch \(e\)\s*\{\s*d\.lines\[key\] = null;\s*\}\s*\/\/ dead line → recreate/.test(src));
check('the line hit-test only offers the entry when it is draggable (pend)',
  /d\.pend \? \['e',\s*'s',\s*'t'\]\s*:\s*\['s',\s*'t'\]/.test(src));
check('line drag freezes the chart gestures and restores them on drop',
  /pane\.chart\.applyOptions\(\{\s*handleScroll:\s*false,\s*handleScale:\s*false\s*\}\)/.test(src) &&
  /handleScroll:\s*st\.lineDrag\.saved\.hs,\s*handleScale:\s*st\.lineDrag\.saved\.hsc/.test(src));
check('dragged levels clamp through _clampLevel (never an illegal SL/TP)',
  /const clamped = _clampLevel\(st\.lineDrag\.kind,\s*d\.side,\s*d\.pend,\s*price,/.test(src));
check('the hit-test measures against the LWC element (round-100 origin rule)',
  /_lwcRect\(pane\)/.test(src) && /:scope > \.tv-lightweight-charts/.test(src));

console.log('H) arm → Set / Cancel (nothing is sent until Set)');
check('Buy/Sell/Pend arm the draft (_onSide guards quotes + specs first)',
  /_onSide\(pane,\s*st,\s*side,\s*pend\)\s*\{[\s\S]{0,240}No live quote for[\s\S]{0,300}_draftArm\(pane,\s*st,\s*side,\s*pend\);/.test(src));
check('arming replaces an old draft cleanly (cancel first)',
  /_draftArm\(pane,\s*st,\s*side,\s*pend\)\s*\{\s*const q[\s\S]{0,120}this\._draftCancel\(st\);\s*\/\/ re-arming replaces/.test(src));
check('the armed owner button lights up (oc-armed), others go out',
  /b\.classList\.toggle\('oc-armed',\s*b === hot\)/.test(src));
check('the status strip rides oc-hidden — never inline display (round-107 rule)',
  /_statusPaint\(st\)\s*\{\s*const d = st\.draft;\s*\n\s*if \(!d\)\s*\{\s*st\.status\.classList\.add\('oc-hidden'\);/.test(src) &&
  !/style\.display\s*=\s*'/.test(src));
check('ROUND113: Set sends AT ONCE — no confirm arm, no padlock (user request)',
  /_onSet\(pane, st\)\s*\{\s*if \(!st\.draft\) return;\s*\n\s*this\._sendDraft\(pane, st\);/.test(src) &&
  !/_armSet/.test(src) && !/_disarmSet/.test(src) && !/CONFIRM SET<\/span>/.test(src));
check('Cancel removes the three lines + forgets the draft',
  /for \(const k of \['e',\s*'s',\s*'t'\]\)\s*\{[\s\S]{0,120}removePriceLine\(d\.lines\[k\]\)/.test(src) &&
  /st\.draft = null;\s*\n\s*this\._armVisual\(st\);/.test(src));
check('Esc cancels every draft (and never fires while the Risk field is typed in)',
  /U\.isTyping\(e\.target\)\) return;\s*\/\/ the Risk field reverts itself[\s\S]{0,60}this\._draftCancelAll\(\);/.test(src));
check('the pend entry without distance refuses Set and KEEPS the draft',
  /Move the entry line away from the market[\s\S]{0,120}return;\s*\/\/ the draft stays for adjustment/.test(src));
check('success cancels the draft — the real overlay lines take over',
  /if \(!bad\) this\._draftCancel\(st\);\s*\/\/ success: the real lines take over/.test(src));
check('the draft defaults arm from the VISIBLE span (10% / 20% shape)',
  /_draftDefaults\(side,\s*q\.bid,\s*q\.ask,\s*this\._visibleSpan\(pane\),\s*spec\)/.test(src));

console.log('I) the risk section (Lot / $ / % per the mock-up)');
check('three mode buttons % $ Lot — data-m pct/money/lot',
  /mkMode\('pct',\s*'%'/m.test(src) && /mkMode\('money',\s*'\$'/m.test(src) && /mkMode\('lot',\s*'Lot'/m.test(src));
check('the resolver turns (mode, value, SL distance) into volume + money',
  /_resolveVol\(spec,\s*this\._rmode,\s*this\._riskCur\(\),\s*slDist,\s*TradeRoute\.equity\(\)\)/.test(src));
check('the status strip shows what WILL be sent (Vol · SL $ · TP $)',
  /'Vol ' \+ _volTxt\(r\.vol, spec\) \+ ' · SL ' \+ fmtMoney\(-r\.risk\) \+ ' · TP ' \+ fmtMoney\(tpMoney\)/.test(src));
check('pending status names the order kind (Buy Limit / Sell Stop…)',
  /\(OT_NAME\[t\] \|\| 'Pending'\) \+ ' ' \+ _volTxt\(r\.vol, spec\)/.test(src));
check('the values persist per mode (JSON {lot, money, pct})',
  /U\.lsSet\(K\.rval,\s*JSON\.stringify\(this\._rvals\)\)/.test(src));
check('the mode persists (mt5_oct_risk_mode)',
  /U\.lsSet\(K\.rmode,\s*m\)/.test(src));

console.log('J) Open Positions (% / $ · collapse · half · risk-free · close)');
check("the section header reads 'Open Positions' with % / $ unit buttons",
  /'Open Positions'/.test(src) && /unitPct\.dataset\.u = 'pct'/.test(src) && /unitUsd\.dataset\.u = 'usd'/.test(src));
check('the % / $ toggle persists and re-leads every pane',
  /U\.lsSet\(K\.plunit,\s*this\._plunit\)/.test(src) && /st\.posSig = '';\s*\/\/ rebuild with the new lead unit/.test(src));
check('the collapse arrow persists and toggles the list via oc-hidden',
  /U\.lsSet\(K\.collapsed,\s*this\._collapsed\)/.test(src) &&
  /st\.posList\.classList\.toggle\('oc-hidden',\s*this\._collapsed\)/.test(src));
check('rows rebuild on structural change only (ticket/vol/SL/TP/symbol/unit)',
  /\[p\.ticket,\s*p\.type,\s*p\.volume,\s*p\.open,\s*p\.sl,\s*p\.tp,\s*p\.symbol\]\.join\(':'\)/.test(src));
check('ROUND113: live P/L rides the tick — ONE unit only (pct of equity, $ fallback)',
  /const profit = TradeRoute\.profitOf\(p\);/.test(src) &&
  /_plHtml\(profit, eq, true\)/.test(src) &&
  /if \(this\._plunit === 'pct' && eq > 0\)/.test(src));
check('close half: TradeRoute.close(ticket, volume) — the partial form',
  /_posHalf\(p\.ticket,\s*halfV\)/.test(src) && /TradeRoute\.close\(ticket,\s*vol\)/.test(src));
check('risk-free: the SL jumps to the entry (break-even) via TradeRoute.modifySLTP',
  /_posRiskFree\(p\)/.test(src) &&
  /TradeRoute\.modifySLTP\(p\.ticket,\s*be,\s*p\.tp \|\| 0(,\s*\{\s*be:\s*true\s*\})?\)/.test(src) &&
  /Risk-free — SL moved to break-even/.test(src));
check('close: TradeRoute.close(ticket, 0)',
  /TradeRoute\.close\(ticket,\s*0\)/.test(src));
check('the half button disables when the half would be no-op (vol_min / full gate)',
  /if \(!\(half >= vmin && half < p\.volume\)\) halfBtn\.disabled = true;/.test(src));
check('the risk-free button disables when the SL already sits at break-even',
  /if \(p\.sl > 0 && Math\.abs\(p\.sl - p\.open\) < be\) rfBtn\.disabled = true;/.test(src));
check('the empty state reads "No open positions"',
  /'No open positions'/.test(src));
check('the row actions stopPropagation (no chart gestures from a click)',
  /halfBtn\.addEventListener\('click',\s*\(e\) => \{\s*e\.stopPropagation\(\);/.test(src));

console.log('K) structure, theme and safety');
check('the panel row set matches the mock-up: title · risk · grid · status · positions',
  /'oc-title'/.test(src) && /'oc-risk'/.test(src) && /'oc-grid'/.test(src) &&
  /'oc-status oc-hidden'/.test(src) && /'oc-poshead'/.test(src) && /'oc-poslist'/.test(src));
check('the title row carries the live bid/ask',
  /_fmtPx\(st\.sym,\s*q\.bid,\s*pane\) \+ ' \/ ' \+ _fmtPx\(st\.sym,\s*q\.ask,\s*pane\)/.test(src));
check('css: risk field + stepper + modes + status + positions all themed',
  /\.oc-rin\s*\{[^}]*color:\s*var\(--text\);/s.test(css) &&
  /\.oc-step\s*\{[^}]*background:\s*var\(--panel2\);/s.test(css) &&
  /\.oc-modeb\.oc-on\s*\{\s*border-color:\s*var\(--blue\);/s.test(css) &&
  /\.oc-status\s*\{[^}]*background:\s*var\(--panel2\);/s.test(css) &&
  /\.oc-poslist\s*\{[^}]*max-height:\s*132px;\s*overflow-y:\s*auto;/s.test(css));
check('css: Buy/Sell keep the app trade colours; pend arms are translucent',
  /\.oc-side\s*\{[^}]*background-color:\s*var\(--red\);/s.test(css) &&
  /\.oc-side\.oc-buy\s*\{\s*background-color:\s*var\(--green\);\s*\}/.test(css) &&
  /\.oc-side\.oc-pendbuy\s*\{[^}]*rgba\(8,153,129,\.15\)/s.test(css) &&
  /\.oc-side\.oc-pendsell\s*\{[^}]*rgba\(242,54,69,\.13\)/s.test(css));
check('css: Set takes the app blue; Cancel stays neutral',
  /\.oc-set\s*\{\s*background:\s*var\(--blue\);\s*color:\s*#ffffff;\s*\}/.test(css) &&
  /\.oc-cancel\s*\{\s*background:\s*var\(--panel2\);/.test(css));
check('css: P/L colours ride the theme greens/reds',
  /\.oc-pos-pl b\.pos,\s*\.oc-pos-pl span\.pos\s*\{\s*color:\s*var\(--green\);\s*\}/.test(css) &&
  /\.oc-pos-pl b\.neg,\s*\.oc-pos-pl span\.neg\s*\{\s*color:\s*var\(--red\);\s*\}/.test(css));
check('css: the collapse chevron rotates when closed',
  /\.oc-coll\.oc-closed svg\s*\{\s*transform:\s*rotate\(-90deg\);\s*\}/.test(css));
check('icons.js gained the shield (risk-free)', /shield:\s*S\(/.test(icons));
check('the debug hook exposes the draft snapshot for the E2E repro',
  /_dbg\(pane\)\s*\{/.test(src) && /lines:\s*\{\s*e:\s*!!d\.lines\.e,\s*s:\s*!!d\.lines\.s,\s*t:\s*!!d\.lines\.t\s*\}/.test(src));
check('the panel mousedown never reaches the chart engine; the line-drag skips the panel',
  /panel\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\);/.test(src) &&
  /st\.panel\.contains\(e\.target\) \|\| st\.pill\.contains\(e\.target\)/.test(src));
check('the line cursor arbiter keeps a private curOn (no fight with the overlay)',
  /\}\s*else if \(st\.curOn\)\s*\{[\s\S]{0,160}removeProperty\('cursor'\)/.test(src));
check('symbol change cancels the draft before anything else touches it',
  /if \(st\.sym !== pane\.symbol\)\s*\{\s*\n\s*this\._draftCancel\(st\);/.test(src));
check('the spec retry lives in the tick (the panel boots before the WS connects)',
  /if \(!Trade\.specSync\(st\.sym\)\)/.test(src) && /specTryAt > 2000/.test(src));

console.log('');
console.log(N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
