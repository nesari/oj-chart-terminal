/**
 * test_round248_emoji.mjs — ROUND248 Icons (emoji) tool wiring.
 *
 * Static pins: registry, factory, glyph, toolbar group, CTX, schema+builder,
 * grid CSS.
 *
 * Run: node tests/unit/test_round248_emoji.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const tools2 = readFileSync('src/renderer/js/drawing/tools2.js', 'utf8');
const ui = readFileSync('src/renderer/js/drawing/ui.js', 'utf8');
const icons = readFileSync('src/renderer/js/ui/icons.js', 'utf8');
const settings = readFileSync('src/renderer/js/drawing/settings.js', 'utf8');
const css = readFileSync('src/renderer/css/app.css', 'utf8');

/* 1 — emoji catalogue */
ok(tools.includes('const EMOJI_CATS = ['), 'EMOJI_CATS defined');
ok(/export \{[^}]*EMOJI_CATS[^}]*\}/.test(tools), 'EMOJI_CATS exported');
for (const cat of ['Faces', 'Trading', 'Markers']) {
  ok(tools.includes("['" + cat + "'"), 'category: ' + cat);
}
for (const ch of ['👍', '📈', '🐂', '🚀', '⬆️']) {
  ok(tools.includes("'" + ch + "'"), 'glyph in catalogue: ' + ch);
}

/* 2 — tool + factory */
ok(/TOOLS\.emoji = \{\s*name: 'Emoji', icon: 'emoji', pts: 1,/.test(tools2), 'TOOLS.emoji (1-click)');
ok(/emoji: \{ ch: '👍', size: 24 \}/.test(tools2), 'factory default');
ok(tools2.includes('Segoe UI Emoji'), 'color-emoji font stack');

/* 3 — toolbar + glyph + CTX */
ok(icons.includes('emoji: S('), 'toolbar glyph');
ok(ui.includes("{ id: 'icons', base: 'emoji', tools: ['emoji'] }"), 'icons group (single tool)');
ok(/^    emoji: \[/m.test(tools), 'CTX entry');

/* 4 — settings: schema + grid builder + dispatch + CSS */
ok(/SCHEMAS\.emoji = \[\s*\{ kind: 'emoji' \}/.test(settings), 'schema with emoji kind');
ok(settings.includes('function buildEmoji(fld)'), 'buildEmoji exists');
ok(settings.includes("else if (fld.kind === 'emoji') buildEmoji(fld);"), 'dispatch wired');
ok(settings.includes("import { TOOLS, EMOJI_CATS } from './tools.js';"), 'catalogue import');
ok(css.includes('.ds-emoji-grid') && css.includes('.ds-emoji-ch'), 'grid CSS');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
