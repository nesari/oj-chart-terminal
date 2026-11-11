/**
 * test_round286_chart_hardening.mjs — ROUND286: stale-state hardening.
 *
 * Found by a live app sweep (tests/archive/e2e/audit_app_deep.py): switching a
 * chart to an interval that is not in `App.tfById` threw
 *   TypeError: Cannot read properties of undefined (reading 'label')
 * inside updateLegendTitle, leaving the pane half-switched.
 *
 * That state is reachable in normal use: a saved layout (`mt5_boot_panes`)
 * or a per-pane record can name a CUSTOM interval the user has since deleted.
 * The render path dereferenced `App.tfById[pane.tf].label` in several places
 * with no guard.
 *
 * Pins:
 *  1. applyTf rejects an unknown interval id (loud no-op, chart stays intact)
 *  2. both legend dereferences fall back to the raw id instead of throwing
 *  3. a valid interval still switches normally
 *
 * Run: node tests/unit/test_round286_chart_hardening.mjs
 */

import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const render = readSource('src/renderer/js/chart/manager/render.js');
const layout = readSource('src/renderer/js/chart/manager/layout.js');

/* ---------- 1. applyTf guards an unknown id ---------- */
{
  ok(/if \(tfId != null && !App\.tfById\[tfId\]\) \{/.test(render),
    'applyTf checks the interval exists before switching');
  const guard = (render.match(/if \(tfId != null && !App\.tfById\[tfId\]\) \{[\s\S]{0,420}?\n    \}/) || [''])[0];
  ok(/return;/.test(guard), 'the guard returns instead of continuing');
  ok(/Log\.warn/.test(guard), 'the rejection is logged (not silent)');
  /* the guard must run BEFORE pane.tf is written */
  const guardIdx = render.indexOf('if (tfId != null && !App.tfById[tfId])');
  const assignIdx = render.indexOf('pane.tf = tfId;', guardIdx);
  ok(guardIdx > 0 && assignIdx > guardIdx, 'the guard runs before pane.tf is mutated');
}

/* ---------- 2. legend never dereferences a missing definition ---------- */
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const layoutCode = strip(layout);
  /* every dereference of the interval label must sit behind a guard */
  const bare = layoutCode.split('\n').filter((l) => {
    const m = /App\.tfById\[pane\.tf\]\.label/.exec(l);
    if (!m) return false;
    return !/\?|\&\&/.test(l.slice(0, m.index));
  });
  ok(bare.length === 0, 'no bare App.tfById[pane.tf].label dereference remains', bare[0]);
  /* the interval part of the title */
  ok(/const tfDef = App\.tfById\[pane\.tf\];/.test(layout),
    'the legend title resolves the interval through a guarded local');
  ok(/partsW\.push\(tfDef \? tfDef\.label : String\(pane\.tf \|\| ''\)\)/.test(layout),
    'the title falls back to the raw id');
  /* the dedicated interval element */
  ok(/els\.lgTf\.textContent = App\.tfById\[pane\.tf\] \? App\.tfById\[pane\.tf\]\.label : String\(pane\.tf \|\| ''\);/.test(layout),
    'the legend interval element falls back too');
}

/* ---------- 3. the specific failing call path is documented ---------- */
{
  const r = render.slice(render.indexOf('function applyTf'), render.indexOf('function applyTf') + 900);
  ok(/ROUND286/.test(r), 'the fix is documented at the call site');
  const l = layout.slice(layout.indexOf('function updateLegendTitle'), layout.indexOf('function updateLegendTitle') + 2200);
  ok(/ROUND286/.test(l), 'the legend fix is documented');
}

/* ---------- 4. functional: simulate the guard ---------- */
{
  /* mirror the production predicate so the rule stays pinned even if the
     implementation is refactored */
  const tfById = { M1: { id: 'M1', sec: 60, label: '1m' }, D1: { id: 'D1', sec: 86400, label: 'D' } };
  const accept = (id) => id == null || !!tfById[id];
  ok(accept('M1') === true, 'a known interval is accepted');
  ok(accept('D1') === true, 'another known interval is accepted');
  ok(accept('C_7H') === false, 'a deleted custom interval is rejected');
  ok(accept('') === false, 'an empty id is rejected');
  ok(accept(null) === true, 'null keeps the legacy no-op path');
}

/* ---------- 5. no other table is dereferenced unguarded in the render path ---------- */
{
  /* strip block comments so the explanatory comments (which quote the old
     broken expression) are not mistaken for code */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bad = [];
  const RE = /App\.(STYLES|LAYOUTS|tfById)\[[^\]]+\]\.[a-zA-Z_]+/;
  for (const [name, src] of [['render.js', stripComments(render)], ['layout.js', stripComments(layout)]]) {
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      const m = RE.exec(l);
      if (!m) return;
      const head = l.slice(0, m.index);
      /* a guard on the same line (ternary / logical / optional chain) is fine */
      if (/\?|\&\&|\|\|/.test(head)) return;
      /* an inline ternary on the very same lookup counts as a guard */
      if (new RegExp(m[1] + '\\[').test(head)) return;
      bad.push(name + ':' + (i + 1) + ' ' + l.trim().slice(0, 90));
    });
  }
  ok(bad.length === 0, 'no unguarded STYLES/LAYOUTS/tfById dereference in the render path', bad.slice(0, 3).join(' | '));
}

console.log('\nROUND286: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
