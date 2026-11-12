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
import { applyStroke, arrowHead, chipLabel, drawAnnotation, normRect, polyPts, ptXY, insidePoly } from './common.js';
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
  /* ROUND285 (TV parity): the bubble is a ROUNDED RECT with a TRIANGULAR
     TAIL that points at the leader target — one closed outline, not a
     rectangle plus a separate leader line. The tail placement follows the
     `pointer` option (auto / up / down / left / right); auto picks the side
     facing the target, which is what TV's default look does.
     Returns the outline in screen space so draw/hit share one geometry. */
  function calloutGeo(v, d) {
    const [A, B] = polyPts(v, d);
    const ctx = v.ctx;
    const fs = d.opts.fontSize || 12;
    const savedFont = ctx.font;
    ctx.save();
    ctx.font = `${d.opts.italic ? 'italic ' : ''}${d.opts.bold ? '700 ' : ''}${fs}px "Segoe UI", Arial, sans-serif`;
    const text = String(d.opts.text || 'Callout');
    const lines = text.split('\n');
    const lw = Math.max(...lines.map((l) => ctx.measureText(l).width), 24);
    ctx.restore();
    ctx.font = savedFont;
    const lh = fs + 4;
    const padX = 9, padY = 6;
    /* ROUND289: TV's bubble is slightly taller than its text, which is what
       gives the Text tab's vertical alignment (Top / Inside / Bottom) any room
       to move. Without this slack the padded inner box was EXACTLY the text
       block, so all three choices painted identically. */
    const vSlack = 10;
    const bw = lw + padX * 2;
    const bh = lines.length * lh + padY * 2 + vSlack;
    /* bubble centre sits on the anchor; the tail reaches the target */
    const cx = A[0], cy = A[1];
    const dx = B[0] - cx, dy = B[1] - cy;
    let side = d.opts.pointer || 'auto';
    if (side === 'auto') {
      side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
    }
    /* keep the bubble inside the pane so the text stays readable */
    const left = U.clamp(cx - bw / 2, 2, Math.max(2, v.pw - bw - 2));
    const top = U.clamp(cy - bh / 2, 2, Math.max(2, v.ph - bh - 2));
    const right = left + bw, bottom = top + bh;
    /* tail: a triangle from a base on the chosen edge out to the target */
    const TW = Math.max(8, Math.min(16, fs));   // half base width
    const TH = 12;                               // tail length (clamped to the gap)
    const gap = { right: B[0] - right, left: left - B[0], down: B[1] - bottom, up: top - B[1] }[side];
    const tl = U.clamp(Math.abs(gap), 4, TH);
    let tail = null;
    if (side === 'right') {
      const my = U.clamp(B[1], top + 6, bottom - 6);
      tail = [[right, my - TW], [right + tl, U.clamp(B[1], top, bottom)], [right, my + TW]];
    } else if (side === 'left') {
      const my = U.clamp(B[1], top + 6, bottom - 6);
      tail = [[left, my - TW], [left - tl, U.clamp(B[1], top, bottom)], [left, my + TW]];
    } else if (side === 'down') {
      const mx = U.clamp(B[0], left + 6, right - 6);
      tail = [[mx - TW, bottom], [U.clamp(B[0], left, right), bottom + tl], [mx + TW, bottom]];
    } else {
      const mx = U.clamp(B[0], left + 6, right - 6);
      tail = [[mx - TW, top], [U.clamp(B[0], left, right), top - tl], [mx + TW, top]];
    }
    return { left, top, right, bottom, bw, bh, lines, lh, padX, padY, side, tail, A, B };
  }

  TOOLS.callout = {
    name: 'Callout', icon: 'callout', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const g = calloutGeo(v, d);
      const radius = 6;
      /* ONE closed path: rounded rect + tail, so fill and stroke agree and
         the tail is part of the bubble (TV) instead of a separate line. */
      const path = () => {
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(g.left, g.top, g.bw, g.bh, radius);
        } else {
          ctx.rect(g.left, g.top, g.bw, g.bh);
        }
        if (g.tail) {
          ctx.moveTo(g.tail[0][0], g.tail[0][1]);
          ctx.lineTo(g.tail[1][0], g.tail[1][1]);
          ctx.lineTo(g.tail[2][0], g.tail[2][1]);
          ctx.closePath();
        }
      };
      applyStroke(ctx, d);
      if (d.opts.fill !== false) {
        ctx.save();
        ctx.globalAlpha = typeof d.opts.fillOpacity === 'number' ? U.clamp(d.opts.fillOpacity, 0.02, 1) : 0.9;
        ctx.fillStyle = d.opts.fillColor || d.opts.color || '#2962ff';
        path();
        ctx.fill();
        ctx.restore();
      }
      /* the outline is drawn twice: the rounded rect, then the tail, so the
         shared edge between them is not stroked through the bubble */
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(g.left, g.top, g.bw, g.bh, radius);
      else ctx.rect(g.left, g.top, g.bw, g.bh);
      ctx.stroke();
      if (g.tail) {
        ctx.beginPath();
        ctx.moveTo(g.tail[0][0], g.tail[0][1]);
        ctx.lineTo(g.tail[1][0], g.tail[1][1]);
        ctx.lineTo(g.tail[2][0], g.tail[2][1]);
        ctx.closePath();
        ctx.stroke();
      }
      /* ROUND289 (TV parity): the Text tab's horizontal + vertical alignment
         now apply INSIDE the bubble (they used to be ignored here — every
         callout was top-left). `textHAlign` moves the text block between the
         padded edges; `textVAlign` moves it between the top and bottom
         padding, so 'inside' centres it both ways. */
      ctx.fillStyle = d.opts.textColor || '#ffffff';
      const ha = d.opts.textHAlign || 'left';
      const va = d.opts.textVAlign || 'top';
      ctx.textBaseline = 'top';
      ctx.textAlign = ha === 'center' ? 'center' : ha === 'right' ? 'right' : 'left';
      const blockH = g.lines.length * g.lh;
      const innerTop = g.top + g.padY;
      const innerH = g.bh - g.padY * 2;
      const y0 = va === 'inside'
        ? innerTop + Math.max(0, (innerH - blockH) / 2)
        : va === 'bottom'
          ? g.bottom - g.padY - blockH
          : innerTop;
      const xOf = ha === 'center' ? (g.left + g.right) / 2
        : ha === 'right' ? g.right - g.padX
          : g.left + g.padX;
      g.lines.forEach((l, i) => ctx.fillText(l, xOf, y0 + i * g.lh));
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const g = calloutGeo(v, d);
        if (x >= g.left - 4 && x <= g.right + 4 && y >= g.top - 4 && y <= g.bottom + 4) return true;
        if (g.tail && insidePoly(x, y, g.tail)) return true;
        /* still grabbable on the tail tip / leader gap */
        return U.distSeg(x, y, g.A[0], g.A[1], g.B[0], g.B[1]) < 8;
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
