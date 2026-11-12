/**
 * Drawing tool definitions — TradingView behaviour
 *
 * Each tool: { name, icon, pts (clicks needed), draw(view,d,sel), handles(view,d),
 * hitBody(view,d,x,y), dragHandle(view,d,idx,pt), hitR }
 * points stored as {t: epochSec, p: price} — anchored to chart coordinates.
 *
 * @module drawing/tools
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';

const HIT = 7;

  /* theme-aware canvas chrome (dark/light, round 19) - safe without Theme */
  const TH = (k, fallback) => (Theme.c) ? Theme.c(k) : fallback;

  function applyStroke(ctx, d) {
    ctx.strokeStyle = d.opts.color;
    ctx.lineWidth = d.opts.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(U.dashFor(d.opts.style, d.opts.width));
    const bo = d.opts.borderOpacity; // Box dialog: Border > Opacity
    ctx.globalAlpha = (typeof bo === 'number' && isFinite(bo)) ? U.clamp(bo, 0.02, 1) : 1;
  }

  /* fill helpers (settings: Background color + opacity) */
  function fillAlphaOf(d) {
    const o = d.opts.fillOpacity;
    return typeof o === 'number' && isFinite(o) ? U.clamp(o, 0.02, 1) : 0.15;
  }
  function fillColorOf(d) { return d.opts.fillColor || d.opts.color; }
  function middleAlphaOf(d) {
    const o = d.opts.middleOpacity;
    return typeof o === 'number' && isFinite(o) ? U.clamp(o, 0.02, 1) : 1;
  }

  function drawHandle(ctx, x, y, active) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = active ? '#2962ff' : '#9598a1';
    ctx.stroke();
    ctx.restore();
  }

  function ptXY(view, p) { return [view.xOf(p.t), view.yOf(p.p)]; }

  /* segment with optional extend left/right, clipped to pane viewport */
  function segWithExtend(view, x1, y1, x2, y2, eL, eR) {
    if (!eL && !eR) return [x1, y1, x2, y2];
    /* ROUND243 (TV parity): the old code clipped each side into the same
       xa..xb pair, so extend-both collapsed to extend-left (the eL branch
       overwrote the eR edge). One clip over the full extended span keeps
       both edges. Single-side behaviour is unchanged. */
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const T = (view.w + view.h) * 2;
    const c = U.clipLine(
      eL ? x1 - ux * T : x1, eL ? y1 - uy * T : y1,
      eR ? x2 + ux * T : x2, eR ? y2 + uy * T : y2,
      view.pw, view.ph);
    if (c) return [c[0], c[1], c[2], c[3]];
    return [x1, y1, x2, y2];
  }

  function arrowHead(ctx, x, y, fromX, fromY, size) {
    const ang = Math.atan2(y - fromY, x - fromX);
    const a1 = ang + Math.PI * 0.85, a2 = ang - Math.PI * 0.85;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a1) * size, y + Math.sin(a1) * size);
    ctx.lineTo(x + Math.cos(a2) * size, y + Math.sin(a2) * size);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  function priceTag(view, y, text, color) {
    const draw = () => {
      const ctx = view.ctx;
      const wpx = view.axisW, x0 = view.w - wpx;
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y - 9.5, wpx, 19);
      ctx.fillStyle = TH('tagText', '#fff');
      ctx.font = '600 10.5px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x0 + wpx / 2, y + 0.5);
      ctx.restore();
    };
    /* queued: render() flushes axis tags AFTER the plot clip is popped */
    if (view.axisQueue) { view.axisQueue.push(draw); return; }
    draw();
  }

  /* ROUND66 (user report — ROOT fix): the time tag used to paint on the
     overlay canvas, which sits UNDER the .tax-ext DOM strip — the static
     numbers rendered ON TOP of the highlight ("the numbers and the highlight
     fall on each other"; the ghost tick visible inside the blue tag in the
     user's screenshot). The tag is now a DOM pill appended to view.taxTags —
     the layer ABOVE the numbers (z 7 > .tax-ext 6), the same mechanism as the
     crosshair pill, which never overlapped. The engine rebuilds the layer
     every frame BEFORE the drawings append, so stale pills are impossible.
     Rows: a tag that would cover another at the same spot rises 19px, so a
     drawn vline + a news pill (or several events) on one bar stay readable. */
  function axisTimeTag(view, x, text, color, extraCls, noClamp) {
    const host = view.taxTags;
    if (!host || !text) return;
    const w = text.length * 6.6 + 14;
    /* ROUND68 (user): a NEWS highlight must stay anchored to its own time —
       when the chart is panned left/right the pill moves with the chart and,
       once its minute leaves the display, it is simply not painted any more
       (it used to slide up to the edge and stick there, never leaving the
       view). UI pills (crosshair, drawn vlines) keep the edge-clamp. */
    if (noClamp) {
      if (x + w / 2 < 0 || x - w / 2 > view.pw) return; // off-view -> gone, stays at its true place
    } else {
      x = U.clamp(x, Math.min(w / 2, view.pw / 2), Math.max(view.pw - w / 2, view.pw / 2));
    }
    const placed = host._placed || (host._placed = []);
    let row = 0;
    while (row < 2 && placed.some((p) => p.row === row && x - w / 2 < p.x1 + 4 && x + w / 2 > p.x0 - 4)) row++;
    if (row >= 2) return; // too dense — the vertical line itself still marks the spot
    placed.push({ row, x0: x - w / 2, x1: x + w / 2 });
    const tag = document.createElement('span');
    tag.className = 'tax-tag' + (extraCls ? ' ' + extraCls : '');
    tag.style.setProperty('--tag-c', color || '#2962ff');
    tag.textContent = text;
    tag.style.left = Math.round(x) + 'px';
    tag.style.bottom = (3 + row * 19) + 'px';
    host.appendChild(tag);
  }

  function timeTag(view, x, text, color) {
    axisTimeTag(view, x, text, color);
  }

  /* time shown on the time axis for a vertical line (ROUND 35, TV parity:
     the tag carries the DATE next to the time — the exact TZ.crossLabel
     format the crosshair pill already uses, "Mon 07 Sep '26  12:51";
     second-based intervals add :ss, daily-and-above shows the date only) */
  function vTimeLabel(view, t) {
    return TZ.crossLabel(App.tz, t, view.tfSec < 60, view.tfSec >= 86400);
  }

  /* small on-plot price chip (TV "Price labels" on line endpoints) */
  /* ROUND285: local chip helper for tools defined in this module (tools2 has
     its own in common.js; this one keeps tools.js self-contained). */
  function chipLabel(ctx, x, y, text, bg, fg) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg || 'rgba(24,28,39,.92)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 8, w, 15, 3); else ctx.rect(x - w / 2, y - 8, w, 15);
    ctx.fill();
    ctx.fillStyle = fg || '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 0.5);
    ctx.restore();
  }

  function priceChip(view, x, y, price, color) {
    const ctx = view.ctx;
    const txt = U.fmtPrice(price, view.digits);
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
    const w = ctx.measureText(txt).width + 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 19, w, 15, 3); else ctx.rect(x - w / 2, y - 19, w, 15);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, x, y - 11.5);
    ctx.restore();
  }

  /* Text-tab annotation (TV). With a box {x0,x1,y0,y1} the Text-tab font +
     alignment settings apply (Top/Inside/Bottom + Left/Center/Right inside
     the box) and the text is CLIPPED to the shape (rounds 19/20). Without a
     box it renders at (x, y) exactly like the previous builds. */
  function drawAnnotation(view, d, x, y, box) {
    const t = String(d.opts.text || '').trim();
    if (!t) return;
    const ctx = view.ctx;
    ctx.save();
    if (typeof d.opts.textOpacity === 'number' && isFinite(d.opts.textOpacity)) {
      ctx.globalAlpha = U.clamp(d.opts.textOpacity, 0.05, 1); // round 21: TV text opacity
    }
    const fs = d.opts.fontSize || 11;
    ctx.font = `${d.opts.italic ? 'italic ' : ''}${d.opts.bold ? '700 ' : ''}${fs}px "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = d.opts.textColor || TH('text', '#d1d4dc');
    if (!box) { ctx.textBaseline = 'top'; ctx.fillText(t, x, y); ctx.restore(); return; }
    const lines = t.split('\n');
    const lh = fs + 3;
    const H = lines.length * lh;
    const pad = 5;
    const ha = d.opts.textHAlign || 'left';
    const va = d.opts.textVAlign || 'top';
    if (ha === 'center') ctx.textAlign = 'center';
    else if (ha === 'right') ctx.textAlign = 'right';
    else ctx.textAlign = 'left';
    const bx = ha === 'center' ? (box.x0 + box.x1) / 2 : ha === 'right' ? box.x1 - pad : box.x0 + pad;
    const by = va === 'inside' ? (box.y0 + box.y1 - H) / 2
      : va === 'bottom' ? box.y1 - pad - H
      : box.y0 + pad;
    ctx.textBaseline = 'top';
    /* TV: the annotation stays INSIDE the shape - real-area boxes clip it */
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    if (bw > 8 && bh > 8) {
      ctx.beginPath();
      ctx.rect(box.x0 + 1, box.y0 + 1, bw - 2, bh - 2);
      ctx.clip();
    }
    lines.forEach((l, i) => ctx.fillText(l, bx, by + i * lh));
    ctx.restore();
  }

  /* trend INFO stats (Stats / Stats position / Always show stats) */
  function trendStats(view, d, sel) {
    if (!d.opts.stats || d.opts.stats === 'hidden') return;
    if (!sel && !d.opts.alwaysStats) return;
    const ctx = view.ctx;
    const [x1, y1] = ptXY(view, d.points[0]);
    const [x2, y2] = ptXY(view, d.points[1]);
    const dp = d.points[1].p - d.points[0].p;
    const bars = Math.abs(Math.round(U.timeToLogical(view.times, d.points[1].t) - U.timeToLogical(view.times, d.points[0].t)));
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const l1 = `${dp >= 0 ? '+' : ''}${U.fmtPrice(dp, view.digits)} (${bars} bars)`;
    const l2 = `angle ${Math.abs(ang).toFixed(1)}\u00b0`;
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
    const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 14;
    const pos = d.opts.statsPos === 'left' ? Math.min(x1, x2) : d.opts.statsPos === 'middle' ? (x1 + x2) / 2 : Math.max(x1, x2);
    const py = Math.min(y1, y2) - 32;
    ctx.fillStyle = 'rgba(24,28,39,.94)';
    ctx.strokeStyle = d.opts.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(pos - w / 2, py, w, 30, 4); else ctx.rect(pos - w / 2, py, w, 30);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d1d4dc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(l1, pos, py + 9.5);
    ctx.fillStyle = '#787b86';
    ctx.font = '10px "Segoe UI", Arial, sans-serif';
    ctx.fillText(l2, pos, py + 21.5);
    ctx.restore();
  }

  const FIB_LEVELS = [
    { r: 0, c: '#787b86' }, { r: 0.236, c: '#f23645' }, { r: 0.382, c: '#ff9800' },
    { r: 0.5, c: '#4caf50' }, { r: 0.618, c: '#089981' }, { r: 0.786, c: '#00bcd4' },
    { r: 1, c: '#787b86' },
  ];
  const FIBEXT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618, 3.618, 4.236];

  /* ROUND248 (TV parity — Icons category): curated single-glyph emoji, grouped
     like TV's menu tabs. Kept to common glyphs (no ZWJ/skin-tone sequences)
     so canvas measureText + paint stay consistent everywhere. */
  const EMOJI_CATS = [
    ['Faces', ['😀', '😁', '😂', '🤣', '😊', '😍', '🤔', '😐', '😮', '😢', '😡', '🤯', '🥳', '😴', '🤠', '👍', '👎', '👏', '💪', '👀']],
    ['Trading', ['📈', '📉', '📊', '💰', '💵', '💸', '🐂', '🐻', '🎯', '💎', '🚀', '🔥', '💯', '⚠️', '✅', '❌', '⭐', '🏆', '🥇', '💡']],
    ['Markers', ['⬆️', '⬇️', '➡️', '↗️', '↘️', '🔔', '📌', '📍', '🚩', '🏁', '📢', '💬', '❓', '❗', '⭕', '✖️', '✔️', '➕', '➖', '🔍']],
  ];

  function normRect(d) {
    const tL = Math.min(d.points[0].t, d.points[1].t);
    const tR = Math.max(d.points[0].t, d.points[1].t);
    const pT = Math.max(d.points[0].p, d.points[1].p);
    const pB = Math.min(d.points[0].p, d.points[1].p);
    return { tL, tR, pT, pB };
  }

  /* Ray-cast point-in-polygon (screen points). Used by filled shapes whose
     interior must behave like the painted fill, not only their outline. */
  function insidePoly(x, y, P) {
    let hit = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) hit = !hit;
    }
    return hit;
  }

  const TOOLS = {};

  /* ---------------- trend line / arrow / ray / extended ---------------- */
  function lineDraw(view, d, sel, mode) {
    // mode: 'seg' | 'ray' | 'inf' | 'arrow'
    const ctx = view.ctx;
    const [x1, y1] = ptXY(view, d.points[0]);
    const [x2, y2] = ptXY(view, d.points[1]);
    let seg;
    if (mode === 'ray') seg = segWithExtend(view, x1, y1, x2, y2, false, true);
    else if (mode === 'inf') seg = segWithExtend(view, x1, y1, x2, y2, true, true);
    else seg = segWithExtend(view, x1, y1, x2, y2, !!d.opts.extendLeft, !!d.opts.extendRight);
    if (!seg) return;
    applyStroke(ctx, d);
    ctx.beginPath();
    ctx.moveTo(seg[0], seg[1]);
    ctx.lineTo(seg[2], seg[3]);
    ctx.stroke();
    if (mode === 'arrow') arrowHead(ctx, x2, y2, x1, y1, 8 + d.opts.width * 2);
  }

  function lineBody(view, d, eL, eR) {
    const [x1, y1] = ptXY(view, d.points[0]);
    const [x2, y2] = ptXY(view, d.points[1]);
    /* eL/eR let Ray/Extended/Arrow share this body test. When omitted the
       tool's own Extend toggles are used, so an extended trend line is
       grabbable along the painted extension too (not only A..B). */
    if (eL === undefined) eL = !!d.opts.extendLeft;
    if (eR === undefined) eR = !!d.opts.extendRight;
    let seg = [x1, y1, x2, y2];
    if (eL || eR) seg = segWithExtend(view, x1, y1, x2, y2, !!eL, !!eR);
    const m = Math.max(5, 4 + (d.opts.width || 2));
    return (x, y) => U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < m;
  }

  TOOLS.trend = {
    name: 'Trend Line', icon: 'trend', pts: 2,
    draw(v, d, sel) {
      lineDraw(v, d, sel, 'seg');
      const [x1, y1] = ptXY(v, d.points[0]);
      const [x2, y2] = ptXY(v, d.points[1]);
      if (d.opts.arrows) {
        arrowHead(v.ctx, x1, y1, x2, y2, 8 + d.opts.width * 2);
        arrowHead(v.ctx, x2, y2, x1, y1, 8 + d.opts.width * 2);
      }
      if (d.opts.priceLabels) {
        priceChip(v, x1, y1, d.points[0].p, d.opts.color);
        priceChip(v, x2, y2, d.points[1].p, d.opts.color);
      }
      trendStats(v, d, sel);
      drawAnnotation(v, d, (x1 + x2) / 2 + 6, (y1 + y2) / 2 + 6);
    },
    handles(v, d) {
      const a = ptXY(v, d.points[0]), b = ptXY(v, d.points[1]);
      const hs = [a, b];
      if (d.opts.middle) hs.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      return hs;
    },
    hitBody: lineBody,
    dragHandle(v, d, i, pt) {
      if (i === 2 && d.opts.middle) { // middle handle moves the whole line
        const mt = (d.points[0].t + d.points[1].t) / 2, mp = (d.points[0].p + d.points[1].p) / 2;
        const dt = pt.t - mt, dp = pt.p - mp;
        d.points[0] = { t: d.points[0].t + dt, p: d.points[0].p + dp };
        d.points[1] = { t: d.points[1].t + dt, p: d.points[1].p + dp };
        return;
      }
      d.points[i] = { t: pt.t, p: pt.p };
    },
  };

  TOOLS.arrow = {
    name: 'Arrow', icon: 'arrowline', pts: 2,
    draw(v, d, sel) { lineDraw(v, d, sel, 'arrow'); },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) { return lineBody(v, d, false, false); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.ray = {
    name: 'Ray', icon: 'ray', pts: 2,
    draw(v, d, sel) { lineDraw(v, d, sel, 'ray'); },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) { return lineBody(v, d, false, true); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.extended = {
    name: 'Extended Line', icon: 'extended', pts: 2,
    draw(v, d, sel) { lineDraw(v, d, sel, 'inf'); },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) { return lineBody(v, d, true, true); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- parallel channel ----------------
     ROUND252 (TV parity): Channel's levels — extra parallels at in-channel
     ratios (levels editor, per-level colors). Empty by default (TV default is
     the two edges). */
  function parallelOff(P) {
    /* perpendicular offset of click 3 from the infinite P1P2 line (R243: no
       clamp — TV width even past the segment ends) */
    const [x1, y1] = P[0], [x2, y2] = P[1], [x3, y3] = P[2];
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    const t = ((x3 - x1) * dx + (y3 - y1) * dy) / l2;
    return [x3 - (x1 + t * dx), y3 - (y1 + t * dy)];
  }
  TOOLS.parallel = {
    name: 'Parallel Channel', icon: 'parallel', pts: 3,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const P = d.points.map((p) => ptXY(v, p));
      const [x1, y1] = P[0], [x2, y2] = P[1];
      const [ox, oy] = parallelOff(P);
      const eL = !!d.opts.extendLeft, eR = !!d.opts.extendRight;
      const edge = (fx) => segWithExtend(v, x1 + ox * fx, y1 + oy * fx, x2 + ox * fx, y2 + oy * fx, eL, eR);
      const s1 = edge(0);
      const s2 = edge(1);
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s1[2], s1[3]);
        ctx.lineTo(s2[2], s2[3]); ctx.lineTo(s2[0], s2[1]);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s1[2], s1[3]); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s2[0], s2[1]); ctx.lineTo(s2[2], s2[3]); ctx.stroke();
      /* Channel's levels (fractions of the full width, per-level colors) */
      for (const lv of levelsOf(d, [])) {
        if (lv.on === false || !isFinite(lv.r)) continue;
        const s = edge(lv.r);
        ctx.save();
        ctx.strokeStyle = lv.c || d.opts.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(U.dashFor(d.opts.style || 'solid', 1));
        ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.stroke();
        ctx.restore();
      }
      if (!eL && !eR) { // width guides
        ctx.save();
        ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.strokeStyle = d.opts.color;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + ox, y1 + oy);
        ctx.moveTo(x2, y2); ctx.lineTo(x2 + ox, y2 + oy);
        ctx.stroke(); ctx.restore();
      }
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        // edges + Channel's levels (same spans as draw)
        const P = d.points.map((p) => ptXY(v, p));
        const [ox, oy] = parallelOff(P);
        const eL = !!d.opts.extendLeft, eR = !!d.opts.extendRight;
        const m = Math.max(5, 4 + d.opts.width);
        const spans = [0, 1];
        for (const lv of levelsOf(d, [])) {
          if (lv.on !== false && isFinite(lv.r)) spans.push(lv.r);
        }
        for (const fx of spans) {
          const s = segWithExtend(v, P[0][0] + ox * fx, P[0][1] + oy * fx,
            P[1][0] + ox * fx, P[1][1] + oy * fx, eL, eR);
          if (U.distSeg(x, y, s[0], s[1], s[2], s[3]) < m) return true;
        }
        if (d.opts.fill) {
          const s1 = segWithExtend(v, P[0][0], P[0][1], P[1][0], P[1][1], eL, eR);
          const s2 = segWithExtend(v, P[0][0] + ox, P[0][1] + oy, P[1][0] + ox, P[1][1] + oy, eL, eR);
          return insidePoly(x, y, [[s1[0], s1[1]], [s1[2], s1[3]], [s2[2], s2[3]], [s2[0], s2[1]]]);
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- round 52: TV channels flyout additions ----------------
     Trend Angle / Flat Top-Bottom / Disjoint Channel — TradingView parity:
     same draw gestures, same Style-tab fields (line, background fill,
     extend left/right) as the reference screenshots. */

  /* Trend Angle: click 1 = anchor, click 2 = direction; the angle is shown
     in a small TV-style chip near the second point (screen-space degrees,
     zoom-dependent exactly like TV). Extend left/right optional. */
  TOOLS.trendangle = {
    name: 'Trend Angle', icon: 'trendangle', pts: 2,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const [x1, y1] = ptXY(v, d.points[0]);
      const [x2, y2] = ptXY(v, d.points[1]);
      const seg = segWithExtend(v, x1, y1, x2, y2, !!d.opts.extendLeft, !!d.opts.extendRight);
      if (seg) {
        applyStroke(ctx, d);
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
      }
      if (d.opts.showAngle !== false) { // TV: degrees label at the far end
        const ang = (Math.atan2(y1 - y2, x2 - x1) * 180) / Math.PI; // + up, - down (TV sign)
        const txt = `${ang.toFixed(1)}\u00b0`;
        ctx.save();
        ctx.setLineDash([]);
        ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
        const w = ctx.measureText(txt).width + 10;
        ctx.fillStyle = d.opts.color || '#2962ff';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x2 - w / 2, y2 + 6, w, 15, 3); else ctx.rect(x2 - w / 2, y2 + 6, w, 15);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, x2, y2 + 13.5);
        ctx.restore();
      }
      drawAnnotation(v, d, (x1 + x2) / 2 + 6, (y1 + y2) / 2 + 6);
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody: lineBody,
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* Flat Top/Bottom: click 1+2 = the sloped border, click 3 = the price of
     the FLAT border (its time is ignored — the third handle edits price
     only, like TV). Filled channel by default (TV). */
  /* ROUND247: painted spans shared by draw + hit (the old hit only knew the
     un-extended anchor range). */
  function flatSpan(v, d) {
    const [x1, y1] = ptXY(v, d.points[0]);
    const [x2, y2] = ptXY(v, d.points[1]);
    const yF = v.yOf(d.points[2].p);
    const eL = !!d.opts.extendLeft, eR = !!d.opts.extendRight;
    let xa = x1, xb = x2, ya = y1, yb = y2;
    if ((eL || eR) && Math.abs(x2 - x1) > 0.5) {
      const k = (y2 - y1) / (x2 - x1);
      if (eL) { xa = 0; ya = y1 + k * (xa - x1); }
      if (eR) { xb = v.pw; yb = y1 + k * (xb - x1); }
    }
    return { xa, ya, xb, yb, yF };
  }
  TOOLS.flattop = {
    name: 'Flat Top/Bottom', icon: 'flattop', pts: 3,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const { xa, ya, xb, yb, yF } = flatSpan(v, d);
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.lineTo(xb, yF); ctx.lineTo(xa, yF);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke(); // sloped side
      ctx.beginPath(); ctx.moveTo(xa, yF); ctx.lineTo(xb, yF); ctx.stroke(); // flat side
    },
    handles(v, d) {
      const [x1, y1] = ptXY(v, d.points[0]);
      const [x2] = ptXY(v, d.points[1]);
      return [[x1, v.yOf(d.points[0].p)], [x2, v.yOf(d.points[1].p)], [(x1 + x2) / 2, v.yOf(d.points[2].p)]];
    },
    hitBody(v, d) {
      return (x, y) => {
        const { xa, ya, xb, yb, yF } = flatSpan(v, d);
        const x0 = Math.min(xa, xb), x1e = Math.max(xa, xb);
        if (x < x0 - 4 || x > x1e + 4) return false;
        const dS = U.distSeg(x, y, xa, ya, xb, yb);
        const dF = U.distSeg(x, y, xa, yF, xb, yF);
        if (Math.min(dS, dF) < Math.max(5, 4 + d.opts.width)) return true;
        return !!d.opts.fill && insidePoly(x, y, [[xa, ya], [xb, yb], [xb, yF], [xa, yF]]);
      };
    },
    dragHandle(v, d, i, pt) {
      if (i === 2) { d.points[2].p = pt.p; return; } // flat border: price only
      d.points[i] = { t: pt.t, p: pt.p };
    },
  };

  /* Disjoint Channel: click 1+2 = first line, click 3 = carries the second
     line — it stays PARALLEL to the first but is shifted BOTH perpendicular
     AND along the line direction (that is what makes it disjoint). Line 2
     has its own color/width/style; the background fills only where the two
     lines overlap in time (TV). */
  function disjGeo(v, d) {
    const A = ptXY(v, d.points[0]), B = ptXY(v, d.points[1]), C = ptXY(v, d.points[2]);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;      // unit direction
    const nx = -uy, ny = ux;                 // unit normal
    const rx = C[0] - A[0], ry = C[1] - A[1];
    const s = rx * ux + ry * uy;             // shift along the line (disjoint part)
    const off = rx * nx + ry * ny;           // perpendicular offset
    return { A, B, len, ux, uy, nx, ny, s, off };
  }
  /* ROUND243 (TV parity): line 2 rides the parallel through click 3 — the
     old P2a/P2b dropped the normal component, so line 2 sat ON line 1's axis
     (only the fill used `off`). One shared helper for draw + hit. */
  function disjP2(g) {
    return [
      [g.A[0] + g.ux * g.s + g.nx * g.off, g.A[1] + g.uy * g.s + g.ny * g.off],
      [g.A[0] + g.ux * (g.s + g.len) + g.nx * g.off, g.A[1] + g.uy * (g.s + g.len) + g.ny * g.off],
    ];
  }
  TOOLS.disjoint = {
    name: 'Disjoint Channel', icon: 'disjoint', pts: 3,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const g = disjGeo(v, d);
      const [P2a, P2b] = disjP2(g);
      const eL = !!d.opts.extendLeft, eR = !!d.opts.extendRight;
      let s1 = [g.A[0], g.A[1], g.B[0], g.B[1]];
      let s2 = [P2a[0], P2a[1], P2b[0], P2b[1]];
      if (eL || eR) {
        const T = (v.w + v.h) * 3;
        const c1 = U.clipLine(
          eL ? g.A[0] - g.ux * T : g.A[0], eL ? g.A[1] - g.uy * T : g.A[1],
          eR ? g.B[0] + g.ux * T : g.B[0], eR ? g.B[1] + g.uy * T : g.B[1], v.pw, v.ph);
        const c2 = U.clipLine(
          eL ? P2a[0] - g.ux * T : P2a[0], eL ? P2a[1] - g.uy * T : P2a[1],
          eR ? P2b[0] + g.ux * T : P2b[0], eR ? P2b[1] + g.uy * T : P2b[1], v.pw, v.ph);
        if (c1) s1 = c1;
        if (c2) s2 = c2;
      }
      if (d.opts.fill && !eL && !eR) {
        /* TV: fill only where the two lines overlap along the line direction */
        const o0 = Math.max(0, Math.min(g.s, g.len));
        /* ROUND243: o1 used max(s,0)+len, over-filling [0,len] when s<0 —
           the true overlap end is min(len, s+len). */
        const o1 = Math.min(g.len, g.s + g.len);
        if (o1 - o0 > 1) {
          ctx.save();
          ctx.globalAlpha = fillAlphaOf(d);
          ctx.fillStyle = fillColorOf(d);
          ctx.beginPath();
          ctx.moveTo(g.A[0] + g.ux * o0, g.A[1] + g.uy * o0);
          ctx.lineTo(g.A[0] + g.ux * o1, g.A[1] + g.uy * o1);
          ctx.lineTo(g.A[0] + g.ux * o1 + g.nx * g.off, g.A[1] + g.uy * o1 + g.ny * g.off);
          ctx.lineTo(g.A[0] + g.ux * o0 + g.nx * g.off, g.A[1] + g.uy * o0 + g.ny * g.off);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s1[2], s1[3]); ctx.stroke();
      ctx.save();
      ctx.strokeStyle = d.opts.color2 || d.opts.color;
      ctx.lineWidth = d.opts.width2 || d.opts.width;
      ctx.setLineDash(U.dashFor(d.opts.style2 || d.opts.style, d.opts.width2 || d.opts.width));
      ctx.beginPath(); ctx.moveTo(s2[0], s2[1]); ctx.lineTo(s2[2], s2[3]); ctx.stroke();
      ctx.restore();
      /* ROUND285 (TV parity): TV labels the gap between the two parallel
         lines with its distance in price and %. Optional via Show distance. */
      if (d.opts.showDistance !== false) {
        const mx = (g.A[0] + g.B[0]) / 2;
        const my = (g.A[1] + g.B[1]) / 2;
        const p1 = g.A, p2 = [g.A[0] + g.nx * g.off, g.A[1] + g.ny * g.off];
        const distPx = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        if (distPx > 6) {
          const pA = d.points[0].p, pB = d.points[1].p;
          const perPx = Math.abs((pB - pA) / Math.max(1, Math.hypot(g.B[0] - g.A[0], g.B[1] - g.A[1])));
          const dpv = distPx * perPx;
          const pct = pA ? (dpv / Math.abs(pA)) * 100 : 0;
          chipLabel(ctx, mx + g.nx * (g.off / 2), my + g.ny * (g.off / 2),
            `${U.fmtPrice(dpv, v.digits)} (${pct.toFixed(2)}%)`, 'rgba(24,28,39,.92)');
        }
      }
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        const g = disjGeo(v, d);
        const [P2a, P2b] = disjP2(g);
        const d1 = U.distSeg(x, y, g.A[0], g.A[1], g.B[0], g.B[1]);
        const d2 = U.distSeg(x, y, P2a[0], P2a[1], P2b[0], P2b[1]);
        if (Math.min(d1, d2) < Math.max(5, 4 + (d.opts.width2 || d.opts.width))) return true;
        /* the fill is only painted when both extension sides are off */
        if (d.opts.fill && !d.opts.extendLeft && !d.opts.extendRight) {
          const o0 = Math.max(0, Math.min(g.s, g.len));
          const o1 = Math.min(g.len, g.s + g.len);
          if (o1 - o0 > 1) {
            return insidePoly(x, y, [
              [g.A[0] + g.ux * o0, g.A[1] + g.uy * o0],
              [g.A[0] + g.ux * o1, g.A[1] + g.uy * o1],
              [g.A[0] + g.ux * o1 + g.nx * g.off, g.A[1] + g.uy * o1 + g.ny * g.off],
              [g.A[0] + g.ux * o0 + g.nx * g.off, g.A[1] + g.uy * o0 + g.ny * g.off],
            ]);
          }
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- anchors ---------------- */
  TOOLS.hline = {
    name: 'Horizontal Line', icon: 'hline', pts: 1,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const y = v.yOf(d.points[0].p);
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(v.pw, y); ctx.stroke();
      /* ROUND252 (TV parity): the price label toggles (was always on). */
      if (d.opts.priceLabels !== false) priceTag(v, y, U.fmtPrice(d.points[0].p, v.digits), d.opts.color);
    },
    handles(v, d) { return [[v.xOf(d.points[0].t), v.yOf(d.points[0].p)]]; },
    hitBody(v, d) {
      return (x, y) => Math.abs(y - v.yOf(d.points[0].p)) < Math.max(5, 3 + d.opts.width);
    },
    dragHandle(v, d, i, pt) { d.points[0].p = pt.p; },
  };

  TOOLS.hray = {
    name: 'Horizontal Ray', icon: 'hray', pts: 2,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const y = v.yOf(d.points[0].p);
      const x0 = v.xOf(d.points[0].t);
      const dir = d.points[1].t >= d.points[0].t ? 1 : -1;
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(dir > 0 ? v.pw : 0, y);
      ctx.stroke();
      /* ROUND252 (TV parity): the price label toggles (was always on). */
      if (d.opts.priceLabels !== false) priceTag(v, y, U.fmtPrice(d.points[0].p, v.digits), d.opts.color);
    },
    handles(v, d) {
      return [[v.xOf(d.points[0].t), v.yOf(d.points[0].p)], [v.xOf(d.points[1].t), v.yOf(d.points[0].p)]];
    },
    hitBody(v, d) {
      return (x, y) => {
        if (Math.abs(y - v.yOf(d.points[0].p)) > Math.max(5, 3 + d.opts.width)) return false;
        const x0 = v.xOf(d.points[0].t);
        const dir = d.points[1].t >= d.points[0].t ? 1 : -1;
        return dir > 0 ? x >= x0 - 2 : x <= x0 + 2;
      };
    },
    dragHandle(v, d, i, pt) {
      if (i === 0) { d.points[0].t = pt.t; d.points[0].p = pt.p; }
      else d.points[1].t = pt.t;
    },
  };

  TOOLS.vline = {
    name: 'Vertical Line', icon: 'vline', pts: 1,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const x = v.xOf(d.points[0].t);
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.ph); ctx.stroke();
      /* ROUND252 (TV parity): the time label toggles (was always on). */
      if (d.opts.showTime !== false) timeTag(v, x, vTimeLabel(v, d.points[0].t), d.opts.color);
    },
    handles(v, d) { return [[v.xOf(d.points[0].t), v.h / 2]]; },
    hitBody(v, d) {
      return (x, y) => Math.abs(x - v.xOf(d.points[0].t)) < Math.max(5, 3 + d.opts.width);
    },
    dragHandle(v, d, i, pt) { d.points[0].t = pt.t; },
  };

  TOOLS.crossline = {
    name: 'Cross Line', icon: 'crossline', pts: 1,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const x = v.xOf(d.points[0].t), y = v.yOf(d.points[0].p);
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(v.pw, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.ph); ctx.stroke();
      /* ROUND252 (TV parity): both labels toggle (were always on). */
      if (d.opts.priceLabels !== false) priceTag(v, y, U.fmtPrice(d.points[0].p, v.digits), d.opts.color);
      if (d.opts.showTime !== false) timeTag(v, x, vTimeLabel(v, d.points[0].t), d.opts.color);
    },
    handles(v, d) { return [[v.xOf(d.points[0].t), v.yOf(d.points[0].p)]]; },
    hitBody(v, d) {
      return (x, y) => {
        const px = v.xOf(d.points[0].t), py = v.yOf(d.points[0].p);
        return Math.abs(y - py) < Math.max(5, 3 + d.opts.width) || Math.abs(x - px) < Math.max(5, 3 + d.opts.width);
      };
    },
    dragHandle(v, d, i, pt) { d.points[0] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- shapes ---------------- */
  TOOLS.rect = {
    name: 'Rectangle', icon: 'rect', pts: 2,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
      const yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      const eL = !!d.opts.extendLeft, eR = !!d.opts.extendRight;
      if (d.opts.fill) {
        /* round 22: the background covers the EXTENDED region too — the whole
           shape (body + extension) obeys the same fill colour/opacity */
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.fillRect(eL ? 0 : xL, yT, (eR ? v.pw : xR) - (eL ? 0 : xL), yB - yT);
        ctx.restore();
      }
      /* TV Box (round 21): the extended side loses its end cap — the top and
         bottom border lines (and the middle line) run straight through to
         the plot edge, so the body and the extension read as ONE shape */
      applyStroke(ctx, d);
      const xa = eL ? 0 : xL, xb = eR ? v.pw : xR;
      ctx.beginPath(); ctx.moveTo(xa, yT); ctx.lineTo(xb, yT); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xa, yB); ctx.lineTo(xb, yB); ctx.stroke();
      if (!eL) { ctx.beginPath(); ctx.moveTo(xL, yT); ctx.lineTo(xL, yB); ctx.stroke(); }
      if (!eR) { ctx.beginPath(); ctx.moveTo(xR, yT); ctx.lineTo(xR, yB); ctx.stroke(); }
      if (d.opts.middle !== false) {
        ctx.save();
        ctx.globalAlpha = middleAlphaOf(d);
        ctx.strokeStyle = d.opts.middleColor || d.opts.color;
        ctx.lineWidth = d.opts.middleWidth || 1;
        ctx.setLineDash(U.dashFor(d.opts.middleStyle || 'solid', d.opts.middleWidth || 1));
        const ym = (yT + yB) / 2;
        ctx.beginPath(); ctx.moveTo(xa, ym); ctx.lineTo(xb, ym); ctx.stroke();
        ctx.restore();
      }
      drawAnnotation(v, d, xL + 5, yT + 5, { x0: xL, x1: xR, y0: yT, y1: yB });
    },
    /* TV: 8 resize zones — 4 corners + 4 edge midpoints */
    handles(v, d) {
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
      const yT = v.yOf(n.pT), yB = v.yOf(n.pB), xm = (xL + xR) / 2, ym = (yT + yB) / 2;
      return [[xL, yT], [xR, yT], [xL, yB], [xR, yB], [xL, ym], [xR, ym], [xm, yT], [xm, yB]];
    },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
        const yT = v.yOf(n.pT), yB = v.yOf(n.pB);
        const eL = !!d.opts.extendLeft, eR = !!d.opts.extendRight;
        const x0 = eL ? 0 : Math.min(xL, xR), x1 = eR ? v.pw : Math.max(xL, xR);
        const y0 = Math.min(yT, yB), y1 = Math.max(yT, yB);
        if (x < x0 - 4 || x > x1 + 4 || y < y0 - 4 || y > y1 + 4) return false;
        // near an edge or inside border zone (TV: edges draggable)
        const dl = Math.abs(x - x0), dr = Math.abs(x - x1), dt = Math.abs(y - y0), db = Math.abs(y - y1);
        const m = Math.max(5, 3 + d.opts.width);
        const inside = x > x0 + m && x < x1 - m && y > y0 + m && y < y1 - m;
        if (inside && !d.opts.fill) {
          /* ROUND258: the Middle line is painted inside a hollow Box, so it
             must stay grabbable even though the interior is not filled. */
          if (d.opts.middle !== false) {
            const ym = (y0 + y1) / 2;
            if (U.distSeg(x, y, x0, ym, x1, ym) < m) return true;
          }
          return false; // hollow rect: only border + middle line grab
        }
        return (dl < m || dr < m || dt < m || db < m) || inside;
      };
    },
    dragHandle(v, d, i, pt) {
      const n = normRect(d);
      let { tL, tR, pT, pB } = n;
      if (i === 0) { tL = pt.t; pT = pt.p; }
      else if (i === 1) { tR = pt.t; pT = pt.p; }
      else if (i === 2) { tL = pt.t; pB = pt.p; }
      else if (i === 3) { tR = pt.t; pB = pt.p; }
      else if (i === 4) { tL = pt.t; }
      else if (i === 5) { tR = pt.t; }
      else if (i === 6) { pT = pt.p; }
      else if (i === 7) { pB = pt.p; }
      d.points[0] = { t: tL, p: pT };
      d.points[1] = { t: tR, p: pB };
    },
  };

  TOOLS.ellipse = {
    name: 'Ellipse', icon: 'ellipse', pts: 2,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
      const yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      const cx = (xL + xR) / 2, cy = (yT + yB) / 2;
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(xR - xL) / 2, Math.abs(yB - yT) / 2, 0, 0, Math.PI * 2);
      if (d.opts.fill) {
        ctx.save(); ctx.globalAlpha = fillAlphaOf(d); ctx.fillStyle = fillColorOf(d); ctx.fill(); ctx.restore();
      }
      ctx.stroke();
      drawAnnotation(v, d, xL, yT, { x0: xL, x1: xR, y0: yT, y1: yB });
    },
    /* TV: 8 resize zones like the rectangle */
    handles(v, d) {
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
      const yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      const xm = (xL + xR) / 2, ym = (yT + yB) / 2;
      return [[xL, yT], [xR, yT], [xL, yB], [xR, yB], [xL, ym], [xR, ym], [xm, yT], [xm, yB]];
    },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const cx = (v.xOf(n.tL) + v.xOf(n.tR)) / 2, cy = (v.yOf(n.pT) + v.yOf(n.pB)) / 2;
        const rx = Math.abs(v.xOf(n.tR) - v.xOf(n.tL)) / 2 + 4, ry = Math.abs(v.yOf(n.pB) - v.yOf(n.pT)) / 2 + 4;
        const nx = (x - cx) / (rx || 1), ny = (y - cy) / (ry || 1);
        const q = nx * nx + ny * ny;
        if (d.opts.fill) return q <= 1.06;
        return Math.abs(q - 1) < 0.14;
      };
    },
    dragHandle(v, d, i, pt) {
      const n = normRect(d);
      let { tL, tR, pT, pB } = n;
      if (i === 0) { tL = pt.t; pT = pt.p; }
      else if (i === 1) { tR = pt.t; pT = pt.p; }
      else if (i === 2) { tL = pt.t; pB = pt.p; }
      else if (i === 3) { tR = pt.t; pB = pt.p; }
      else if (i === 4) { tL = pt.t; }
      else if (i === 5) { tR = pt.t; }
      else if (i === 6) { pT = pt.p; }
      else if (i === 7) { pB = pt.p; }
      d.points[0] = { t: tL, p: pT };
      d.points[1] = { t: tR, p: pB };
    },
  };

  TOOLS.triangle = {
    name: 'Triangle', icon: 'triangle', pts: 3,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const P = d.points.map((p) => ptXY(v, p));
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[2][0], P[2][1]);
      ctx.closePath();
      if (d.opts.fill) { ctx.save(); ctx.globalAlpha = fillAlphaOf(d); ctx.fillStyle = fillColorOf(d); ctx.fill(); ctx.restore(); }
      ctx.stroke();
      const cxx = (P[0][0] + P[1][0] + P[2][0]) / 3, cyy = (P[0][1] + P[1][1] + P[2][1]) / 3;
      const bx0 = Math.min(P[0][0], P[1][0], P[2][0]), bx1 = Math.max(P[0][0], P[1][0], P[2][0]);
      const by0 = Math.min(P[0][1], P[1][1], P[2][1]), by1 = Math.max(P[0][1], P[1][1], P[2][1]);
      drawAnnotation(v, d, bx0, by0, { x0: bx0, x1: bx1, y0: by0, y1: by1 });
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        const P = d.points.map((p) => ptXY(v, p));
        const edge = U.distSeg(x, y, P[0][0], P[0][1], P[1][0], P[1][1]) < 6 ||
               U.distSeg(x, y, P[1][0], P[1][1], P[2][0], P[2][1]) < 6 ||
               U.distSeg(x, y, P[2][0], P[2][1], P[0][0], P[0][1]) < 6;
        return edge || (!!d.opts.fill && insidePoly(x, y, P));
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- fibs ---------------- */
  function levelsOf(d, fallback) {
    const ls = Array.isArray(d.opts.levels) ? d.opts.levels : null;
    /* ROUND256 (TV parity): Use one color paints every level with the line
       color (editor + stored colors untouched — mapping only). */
    const base = d.opts.color;
    const paint = (arr) => (d.opts.useOneColor && base)
      ? arr.map((l) => Object.assign({}, l, { c: base })) : arr;
    if (ls && ls.length) return paint(ls.filter((l) => l && isFinite(l.r)));
    return paint(fallback.map((l) => ({ r: l.r, c: l.c, on: true })));
  }
  function levelPrice(d, r) {
    /* ROUND245 (TV parity): Reverse mirrors the scale — 0 sits at the other
       end. Labels keep their ratio numbers; positions mirror. */
    const rr = d.opts.reverse ? 1 - r : r;
    return d.points[1].p + (d.points[0].p - d.points[1].p) * rr;
  }

  TOOLS.fib = {
    name: 'Fib Retracement', icon: 'fib', pts: 2,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const x1 = v.xOf(d.points[0].t), x2 = v.xOf(d.points[1].t);
      let xa = Math.min(x1, x2), xb = Math.max(x1, x2);
      const xe = d.opts.extendRight ? v.pw : xb;
      if (d.opts.extendLeft) xa = 0;
      const levels = levelsOf(d, FIB_LEVELS);
      // background bands between consecutive levels (TV Background)
      /* ROUND284: only `fill` exists in the dialog; the old `bgFill` alias was
         never writable by any UI, so keeping it hid the fact that the toggle
         is the single source of truth. */
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        for (let i = 0; i < levels.length - 1; i++) {
          if (levels[i].on === false || levels[i + 1].on === false) continue;
          const ya = v.yOf(levelPrice(d, levels[i].r));
          const yb = v.yOf(levelPrice(d, levels[i + 1].r));
          ctx.fillStyle = levels[i + 1].c || levels[i].c;
          ctx.fillRect(xa, Math.min(ya, yb), Math.max(1, xe - xa), Math.abs(yb - ya));
        }
        ctx.restore();
      }
      // connector (TV Trend Line visibility toggle)
      if (d.opts.showTrend !== false) {
        ctx.save();
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(150,153,165,.8)';
        ctx.beginPath();
        ctx.moveTo(x1, v.yOf(d.points[0].p)); ctx.lineTo(x2, v.yOf(d.points[1].p));
        ctx.stroke();
        ctx.restore();
      }
      ctx.font = '10.5px "Segoe UI", Arial, sans-serif';
      ctx.textBaseline = 'bottom';
      for (const lv of levels) {
        if (lv.on === false) continue;
        const price = levelPrice(d, lv.r);
        const y = v.yOf(price);
        ctx.save();
        /* ROUND256 (TV parity): Levels Line thickness/style (defaults keep
           the old solid-1px look). */
        ctx.setLineDash(U.dashFor(d.opts.levelStyle || 'solid', d.opts.levelWidth || 1));
        ctx.strokeStyle = lv.c; ctx.lineWidth = d.opts.levelWidth || 1;
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xe, y); ctx.stroke();
        ctx.fillStyle = lv.c;
        const lbl = (d.opts.showRatio !== false ? lv.r.toFixed(3) : '') +
          (d.opts.showPrice !== false ? '  ' + U.fmtPrice(price, v.digits) : '');
        if (lbl.trim()) ctx.fillText(lbl, Math.min(xa, v.pw - 120), y - 2);
        ctx.restore();
      }
      drawAnnotation(v, d, Math.min(x1, x2) + 4, Math.min(v.yOf(d.points[0].p), v.yOf(d.points[1].p)) - 16);
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) {
      return (x, y) => {
        const x1 = v.xOf(d.points[0].t), x2 = v.xOf(d.points[1].t);
        const xa = d.opts.extendLeft ? 0 : Math.min(x1, x2);
        const xb = d.opts.extendRight ? v.pw : Math.max(x1, x2);
        if (x < xa - 4 || x > xb + 4) return false;
        /* the dashed A->B connector is painted when Trend Line is on */
        if (d.opts.showTrend !== false &&
            U.distSeg(x, y, x1, v.yOf(d.points[0].p), x2, v.yOf(d.points[1].p)) < 5) return true;
        const prices = levelsOf(d, FIB_LEVELS)
          .filter((lv) => lv.on !== false)
          .map((lv) => levelPrice(d, lv.r));
        if (!prices.length) return false;
        const top = v.yOf(Math.max(...prices)) - 5;
        const bot = v.yOf(Math.min(...prices)) + 5;
        return y >= Math.min(top, bot) && y <= Math.max(top, bot);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.fibext = {
    name: 'Trend-Based Fib Extension', icon: 'fibext', pts: 3,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const P = d.points.map((p) => [v.xOf(p.t), v.yOf(p.p)]);
      /* the A-B-C connector (TV Trend Line visibility toggle) */
      if (d.opts.showTrend !== false) {
        ctx.save();
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(150,153,165,.8)';
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[2][0], P[2][1]);
        ctx.stroke();
        ctx.restore();
      }
      const x3 = P[2][0];
      /* ROUND245 (TV parity, 2020 extend-lines update): extension rays run
         left/right on demand — right stays the default (the old right-only
         look for existing drawings). */
      const xL = d.opts.extendLeft ? 0 : x3;
      const xR = d.opts.extendRight !== false ? v.pw : x3;
      ctx.font = '10.5px "Segoe UI", Arial, sans-serif';
      ctx.textBaseline = 'bottom';
      const levels = levelsOf(d, FIBEXT_LEVELS.map((r) => ({ r, c: r === 0 ? '#787b86' : '#2962ff', on: true })));
      for (const lv of levels) {
        if (lv.on === false) continue;
        const r = lv.r;
        const price = d.points[2].p + (d.points[1].p - d.points[0].p) * r;
        const y = v.yOf(price);
        const col = lv.c || (r === 0 ? '#787b86' : '#2962ff');
        ctx.save();
        /* ROUND256 (TV parity): Levels Line thickness/style — the zero level
           stays solid (defaults keep the old look). */
        const lls = d.opts.levelStyle;
        ctx.setLineDash(r === 0 ? [] : (lls ? U.dashFor(lls, d.opts.levelWidth || 1) : [5, 3]));
        ctx.strokeStyle = col;
        ctx.lineWidth = d.opts.levelWidth || 1;
        ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y); ctx.stroke();
        ctx.fillStyle = col;
        const lbl = (d.opts.showRatio !== false ? r.toFixed(3) : '') +
          (d.opts.showPrice !== false ? '  ' + U.fmtPrice(price, v.digits) : '');
        if (lbl.trim()) ctx.fillText(lbl, Math.min(Math.max(xL + 4, 4), v.pw - 120), y - 2);
        ctx.restore();
      }
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        const P = d.points.map((p) => [v.xOf(p.t), v.yOf(p.p)]);
        const near = U.distSeg(x, y, P[0][0], P[0][1], P[1][0], P[1][1]) < 6 ||
                     U.distSeg(x, y, P[1][0], P[1][1], P[2][0], P[2][1]) < 6;
        if (near && d.opts.showTrend !== false) return true;
        const p0 = d.points[0].p, p1 = d.points[1].p, p2 = d.points[2].p;
        /* ROUND245: the same level set draw uses (custom levels included —
           the old code only knew the factory list). */
        const prices = levelsOf(d, FIBEXT_LEVELS.map((r) => ({ r })))
          .filter((l) => l.on !== false)
          .map((l) => p2 + (p1 - p0) * l.r);
        if (!prices.length) return false;
        const top = v.yOf(Math.max(...prices)) - 5, bot = v.yOf(Math.min(...prices)) + 5;
        const xL = d.opts.extendLeft ? 0 : P[2][0], xR = d.opts.extendRight !== false ? v.pw : P[2][0];
        return x >= xL - 4 && x <= xR + 4 && y >= Math.min(top, bot) && y <= Math.max(top, bot);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- text / note ---------------- */
  function textMetrics(v, d) {
    v.ctx.font = `${d.opts.italic ? 'italic ' : ''}${d.opts.bold ? '700 ' : ''}${d.opts.fontSize || 14}px "Segoe UI", Arial, sans-serif`;
    const lines = String(d.opts.text || 'Text').split('\n');
    const w = Math.max(...lines.map((l) => v.ctx.measureText(l).width));
    return { w: w + 8, h: lines.length * ((d.opts.fontSize || 14) + 3) + 6, lines };
  }

  /* text box top-left honouring the alignment setting (left/center/right of anchor) */
  function textBox(v, d) {
    const m = textMetrics(v, d);
    const x = v.xOf(d.points[0].t), y = v.yOf(d.points[0].p);
    let x0 = x;
    if (d.opts.align === 'center') x0 = x - m.w / 2;
    else if (d.opts.align === 'right') x0 = x - m.w;
    return { x: x0, y, w: m.w, h: m.h, m };
  }

  TOOLS.text = {
    name: 'Text', icon: 'text', pts: 1,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const fs = d.opts.fontSize || 14;
      const b = textBox(v, d);
      ctx.save();
      ctx.font = `${d.opts.italic ? 'italic ' : ''}${d.opts.bold ? '700 ' : ''}${fs}px "Segoe UI", Arial, sans-serif`;
      ctx.textBaseline = 'top';
      if (d.opts.bg) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }
      ctx.fillStyle = d.opts.color;
      b.m.lines.forEach((l, i) => ctx.fillText(l, b.x + 4, b.y + 3 + i * (fs + 3)));
      /* ROUND255 (TV parity): Border around the text box (off by default). */
      if (d.opts.border) {
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = d.opts.borderColor || d.opts.color;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      if (sel) {
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(150,153,165,.7)';
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      ctx.restore();
    },
    handles(v, d) { return [[v.xOf(d.points[0].t), v.yOf(d.points[0].p)]]; },
    hitBody(v, d) {
      return (x, y) => {
        const b = textBox(v, d);
        return x >= b.x - 3 && x <= b.x + b.w + 3 && y >= b.y - 3 && y <= b.y + b.h + 3;
      };
    },
    dragHandle(v, d, i, pt) { d.points[0] = { t: pt.t, p: pt.p }; },
  };

  /* Note geometry shared by draw + hit-testing so the selectable box always
     matches the painted label (font size is a real setting now). */
  function noteBox(v, d) {
    const fs = isFinite(d.opts.fontSize) ? U.clamp(Math.round(d.opts.fontSize), 8, 24) : 11;
    const label = String(d.opts.text || 'Note');
    const ctx = v.ctx;
    ctx.save();
    ctx.font = `${fs}px "Segoe UI", Arial, sans-serif`;
    const w = Math.min(220, ctx.measureText(label).width + 22);
    ctx.restore();
    const h = fs + 11;
    return { x: v.xOf(d.points[0].t), y: v.yOf(d.points[0].p), w, h, fs, label };
  }
  TOOLS.note = {
    name: 'Note', icon: 'note', pts: 1,
    draw(v, d, sel) {
      const ctx = v.ctx;
      const b = noteBox(v, d);
      const x = b.x, y = b.y, h = b.h, w = b.w, fs = b.fs;
      ctx.save();
      ctx.font = `${fs}px "Segoe UI", Arial, sans-serif`;
      ctx.setLineDash([]);
      // flag
      ctx.fillStyle = d.opts.color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 14, y - 7);
      ctx.lineTo(x + 14, y + 7);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x + 14, y - h / 2, w, h, 4);
      else ctx.rect(x + 14, y - h / 2, w, h);
      ctx.fillStyle = (Theme.c) ? Theme.c('chipBg') : '#1e222d'; /* AUD-001 */
      ctx.fill();
      ctx.strokeStyle = d.opts.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#d1d4dc';
      ctx.textBaseline = 'middle';
      /* truncate to the painted bubble at the chosen font size */
      const maxW = Math.max(12, w - 10);
      let shown = b.label;
      if (ctx.measureText(shown).width > maxW) {
        while (shown.length > 1 && ctx.measureText(shown + '\u2026').width > maxW) shown = shown.slice(0, -1);
        shown += '\u2026';
      }
      ctx.fillText(shown, x + 24, y + 0.5);
      ctx.restore();
    },
    handles(v, d) { return [[v.xOf(d.points[0].t), v.yOf(d.points[0].p)]]; },
    hitBody(v, d) {
      return (x, y) => {
        const b = noteBox(v, d);
        return x >= b.x - 4 && x <= b.x + 14 + b.w && y >= b.y - b.h / 2 - 4 && y <= b.y + b.h / 2 + 4;
      };
    },
    dragHandle(v, d, i, pt) { d.points[0] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- measure ---------------- */
  TOOLS.measure = {
    name: 'Measure', icon: 'measure', pts: 2,
    draw(v, d, sel) {
      /* guard: the 1-point preview (cursor left the pane) must never render —
         points[1] undefined used to produce a runaway fill over the chart */
      if (!d.points || d.points.length < 2 || !d.points[1]) return;
      const ctx = v.ctx;
      const x1 = v.xOf(d.points[0].t), y1 = v.yOf(d.points[0].p);
      const x2 = v.xOf(d.points[1].t), y2 = v.yOf(d.points[1].p);
      const up = d.points[1].p >= d.points[0].p;
      const col = d.opts.color || '#2962ff';
      const x0 = Math.min(x1, x2), x3 = Math.max(x1, x2);
      const yT = Math.min(y1, y2), yB = Math.max(y1, y2);
      const fo = typeof d.opts.fillOpacity === 'number' && isFinite(d.opts.fillOpacity)
        ? U.clamp(d.opts.fillOpacity, 0.02, 1) : 0.25;
      /* TV measure look (round 21): translucent box, a vertical line on the
         START bar with a direction arrow at its tip and a mid-height arrow
         pointing at the end bar — no hard border around the box */
      ctx.save();
      ctx.globalAlpha = fo;
      ctx.fillStyle = col;
      ctx.fillRect(x0, yT, x3 - x0, yB - yT);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, Math.min(2, d.opts.width || 1));
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1, yT); ctx.lineTo(x1, yB); ctx.stroke();
      if (d.opts.showArrows !== false) {
        arrowHead(ctx, x1, up ? yT : yB, x1, up ? yB : yT, 7.5);
        const ym = (yT + yB) / 2;
        ctx.beginPath(); ctx.moveTo(x1, ym); ctx.lineTo(x2 > x1 ? x3 : x0, ym); ctx.stroke();
        arrowHead(ctx, x2 > x1 ? x3 : x0, ym, x1, ym, 7.5);
      }
      ctx.restore();
      /* Info chip — ROUND285 (TV parity): TV's measure card is a small dark
         panel with THREE stacked lines (price move + %, bar count, duration)
         and a subtle separator, anchored to the top edge of the range. The
         old version crammed two lines into a colour-filled box that matched
         the range colour, which made it hard to read over a filled area. */
      if (d.opts.showLabel !== false) {
        const dp = d.points[1].p - d.points[0].p;
        const pct = (dp / d.points[0].p) * 100;
        const bars = Math.round(Math.abs(U.timeToLogical(v.times, d.points[1].t) - U.timeToLogical(v.times, d.points[0].t)));
        const dur = U.durHuman(Math.abs(d.points[1].t - d.points[0].t));
        const sgn = dp >= 0 ? '+' : '';
        /* ROUND289 (TV parity): TV lets each card row be switched off on its
           own (price/percent, bar count, duration). The old single
           `showLabel` toggle hid the entire card. `showLabel` still wins as
           the master switch so existing drawings keep working. */
        const rows = [];
        if (d.opts.showPrice !== false) rows.push({ text: `${sgn}${U.fmtPrice(dp, v.digits)} (${sgn}${pct.toFixed(2)}%)`, dir: true });
        if (d.opts.showBars !== false) rows.push({ text: `${bars} ${bars === 1 ? 'bar' : 'bars'}` });
        if (d.opts.showDuration !== false) rows.push({ text: dur });
        if (!rows.length) return;                 // every row hidden — no empty panel
        const fs = 11, lh = 15, padX = 10, padY = 7;
        ctx.save();
        ctx.font = `600 ${fs}px "Segoe UI", Arial, sans-serif`;
        const bw = Math.max(...rows.map((r) => ctx.measureText(r.text).width)) + padX * 2;
        const bh = rows.length * lh + padY * 2;
        const bx = U.clamp((x0 + x3) / 2 - bw / 2, 2, Math.max(2, v.pw - bw - 2));
        let by = yT - bh - 6;
        if (by < 2) by = yB + 6;                 // no room above — go below
        if (by + bh > v.ph - 2) by = Math.max(2, yT + 4);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(19,23,34,0.92)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 4); else ctx.rect(bx, by, bw, bh);
        ctx.fill();
        /* hairline border in the range colour ties the card to the measurement */
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        rows.forEach((r, i) => {
          /* the price row carries the direction colour, the rest stay muted */
          ctx.fillStyle = r.dir ? (dp >= 0 ? '#089981' : '#f23645') : '#b2b5be';
          ctx.fillText(r.text, bx + padX, by + padY + lh / 2 + i * lh);
        });
        ctx.restore();
      }
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) {
      return (x, y) => {
        const x1 = v.xOf(d.points[0].t), y1 = v.yOf(d.points[0].p);
        const x2 = v.xOf(d.points[1].t), y2 = v.yOf(d.points[1].p);
        return x >= Math.min(x1, x2) - 4 && x <= Math.max(x1, x2) + 4 &&
               y >= Math.min(y1, y2) - 4 && y <= Math.max(y1, y2) + 4;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- cursor modes (TV: they don't draw, they change the pointer) ---------------- */
  const dotCursor = 'url("data:image/svg+xml;utf8,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><circle cx="4.5" cy="4.5" r="3" fill="#2962ff" stroke="white" stroke-width="1.2"/></svg>')
    + '") 4.5 4.5, crosshair';

  TOOLS.cross = {
    name: 'Cross', icon: 'cross', pts: 0, cursorTool: true,
    crosshair: true, /* ROUND39: the only cursor tool that keeps the cross lines (TV) */
    cursor() { return 'crosshair'; },
    draw() {}, handles() { return []; }, hitBody() { return () => false; }, dragHandle() {},
  };
  TOOLS.arrowcur = {
    name: 'Arrow', icon: 'arrowcur', pts: 0, cursorTool: true,
    cursor() { return 'default'; },
    draw() {}, handles() { return []; }, hitBody() { return () => false; }, dragHandle() {},
  };
  TOOLS.dot = {
    name: 'Dot', icon: 'dot', pts: 0, cursorTool: true,
    cursor() { return dotCursor; },
    draw() {}, handles() { return []; }, hitBody() { return () => false; }, dragHandle() {},
  };

  /* ---------------- zoom in (engine-special) ---------------- */
  TOOLS.zoomin = {
    name: 'Zoom In', icon: 'zoomin', pts: 2, special: 'zoom',
    draw(v, d, sel) {
      const ctx = v.ctx;
      const x1 = v.xOf(d.points[0].t), y1 = v.yOf(d.points[0].p);
      const x2 = v.xOf(d.points[1].t), y2 = v.yOf(d.points[1].p);
      /* ROUND284 (TV parity): the zoom box used to hard-code its blue fill and
         stroke, so the Style tab could not change anything. It now honours the
         same line/background options as every other region drawing. */
      const col = d.opts.color || '#2962ff';
      ctx.save();
      if (d.opts.fill !== false) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.restore();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, d.opts.width || 1);
      ctx.globalAlpha = typeof d.opts.borderOpacity === 'number' && isFinite(d.opts.borderOpacity)
        ? U.clamp(d.opts.borderOpacity, 0.02, 1) : 1;
      ctx.setLineDash(U.dashFor(d.opts.style || 'dashed', ctx.lineWidth));
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.restore();
    },
    handles() { return []; },
    hitBody() { return () => false; },
    dragHandle() {},
  };

  /* ---- context (floating) toolbar layout per tool (TV, round 21) ----
     grip (2×3 dots) + templates are PREPENDED automatically for every tool.
     Items: stroke / bg / textc (colour+opacity swatches), width, style
     (TV popups), settings (gear), alert (bell), lock, delete, dots (⋯ menu:
     visual order, visibility on intervals, clone, copy, hide). */
  const CTX = {
    trend: ['stroke', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    arrow: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    parallel: ['stroke', 'bg', 'textc', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    ray: ['stroke', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    extended: ['stroke', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    hline: ['stroke', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    hray: ['stroke', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    vline: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    crossline: ['stroke', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    rect: ['stroke', 'bg', 'textc', 'width', 'style', 'settings', 'alert', 'lock', 'delete', 'dots'],
    ellipse: ['stroke', 'bg', 'textc', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    triangle: ['stroke', 'bg', 'textc', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    /* round 69: TV shapes-flyout additions (floating context bar per tool) */
    brush: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    highlighter: ['stroke', 'width', 'settings', 'lock', 'delete', 'dots'],
    arrowmarker: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    arrowmarku: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    arrowmarkd: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    rotrect: ['stroke', 'bg', 'textc', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    circle: ['stroke', 'bg', 'textc', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    path: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    polyline: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    arc: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    curve: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    dblcurve: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    fib: ['width', 'style', 'settings', 'lock', 'delete', 'dots'],
    fibext: ['width', 'style', 'settings', 'lock', 'delete', 'dots'],
    text: ['textc', 'fontSize', 'settings', 'lock', 'delete', 'dots'],
    note: ['settings', 'lock', 'delete', 'dots'],
    /* ROUND248: Icons category context bar. */
    emoji: ['settings', 'lock', 'delete', 'dots'],
    /* ROUND246: annotations back on the menu need context-bar entries too. */
    callout: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    flagmark: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    arrowmarkl: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    arrowmarkr: ['stroke', 'settings', 'lock', 'delete', 'dots'],
    measure: ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'],
    zoomin: [],
  };

export { TOOLS, CTX as CTX_LAYOUT, FIB_LEVELS, EMOJI_CATS, segWithExtend, axisTimeTag };
