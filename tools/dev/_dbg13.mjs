// Inspect the engine's globals history for `up`/`up1`/`trend` around bar 100.
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
plot(trend == 1 ? up : na, title="Up Trend")
plot(trend == 1 ? na : dn, title="Down Trend")
`;

const bars = [];
let price = 100, t = 1700000000;
for (let i = 0; i < 300; i++) {
  const phase = i < 100 ? 0 : i < 200 ? 1 : 2;
  price += (phase === 1 ? -0.35 : 0.3) + (i % 7 === 0 ? (phase === 1 ? -0.6 : 0.5) : 0);
  const o = price, c = price + Math.sin(i) * 0.15;
  bars.push({ time: t + i * 60, open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c });
}

const c = compile(SRC, { tfSec: 60, symbol: 'TEST' });
const rt = c.createInstance({ tfSec: 60, symbol: 'TEST', mintick: 1e-5 });
await rt.runAll(bars);

function hist(name) {
  const rec = rt.globals.get(name);
  return rec ? rec.hist : null;
}
const upH = hist('up'), up1H = hist('up1'), trH = hist('trend'), srcH = hist('src');
console.log('globals with hist:', [...rt.globals.keys()].filter(n => rt.globals.get(n).hist).join(', '));
console.log('up1 rec:', JSON.stringify(rt.globals.get('up1') && Object.keys(rt.globals.get('up1'))));
console.log('up1 value at 100:', rt.globals.get('up1') && rt.globals.get('up1').value);
for (let i = 98; i < 106; i++) {
  console.log(`bar ${i}: close=${bars[i].close.toFixed(2)} src=${srcH[i].toFixed(2)} up=${upH[i] && upH[i].toFixed(3)} up1=${(rt.globals.get("up1").hist ? (rt.globals.get("up1").hist[i] != null ? rt.globals.get("up1").hist[i].toFixed(3) : "NA") : "nohist")} trend=${trH[i]}`);
}
