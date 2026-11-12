/**
 * test_round284_drawing_settings.mjs — drawing-tool settings parity (vs TV).
 *
 * The audit in `docs/DRAWING-TOOLS-VS-TV.md` found tools whose engine code
 * reads an option that no dialog control could ever write — the user could
 * see the tool but not configure it. ROUND284 closes them:
 *
 *   measure      no schema at all        -> line + background + arrows + label
 *   callout      no schema at all        -> line + bubble fill (Text tab owns text)
 *   emoji        no schema at all        -> glyph picker + size
 *   circle/curve/dblcurve/polyline/rotrect  painted a fill with no toggle
 *   flagmark     no schema               -> size + fill
 *   arrowmarker  no schema               -> size
 *   fib          dead `bgFill` alias     -> single `fill` source of truth
 *   rect         three-state Extend      -> four states (both), like TV
 *
 * The suite parses the real sources (schema side + engine side) so it keeps
 * working as tools are added: a new tool that reads opts.X without a control
 * to write X fails here.
 *
 * Run: node tests/unit/test_round284_drawing_settings.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DRW = path.join(ROOT, 'src', 'renderer', 'js', 'drawing');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- parsers (default arguments: file contents) ---------- */
function matchBrace(s, openIdx) {
  let d = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') d++;
    else if (s[i] === '}' || s[i] === ']') { d--; if (!d) return i; }
  }
  return -1;
}

function readEngineOpts() {
  const files = ['tools.js', ...fs.readdirSync(path.join(DRW, 'tools2')).map((f) => path.join('tools2', f))];
  const bodies = {};
  for (const f of files) {
    const src = fs.readFileSync(path.join(DRW, f), 'utf8');
    const re = /TOOLS\.([a-zA-Z0-9_]+)\s*=\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length - 1;
      const end = matchBrace(src, start);
      bodies[m[1]] = (bodies[m[1]] || '') + src.slice(start, end + 1);
    }
  }
  const out = {};
  for (const [id, b] of Object.entries(bodies)) {
    const s = new Set();
    for (const mm of b.matchAll(/\b(?:d|o)\.opts\.([a-zA-Z0-9_]+)/g)) s.add(mm[1]);
    for (const mm of b.matchAll(/\bopts\.([a-zA-Z0-9_]+)/g)) s.add(mm[1]);
    out[id] = s;
  }
  return out;
}

function readSchemas() {
  const src = fs.readFileSync(path.join(DRW, 'settings.js'), 'utf8');
  const s0 = src.indexOf('const SCHEMAS = {');
  const openBrace = src.indexOf('{', s0);
  const closeBrace = matchBrace(src, openBrace);
  const out = {};
  const collect = (arrStart) => {
    const arrEnd = matchBrace(src, arrStart);
    const items = [];
    let j = arrStart + 1;
    while (j < arrEnd) {
      if (src[j] === '{') { const e = matchBrace(src, j); items.push(src.slice(j, e + 1)); j = e + 1; }
      else j++;
    }
    return { items, end: arrEnd };
  };
  let i = openBrace + 1;
  while (i < closeBrace) {
    const m = /^\s*([a-zA-Z0-9_]+)\s*:\s*\[/.exec(src.slice(i, i + 400));
    if (m) {
      const arrStart = src.indexOf('[', i + m[0].length - 1);
      const { items, end } = collect(arrStart);
      out[m[1]] = items;
      i = end + 1;
      continue;
    }
    i++;
  }
  /* Schemas are ALSO declared as `SCHEMAS.<tool> = [...]` after the table, and
     those assignments win at runtime. Missing them made the first audit report
     17 tools as "no schema" when they had one all along. */
  const re = /SCHEMAS\.([a-zA-Z0-9_]+)\s*=\s*(\[|SCHEMAS\.([a-zA-Z0-9_]+))/g;
  let m2;
  while ((m2 = re.exec(src))) {
    if (m2[2].startsWith('SCHEMAS.')) { if (out[m2[3]]) out[m2[1]] = out[m2[3]]; continue; }
    const arrStart = src.indexOf('[', m2.index + m2[0].length - 1);
    out[m2[1]] = collect(arrStart).items;
  }
  return out;
}

const LINE = ['color', 'width', 'style'];
const FILL = ['fill', 'fillColor', 'fillOpacity'];
const TEXT_TAB = ['text', 'italic', 'bold', 'fontSize', 'textColor', 'textVAlign', 'textHAlign', 'textalign', 'align'];
/* options the ENGINE writes while the user drags, not dialog fields:
   `ctrls` = bend controls for curves, `stop` = posforecast's dragged stop
   level (ROUND289). Both are produced by gestures, so no dialog must expose
   them — but the painter legitimately reads them back. */
const IGNORE = new Set(['vis', 'ctrls', 'stop']);

function covers(item) {
  const out = new Set();
  const kind = (/kind:\s*'([a-zA-Z]+)'/.exec(item) || [])[1];
  if (kind === 'line') LINE.forEach((k) => out.add(k));
  if (kind === 'fill') FILL.forEach((k) => out.add(k));
  if (kind === 'emoji') out.add('ch');
  if (/\barrows:\s*true/.test(item)) out.add('arrows');
  for (const k of item.matchAll(/(?:^|[^a-zA-Z])key:\s*'([a-zA-Z0-9_]+)'/g)) out.add(k[1]);
  for (const k of item.matchAll(/(?:colorKey|widthKey|styleKey):\s*'([a-zA-Z0-9_]+)'/g)) out.add(k[1]);
  if (kind === 'group') {
    const j = item.indexOf('[');
    if (j >= 0) {
      const end = matchBrace(item, j);
      let k = j + 1;
      while (k < end) {
        if (item[k] === '{') { const e = matchBrace(item, k); for (const x of covers(item.slice(k, e + 1))) out.add(x); k = e + 1; }
        else k++;
      }
    }
  }
  return out;
}

/* ---------- 1. no tool is left without a schema ---------- */
const ENGINE = readEngineOpts();
const SCHEMA = readSchemas();
{
  /* Cursor tools draw nothing and own no options (TV: they only change the
     pointer), so they legitimately have no Style tab. */
  const CURSOR_TOOLS = new Set(['cross', 'arrowcur', 'dot']);
  const noSchema = Object.keys(ENGINE).filter((id) => !CURSOR_TOOLS.has(id) && !SCHEMA[id]);
  ok(noSchema.length === 0, 'every drawing tool (not a cursor tool) has a settings schema', noSchema.join(', '));
  ok(Object.keys(SCHEMA).length >= 70, 'the schema table still covers the whole toolset (' + Object.keys(SCHEMA).length + ')');
}

/* ---------- 2. every option the engine reads is writable ---------- */
{
  const gaps = [];
  for (const id of Object.keys(ENGINE).sort()) {
    const engine = [...ENGINE[id]].filter((k) => !IGNORE.has(k) && !TEXT_TAB.includes(k));
    const cov = new Set();
    /* `extend` select maps onto extendLeft/extendRight via applyExtend() */
    const hasExtendSelect = (SCHEMA[id] || []).some((it) => /key:\s*'extend'/.test(it));
    for (const it of (SCHEMA[id] || [])) for (const x of covers(it)) cov.add(x);
    if (hasExtendSelect) { cov.add('extendLeft'); cov.add('extendRight'); }
    const missing = engine.filter((k) => !cov.has(k));
    if (missing.length) gaps.push(id + ': ' + missing.join(','));
  }
  ok(gaps.length === 0, 'no tool reads an option the dialog cannot write', gaps.join(' | '));
}

/* ---------- 3. the specific ROUND284 additions ---------- */
/* Only two tools genuinely lacked a writable option. The other tools in the
   first audit (measure, callout, emoji, circle, curve, polyline, …) DO have
   schemas — declared as `SCHEMAS.<tool> = [...]` after the table, which the
   first analysis missed. They are asserted as regressions below, not as new
   work. */
{
  const has = (id, re) => (SCHEMA[id] || []).some((it) => re.test(it));

  ok(has('zoomin', /kind:\s*'line'/), 'zoomin: line row');
  ok(has('zoomin', /key:\s*'borderOpacity'/), 'zoomin: border opacity');
  ok(has('zoomin', /kind:\s*'fill'/), 'zoomin: background fill');

  ok(has('flagmark', /kind:\s*'line'/), 'flagmark: line row (gives colour AND width)');
  ok(has('flagmark', /key:\s*'markSize'/), 'flagmark: size');
  ok(has('flagmark', /kind:\s*'fill'/), 'flagmark: background');
}

/* ---------- 3b. regressions: schemas that already existed keep working ---------- */
{
  const has = (id, re) => (SCHEMA[id] || []).some((it) => re.test(it));
  /* these were declared via SCHEMAS.x = [...] — pinned so a future refactor
     that drops one is caught here instead of silently falling back */
  ok(has('measure', /key:\s*'fillOpacity'/), 'measure still has its box opacity');
  ok(has('measure', /key:\s*'showArrows'/), 'measure still has the arrow toggle');
  ok(has('measure', /key:\s*'showLabel'/), 'measure still has the info label toggle');
  ok(has('callout', /kind:\s*'fill'/), 'callout still has the bubble fill');
  ok(has('callout', /key:\s*'fontSize'/), 'callout still has its font size');
  ok(has('emoji', /kind:\s*'emoji'/), 'emoji still has the glyph picker');
  ok(has('emoji', /key:\s*'size'/), 'emoji still has its size');
  for (const id of ['circle', 'curve', 'dblcurve', 'polyline', 'rotrect']) {
    ok(has(id, /kind:\s*'fill'/), id + ' still has the Background toggle');
  }
  ok(has('path', /kind:\s*'line'/), 'path still renders a line row');
  ok(has('arc', /kind:\s*'line'/), 'arc still renders a line row');
}

/* ---------- 4. fib has ONE fill source of truth ---------- */
{
  const tools = fs.readFileSync(path.join(DRW, 'tools.js'), 'utf8');
  ok(!/d\.opts\.bgFill/.test(tools), 'the dead `bgFill` alias is gone from the engine');
  ok(/if \(d\.opts\.fill\) \{/.test(tools.slice(tools.indexOf('background bands between consecutive levels'))),
    'fib background is driven by opts.fill only');
  ok(hasFibFill(), 'fib schema still exposes Background');

  function hasFibFill() { return (SCHEMA.fib || []).some((it) => /kind:\s*'fill'/.test(it)); }
}

/* ---------- 5. TV Box extend has all four states ---------- */
{
  const rect = (SCHEMA.rect || []).find((it) => /key:\s*'extend'/.test(it)) || '';
  ok(/'none'/.test(rect) && /'left'/.test(rect) && /'right'/.test(rect) && /'both'/.test(rect),
    'rect Extend offers none/left/right/both like TV');
  const st = fs.readFileSync(path.join(DRW, 'settings.js'), 'utf8');
  ok(!/type === 'rect' && d\.opts\.extendLeft && d\.opts\.extendRight/.test(st),
    'the legacy migration that forced extendRight=false is removed');
  /* and applyExtend really maps all four */
  ok(/extendLeft = val === 'left' \|\| val === 'both'/.test(st), 'applyExtend maps "both" to the left edge');
  ok(/extendRight = val === 'right' \|\| val === 'both'/.test(st), 'applyExtend maps "both" to the right edge');
}

/* ---------- 6. the engine really honours both box edges ---------- */
{
  const tools = fs.readFileSync(path.join(DRW, 'tools.js'), 'utf8');
  const rectBody = tools.slice(tools.indexOf('TOOLS.rect = {'), tools.indexOf('TOOLS.ellipse = {'));
  ok(/const eL = !!d\.opts\.extendLeft, eR = !!d\.opts\.extendRight;/.test(rectBody),
    'rect draw reads both edges independently');
  ok(/const xa = eL \? 0 : xL, xb = eR \? v\.pw : xR;/.test(rectBody),
    'rect paints to the pane side for each enabled edge');
  ok(/ctx\.fillRect\(eL \? 0 : xL, yT, \(eR \? v\.pw : xR\) - \(eL \? 0 : xL\)/.test(rectBody),
    'the background covers the extended region too');
}

/* ---------- 7. filled shapes ship usable factory defaults ---------- */
{
  const shapes = fs.readFileSync(path.join(DRW, 'tools2', 'shapes.js'), 'utf8');
  const FACT = shapes.slice(shapes.indexOf('const FACTORY = {'), shapes.indexOf('for (const [type, opts] of Object.entries(FACTORY))'));
  for (const id of ['circle', 'polyline', 'curve', 'dblcurve', 'rotrect']) {
    const line = (FACT.match(new RegExp('^\\s*' + id + ':\\s*\\{[^}]*\\}', 'm')) || [''])[0];
    ok(/fill:/.test(line), id + ': factory defaults declare the fill state', line.trim().slice(0, 80));
    ok(/fillColor:/.test(line), id + ': factory defaults declare a fill colour');
    ok(/fillOpacity:/.test(line), id + ': factory defaults declare a fill opacity');
  }
  /* the shapes that were already filled keep their values (no regression) */
  ok(/flattop:.*fill:\s*true/.test(FACT) && /sector:.*fill:\s*true/.test(FACT), 'previously-filled shapes keep fill:true');
}

/* ---------- 8. schemas stay well-formed ---------- */
{
  const bad = [];
  for (const [id, items] of Object.entries(SCHEMA)) {
    for (const it of items) {
      const kind = (/kind:\s*'([a-zA-Z]+)'/.exec(it) || [])[1];
      if (!['line', 'fill', 'check', 'select', 'number', 'slider', 'color', 'levels', 'group', 'sec', 'emoji', 'text'].includes(kind)) {
        bad.push(id + ' -> ' + kind);
      }
      /* every non-line/fill/sec/levels/emoji/text entry needs a key */
      if (['check', 'select', 'number', 'slider', 'color'].includes(kind) && !/key:\s*'/.test(it)) bad.push(id + ' -> missing key');
    }
  }
  ok(bad.length === 0, 'every schema entry is well-formed', bad.slice(0, 4).join(' | '));
}

console.log('\nROUND284: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
