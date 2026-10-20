/** SCRATCH — dump SMC level labels on known grid. */
import { readFileSync } from 'node:fs';
import { compile } from '../../src/core/pine/compile.js';
const src = readFileSync(new URL('../fixtures/pine/corpus/smartmoney.pine', import.meta.url), 'utf8');
const c = compile(src);
const p0 = c.createInstance({ tfSec: 900, symbol: 'XAUUSD' });
const t00 = 1790600400 - (1790600400 % 900);
const tb = [];
for (let i = 0; i < 60; i++) tb.push({ time: t00 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 });
p0.runAll(tb);
const ids = {};
for (const d of p0.inputDefs) if (/^(Daily|Weekly|Monthly)$/.test(d.title)) ids[d.title] = d.id;
const day = 86400, t0 = 1790600400 - (1790600400 % day);
const bars = [];
for (let d = 0; d < 3; d++) for (let k = 0; k < 96; k++) {
  let h = 4100 + (k % 5), l = 4095 - (k % 3);
  if (d === 1 && k === 40) { h = 4200; l = 4080; }
  bars.push({ time: t0 + d * day + k * 900, open: 4100, high: h, low: l, close: 4100, volume: 10 });
}
const iv = {}; iv[ids.Daily] = true;
const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', inputValues: iv });
rt.runAll(bars);
console.log('lines=' + rt.store.line.size);
for (const ln of rt.store.line.values()) console.log('line y1=' + ln.y1, 'y2=' + ln.y2, 'x1=' + ln.x1, 'x2=' + ln.x2, ln.style, ln.xloc);
for (const lb of rt.store.label.values()) console.log('label text=' + JSON.stringify(lb.text), 'x=' + lb.x, 'y=' + lb.y, lb.size);
