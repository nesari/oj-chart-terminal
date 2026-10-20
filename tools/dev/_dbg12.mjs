// Reference (hand-rolled, TV-exact) Supertrend vs the engine's output.
// TV v4 semantics per the script:
//   up  = src - mult*atr
//   up1 = nz(up[1], up)
//   up := close[1] > up1 ? max(up, up1) : up      <-- ratchet: only rises while prev close above
//   trend := trend==-1 and close > dn1 ? 1 : trend==1 and close < up1 ? -1 : trend
// NOTE the script uses dn1 / up1 (the PREVIOUS bar's band), and trend flips
// compare close to the *previous* band — matching TV exactly.

function refSupertrend(bars, periods = 10, mult = 3.0) {
  // ATR: RMA-like (changeATR=true -> atr() = rma(tr, periods))
  const tr = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { tr.push(b.high - b.low); continue; }
    const p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  // RMA (Wilder) = alpha = 1/len
  const atr = [];
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < periods - 1) { atr.push(null); continue; }
    if (prev == null) { prev = tr.slice(0, periods).reduce((a, c) => a + c, 0) / periods; }
    else { prev = (prev * (periods - 1) + tr[i]) / periods; }
    atr.push(prev);
  }
  let up = null, dn = null, trend = 1, up1 = null, dn1 = null;
  const ups = [], dns = [], trends = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const a = atr[i];
    if (a == null) { ups.push(null); dns.push(null); trends.push(1); continue; }
    const src = (b.high + b.low) / 2;
    let upNew = src - mult * a;
    let dnNew = src + mult * a;
    // up1 = nz(up[1], up): on the first valid bar up1 = up itself
    if (up1 == null) up1 = upNew;
    if (dn1 == null) dn1 = dnNew;
    upNew = b.close_prev > up1 ? Math.max(upNew, up1) : upNew; // close[1]
    dnNew = b.close_prev < dn1 ? Math.min(dnNew, dn1) : dnNew;
    // trend
    if (trend === -1 && b.close > dn1) trend = 1;
    else if (trend === 1 && b.close < up1) trend = -1;
    ups.push(trend === 1 ? upNew : null);
    dns.push(trend === -1 ? dnNew : null);
    trends.push(trend);
    up1 = upNew; dn1 = dnNew;
  }
  return { ups, dns, trends };
}

// build bars with close_prev
function mkBars() {
  const bars = [];
  let price = 100, t = 1700000000;
  for (let i = 0; i < 300; i++) {
    const phase = i < 100 ? 0 : i < 200 ? 1 : 2;
    price += (phase === 1 ? -0.35 : 0.3) + (i % 7 === 0 ? (phase === 1 ? -0.6 : 0.5) : 0);
    const o = price, c = price + Math.sin(i) * 0.15;
    bars.push({ time: t + i * 60, open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c });
  }
  for (let i = 0; i < bars.length; i++) bars[i].close_prev = i > 0 ? bars[i - 1].close : bars[i].close;
  return bars;
}

const bars = mkBars();
const ref = refSupertrend(bars);
import { compile } from '../../src/core/pine/compile.js';
const SRC = `//@version=4
study("Supertrend", overlay = true)
Periods = input.int(10, "ATR Period")
src = input(hl2, "Source")
Multiplier = input.float(3.0, "ATR Multiplier", step=0.1)
atr = atr(Periods)
up = src - (Multiplier*atr)
up1 = nz(up[1], up)
up := close[1] > up1 ? max(up, up1) : up
dn = src + (Multiplier*atr)
dn1 = nz(dn[1], dn)
dn := close[1] < dn1 ? min(dn, dn1) : dn
trend = 1
trend := nz(trend[1], trend)
trend := trend == -1 and close > dn1 ? 1 : trend == 1 and close < up1 ? -1 : trend
plot(trend == 1 ? up : na, title="Up Trend", style=plot.style_linebr, linewidth=2, color=color.green)
plot(trend == 1 ? na : dn, title="Down Trend", style=plot.style_linebr, linewidth=2, color=color.red)
`;
const c = compile(SRC, { tfSec: 60, symbol: 'TEST' });
if (!c.ok) { console.log('COMPILE FAIL:', c.errors.map(e => e.message).join('; ')); process.exit(1); }
const rt = c.createInstance({ tfSec: 60, symbol: 'TEST', mintick: 1e-5 });
await rt.runAll(bars);
const ups = [...rt.out.plots.values()].find(p => p.title === 'Up Trend');
const dns = [...rt.out.plots.values()].find(p => p.title === 'Down Trend');

let mismatches = 0;
for (let i = 0; i < bars.length; i++) {
  const eUp = ups.values[i], rUp = ref.ups[i];
  const eDn = dns.values[i], rDn = ref.dns[i];
  const upOk = (eUp == null) === (rUp == null) && (eUp == null || Math.abs(eUp - rUp) < 0.02);
  const dnOk = (eDn == null) === (rDn == null) && (eDn == null || Math.abs(eDn - rDn) < 0.02);
  if (!upOk || !dnOk) {
    if (mismatches < 12) console.log(`MISMATCH bar ${i}: engine up=${eUp} ref up=${rUp} | engine dn=${eDn} ref dn=${rDn}`);
    mismatches++;
  }
}
console.log('total mismatches:', mismatches, '/', bars.length);
