/**
 * Right panel controller (extracted from app.js in Phase 2)
 *
 * The icon rail is FIXED at the far right edge (TV); clicking a rail icon
 * opens its panel to the LEFT of the rail (the chart + its price scale shift
 * left). Clicking the active icon again closes the panel — the rail itself
 * never hides (rounds 17/18).
 *
 * @module ui/rightpanel
 */
import { U } from '../core/util.js';
import { Watchlist } from '../panels/watchlist.js';
import { Diagnostics } from '../panels/diagnostics.js';
import { StratDock } from '../panels/stratdock.js';

/** open (or toggle-close) the right panel on a given tab */
export function RightPanelShowTab(tab) {
  /* ROUND179: the Strategy Tester lives in the bottom dock now — its rail
     icon toggles the dock instead of opening a rail tab. */
  if (tab === 'tester') { StratDock.toggle(); return; }
  const content = document.getElementById('right-content');
  const btn = document.querySelector('#right-tabs .rt-btn[data-tab="' + tab + '"]');
  // clicking the icon of the already-open panel closes it (TV)
  const alreadyOpen = !content.classList.contains('hidden') && btn && btn.classList.contains('active');
  if (alreadyOpen) { RightPanelClose(); return; }
  content.classList.remove('hidden');
  const split = document.getElementById('rp-split');
  if (split) split.classList.remove('hidden');
  document.querySelectorAll('#right-tabs .rt-btn[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.rtab').forEach((t) => t.classList.add('hidden'));
  const el = document.getElementById('tab-' + tab);
  if (el) el.classList.remove('hidden');
  try { U.lsSet('mt5_rp_tab', tab); } catch (e) {}
  /* BUG-013: the watchlist lives-subscribes EVERY listed symbol while its
     panel is open and releases them when another tab/closed state takes
     over — row data flow never depends on the chart's selection */
  if (Watchlist.setPanelOpen) Watchlist.setPanelOpen(tab === 'watchlist');
  /* round 28: the diagnostics view refreshes when it becomes visible */
  if (tab === 'diagnostics' && Diagnostics.onShow) Diagnostics.onShow();
}

/** close the right panel entirely */
export function RightPanelClose() {
  const content = document.getElementById('right-content');
  content.classList.add('hidden');
  const split = document.getElementById('rp-split');
  if (split) split.classList.add('hidden');
  document.querySelectorAll('#right-tabs .rt-btn[data-tab]').forEach((b) => b.classList.remove('active'));
  try { U.lsSet('mt5_rp_tab', 'closed'); } catch (e) {}
  if (Watchlist.setPanelOpen) Watchlist.setPanelOpen(false);
}

/* ---------- ROUND40: panel width resize (user report: the panel width used
   to be adjustable) ---------- */
const RP_W_KEY = 'mt5_rp_width';
const RP_W_MIN = 230, RP_W_MAX = 480, RP_W_DEF = 290;
/* ROUND103: the persisted width was applied blind. Restore a 480px panel on
   a 1024px laptop (or drag the window narrow with the panel open) and the
   chart was squeezed toward zero with no way back except dragging the
   splitter — the splitter itself is what had been pushed off-screen. The
   panel may never take more than half the window. */
function rpMaxWidth() {
  return Math.max(RP_W_MIN, Math.min(RP_W_MAX, Math.round(window.innerWidth * 0.5)));
}
function rpApplyWidth(px) {
  const content = document.getElementById('right-content');
  if (!content) return;
  px = Math.min(rpMaxWidth(), Math.max(RP_W_MIN, Math.round(px)));
  content.style.width = px + 'px';
  content.style.flex = '0 0 ' + px + 'px';
  return px;
}
export function RightPanelInitResize() {
  const split = document.getElementById('rp-split');
  const content = document.getElementById('right-content');
  if (!split || !content) return;
  const saved = Math.round(Number(U.lsGet(RP_W_KEY, RP_W_DEF)));
  rpApplyWidth(isFinite(saved) ? saved : RP_W_DEF);
  /* re-clamp when the window itself shrinks (the stored preference is kept,
     so widening the window restores the width the user chose) */
  window.addEventListener('resize', () => {
    const content = document.getElementById('right-content');
    if (!content || content.classList.contains('hidden')) return;
    const want = Math.round(Number(U.lsGet(RP_W_KEY, RP_W_DEF)));
    rpApplyWidth(isFinite(want) ? want : RP_W_DEF);
  });
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startW = content.getBoundingClientRect().width;
    const move = (ev) => {
      rpApplyWidth(startW + (startX - ev.clientX));
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.body.style.cursor = '';
      U.lsSet(RP_W_KEY, Math.round(content.getBoundingClientRect().width));
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.body.style.cursor = 'col-resize';
  });
  split.addEventListener('dblclick', () => {
    rpApplyWidth(RP_W_DEF);
    U.lsSet(RP_W_KEY, RP_W_DEF);
  });
}

/** public facade (same shape the old window.RightPanel exposed) */
export const RightPanel = { showTab: RightPanelShowTab, close: RightPanelClose, initResize: RightPanelInitResize };
