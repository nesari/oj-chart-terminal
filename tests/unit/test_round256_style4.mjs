/**
 * test_round256_style4.mjs — ROUND256 settings batch 4 (fib one-color,
 * trend-line toggles, levels line, wedge background).
 *
 * Run: node tests/unit/test_round256_style4.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const tools2 = readFileSync('src/renderer/js/drawing/tools2.js', 'utf8');
const settings = readFileSync('src/renderer/js/drawing/settings.js', 'utf8');
const state = readFileSync('src/core/state.js', 'utf8');

/* 1 — use one color (central mapping) */
ok(tools.includes('d.opts.useOneColor && base'), 'levelsOf one-color mapping');
ok(tools2.includes('d.opts.useOneColor && base'), 'levelsOfF one-color mapping');
for (const id of ['fib', 'fibext', 'fibchannel', 'fibtz', 'fibspeedfan', 'fibttime',
  'fibcircles', 'fibarcs', 'fibwedge', 'pitchfan']) {
  const re = new RegExp('^    ' + id + ": \\[[\\s\\S]*?key: 'useOneColor'", 'm');
  ok(re.test(settings), 'schema one-color: ' + id);
}

/* 2 — trend-line visibility */
for (const [src, name] of [[tools, 'fib'], [tools, 'fibext'], [tools2, 'fibttime'], [tools2, 'fibarcs']]) {
  ok(src.includes('if (d.opts.showTrend !== false)'), 'trend gate in ' + name);
}
for (const id of ['fib', 'fibext', 'fibttime', 'fibarcs']) {
  const re = new RegExp('^    ' + id + ": \\[[\\s\\S]*?key: 'showTrend'", 'm');
  ok(re.test(settings), 'schema trend toggle: ' + id);
}

/* 3 — levels line thickness/style (fib + fibext) */
ok(tools.includes("U.dashFor(d.opts.levelStyle || 'solid', d.opts.levelWidth || 1)"), 'fib levels dash');
ok(tools.includes('ctx.lineWidth = d.opts.levelWidth || 1'), 'fibext levels width');
for (const id of ['fib', 'fibext']) {
  const re = new RegExp('^    ' + id + ": \\[[\\s\\S]*?key: 'levelWidth'[\\s\\S]*?key: 'levelStyle'", 'm');
  ok(re.test(settings), 'schema levels line: ' + id);
}

/* 4 — wedge background */
ok(tools2.includes('Background fills the wedge triangle'), 'wedge fill comment');
ok(/fibwedge: \[[\s\S]*?kind: 'fill'/.test(settings), 'wedge schema fill');

/* 5 — factory defaults keep old look */
ok(/fib: \{[\s\S]*?showTrend: true/.test(state), 'core fib showTrend');
ok(/fibttime: Object\.assign\(\{[^}]*showTrend: true/.test(tools2), 'fibttime factory showTrend');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
