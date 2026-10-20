// Reproduce the EXACT Supertrend logic from the user's code and inspect values
// to find where trend/up/dn computation diverges from TradingView.
import { compile } from '../src/core/pine/compile.js';

const SRC = `//@version=4
study("Supertrend", overlay = true, format=format.price, precision=2, resolution="")
Periods = input(title="ATR Period", type=input.integer, defval=10)
src = input(hl2, title="Source")
Multiplier = input(title="ATR Multiplier", type=input.float, step=0.1, defval=3.0)
changeATR= input(title="Change ATR Calculation Method ?", type=input.bool, defval=true)
showsignals = input(title="Show Buy/Sell Signals ?", type=input.bool, defval=true)
highlighting = input(title="Highlighter On/Off ?", type=input.bool, defval=true)
atr2 = sma(tr, Periods)
atr= changeATR ? atr(Periods) : atr2
up=src-(Multiplier*atr)
up1 = nz(up[1],up)
up := close[1] > up1 ? max(up,up1) : up
dn=src+(Multiplier*atr)
dn1 = nz(dn[1], dn)
dn := close[1] < dn1 ? min(dn,dn1) : dn
trend = 1
trend := nz(trend[1], trend)
trend := trend == -1 and close > dn1 ? 1 : trend == 1 and close < up1 ? -1 : trend
upPlot = plot(trend == 1 ? up : na, title="Up Trend", style=plot.style_linebr, linewidth=2, color=color.green)
buySignal = trend == 1 and trend[1] == -1
plotshape(buySignal ? up : na, title="UpTrend Begins", location=location.absolute, style=shape.circle, size=size.tiny, color=color.green, transp=0)
dnPlot = plot(trend == 1 ? na : dn, title="Down Trend", style=plot.style_linebr, linewidth=2, color=color.red)
mPlot = plot(ohlc4, title="", style=plot.style_circles, linewidth=0)
fill(mPlot, upPlot, title="UpTrend Highligter", color=highlighting ? (trend == 1 ? color.green : color.white) : color.white)
fill(mPlot, dnPlot, title="DownTrend Highligter", color=highlighting ? (trend == -1 ? color.red : color.white) : color.white)
`;

const c = compile(SRC, { tfSec: 60, symbol: 'TEST' });
if (!c.ok) { console.log('COMPILE FAIL:', c.errors[0].message); process.exit(1); }
const rt = c.createInstance({ tfSec: 60, symbol: 'TEST', mintick: 1e-5 });

// deterministic synthetic bars with clear trend phases
const bars = [];
let t = 1700000000, price = 100;
for (let i = 0; i < 300; i++) {
  // phase A: strong uptrend, phase B: downtrend, phase C: uptrend
  const phase = i < 100 ? 0 : i < 200 ? 1 : 2;
  price += (phase === 1 ? -0.35 : 0.3) + (i % 7 === 0 ? (phase === 1 ? -0.6 : 0.5) : 0);
  const o = price, c_ = price + (Math.sin(i) * 0.15);
  bars.push({ time: t + i * 60, open: o, high: Math.max(o, c_) + 0.2, low: Math.min(o, c_) - 0.2, close: c_ });
}
await rt.runAll(bars);

const upP = rt.out.plots.get('g:36') || [...rt.out.plots.values()].find(p => p.title === 'Up Trend');
const dnP = [...rt.out.plots.values()].find(p => p.title === 'Down Trend');
const mP = [...rt.out.plots.values()].find(p => p.title === '');

console.log('plots:', [...rt.out.plots.values()].map(p => `${p.title || '(mPlot)'}[${p.style}]`).join(', '));

// print bars around a trend flip
function show(from, to) {
  for (let i = from; i < to; i++) {
    const b = bars[i];
    console.log(`bar ${i}: close=${b.close.toFixed(2)} hl2=${((b.high+b.low)/2).toFixed(2)} up=${upP.values[i] == null ? 'NA' : upP.values[i].toFixed(2)} dn=${dnP.values[i] == null ? 'NA' : dnP.values[i].toFixed(2)}`);
  }
}
show(95, 108);  // around phase A->B
console.log('---');
show(195, 208); // around phase B->C
