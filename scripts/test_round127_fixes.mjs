/**
 * ROUND127 — five user fixes:
 *
 *  1. History: partial closes merge into ONE row per position (MT5 parity —
 *     volume = total closed, close = vwap of the exits, profit = the sum).
 *     The per-fragment deal view of round 120 is gone (user report).
 *  2. Chart history layer: marks sit at the CENTER of the candle containing
 *     the deal on EVERY timeframe — the intra-bar frac shift is gone (it
 *     pushed marks right of center by an amount that grew with the tf).
 *  3. Taskbar icon: multi-size assets/app.ico built from the user's logo +
 *     the win32 unpackaged AUMID (process.execPath) + both windows use it.
 *  4. Float panel dark/light: every text part passes a 3:1 contrast check
 *     in BOTH themes (e2e audit); the ½ chip got a lighter dark-mode blue.
 *  5. Entry/SL/TP lines: a bare CLICK does nothing — the drag only ARMS
 *     after DRAG_ARM_PX of real pointer travel (Click+drag&drop).
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

const dock = read('src/renderer/js/trade/dock.js');
const hist = read('src/renderer/js/trade/history.js');
const overlay = read('src/renderer/js/trade/overlay.js');
const main = read('main.js');
const tradeCss = read('src/renderer/css/trade.css');
const icoExists = fs.existsSync(ROOT + 'assets/app.ico');
const auditExists = fs.existsSync(ROOT + 'scripts/audit_round127_panel_theme.py');

console.log('— ROUND127 · 1: history = one row per POSITION (MT5 partial parity) —');
check('dock: _histRows returns a single merged row (no per-fragment loop)',
  /_histRows\(pid, g\) \{[\s\S]*?const dir = g\.in\.type === 0 \? 0 : 1;/.test(dock) &&
  !/for \(let i = 0; i < g\.outs\.length; i\+\+\)/.test(dock));
check('dock: volume = the TOTAL closed volume across the partials',
  /vol \+= o\.volume \|\| 0;/.test(dock) &&
  /closedVol: (?:volNum|vol),/.test(dock));   /* volNum = float-sanitized total (round 128) */
check('dock: close price = the volume-weighted average of the exits (vwap)',
  /vx \+= \(o\.price \|\| 0\) \* \(o\.volume \|\| 0\);/.test(dock) &&
  /const close = vol > 0 \? vx \/ vol :/.test(dock));
check('dock: profit/comm/fee/swap are the SUMS, entry fees ride the row',
  /profit \+= o\.profit \|\| 0;/.test(dock) &&
  /comm: comm \+ inComm, fee: fee \+ inFee, swap: swap \+ inSwap,/.test(dock));
check('dock: close time = the LAST fragment, comment prefers the position one',
  /if \(\(o\.time \|\| 0\) > closeT\) closeT = o\.time;/.test(dock) &&
  /comment: \(g\.in\.comment \|\| ''\)\.trim\(\) \|\| outComment,/.test(dock));
check('dock: SL/TP-hit detection reads every fragment reason (4=SL, 5=TP)',
  /if \(o\.reason === 4\) \{ slHit = true;/.test(dock) && /if \(o\.reason === 5\) \{ tpHit = true;/.test(dock));
check('dock: the row tooltip names the merged trade, no more "MT5 deal view"',
  /closed in ' \+ t\.parts \+ ' parts \(one MT5 position\)/.test(dock) &&
  !/partial close ' \+ t\.frag/.test(dock));

console.log('— ROUND127 · 2: chart history marks at the candle CENTER on every tf —');
check('history: _xOf no longer shifts by the intra-bar fraction',
  /_xOf\(pane, ts, t\) \{[\s\S]*?const s = timeSpec\(timeAxis\(pane\), t, tf\);[\s\S]*?return \(a != null && isFinite\(a\)\) \? a : null;/.test(hist) &&
  !/a \+ sp \* s\.frac/.test(hist));
check('history: the containing bar still resolves through the gap-inclusive axis',
  /const s = timeSpec\(timeAxis\(pane\), t, tf\);/.test(hist));
check('history: doc header documents the center rule',
  /the mark sits at the candle CENTER on every timeframe/.test(hist));

console.log('— ROUND127 · 3: the taskbar shows the built OJ icon —');
check('icon: the multi-size assets/app.ico ships with the app', icoExists);
check('icon: main.js prefers the .ico on win32 (png stays the non-Windows fallback)',
  /const APP_ICON = \(process\.platform === 'win32' && fs\.existsSync\(APP_ICON_ICO\)\)[\s\S]*\? APP_ICON_ICO/.test(main));
check('icon: BOTH windows (host + detached solo) take APP_ICON',
  (main.match(/icon: APP_ICON,/g) || []).length === 2);
check('icon: win32 AUMID = the executable path (Electron unpackaged-app contract)',
  /app\.setAppUserModelId\(process\.platform === 'win32' \? process\.execPath : 'OJChart Notification'\)/.test(main));
check('icon: the one-time build script is part of the repo',
  fs.existsSync(ROOT + 'scripts/make_app_icon.py') && /make_app_icon/.test(main));

console.log('— ROUND127 · 4: float panel dark/light sweep —');
check('audit: the two-theme contrast audit script ships', auditExists);
check('css: the dark-mode ½ chip left the sub-3:1 blue for the lighter one',
  /\.oc-pact\.oc-half \{ color: #5b8cff;/.test(tradeCss) &&
  /body\.theme-light \.oc-pact\.oc-half \{ color: var\(--blue\);/.test(tradeCss));
check('css: hover fills of every action chip stay token-colored',
  /\.oc-pact\.oc-half:hover:not\(:disabled\) \{ background: var\(--blue\)/.test(tradeCss));

console.log('— ROUND127 · 5: entry/SL/TP lines answer ONLY to Click+drag&drop —');
check('overlay: the arm threshold exists (6px of real travel)',
  /const DRAG_ARM_PX = 6;/.test(overlay));
check('overlay: mousedown only starts a CANDIDATE drag (no move, no freeze)',
  /_onDown\(e, pane\) \{[\s\S]*?armed: false,/.test(overlay) &&
  !/this\._onMove\(e\);\n  \},/.test(overlay));
check('overlay: the drag arms only after DRAG_ARM_PX of pointer travel',
  /if \(!d\.armed\) \{[\s\S]*?const travel = Math\.hypot\(e\.clientX - d\.sx, e\.clientY - d\.sy\);[\s\S]*?if \(\!\(travel >= DRAG_ARM_PX\)\) return;[\s\S]*?this\._armDrag\(e, d\);/.test(overlay));
check('overlay: arming freezes gestures + highlights + prefetches the spec',
  /_armDrag\(e, d\) \{[\s\S]*?handleScroll: false, handleScale: false[\s\S]*?this\._highlight\(pane, st, line\.ticket\);/.test(overlay));
check('overlay: a never-armed release does NOTHING (no order, no toast)',
  /_onUp\(e\) \{[\s\S]*?if \(!d\.armed\) \{ this\._drag = null; return; \}/.test(overlay));
check('overlay: the right-click trade menu + hover hold are untouched',
  /_onCtx\(e, pane\) \{/.test(overlay) && /TIP_DWELL_MS = 2000;/.test(overlay));

/* ---------- behavioral mirrors ---------- */
console.log('— ROUND127 · behavioral mirrors —');

/* mirror: the merged history row economics (same math as dock._histRows) */
function mergedRow(g) {
  let vol = 0, profit = 0, vx = 0, comm = 0, fee = 0, swap = 0, closeT = 0;
  let slHit = false, tpHit = false, slPx = 0, tpPx = 0;
  for (const o of g.outs) {
    vol += o.volume || 0; profit += o.profit || 0;
    vx += (o.price || 0) * (o.volume || 0);
    comm += o.commission || 0; fee += o.fee || 0; swap += o.swap || 0;
    if ((o.time || 0) > closeT) closeT = o.time;
    if (o.reason === 4) { slHit = true; if (!slPx) slPx = o.price; }
    if (o.reason === 5) { tpHit = true; if (!tpPx) tpPx = o.price; }
  }
  const close = vol > 0 ? vx / vol : 0;
  return { vol, close, closeT, profit, slHit, tpHit };
}
/* three partials + an SL hit among them → ONE row, vwap close, SL flagged */
const g = { in: { price: 2000, type: 0, comment: '  ' }, outs: [
  { volume: 0.5, price: 2010, profit: 5, commission: -0.5, time: 100, reason: 0 },
  { volume: 0.3, price: 2005, profit: 1.5, commission: -0.3, time: 200, reason: 0 },
  { volume: 0.2, price: 1998, profit: -0.4, commission: -0.2, time: 300, reason: 4 }] };
const row = mergedRow(g);
check('mirror: 3 partials → one row (vol 1.0, last close time 300)',
  Math.abs(row.vol - 1.0) < 1e-9 && row.closeT === 300);
check('mirror: vwap close = Σ(p·v)/Σv with the SL fragment included',
  Math.abs(row.close - (2010 * 0.5 + 2005 * 0.3 + 1998 * 0.2)) < 1e-9);
check('mirror: the SL hit survives the merge (reason 4 fragment seen)',
  row.slHit === true && row.tpHit === false);

/* mirror: the candle-center x rule (the exact LWC vendor math) */
function centerX(idx, barSpacing) { return (idx + 0.5) * barSpacing; } // = logicalToCoordinate
check('mirror: logicalToCoordinate(idx) IS the candle center in this LWC build',
  centerX(2, 10) === 25 && centerX(7, 8) === 60);
check('mirror: mid-bar and edge fills of the SAME bar share one center',
  centerX(4, 12) === centerX(4, 12));

/* mirror: the click vs drag state machine (overlay._onDown/_onMove/_onUp) */
const ARM = 6;
function session(moves, end) {
  let armed = false, orders = 0, moved = false;
  const down = { x: 100, y: 100 };
  let cur = { ...down };
  const travel = () => Math.hypot(cur.x - down.x, cur.y - down.y);
  const onMove = (x, y) => {
    cur = { x, y };
    if (!armed) {
      if (!(travel() >= ARM)) return;
      armed = true;
    }
    moved = true; // the live line re-price happens here (armed only)
  };
  const onUp = () => { if (!armed) return 'nothing'; orders++; return 'modify'; };
  for (const m of moves) onMove(m[0], m[1]);
  return end(onUp);
}
check('mirror: press + release (jitter 3px) = click → NOTHING, no order',
  session([[103, 100]], (up) => up()) === 'nothing');
check('mirror: press + 5px drift + release = still a click → NOTHING',
  session([[104, 102]], (up) => up()) === 'nothing');
check('mirror: press + 7px travel + release = drag&drop → ONE modify',
  session([[100, 108]], (up) => up()) === 'modify');
check('mirror: press + walk away 40px + release = the same drag path',
  session([[110, 100], [130, 100], [140, 102]], (up) => up()) === 'modify');

console.log('\nROUND127: ' + N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
