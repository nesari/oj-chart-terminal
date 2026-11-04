/**
 * ROUND276 — market-chip rule + broker offset consistency.
 *
 * Real-account report: with a live MT5 account every chart said "Market
 * closed" while history loaded fine.
 *
 * Two confirmed defects came out of the investigation:
 *
 * 1. The provider's offset estimate samples the newest M1 BAR OPEN. The
 *    terminal publishes the forming bar a second or two after :00, so the
 *    estimate flickered between 7140 and 7200 at every minute boundary on a
 *    live broker (reproduced; 7140 had also been persisted to disk). The
 *    renderer rejected a tick stamped 60 s ahead of its server clock
 *    (`age >= -5`), which flips the badge to "Market closed".
 *    Fix: snap accepted estimates to the broker's 15-minute grid, and send
 *    the offset that produced each tick stamp with the tick itself.
 *
 * 2. When ticks stop (stalled terminal quote feed / still-syncing symbol)
 *    while the loaded history is still fresh, the market is NOT closed.
 *    The badge used to claim "Market closed"; it now says "No live data".
 *
 * Run: node tests/unit/test_round276_market_chip.mjs
 */

import { marketChipState, CHIP_STALE_SEC, CHIP_FUTURE_SKEW_SEC } from '../../src/core/market-chip.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

/* ---------- 1. chip rule: fresh ticks ---------- */
{
  ok(marketChipState(0, 5, 60) === 'open', 'a tick stamped now is open');
  ok(marketChipState(179, 5, 60) === 'open', 'a 179s-old tick is still open');
  ok(marketChipState(180, 5, 60) === 'live-missing', 'a 180s-old tick is no longer open');
  ok(marketChipState(-1, 5, 60) === 'open', 'a tick 1s ahead is open');
  ok(marketChipState(-179, 5, 60) === 'open', 'a tick 179s ahead (offset jitter) is open');
  ok(marketChipState(-181, 5, 60) === 'live-missing', 'a tick beyond the future tolerance is not open');
  ok(CHIP_STALE_SEC === 180 && CHIP_FUTURE_SKEW_SEC === 180,
    'the thresholds are the documented 180s windows');
}

/* ---------- 2. chip rule: ticks stopped ---------- */
{
  ok(marketChipState(600, 30, 60) === 'live-missing',
    'ticks stopped but fresh bars -> "No live data", not closed');
  ok(marketChipState(600, 180 + 60 + 1, 60) === 'closed',
    'ticks stopped and stale bars -> closed');
  ok(marketChipState(600, 180 + 900, 900) === 'live-missing',
    'the bar freshness window scales with the timeframe');
  ok(marketChipState(600, null, 60) === 'closed',
    'ticks stopped with no loaded bars -> closed');
}

/* ---------- 3. chip rule: no tick ever (startup / weekend) ---------- */
{
  ok(marketChipState(null, null, 60) === 'idle', 'no tick and no bars -> idle (unknown)');
  ok(marketChipState(null, 30, 60) === 'idle', 'no tick yet but fresh bars -> idle, not closed');
  ok(marketChipState(null, 400, 60) === 'closed', 'no tick and stale bars -> closed (weekend open)');
  ok(marketChipState(null, 900, 900) === 'idle', 'M15 bar is still forming within its window');
}

/* ---------- 4. provider offset snapping (source contract) ---------- */
{
  const py = readSource('provider/mt5.py');
  ok(/def _snap_off\(v\)/.test(py), 'mt5.py defines the 15-minute snap helper');
  ok(/int\(round\(float\(v\) \/ 900\.0\) \* 900\)/.test(py), 'snap rounds to the 15-minute grid');
  ok(/if _quantized\(est\):\s*\n\s*est = _snap_off\(est\)/.test(py),
    'server_now snaps an accepted estimate before using it');
  ok(/_SRV_OFF = _snap_off\(v\)/.test(py), 'a persisted estimate is snapped on load');
  ok(/stamp = server_now\(\).*?_SRV_OFF/s.test(py) && /off = int\(_SRV_OFF\)/.test(py),
    'next_tick reads the offset that produced its stamp exactly once');
  ok(/return px, 1, stamp, bid, ask, off/.test(py),
    'the tick tuple carries the matching offset');
}

/* ---------- 5. provider tick keeps time/off atomic ---------- */
{
  const common = readSource('provider/provider_common.py');
  ok(/off = int\(tk\[5\]\) if len\(tk\) > 5/.test(common),
    'provider_common prefers the offset carried by the tick');
  ok(/'price': price, 'volume': vol, 'off': off/.test(common),
    'the tick message uses that offset');
}

/* ---------- 6. renderer wiring ---------- */
{
  const layout = readSource('src/renderer/js/chart/manager/layout.js');
  ok(/import \{ marketChipState \} from '\.\.\/\.\.\/\.\.\/\.\.\/core\/market-chip\.js'/.test(layout),
    'layout uses the shared, tested chip rule');
  ok(layout.includes("'No live data'"), 'the badge distinguishes a silent feed from a closed market');
  ok(/pane\._mktState !== state/.test(layout), 'chip transitions are logged once');
  ok(!/age >= -5/.test(layout), 'the old 5-second future rejection is gone');

  const feed = readSource('src/core/feed.js');
  ok(/broker offset applied/.test(feed), 'offset changes are logged for future reports');
}

/* ---------- 7. one instance owns the terminal + provider port ---------- */
{
  const main = readSource('main.js');
  ok(/app\.requestSingleInstanceLock\(\)/.test(main),
    'main asks for the single-instance lock');
  ok(/app\.on\('second-instance'/.test(main),
    'a second launch focuses the running window instead of spawning a rival provider');
  ok(/if \(singleInstance\) app\.whenReady\(\)/.test(main),
    'the refused instance never boots a window/provider');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
