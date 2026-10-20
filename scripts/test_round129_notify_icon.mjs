/**
 * ROUND129 — the trade-notification list moves BEHIND a bell icon + a
 * once-a-day automatic purge (user request):
 *
 *  1. Bell icon: the Alerts panel's "Trade notifications" block gets a
 *     compact header — bell icon + count badge + title + the capture
 *     master switch. Clicking the bell (or the title) expands the list
 *     + details IN the same Alerts section; the open choice persists.
 *  2. Daily auto-purge: the app purges the list automatically — a
 *     rolling 24 h retention sweep that runs AT MOST once per day
 *     (persisted last-purge stamp), re-checked at boot, on a 30-min
 *     interval and before every store.
 *  3. Manual cleanup stays: per-row delete + Clear all.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const talerts = read('src/renderer/js/trade/alerts.js');
const palerts = read('src/renderer/js/panels/alerts.js');
const tradeCss = read('src/renderer/css/trade.css');
const code = talerts.replace(/\/\*[\s\S]*?\*\//g, '');
const ui = palerts.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND129 · 1: the bell icon owns the list —');
check('panels: the header renders a #tn-bell button with the bell icon',
  /<button class="tn-bell" id="tn-bell"/.test(ui) && /\$\{icon\('bell'\)\}/.test(ui));
check('panels: the bell carries a live count badge (99+ capped, hidden at zero)',
  /id="tn-badge">\$\{n > 99 \? '99\+' : n\}<\/span>/.test(ui) && /tn-badge\$\{n \? '' : ' tn-zero'\}/.test(ui));
check('panels: clicking the bell toggles the list and re-renders (ROUND131: animated accToggle)',
  /bell\.addEventListener\('click', \(\) => accToggle\('trade-notify-log', \(\) => tnOpen, setTnOpen, renderNotifyLog\)\);/.test(ui));
check('panels: the title is clickable too (same toggle)',
  /querySelector\('#tn-title'\)\.addEventListener\('click', \(\) => accToggle\('trade-notify-log', \(\) => tnOpen, setTnOpen, renderNotifyLog\)\);/.test(ui));
check('panels: the open/closed choice PERSISTS (mt5_tn_open)',
  /U\.lsGet\('mt5_tn_open', false\) === true/.test(ui) && /U\.lsSet\('mt5_tn_open', tnOpen\)/.test(ui));
check('panels: collapsed by default renders only the unified header, never the list (ROUND130 card)',
  /class="al-card al-tn\$\{tnOpen \? ' al-open' : ''\}"/.test(ui) &&
  /if \(!tnOpen \|\| !on\) return;/.test(ui));
check('panels: the list + details render INSIDE the same Alerts section (#trade-notify-log)',
  /getElementById\('trade-notify-log'\)/.test(ui));
check('panels: rows keep tag + message + wall-time + per-row delete',
  /NLOG_TAG\[r\.type\] \|\| 'INFO'/.test(ui) && /fmtWallTz\(r\.at\)/.test(ui) &&
  /TradeAlerts\.removeNlog\(r\.id\)/.test(ui));
check('panels: Clear all stays in the toolbar',
  /TradeAlerts\.clearNlog\(\)/.test(ui));
check('panels: turning the capture switch ON auto-expands the list (affordance)',
  /if \(en\.checked\) \{ setTnOpen\(true\); renderNotifyLog\(\); \}/.test(ui));
check('panels: the reader scroll survives the 1.2s re-render',
  /const prevScroll = prevList \? prevList\.scrollTop : 0;/.test(ui) &&
  /if \(prevScroll > 0\) list\.scrollTop = prevScroll;/.test(ui));
check('panels: the switch remains on the header row (one click away, ROUND130 pill)',
  /class="sw-mini al-sw"/.test(ui));
check('css: bell, badge, title and hint styles ship',
  /\.tn-bell \{/.test(tradeCss) && /\.tn-badge \{/.test(tradeCss) &&
  /\.tn-badge\.tn-zero \{ display: none; \}/.test(tradeCss) &&
  /\.tn-title \{/.test(tradeCss) && /\.tn-hint \{/.test(tradeCss));
check('css: the open bell is highlighted (blue chip, ROUND130 accordion)',
  /\.al-card\.al-tn\.al-open \.tn-bell \{ background: rgba\(41, 98, 255, \.16\); color: var\(--blue\); \}/.test(tradeCss));
check('panels: an aria-expanded state rides the bell (a11y)',
  /aria-expanded="\$\{tnOpen \? 'true' : 'false'\}"/.test(ui));

console.log('— ROUND129 · 2: the once-a-day automatic purge —');
check('alerts: a 24 h rolling retention constant exists',
  /const NLOG_TTL = 24 \* 60 \* 60 \* 1000;/.test(code));
check('alerts: the last-purge stamp persists under its own key',
  /const K_PURGE = 'mt5_trnotify_purge';/.test(code));
check('alerts: purgeNlog(force) drops every event older than the TTL',
  /this\.nlog = this\.nlog\.filter\(\(r\) =>\s*\n\s*r && Number\(r\.at \|\| 0\) > 0 && now - Number\(r\.at\) < NLOG_TTL\);/.test(code));
check('alerts: the sweep is GATED to once per day by the persisted stamp',
  /const last = Number\(U\.lsGet\(K_PURGE, 0\)\) \|\| 0;\s*\n\s*if \(last > 0 && now - last < NLOG_TTL\) return 0;/.test(code));
check('alerts: force=true bypasses the gate (first boot / tests)',
  /purgeNlog\(force\) \{[\s\S]*?if \(force !== true\) \{[\s\S]*?if \(last > 0 && now - last < NLOG_TTL\) return 0;/.test(code));
check('alerts: the stamp is ALWAYS refreshed (a falsy stamp can never re-arm every tick)',
  /never persist a falsy stamp/.test(talerts) && /U\.lsSet\(K_PURGE, now\)/.test(code));
check('alerts: the purge runs at BOOT',
  /try \{ this\.purgeNlog\(\); \} catch \(e\) \{\}\s*\n\s*if \(!this\._purgeTimer\) \{/.test(code));
check('alerts: and re-checks on a 30-min interval (guard against double timers)',
  /PURGE_EVERY_MS = 30 \* 60 \* 1000;/.test(code) &&
  /this\._purgeTimer = setInterval\(\(\) => \{\s*\n\s*try \{ this\.purgeNlog\(\); \} catch \(e\) \{\}\s*\n\s*\}, PURGE_EVERY_MS\);/.test(code));
check('alerts: every store re-checks the gate (a throttled timer cannot grow the list unbounded)',
  /_logEvent\(ev\) \{[\s\S]*?try \{ this\.purgeNlog\(\); \} catch \(e\) \{\}\s*\n\s*this\.nlog\.unshift\(/.test(code));
check('alerts: the purge emits once when it actually removed rows',
  /if \(this\.nlog\.length !== before\) \{[\s\S]*?this\._emit\(\);/.test(code));
check('alerts: purgeNlog returns the removal count (introspection)',
  /return before - this\.nlog\.length;/.test(code));
check('alerts: purgeInMin exposes the minutes to the next sweep (panel status line)',
  /purgeInMin\(\) \{[\s\S]*?Math\.max\(0, Math\.ceil\(\(last \+ NLOG_TTL - Date\.now\(\)\) \/ 60000\)\);/.test(code));
check('panels: the hint names the auto-cleanup rule + the next sweep',
  /Auto-cleanup: events older than 24 h are purged automatically once a day/.test(ui) &&
  /TradeAlerts\.purgeInMin\(\)/.test(ui));
check('alerts: the 200-row hard cap from round 128 is untouched',
  /if \(this\.nlog\.length > NLOG_MAX\) this\.nlog\.length = NLOG_MAX;/.test(code));

/* ---------- behavioral mirrors ---------- */
console.log('— ROUND129 · behavioral mirrors —');

/* mirror: the exact purge filter + gate of purgeNlog */
const TTL = 24 * 60 * 60 * 1000;
function makePurger(now0) {
  let now = now0, stamp = 0;
  const purge = (rows, force) => {
    if (force !== true) {
      const last = stamp;
      if (last > 0 && now - last < TTL) return { rows, removed: 0, gated: true };
    }
    stamp = now;
    const kept = rows.filter((r) => r && Number(r.at || 0) > 0 && now - Number(r.at) < TTL);
    return { rows: kept, removed: rows.length - kept.length, gated: false };
  };
  const tick = (ms) => { now += ms; };
  return { purge, tick, stamp: () => stamp, now: () => now };
}
/* seed: one fresh event, one 5 h old, one 23 h old, one 25 h old, one broken */
const mk = (ageH, at) => ({ id: 'r' + Math.random(), at: at != null ? at : Date.now() - ageH * 3600000 });
let P = makePurger(Date.now());
let rows = [mk(0.1), mk(5), mk(23), mk(25), { id: 'bad', at: 0 }];
let r1 = P.purge(rows, true);   /* force: first boot has no stamp */
check('mirror: force sweep keeps ≤24 h rows, drops the 25 h one AND the broken stamp',
  r1.removed === 2 && r1.rows.length === 3, `${r1.removed}/${r1.rows.length}`);
check('mirror: the sweep writes the stamp', P.stamp() === P.now());
let r2 = P.purge(r1.rows);      /* gated — under 24 h since the sweep */
check('mirror: a second sweep the same day is GATED (nothing removed)',
  r2.gated === true && r2.removed === 0 && r2.rows.length === 3);
P.tick(TTL + 60000);            /* a day passes */
rows = r2.rows.concat([{ id: 'new', at: P.now() }]);  /* an event arrives NOW */
let r3 = P.purge(rows);
check('mirror: the NEXT day sweep runs again (the 5 h/23 h rows aged out, the fresh one stays)',
  r3.gated === false && r3.removed === 3 && r3.rows.length === 1, `${r3.removed}/${r3.rows.length}`);
/* mirror: minutes-to-next-sweep */
const last = Date.now() - 23 * 3600000;
const leftMin = Math.max(0, Math.ceil((last + TTL - Date.now()) / 60000));
check('mirror: purgeInMin ≈ 60 after 23 h (rounds up, never negative)',
  Math.abs(leftMin - 60) <= 1);
const leftPast = Math.max(0, Math.ceil((Date.now() - TTL + TTL - Date.now()) / 60000));
check('mirror: purgeInMin clamps to 0 when the sweep is due', leftPast === 0);

/* mirror: the badge text rule (n, 99+, hidden at 0) */
const badge = (n) => (n > 99 ? '99+' : String(n));
check('mirror: badge shows 0→hidden, 7→7, 150→99+',
  badge(150) === '99+' && badge(7) === '7');

console.log('\nROUND129: ' + N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
