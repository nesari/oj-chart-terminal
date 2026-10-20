/* compile+run probe for pine fixtures (arg 2 = path) — writes RESULT lines */
import { compile } from '../../src/core/pine/compile.js';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const code = readFileSync(path, 'utf8');
let c;
try { c = compile(code, { tfSec: 60 }); }
catch (e) { console.log('RESULT: COMPILE-THROW ->', String(e && e.message || e).split('\n')[0].slice(0, 220)); process.exit(0); }
if (!c.ok) {
  console.log('RESULT: COMPILE-FAIL ->', c.errors.map((e) => e.message).join(' ; ').slice(0, 300));
  process.exit(0);
}
try {
  const inst = c.createInstance({ tfSec: 60, symbol: 'TEST' });
  const bars = [];
  for (let i = 0; i < 600; i++) {
    const base = 100 + i * 0.1 + 10 * Math.sin(i / 12);
    bars.push({ time: 1700000000 + i * 60, open: base, high: base + 1.2, low: base - 1.1, close: base + 0.3, volume: 1000 + i });
  }
  inst.runAll(bars);
  const p = inst.out.plotsOrder.length;
  console.log(`RESULT: RUN-OK plots=${p}`);
} catch (e) {
  console.log('RESULT: RUN-FAIL ->', String(e && e.message || e).split('\n')[0].slice(0, 250));
}
