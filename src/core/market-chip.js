/**
 * Pure market-state badge rule for the chart legend ("Market open" /
 * "Market closed" / "No live data").
 *
 * Extracted from chart/manager/layout.js in ROUND276 so the rule can be
 * unit-tested without a DOM. The badge is driven by two ages measured against
 * the provider's estimated SERVER clock:
 *
 *   · tickAge — seconds since the newest tick stamp (null: no tick yet)
 *   · barAge  — seconds since the newest bar open (null: history not loaded)
 *
 * Why a future tolerance: a real broker estimate can be a whole minute ahead
 * of a tick's stamp while the terminal publishes the new forming bar late
 * (proven: 7140 vs 7200 on a live account). Rejecting an age of -60 s flipped
 * every symbol to "Market closed" even though ticks were flowing. A tick
 * stamped up to CHIP_FUTURE_SKEW_SEC in the future is treated as fresh.
 *
 * Why "live-missing": when ticks stop but the history is still fresh, the
 * session is NOT closed — the provider/terminal is simply silent (quote feed
 * stalled, symbol still syncing). Reporting "Market closed" there was the
 * exact false alarm in the real-account report; "No live data" is truthful and
 * does not blame the market.
 *
 * @module core/market-chip
 */

export const CHIP_STALE_SEC = 180;        // ticks/bars older than this are stale
export const CHIP_FUTURE_SKEW_SEC = 180;  // tolerate an estimate ahead of the stamp

/**
 * @param {number|null} tickAge seconds since the newest tick (null: never)
 * @param {number|null} barAge  seconds since the newest bar open (null: none)
 * @param {number|null} tfSec   current timeframe length in seconds
 * @returns {'open'|'idle'|'live-missing'|'closed'}
 */
export function marketChipState(tickAge, barAge, tfSec) {
  const known = (v) => v != null && Number.isFinite(Number(v));
  const tf = known(tfSec) ? Math.max(0, Number(tfSec)) : 0;
  const barFresh = known(barAge) && Number(barAge) <= CHIP_STALE_SEC + tf;

  if (known(tickAge)) {
    const age = Number(tickAge);
    if (age > -CHIP_FUTURE_SKEW_SEC && age < CHIP_STALE_SEC) return 'open';
    /* ticks stopped: only call the market closed when the bars agree */
    return barFresh ? 'live-missing' : 'closed';
  }

  if (!known(barAge)) return 'idle';   // nothing loaded yet: unknown
  return barFresh ? 'idle' : 'closed';
}
