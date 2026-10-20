/**
 * test_round241_stratlist.mjs — ROUND241 strategy-vs-indicator identity.
 *
 * isStrategySource (core/pine/compile.js) mirrors the compiler's declMeta:
 * the FIRST code statement opens strategy(). Agreement with
 * compile().meta.isStrategy is pinned on every compilable case.
 *
 * Run: node scripts/test_round241_stratlist.mjs
 */

import { compile, isStrategySource } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const S_STRAT = '@@V\nstrategy("S241", overlay=true)\nplot(close)\n'.replace('@@V', '//@version=6');
const S_IND = '//@version=6\nindicator("I241", overlay=true)\nplot(close)\n';
const S_STUDY = '//@version=4\nstudy("Old", overlay=true)\nplot(close)\n';
const S_LIB = '//@version=6\nlibrary("L241")\nexport f() => 1\n';
const S_COMMENTED = '//@version=6\n// strategy("Nope", overlay=true)\nindicator("I241b", overlay=true)\nplot(close)\n';
const S_BLOCKED = '//@version=6\n/* strategy("Nope") */\nindicator("I241c")\nplot(close)\n';
const S_NS = '//@version=6\nindicator("I241d")\nstrategy.entry("L", strategy.long)\nplot(close)\n';
const S_TRAIL = '//@version=6\nstrategy("S241t", overlay=true) // trailing note\nplot(close)\n';
const S_MULTI = '//@version=6\nstrategy(\n" S241m ",\noverlay=true)\nplot(close)\n';
const S_URL = '// see https://example.com/a?b=1\n//@version=6\nstrategy("S241u")\nplot(close)\n';
const S_BLOCKSTR = '//@version=6\nstrategy("S241s")\ns = "a/*b"\nplot(close)\n';
const S_EMPTY = '';
const S_NODECL = '//@version=6\nx = 1\nplot(x)\n';

ok(isStrategySource(S_STRAT) === true, 'strategy decl -> true');
ok(isStrategySource(S_IND) === false, 'indicator decl -> false');
ok(isStrategySource(S_STUDY) === false, 'study decl -> false');
ok(isStrategySource(S_LIB) === false, 'library decl -> false');
ok(isStrategySource(S_COMMENTED) === false, 'commented strategy + indicator decl -> false');
ok(isStrategySource(S_BLOCKED) === false, 'block-commented strategy + indicator decl -> false');
ok(isStrategySource(S_NS) === false, 'strategy.entry namespace use is not a declaration');
ok(isStrategySource(S_TRAIL) === true, 'trailing line comment after decl -> true');
ok(isStrategySource(S_MULTI) === true, 'multiline strategy( decl -> true');
ok(isStrategySource(S_URL) === true, 'URL in a comment line does not hide the decl');
ok(isStrategySource(S_BLOCKSTR) === true, 'block opener inside a string does not eat the decl');
ok(isStrategySource(S_EMPTY) === false, 'empty source -> false');
ok(isStrategySource(null) === false, 'null source -> false');

// compiler agreement: every compilable source matches meta.isStrategy
// (block-comment sources never parse in the engine itself, so S_BLOCKED is
// a helper-only case: the dialog still classifies it sanely)
const AGREE = [S_STRAT, S_IND, S_STUDY, S_LIB, S_COMMENTED, S_NS, S_TRAIL, S_MULTI, S_URL, S_BLOCKSTR];
let agree = 0;
for (const src of AGREE) {
  const c = compile(src);
  if (!c.ok || !c.meta) { ok(false, 'compiles: ' + JSON.stringify(src.slice(0, 40))); continue; }
  if (c.meta.isStrategy === isStrategySource(src)) agree++;
  else ok(false, 'agreement: ' + JSON.stringify(src.slice(0, 40)));
}
ok(agree === AGREE.length, 'helper agrees with compiler on ' + AGREE.length + ' sources');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
