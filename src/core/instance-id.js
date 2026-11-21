/**
 * Instance-id minting (ROUND303).
 *
 * WHY THIS IS A MODULE AND NOT A ONE-LINER IN EACH CALLER
 *
 * Two places minted ids as `Date.now() + Math.floor(Math.random() * 999)`:
 * indicators-ui.syncPine() and pine-ui/panel.add() (restoreInto() did a variant
 * of the same). That gives a 0..998 draw inside a ONE-MILLISECOND bucket, so two
 * ids can only collide when they are minted in the same millisecond AND draw the
 * same number.
 *
 * Adding the 15 separate-pane built-ins "at once" does exactly that: every add
 * runs synchronously inside one task, so all 15 draws land in one millisecond
 * bucket. Measured birthday rate for 15 draws over 999 slots: ~6% per round, and
 * a 6-round sweep reproduced it twice.
 *
 * A collision is not cosmetic — both registries are keyed by this id:
 *
 *   pane._subs  (Map instId -> sub-pane)   -> the second _ensureSub() OVERWRITES
 *                                             the first entry, so two indicators
 *                                             share ONE pane and one plots nowhere
 *                                             ("14 panes for 15 records")
 *   rtMap       (Map instId -> state)      -> the second rebuild REPLACES the
 *                                             first state, so one indicator never
 *                                             runs at all ("15 records, 14
 *                                             instances")
 *
 * Both were observed live (R303 audit, finding: "not every separate-pane
 * indicator kept its pane"). The user-visible symptom is an indicator that
 * sometimes fails to appear when several are added quickly — e.g. restoring a
 * saved layout.
 *
 * The fix is a monotonic counter with a per-pane guard: ids stay numbers
 * (persistence, `data-*` attributes and the public API all treat them as
 * numbers), but two ids minted by the same pane can never be equal.
 *
 * @module core/instance-id
 */

/* One counter shared by every minter. Kept above wall-clock ms so a value that
   came from an older build (Date.now()+n) can never be re-minted later. */
let SEQ = 0;
const seen = new WeakMap(); // owner object -> Set of ids minted for it

/**
 * Mint a collision-free instance id.
 * @param {object} [owner] the pane (or any stable object) the id belongs to;
 *                         when given, uniqueness is guaranteed PER OWNER.
 * @returns {number}
 */
export function nextInstanceId(owner) {
  const now = Date.now();
  let id = SEQ = Math.max(SEQ + 1, now);
  if (owner && typeof owner === 'object') {
    let set = seen.get(owner);
    if (!set) { set = new Set(); seen.set(owner, set); }
    /* The counter is global and monotonic, so this loop can only run once even
       if two adders interleave across awaits — but keep it as the hard
       guarantee that matters (same pane, same number is impossible). */
    while (set.has(id)) id = ++SEQ;
    set.add(id);
    return id;
  }
  return id;
}

/** test/diagnostic hook: forget a pane's minted ids (pane teardown). */
export function dropInstanceIds(owner) {
  if (owner && typeof owner === 'object') seen.delete(owner);
}
