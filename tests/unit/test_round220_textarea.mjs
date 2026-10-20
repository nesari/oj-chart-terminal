/**
 * test_round220_textarea.mjs — ROUND220 input.text_area dialog kind.
 *
 * input.text_area / input.textarea register kind 'textarea' (was 'string'),
 * so the settings dialog renders a multiline box like TV (KZP one-per-line
 * lists). Engine value flow is identical to strings. input.string stays
 * 'string'. KZP exposes 3 textarea defs (levels/opens/timestamps).
 *
 * Run: node tests/unit/test_round220_textarea.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const HEAD = '//@version=6\nindicator("T", overlay=true)\n';
function runIt(body) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile failed' };
  try {
    const rt = c.createInstance({ tfSec: 60, symbol: 'T', mintick: 0.01 });
    rt.runAll([{ time: 1700000000, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    return { rt, c };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
}

{
  const r = runIt('t = input.text_area("0930, green\\n1200, orange", "Times")\nv = t\nplot(1)\n');
  const def = !r.error && r.c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 }).inputs.find((d) => d.title === 'Times');
  ok(!r.error && def && def.kind === 'textarea', 'text_area kind is textarea');
  const g = !r.error && r.rt.globals.get('t');
  ok(g && g.value === '0930, green\n1200, orange', 'multiline value round-trips');
}
{
  const r = runIt('t = input.textarea("a\\nb", "Notes")\nplot(1)\n');
  const def = !r.error && r.c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 }).inputs.find((d) => d.title === 'Notes');
  ok(!r.error && def && def.kind === 'textarea', 'input.textarea alias same kind');
}
{
  const r = runIt('t = input.string("x", "Plain")\nplot(1)\n');
  const def = !r.error && r.c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 }).inputs.find((d) => d.title === 'Plain');
  ok(!r.error && def && def.kind === 'string', 'input.string stays string');
}
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'fixtures', 'pine', 'killzones_tfo.pine'), 'utf8');
  const c = compile(src);
  const defs = c.ok ? c.collectInputs({ tfSec: 300, symbol: 'XAUUSD', mintick: 0.001 }).inputs : [];
  const tas = defs.filter((d) => d.kind === 'textarea');
  ok(c.ok && tas.length === 3, 'KZP exposes 3 textarea defs (got ' + tas.length + ')');
  ok(tas.every((d) => String(d.defval).includes('\n')), 'textarea defvals stay multiline');
}

console.log('\nROUND220: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
