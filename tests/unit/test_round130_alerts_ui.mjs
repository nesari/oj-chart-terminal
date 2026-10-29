/**
 * ROUND130 — the Alerts panel redesigned (user request: "I don't like the
 * design and UI of the Alert section… tidy it up and make it beautiful"):
 *
 *  1. ORDER: the alert LIST (the panel's real content) comes FIRST; the
 *     three settings blocks moved into one tidy #al-stack below it.
 *  2. UNIFIED ACCORDIONS: every settings block is now the same .al-card —
 *     header = icon chip + title + (optional TV-style pill switch) +
 *     chevron; body = collapsible, persisted open state per card.
 *  3. ONE SWITCH LANGUAGE: the native checkboxes are gone — pill switches
 *     (.sw-mini / .sw-row) everywhere, styled like the alert-row switch.
 *  4. BEHAVIOR PRESERVED: all ids, cfg keys, events, purge logic, tests'
 *     click targets (#tn-bell, #tn-title, #tn-enabled, #ta-enabled,
 *     #alert-sound-on, #alert-loop-seg, #alert-sound-stop) unchanged.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const html = read('src/renderer/index.html');
const palerts = read('src/renderer/js/panels/alerts.js');
const icons = read('src/renderer/js/ui/icons.js');
const panelsCss = read('src/renderer/css/panels.css');
const appCss = read('src/renderer/css/app.css');
const tradeCss = read('src/renderer/css/trade.css');
const ui = palerts.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND130 · 1: the list first, one tidy stack below —');
const tabAlerts = (html.match(/<div class="rtab hidden" id="tab-alerts">[\s\S]*?<\/div>\s*<div class="rtab hidden" id="tab-datawindow">/) || [''])[0];
check('index: #alert-list moved ABOVE the settings stack',
  tabAlerts.indexOf('id="alert-list"') > -1 &&
  tabAlerts.indexOf('id="alert-list"') < tabAlerts.indexOf('id="al-stack"'));
check('index: the three sections live inside #al-stack (notifications first, sound last)',
  /<div id="al-stack">\s*<div id="trade-notify-log"><\/div>\s*<div id="trade-alert-settings"><\/div>\s*<div id="alert-sound-settings"><\/div>\s*<\/div>/.test(tabAlerts));
check('css: #al-stack is a shrinking, scrolling column that never squeezes the list flat',
  /#al-stack \{[^}]*flex: 0 1 auto; min-height: 0; overflow-y: auto;/.test(panelsCss));
check('css: #alert-list keeps a usable minimum height',
  /#alert-list \{ padding: 10px 10px 4px; min-height: 110px; \}/.test(panelsCss));

console.log('— ROUND130 · 2: the unified accordion cards —');
check('panels: the sound block renders an .al-card accordion with the volume icon chip',
  /class="al-card\$\{asOpen \? ' al-open' : ''\}"/.test(ui) && /\$\{icon\('volume'\)\}/.test(ui));
check('panels: the trading-alerts block renders the same accordion with the shield chip',
  /class="al-card\$\{taOpen \? ' al-open' : ''\}"/.test(ui) && /\$\{icon\('shield'\)\}/.test(ui));
check('panels: the notifications block renders the same accordion with the bell chip',
  /class="al-card al-tn\$\{tnOpen \? ' al-open' : ''\}"/.test(ui));
check('panels: every header = icon chip + title + switch + chevron',
  /<span class="al-ico">/.test(ui) && /<span class="al-t">/.test(ui) &&
  /class="sw-mini al-sw"/.test(ui) && /<span class="al-chev">\$\{icon\('chevdown'\)\}<\/span>/.test(ui));
check('icons: the volume (speaker + waves) glyph ships for the sound card',
  /volume: S\('<path d="M4 9\.5v5h3\.2L12 18\.6V5\.4L7\.2 9\.5H4z"\/><path d="M15\.2 9\.4a3\.6 3\.6 0 010 5\.2M17\.6 7\.2a6\.8 6\.8 0 010 9\.6"\/>'\)/.test(icons));

console.log('— ROUND130 · 3: persisted open state + switch-safe headers —');
check('panels: the sound card open state persists (mt5_as_open)',
  /U\.lsGet\('mt5_as_open', false\) === true/.test(ui) && /U\.lsSet\('mt5_as_open', asOpen\)/.test(ui));
check('panels: the trading-alerts card open state persists (mt5_ta_open)',
  /U\.lsGet\('mt5_ta_open', false\) === true/.test(ui) && /U\.lsSet\('mt5_ta_open', taOpen\)/.test(ui));
check('panels: the notifications card open state persists (mt5_tn_open, kept from ROUND129)',
  /U\.lsGet\('mt5_tn_open', false\) === true/.test(ui));
check('panels: header clicks expand/collapse — but never when the switch was clicked',
  (ui.match(/if \(e\.target\.closest\('\.al-sw'\)\) return;/g) || []).length >= 2);
check('panels: enabling a master switch auto-expands its card (both cards)',
  /if \(en\.checked\) \{ setTnOpen\(true\); renderNotifyLog\(\); \}/.test(ui) &&
  /if \(en\.checked\) \{ setTaOpen\(true\); renderTradeAlerts\(\); \}/.test(ui));
check('panels: collapsed bodies never render their controls (guarded wiring)',
  /if \(!asOpen\) return;/.test(ui) && /if \(!taOpen \|\| !on\) return;/.test(ui) &&
  /if \(!tnOpen \|\| !on\) return;/.test(ui));
check('panels: a playing repeat chain lights a live dot on the sound header',
  /head\.classList\.toggle\('al-playing', Alerts\._sndTimers\.length > 0\)/.test(ui));

console.log('— ROUND130 · 4: one switch language (pill switches) —');
check('panels: the old native-checkbox switch rows are gone from the panel',
  !/news-switch-row/.test(ui) && !/nf-title/.test(ui));
check('panels: the trading-alert type switches are labeled pill rows',
  /<label class="sw-row"><input type="checkbox" id="ta-fill"><i><\/i><span>Pending order activated<\/span><\/label>/.test(ui) &&
  /<label class="sw-row"><input type="checkbox" id="ta-sl"><i><\/i><span>Stop loss hit<\/span><\/label>/.test(ui));
check('panels: per-trade toggles are tiny pills with SL / TP / FILL chips',
  /'sw-mini sw-xs ta-tog'/.test(ui) && /mk\('fill', 'FILL', it\.fill\)/.test(ui));
check('css: the pill switch ships (hidden input + checked knob slide)',
  /\.sw-mini input, \.sw-row input \{ position: absolute; opacity: 0;/.test(panelsCss) &&
  /\.sw-mini input:checked \+ i, \.sw-row input:checked \+ i \{ background: var\(--blue\); border-color: var\(--blue\); \}/.test(panelsCss) &&
  /\.sw-mini input:checked \+ i::after, \.sw-row input:checked \+ i::after \{ transform: translateX\(13px\); background: #fff; \}/.test(panelsCss));
check('css: the xs pill + label chip styles ship',
  /\.sw-mini\.sw-xs i \{ width: 26px; height: 15px; \}/.test(panelsCss) &&
  /\.sw-mini em \{ font-style: normal;/.test(panelsCss));
check('css: the sound body controls kept their home (picker row / segmented repeat / stop)',
  /\.alert-snd-row \{/.test(appCss) && /\.al-seg button\.on \{ background: var\(--blue\); color: #fff; \}/.test(appCss) &&
  /#alert-sound-stop \{/.test(appCss));
check('css: light theme parity for the cards',
  /body\.theme-light \.al-card \{ background: #ffffff; \}/.test(panelsCss));

console.log('— ROUND130 · 5: behavior contracts untouched —');
check('panels: every tested id survives (tn-bell / tn-badge / tn-title / tn-enabled / tn-clear / ta-enabled / alert-sound-on / alert-loop-seg / alert-sound-stop)',
  ['tn-bell', 'tn-badge', 'tn-title', 'tn-enabled', 'tn-clear', 'ta-enabled',
   'alert-sound-on', 'alert-loop-seg', 'alert-sound-stop'].every((id) => ui.includes('id="' + id + '"')));
check('panels: capture config keys unchanged (notifyLog / enabled / onFill / onSL / onTP)',
  /TradeAlerts\.setCfg\('notifyLog', en\.checked\)/.test(ui) &&
  /TradeAlerts\.setCfg\('enabled', en\.checked\)/.test(ui) &&
  /\[\['ta-fill', 'onFill'\], \['ta-sl', 'onSL'\], \['ta-tp', 'onTP'\]\]/.test(ui));
check('panels: cfg.sound / cfg.loop wiring unchanged',
  /Alerts\.cfg\.sound = sel\.value; saveCfg\(\); Alerts\.previewSound\(\);/.test(ui) &&
  /Alerts\.cfg\.loop = b\.dataset\.v === 'inf' \? 'inf' : parseInt\(b\.dataset\.v, 10\) \|\| 1;/.test(ui));
check('panels: the notification rows keep tag + message + wall time + per-row delete + Clear all',
  /NLOG_TAG\[r\.type\] \|\| 'INFO'/.test(ui) && /fmtWallTz\(r\.at\)/.test(ui) &&
  /TradeAlerts\.removeNlog\(r\.id\)/.test(ui) && /TradeAlerts\.clearNlog\(\)/.test(ui));
check('css: the round-129 css contracts still resolve',
  /\.tn-bell \{/.test(tradeCss) && /\.tn-badge \{/.test(tradeCss) &&
  /\.tn-badge\.tn-zero \{ display: none; \}/.test(tradeCss) && /\.tn-hint \{/.test(tradeCss));
check('css: tinted event tags ship (blue open/fill, red SL, green TP, amber partial)',
  /\.tn-tag\.tn-open\s+\{ color: var\(--blue\);/.test(tradeCss) &&
  /\.tn-tag\.tn-sl, \.tn-tag\.tn-slmod\s+\{ color: var\(--red\);/.test(tradeCss) &&
  /\.tn-tag\.tn-tp, \.tn-tag\.tn-tpmod\s+\{ color: var\(--green\);/.test(tradeCss) &&
  /\.tn-tag\.tn-partial \{ color: #b36b00;/.test(tradeCss));
check('css: the old flat blocks are gone (no bare nf-sec card, no tn-head row)',
  !/#alert-sound-settings, #trade-alert-settings \{/.test(appCss) && !/\.tn-head \{/.test(tradeCss));

console.log('— ROUND130 · 6: armed alerts own their feed subscription —');
check('panels: syncAlertSubs holds one ref per active/unfired alert symbol',
  /function syncAlertSubs\(\)/.test(ui) &&
  /if \(a && a\.active && !a\.fired && typeof a\.symbol === 'string' && a\.symbol\) wanted\.add\(a\.symbol\)/.test(ui));
check('panels: removing/disarming/firing releases the ref exactly once',
  /for \(const sym of Array\.from\(alertSubs\)\)[\s\S]{0,200}Manager\.releaseSub\(sym\)/.test(ui) &&
  /alertSubs\.delete\(sym\)/.test(ui));
check('panels: every list mutation (save) re-syncs the subscription set',
  /function save\(\) \{ U\.lsSet\('mt5_alerts', Alerts\.list\); syncAlertSubs\(\); \}/.test(ui));
check('panels: surviving alerts re-subscribe on boot',
  /syncAlertSubs\(\); \/\* armed alerts restored from storage keep their symbols live \*\//.test(palerts));

console.log('\nROUND130: ' + N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
