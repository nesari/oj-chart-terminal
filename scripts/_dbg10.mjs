import { compile } from '../src/core/pine/compile.js';
import { readFileSync } from 'node:fs';
const src = readFileSync('scripts/pine-fixtures/sample-Supertrend.pine', 'utf8');
const c = compile(src, { tfSec: 60, symbol: 'EURUSD' });
console.log('overlay=', c.meta.overlay, 'title=', c.meta.title);
const rt = c.createInstance({ tfSec: 60, symbol: 'EURUSD', mintick: 1e-5 });
const bars = [];
let t = 1700000000000, price = 1.08;
for (let i = 0; i < 300; i++) {
  price += Math.sin(i / 40) * 0.0002 + (Math.random() - 0.5) * 0.0004;
  bars.push({ time: Math.floor(t / 1000), open: price, high: price + 0.0004, low: price - 0.0004, close: price });
  t += 60000;
}
await rt.runChunked(bars, 200);
for (const [k, s] of rt.out.shapes) {
  const texts = [...new Set(s.texts.filter(x => x !== null))];
  console.log(k, s.style, 'texts:', JSON.stringify(texts));
}
