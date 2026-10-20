/**
 * test_round217_overlay.mjs — ROUND217 positional overlay in declarations.
 *
 * TV signature order is (title, shorttitle, overlay, ...) — KZP passes
 * `indicator("...", "KZP [TFO]", true, ...)` positionally and used to land in
 * a sub-pane like RSI because declMeta only read named overlay=. Named wins
 * when both are present. Applies to strategy() too (same 3rd slot).
 *
 * Run: node scripts/test_round217_overlay.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const metaOf = (src) => {
  const c = compile(src);
  if (!c.ok) return { error: c.errors.map((e) => e.message).join('|').slice(0, 150) };
  return { meta: c.meta };
};

{
  const r = metaOf('//@version=6\nindicator("ICT Killzones & Pivots [TFO]", "KZP [TFO]", true, max_labels_count = 500)\nplot(close)\n');
  ok(!r.error && r.meta.overlay === true, 'indicator positional overlay=true (KZP shape)');
}
{
  const r = metaOf('//@version=6\nindicator("T", "T", false)\nplot(close)\n');
  ok(!r.error && r.meta.overlay === false, 'indicator positional overlay=false stays pane');
}
{
  const r = metaOf('//@version=6\nindicator("T")\nplot(close)\n');
  ok(!r.error && r.meta.overlay === false, 'no overlay arg defaults to pane (TV)');
}
{
  const r = metaOf('//@version=6\nindicator("T", "T", true, overlay=false)\nplot(close)\n');
  ok(!r.error && r.meta.overlay === false, 'named overlay wins over positional');
}
{
  const r = metaOf('//@version=6\nindicator("T", "T", overlay=true)\nplot(close)\n');
  ok(!r.error && r.meta.overlay === true, 'named overlay=true still works');
}
{
  const r = metaOf('//@version=5\nstrategy("S", "S", true)\nplot(close)\n');
  ok(!r.error && r.meta.overlay === true && r.meta.isStrategy, 'strategy positional overlay=true');
}
{
  const r = metaOf('//@version=5\nstrategy("S")\nplot(close)\n');
  ok(!r.error && r.meta.overlay === false, 'strategy default stays pane');
}
{
  // title still comes from the first positional (regression guard)
  const r = metaOf('//@version=6\nindicator("My Title", "MT", true)\nplot(close)\n');
  ok(!r.error && r.meta.title === 'My Title' && r.meta.overlay === true, 'title + overlay positional together');
}
{
  // full KZP fixture declares overlay positionally
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'pine-fixtures', 'killzones_tfo.pine'), 'utf8');
  const r = metaOf(src);
  ok(!r.error && r.meta.overlay === true, 'KZP fixture meta.overlay=true');
}

console.log('\nROUND217: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
