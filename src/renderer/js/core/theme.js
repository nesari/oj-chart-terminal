/**
 * Dark / Light theme (round 19)
 *
 * One switch drives the whole app:
 * - CSS variables: body.theme-light overrides the :root palette (all CSS
 * surfaces — toolbars, panels, dialogs, popups — are var-based).
 * - Chart colours: the Settings keys that hold chart-scale colours are
 * migrated to the theme's factory default ONLY while they still hold the
 * other theme's factory default (user-picked colours are never touched).
 * - Canvas drawing chrome (axis tags, stats chips, handles) reads Theme.c().
 * Multi-chart works automatically: Settings.applyAll() re-applies every pane.
 *
 * @module core/theme
 */

import { U } from './util.js';
import { icon } from '../ui/icons.js';
import { Settings } from '../chart/settings.js';
import { Manager } from '../chart/manager.js';

/* chart-scale colour factory defaults per theme */
  const CHART_DEFAULTS = {
    dark: {
      bg1: '#0f0f0f', bg2: '#0a0a0a', gridColor: 'rgba(42,46,57,.55)', /* round 44: TV dark */
      scaleText: '#d1d4dc', scaleLines: '#2a2e39', crossColor: '#758696',
      wmColor: '#787b86', symLabelColor: '#d1d4dc',
    },
    light: {
      bg1: '#ffffff', bg2: '#f0f3fa', gridColor: 'rgba(150,158,175,.30)',
      scaleText: '#131722', scaleLines: '#c9cdd6', crossColor: '#9598a1',
      wmColor: '#b6bac4', symLabelColor: '#131722',
    },
  };

  /* round 44: pre-#0f0f0f dark factory background colours. Settings that
     still hold these legacy values migrate to the new dark defaults exactly
     like the cross-theme migration below — a value that matches NEITHER the
     legacy nor the other theme's factory default is a deliberate user pick
     and is never touched. */
  const LEGACY_DARK_DEFAULTS = { bg1: '#131722', bg2: '#0c0e15' };

  /* canvas chrome colours (not user-configurable) */
  const UI = {
    dark: {
      text: '#d1d4dc', dim: '#787b86',
      tagText: '#ffffff', handleFill: '#ffffff', handleStroke: '#9598a1',
      chipBg: 'rgba(24,28,39,.94)', chipText: '#d1d4dc',
      periodSep: 'rgba(120,123,134,.42)',
    },
    light: {
      text: '#131722', dim: '#6a6d78',
      tagText: '#ffffff', handleFill: '#ffffff', handleStroke: '#787b86',
      chipBg: 'rgba(255,255,255,.95)', chipText: '#131722',
      periodSep: 'rgba(90,96,110,.45)',
    },
  };

  const Theme = {
    mode: U.lsGet('mt5_theme', 'dark'),
    /* AUD-001/BUG-008: factory chart colours per theme (snapshot palette +
       anything that must know the OTHER theme's defaults) */
    chartDefaults(mode) { return Object.assign({}, CHART_DEFAULTS[mode === 'light' ? 'light' : 'dark']); },
    c(key) { return (UI[this.mode] || UI.dark)[key]; },

    /* AUD-001: theme token read with fallback — the ONE helper for canvas/DOM
       chrome colours inside JS (every fixed colour must route through it).
       (Phase 2: moved here from core/util.js U.th — util stays dependency-
       free; canvas painters import Theme directly.) */
    th(key, fallback) {
      const v = this.c(key);
      return (v == null) ? fallback : v;
    },

    /* re-render the theme toggle button */
    _paintBtn() {
      const b = document.getElementById('theme-btn');
      if (!b) return;
      b.innerHTML = icon(this.mode === 'dark' ? 'sun' : 'moon');
      b.title = this.mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    },

    apply(mode) {
      this.mode = mode === 'light' ? 'light' : 'dark';
      U.lsSet('mt5_theme', this.mode);
      document.body.classList.toggle('theme-light', this.mode === 'light');
      this._paintBtn();
      /* migrate chart colour settings that still hold the OTHER theme's
         factory default — deliberate user picks are kept */
      const other = this.mode === 'dark' ? 'light' : 'dark';
      if (Settings && Settings.conf) {
        let touched = false;
        for (const k of Object.keys(CHART_DEFAULTS[this.mode])) {
          const cur = Settings.conf[k];
          const legacy = LEGACY_DARK_DEFAULTS[k]; /* round 44 */
          if (cur === undefined || cur === CHART_DEFAULTS[other][k] ||
              (this.mode === 'dark' && legacy && cur === legacy)) {
            Settings.conf[k] = CHART_DEFAULTS[this.mode][k];
            touched = true;
          }
        }
        if (touched) U.lsSet('mt5_settings', Settings.conf);
      }
      /* re-apply every chart (axis text, grid, background, watermark, lines) */
      if (Settings && Settings.applyAll) Settings.applyAll();
      /* round 23: the per-chart brand wordmark follows the theme — the light
         (white) mark sits on the dark chart, the dark mark on the light chart */
      if (Manager && Manager.applyBrandTheme) {
        try { Manager.applyBrandTheme(); } catch (e) {}
      }
    },

    toggle() { this.apply(this.mode === 'dark' ? 'light' : 'dark'); },
  };

export { Theme };
