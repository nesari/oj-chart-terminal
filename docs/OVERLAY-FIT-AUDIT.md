# OVERLAY-FIT-AUDIT.md — App-Wide Popup/Menu/Dialog Viewport-Fit Sweep (OVF-001, Round 24)

Rule applied to EVERY overlay surface (§2 of BUG-010): container clamped to
the viewport (never past the window bottom — taskbar-safe, 12px safety),
flexible regions scroll internally, every interactive control reachable,
underlying page never scrolls (body overflow hidden).

Mechanism (shared, ONE rule — no per-surface patches):
- `U.fitPopup(el, anchorTop, anchorBottom, {topSafe, margin})` in
  `js/core/util.js` — prefer below the anchor; flip up when more room sits
  above; cap `max-height` to the measured available space; recomputed on
  EVERY open (no stale caches).
- Applied centrally: `drawing/ui.js openFlyout` (every tool-group flyout) and
  `chart/toolbar.js popupAt` (every Toolbar popup/menus).
- Resize while open → the popup CLOSES (one rule for both classes).
- Internal scrolling regions: `.lt-flyout` (flyout body), `.lay-scroll`
  (layout grid), `.lay-layouts` (saved layouts), `.pu-list`-style lists
  (`max-height + overflow-y:auto`), dialogs use page-level scroll inside
  `.dialog` (max-height + overflow), Diagnostics page scrolls as a page.

## Surface table (all verified at 1280×720 and 1366×768, both themes)

| Surface | Trigger | Before state | Fix / state now |
|---|---|---|---|
| Tool-group flyouts (cursor/lines/fibs/gann+elliott+pattern/forecast/shapes) | left-toolbar group click | tall flyouts passed the window bottom at ~768px (BUG-005) | `U.fitPopup` clamp + flip + internal scroll — **fixed (BUG-005)**; re-verified incl. merged PATTERN section |
| Layout/grid picker (`#… .lay-picker`) | layout button | grid had its own scroll but SYNC/LAYOUTS clipped at the window bottom (BUG-010) | whole menu clamped; grid `flex:1 min-height:60` scrolls; SYNC fixed; LAYOUTS `flex:0 1 auto min-height:44` scrolls internally — **fixed (BUG-010)** |
| Top-bar overflow menus (symbol search, TF menu, timezone, chart styles, ⋯ menus) | `popupAt` | position-clamped only — a TALL menu could still pass the bottom | container `max-height` via `U.fitPopup`; menus scroll inside |
| Watchlist "+" add-symbol results | `popupAt`-style list | list capped (`max-height:330px;overflow-y:auto`) | unchanged — already clamped; container also clamped now |
| Watchlist "…" CUSTOMIZE menu | `popupAt` | small menu, fits | clamped by the shared rule |
| Object Tree context menu / per-drawing "…" menu | `popupAt` | fits (short lists) | clamped by the shared rule |
| Per-drawing "…" overflow (Visual order / Visibility / Clone…) | `popupAt` | fits | clamped by the shared rule |
| Color picker (palette + SV/hue + hex) | swatch click | picker height fixed ≈ 300px | fits at 720px; clamped by the shared rule |
| Chart settings dialog (all 5 tabs) | settings button | `.dialog` with internal scroll | unchanged — internal scroll, `margin-top` scales; no clipped controls at 720px (verified) |
| Per-tool drawings settings (Style/Text/Coordinates/Visibility + Template) | gear on ctx toolbar | `.dialog` internal scroll | unchanged — verified reachable |
| Alert create/edit dialog | alert button | `.dialog` internal scroll | unchanged + `.al-search` restyled (THEME-AUDIT) |
| Save-layout dialog (Rename / Save As / Make a copy) | Ctrl+S / menu | `.dialog` internal scroll | unchanged — verified |
| Snapshot flows (Download/Copy) | toolbar / shortcuts | no overlay beyond toast | unchanged |
| Diagnostics page | menu | page-level scroll allowed by contract | unchanged — no clipped controls |
| Alerts / Replay / Data Window popovers | panel buttons | short popovers via `popupAt` | clamped by the shared rule |
| Toasts | events | bottom-right stack, auto-dismiss | unchanged — never permanently block controls (auto-hide + small) |
| Login screen | boot | BUG-001 scope — rebuilt in this round (two-column, internal scroll only) | see BUG-001 |

## Verification
- `scripts/test_bug005_010.py` — **8/8 PASS at 1280×720** (+ a 600px-tall
  window case): every tool flyout clamped with the LAST item reachable and
  clickable; layout menu fully clamped with SYNC visible and Save reachable
  via internal scroll; resize-while-open closes the menu.
- The two previously-broken surfaces (tool flyouts, layout picker) are the
  explicit cases 1–5 of that suite.
- Screenshots: `download/bug005-010-after-fix.png`.
