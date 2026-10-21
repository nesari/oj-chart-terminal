/**
 * Drawing tools batch 2 — marks concern.
 *
 * Moved verbatim out of drawing/tools2.js in F4.3; the module registers the
 * same tools on the shared TOOLS registry (no logic changes).
 *
 * @module drawing/tools2/marks
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { Theme } from '../../core/theme.js';
import { App } from '../../../../core/state.js';
import { TOOLS, segWithExtend } from '../tools.js';
import { applyStroke, arrowHead, chipLabel, drawAnnotation, normRect, polyPts, ptXY } from './common.js';
import { levelsOfF } from './fib-gann.js';
import { TH } from './analysis.js';

  TOOLS.pitchfan = {
    name: 'Pitchfan', icon: 'pitchfan', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b, c] = polyPts(v, d);
      const a0 = Math.atan2(a[1] - b[1], a[0] - b[0]);
      const a1 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      let da = a1 - a0;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const T = (v.w + v.h) * 3;
      ctx.save();
      /* the A-C connector (subtle, like the pitchfork handle) */
      applyStroke(ctx, d);
      ctx.save();
      ctx.globalAlpha *= 0.6;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 1;
      ctx.font = '10px "Segoe UI", Arial, sans-serif';
      for (const lv of levelsOfF(d, [0, 0.382, 0.5, 0.618, 1])) {
        if (lv.on === false) continue;
        const isEdge = Math.abs(lv.r) < 1e-9 || Math.abs(lv.r - 1) < 1e-9;
        const ang = a0 + da * U.clamp(lv.r, 0, 1);
        const seg = U.clipLine(b[0], b[1], b[0] + Math.cos(ang) * T, b[1] + Math.sin(ang) * T, v.pw, v.ph);
        if (!seg) continue;
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        ctx.lineWidth = isEdge ? (d.opts.width || 2) : 1;
        ctx.setLineDash(isEdge ? [] : U.dashFor(d.opts.style || 'solid', 1));
        ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke();
        if (d.opts.showRatio !== false && !isEdge) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.textBaseline = 'bottom';
          ctx.fillText(lv.r.toFixed(3), Math.min(Math.max(seg[2] - 32, 4), v.pw - 36), seg[3] - 2);
        }
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b, c] = polyPts(v, d);
        if (U.distSeg(x, y, a[0], a[1], c[0], c[1]) < 6) return true;
        const a0 = Math.atan2(a[1] - b[1], a[0] - b[0]);
        const a1 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let da = a1 - a0;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        const T = (v.w + v.h) * 3;
        for (const lv of levelsOfF(d, [0, 0.382, 0.5, 0.618, 1])) {
          if (lv.on === false) continue;
          const ang = a0 + da * U.clamp(lv.r, 0, 1);
          const seg = U.clipLine(b[0], b[1], b[0] + Math.cos(ang) * T, b[1] + Math.sin(ang) * T, v.pw, v.ph);
          if (seg && U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < 6) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Callout ---------------- */
  TOOLS.callout = {
    name: 'Callout', icon: 'callout', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [A, B] = polyPts(v, d); // A = bubble anchor, B = leader target
      const text = String(d.opts.text || 'Callout');
      ctx.save();
      ctx.font = `${d.opts.italic ? 'italic ' : ''}${d.opts.bold ? '700 ' : ''}${d.opts.fontSize || 12}px "Segoe UI", Arial, sans-serif`;
      const lines = text.split('\n');
      const lw = Math.max(...lines.map((l) => ctx.measureText(l).width), 30);
      const lh = (d.opts.fontSize || 12) + 4;
      const bh = lines.length * lh + 10;
      const bw = lw + 16;
      const bx = A[0], by = A[1] - bh / 2;
      applyStroke(ctx, d);
      if (d.opts.fill !== false) {
        ctx.save();
        ctx.fillStyle = d.opts.fillColor || d.opts.color || '#2962ff';
        ctx.globalAlpha = typeof d.opts.fillOpacity === 'number' ? d.opts.fillOpacity : 0.9;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6); else ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6); else ctx.rect(bx, by, bw, bh);
      ctx.stroke();
      // leader line + arrow to B
      ctx.beginPath(); ctx.moveTo(bx + bw / 2, by + bh / 2); ctx.lineTo(B[0], B[1]); ctx.stroke();
      arrowHead(ctx, B[0], B[1], bx + bw / 2, by + bh / 2, 7);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 5 + i * lh));
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [A, B] = polyPts(v, d);
        const text = String(d.opts.text || 'Callout');
        return U.distSeg(x, y, A[0], A[1], B[0], B[1]) < 6 || (Math.abs(x - A[0]) < 90 && Math.abs(y - A[1]) < 24);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Arrow Marks + Flag ---------------- */
  function markTool(id, name, icon, dir) {
    TOOLS[id] = {
      name, icon, pts: 1,
      draw(v, d) {
        const ctx = v.ctx;
        const [x, y] = ptXY(v, d.points[0]);
        const s = d.opts.markSize || 22;
        ctx.save();
        ctx.strokeStyle = d.opts.color || '#f23645';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = Math.max(2, d.opts.width || 2);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        const rot = { up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0 }[dir];
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(0, -s / 2); ctx.lineTo(s / 2, s / 6); ctx.lineTo(s / 6, s / 6);
        ctx.lineTo(s / 6, s / 2); ctx.lineTo(-s / 6, s / 2); ctx.lineTo(-s / 6, s / 6);
        ctx.lineTo(-s / 2, s / 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        drawAnnotation(v, d, x + s / 2 + 3, y + 3, { x0: x + s / 2 + 3, x1: x + s / 2 + 3, y0: y, y1: y + s });
      },
      handles(v, d) { return [ptXY(v, d.points[0])]; },
      hitBody(v, d) {
        return (x, y) => {
          const [px, py] = ptXY(v, d.points[0]);
          const s = d.opts.markSize || 22;
          return Math.abs(x - px) < s && Math.abs(y - py) < s;
        };
      },
      dragHandle(v, d, i, pt) { d.points[0] = { t: pt.t, p: pt.p }; },
    };
  }
  markTool('arrowmarku', 'Arrow mark up', 'arrowmarku', 'up');
  markTool('arrowmarkd', 'Arrow mark down', 'arrowmarkd', 'down');
  markTool('arrowmarkl', 'Arrow Mark Left', 'arrowmarkl', 'left');
  markTool('arrowmarkr', 'Arrow Mark Right', 'arrowmarkr', 'right');
  TOOLS.flagmark = {
    name: 'Flag Mark', icon: 'flagmark', pts: 1,
    draw(v, d) {
      const ctx = v.ctx;
      const [x, y] = ptXY(v, d.points[0]);
      const s = d.opts.markSize || 26;
      ctx.save();
      ctx.strokeStyle = d.opts.color || '#2962ff';
      ctx.lineWidth = Math.max(2, d.opts.width || 2);
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, y + s / 2); ctx.lineTo(x, y - s / 2); ctx.stroke();
      if (d.opts.fill !== false) {
        ctx.fillStyle = d.opts.fillColor || d.opts.color || '#2962ff';
        ctx.beginPath();
        ctx.moveTo(x, y - s / 2); ctx.lineTo(x + s * 0.8, y - s / 4); ctx.lineTo(x, y);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      drawAnnotation(v, d, x + s, y + 3, { x0: x + s, x1: x + s, y0: y, y1: y + s });
    },
    handles(v, d) { return [ptXY(v, d.points[0])]; },
    hitBody(v, d) {
      return (x, y) => {
        const [px, py] = ptXY(v, d.points[0]);
        const s = d.opts.markSize || 26;
        return x > px - 4 && x < px + s * 1.2 && Math.abs(y - py) < s;
      };
    },
    dragHandle(v, d, i, pt) { d.points[0] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Emoji (TV Icons category, ROUND248) ----------------
     One click anchors one glyph; the Style tab carries the emoji grid +
     size. Glyph paint uses the OS color-emoji font (no assets needed). */
  TOOLS.emoji = {
    name: 'Emoji', icon: 'emoji', pts: 1,
    draw(v, d) {
      const [x, y] = ptXY(v, d.points[0]);
      const size = isFinite(d.opts.size) ? U.clamp(Math.round(d.opts.size), 8, 128) : 24;
      const ch = String(d.opts.ch || '👍');
      const ctx = v.ctx;
      ctx.save();
      ctx.font = `${size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, x, y);
      ctx.restore();
    },
    handles(v, d) { return [ptXY(v, d.points[0])]; },
    hitBody(v, d) {
      return (x, y) => {
        const [px, py] = ptXY(v, d.points[0]);
        const size = isFinite(d.opts.size) ? U.clamp(Math.round(d.opts.size), 8, 128) : 24;
        const r = Math.max(8, size * 0.6);
        return Math.abs(x - px) < r && Math.abs(y - py) < r;
      };
    },
    dragHandle(v, d, i, pt) { d.points[0] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Long / Short Position (R:R) ---------------- */
  function positionDraw(v, d, isShort) {
    const ctx = v.ctx;
    const n = normRect(d);
    const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
    const entry = d.points[0].p;
    const stop = d.points[1].p;
    const risk = Math.abs(entry - stop) || entry * 0.001;
    const target = d.opts.target != null ? d.opts.target : (isShort ? entry - risk : entry + risk);
    const yE = v.yOf(entry), yS = v.yOf(stop), yT = v.yOf(target);
    const up = isShort ? target < entry : target > entry;
    /* ROUND254 (TV parity): stop/target colors are settable (defaults keep
       the old win/loss look for existing drawings). */
    const winCol = d.opts.targetColor || (up ? '#089981' : '#f23645');
    const lossCol = d.opts.stopColor || (up ? '#f23645' : '#089981');
    const x0 = Math.min(xL, xR), x1 = Math.max(xL, xR);
    const box = (ya, yb, col, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = col;
      ctx.fillRect(x0, Math.min(ya, yb), x1 - x0, Math.abs(yb - ya));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, Math.min(ya, yb), x1 - x0, Math.abs(yb - ya));
      ctx.restore();
    };
    box(yE, yT, winCol, 0.18);
    box(yE, yS, lossCol, 0.18);
    // entry / stop / target lines
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    for (const [yy, col] of [[yE, '#787b86'], [yS, lossCol], [yT, winCol]]) {
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
    }
    ctx.restore();
    // R:R chip
    const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;
    chipLabel(ctx, (x0 + x1) / 2, (Math.min(yT, yS) + Math.max(yT, yS)) / 2,
      `${isShort ? 'Short' : 'Long'}  R:R ${rr.toFixed(2)}`, 'rgba(24,28,39,.92)');
  }
  function positionTool(id, name, isShort) {
    TOOLS[id] = {
      name, icon: isShort ? 'positions' : 'positionl', pts: 2,
      afterFinish(d) {
        /* TV: the target starts at R:R 1:1 (2nd click sets stop distance) */
        const entry = d.points[0].p, stop = d.points[1].p;
        const risk = Math.abs(entry - stop) || entry * 0.001;
        d.opts.target = isShort ? entry - risk : entry + risk;
      },
      draw(v, d) { positionDraw(v, d, isShort); },
      handles(v, d) {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
        const entry = d.points[0].p, stop = d.points[1].p;
        const risk = Math.abs(entry - stop) || entry * 0.001;
        const target = d.opts.target != null ? d.opts.target : (isShort ? entry - risk : entry + risk);
        return [
          [xL, v.yOf(target)], [xR, v.yOf(target)],
          [xL, v.yOf(entry)], [xR, v.yOf(entry)],
          [xL, v.yOf(stop)], [xR, v.yOf(stop)],
        ];
      },
      hitBody(v, d) {
        return (x, y) => {
          const n = normRect(d);
          const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
          const stop = d.points[1].p;
          const risk = Math.abs(d.points[0].p - stop) || d.points[0].p * 0.001;
          const target = d.opts.target != null ? d.opts.target : (isShort ? d.points[0].p - risk : d.points[0].p + risk);
          const ys = [v.yOf(target), v.yOf(d.points[0].p), v.yOf(stop)];
          const y0 = Math.min(...ys) - 5, y1 = Math.max(...ys) + 5;
          return x >= Math.min(xL, xR) - 5 && x <= Math.max(xL, xR) + 5 && y >= y0 && y <= y1;
        };
      },
      /* ROUND246: the target price lives in opts (not points) — a body move
         must carry it along or the R:R silently breaks. Absolute from the
         drag-start snapshot (engine bodyDragState), never accumulating. */
      bodyDragState(d) { return { target: d.opts.target }; },
      onBodyDrag(d, dp, st) {
        if (st && st.target != null && isFinite(st.target)) d.opts.target = st.target + dp;
      },
      dragHandle(v, d, i, pt) {
        const n = normRect(d);
        let { tL, tR, pT, pB } = n;
        if (i === 0) d.opts.target = pt.p;
        else if (i === 1) d.opts.target = pt.p;
        else if (i === 2) { d.points[0].p = pt.p; }
        else if (i === 3) { d.points[0].p = pt.p; }
        else if (i === 4) { d.points[1].p = pt.p; }
        else if (i === 5) { d.points[1].p = pt.p; }
        if (i >= 2) {
          if (i === 2 || i === 4) d.points[0].t = pt.t;
          if (i === 3 || i === 5) d.points[1].t = pt.t;
        }
      },
    };
  }
  positionTool('positionl', 'Long Position', false);
  positionTool('positions', 'Short Position', true);

  /* ---------------- Info Line ----------------
     ROUND252 (TV parity): the line extends left/right on demand (was a bare
     segment) + a real Style tab (was the generic fallback). The stats chip
     stays centered on the anchors. */
  TOOLS.infoline = {
    name: 'Info Line', icon: 'infoline', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = polyPts(v, d);
      const seg = segWithExtend(v, a[0], a[1], b[0], b[1], !!d.opts.extendLeft, !!d.opts.extendRight);
      applyStroke(ctx, d);
      ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke();
      const dp = d.points[1].p - d.points[0].p;
      const pct = (dp / d.points[0].p) * 100;
      const bars = Math.round(Math.abs(U.timeToLogical(v.times, d.points[1].t) - U.timeToLogical(v.times, d.points[0].t)));
      const dur = U.durHuman(Math.abs(d.points[1].t - d.points[0].t));
      const parts = [`${dp >= 0 ? '+' : ''}${U.fmtPrice(dp, v.digits)}`, `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, `${bars} bars · ${dur}`];
      if (d.opts.showPrices !== false) parts.unshift(`${U.fmtPrice(d.points[0].p, v.digits)} → ${U.fmtPrice(d.points[1].p, v.digits)}`);
      const txt = parts.join('  ');
      ctx.save();
      ctx.font = '600 10.5px "Segoe UI", Arial, sans-serif';
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = TH('chipBg', 'rgba(24,28,39,.94)');
      ctx.strokeStyle = d.opts.color || '#2962ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      if (ctx.roundRect) ctx.roundRect(cx - w / 2, cy - 21, w, 21, 4); else ctx.rect(cx - w / 2, cy - 21, w, 21);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = TH('chipText', '#d1d4dc');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, cx, cy - 10.5);
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b] = polyPts(v, d);
        const seg = segWithExtend(v, a[0], a[1], b[0], b[1], !!d.opts.extendLeft, !!d.opts.extendRight);
        return U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < Math.max(5, 4 + (d.opts.width || 2));
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

export { markTool, positionDraw, positionTool };
