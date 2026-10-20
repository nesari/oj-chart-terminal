/**
 * Drawing tools batch 2 (TradingView Drawings List)
 *
 * 34 tools: Pitchfork ×4, Fib Channel/Circles, Gann Box/Square/Fixed/Fan,
 * Brush/Highlighter (engine freehand), Callout, Arrow Marks ×4, Flag Mark,
 * Long/Short Position (R:R), Info Line, Regression Trend, Volume Profile,
 * Elliott ×5 + harmonic patterns. Registered on the SAME TOOLS registry.
 *
 * @module drawing/tools2
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';
import { TOOLS, segWithExtend } from './tools.js';

const HIT = 7;

  function ptXY(v, p) { return [v.xOf(p.t), v.yOf(p.p)]; }
  function normRect(d) {
    const tL = Math.min(d.points[0].t, d.points[1].t), tR = Math.max(d.points[0].t, d.points[1].t);
    const pT = Math.max(d.points[0].p, d.points[1].p), pB = Math.min(d.points[0].p, d.points[1].p);
    return { tL, tR, pT, pB };
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
  /* Text-tab annotation — box form enables the Text-tab font + alignment
     settings; real-area boxes clip the text inside (rounds 19/20) */
  function drawAnnotation(view, d, x, y, box) {
    const t = String(d.opts.text || '').trim();
    if (!t) return;
    const ctx = view.ctx;
    ctx.save();
    const fs = d.opts.fontSize || 11;
    ctx.font = `${d.opts.italic ? 'italic ' : ''}${d.opts.bold ? '700 ' : ''}${fs}px "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = d.opts.textColor || '#d1d4dc';
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
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    if (bw > 8 && bh > 8) {
      ctx.beginPath();
      ctx.rect(box.x0 + 1, box.y0 + 1, bw - 2, bh - 2);
      ctx.clip();
    }
    lines.forEach((l, i) => ctx.fillText(l, bx, by + i * lh));
    ctx.restore();
  }
  function polyPts(v, d) { return d.points.map((p) => ptXY(v, p)); }
  function distToPath(x, y, P, minDist) {
    let best = Infinity;
    for (let i = 1; i < P.length; i++) {
      best = Math.min(best, U.distSeg(x, y, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]));
    }
    return best < minDist;
  }
  function applyStroke(ctx, d) {
    ctx.strokeStyle = d.opts.color || '#2962ff';
    ctx.lineWidth = d.opts.width || 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(U.dashFor(d.opts.style || 'solid', d.opts.width || 2));
    const bo = d.opts.borderOpacity;
    ctx.globalAlpha = (typeof bo === 'number' && isFinite(bo)) ? U.clamp(bo, 0.02, 1) : 1;
  }
  /* round 52: background-fill helpers (same rules as tools.js) — needed by
     the Regression Trend Background fill */
  function fillAlphaOf(d) {
    const o = d.opts.fillOpacity;
    return typeof o === 'number' && isFinite(o) ? U.clamp(o, 0.02, 1) : 0.15;
  }
  function fillColorOf(d) { return d.opts.fillColor || d.opts.color; }
  function chipLabel(ctx, x, y, text, bg, fg) {
    ctx.save();
    ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg || 'rgba(24,28,39,.92)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 8, w, 15, 3); else ctx.rect(x - w / 2, y - 8, w, 15);
    ctx.fill();
    ctx.fillStyle = fg || '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 0.5);
    ctx.restore();
  }

  /* ---------------- Pitchfork family ----------------
     ROUND247 (TV parity — official Auto Pitchfork doc): each variant moves
     the median, not the anchors —
       std:     P0 -> mid(P1,P2)
       schiff:  {P0.t, mid(P0,P1).p} -> mid(P1,P2)
       mschiff: mid(P0,P1) -> mid(P1,P2)
       inside:  mid(P0,P1) -> P2
     Prongs stay parallel through their starts ([P1,P2], or the mid-anchors
     for inside). */
  function forkMid(a, b) { return { t: (a.t + b.t) / 2, p: (a.p + b.p) / 2 }; }
  function forkOrigin(d) {
    const [p0, p1] = d.points;
    const kind = d.opts.forkKind || 'std';
    if (kind === 'schiff') return { t: p0.t, p: forkMid(p0, p1).p };
    if (kind === 'mschiff' || kind === 'inside') return forkMid(p0, p1);
    return { t: p0.t, p: p0.p };
  }
  function forkMedianEnd(d) {
    const [p0, p1, p2] = d.points;
    const kind = d.opts.forkKind || 'std';
    if (kind === 'inside') return { t: p2.t, p: p2.p };
    return { t: (p1.t + p2.t) / 2, p: (p1.p + p2.p) / 2 };
  }
  function forkProngStarts(d) {
    const [p0, p1, p2] = d.points;
    const kind = d.opts.forkKind || 'std';
    if (kind === 'inside') {
      return [{ t: (p0.t + p1.t) / 2, p: (p0.p + p1.p) / 2 }, { t: (p0.t + p2.t) / 2, p: (p0.p + p2.p) / 2 }];
    }
    return [p1, p2];
  }
  /* Painted spans shared by draw + hit: median + both prongs along the
     median direction, extended per the 2020 extend-lines update (right stays
     the default). With both off, one median-vector each. */
  function forkSegs(v, d) {
    const O = ptXY(v, forkOrigin(d));
    const E = ptXY(v, forkMedianEnd(d));
    const [a, b] = forkProngStarts(d).map((p) => ptXY(v, p));
    const dx = E[0] - O[0], dy = E[1] - O[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const T = (v.w + v.h) * 3;
    const eL = !!d.opts.extendLeft, eR = d.opts.extendRight !== false;
    const span = (P) => {
      let sx, sy, ex, ey;
      if (eL || eR) {
        sx = eL ? P[0] - ux * T : P[0]; sy = eL ? P[1] - uy * T : P[1];
        ex = eR ? P[0] + ux * T : P[0]; ey = eR ? P[1] + uy * T : P[1];
      } else {
        sx = P[0]; sy = P[1]; ex = P[0] + dx; ey = P[1] + dy;
      }
      return [sx, sy, ex, ey];
    };
    return { O, med: span(O), prongs: [span(a), span(b)] };
  }
  function forkDraw(v, d) {
    const ctx = v.ctx;
    const { O, med, prongs } = forkSegs(v, d);
    const [a, b] = forkProngStarts(d).map((p) => ptXY(v, p));
    applyStroke(ctx, d);
    /* ROUND254 (TV parity): the Median has its own color/thickness/style row
       (falls back to the base line when unset). */
    const mCol = d.opts.medianColor || d.opts.color;
    const mW = d.opts.medianWidth || d.opts.width;
    const mS = d.opts.medianStyle || d.opts.style;
    const seg = U.clipLine(med[0], med[1], med[2], med[3], v.pw, v.ph);
    if (seg) {
      ctx.save();
      ctx.strokeStyle = mCol;
      ctx.lineWidth = mW;
      ctx.setLineDash(U.dashFor(mS || 'solid', mW || 2));
      ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke();
      ctx.restore();
    }
    for (let i = 0; i < 2; i++) {
      const P = [a, b][i];
      const s2 = U.clipLine(prongs[i][0], prongs[i][1], prongs[i][2], prongs[i][3], v.pw, v.ph);
      if (s2) { ctx.beginPath(); ctx.moveTo(s2[0], s2[1]); ctx.lineTo(s2[2], s2[3]); ctx.stroke(); }
      // connector from O to the prong start
      ctx.save();
      ctx.globalAlpha *= 0.6;
      ctx.beginPath(); ctx.moveTo(O[0], O[1]); ctx.lineTo(P[0], P[1]); ctx.stroke();
      ctx.restore();
    }
  }
  function forkTool(id, name, icon, kind) {
    TOOLS[id] = {
      name, icon, pts: 3,
      draw(v, d) {
        d.opts.forkKind = kind;
        forkDraw(v, d);
        const px = ptXY(v, d.points[0]);
        drawAnnotation(v, d, px[0], px[1], { x0: px[0], x1: px[0], y0: px[1], y1: px[1] });
      },
      handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
      hitBody(v, d) {
        return (x, y) => {
          /* ROUND247: test the painted rays (median + prongs + connectors),
             not just the short anchor tripod — the old test made extended
             forks ungrabbable. */
          const { O, med, prongs } = forkSegs(v, d);
          const m = 6;
          if (U.distSeg(x, y, med[0], med[1], med[2], med[3]) < m) return true;
          const [a, b] = forkProngStarts(d).map((p) => ptXY(v, p));
          for (let i = 0; i < 2; i++) {
            if (U.distSeg(x, y, prongs[i][0], prongs[i][1], prongs[i][2], prongs[i][3]) < m) return true;
            if (U.distSeg(x, y, O[0], O[1], [a, b][i][0], [a, b][i][1]) < m) return true;
          }
          return false;
        };
      },
      dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
    };
  }
  forkTool('pitchfork', 'Pitchfork', 'pitchfork', 'std');
  forkTool('pitchfork_s', 'Schiff Pitchfork', 'pitchfork', 'schiff');
  forkTool('pitchfork_ms', 'Modified Schiff Pitchfork', 'pitchfork', 'mschiff');
  forkTool('pitchfork_i', 'Inside Pitchfork', 'pitchfork', 'inside');

  /* ---------------- Fib Channel ---------------- */
  const FIBC_LEVELS = [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618];
  /* ROUND245 (TV parity): channel rays run both ways on demand — right stays
     the default (the old right-only look). Shared by draw + hit. */
  function fibChanSpan(v, P, bx, by, vx, vy, eL, eR) {
    const T = (v.w + v.h) * 3;
    let sx = bx, sy = by, ex = bx, ey = by;
    if (eL || eR) {
      if (eL) { sx = bx - vx * T; sy = by - vy * T; }
      if (eR) { ex = bx + vx * T; ey = by + vy * T; }
    } else {
      const L = Math.hypot(P[2][0] - P[0][0], P[2][1] - P[0][1]) || 1;
      const n = Math.hypot(vx, vy) || 1;
      ex = bx + (vx / n) * L; ey = by + (vy / n) * L;
    }
    return [sx, sy, ex, ey];
  }
  TOOLS.fibchannel = {
    name: 'Fib Channel', icon: 'fibchannel', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const P = polyPts(v, d);
      const vx = P[1][0] - P[0][0], vy = P[1][1] - P[0][1]; // trend direction (px)
      const levels = levelsOfF(d, FIBC_LEVELS);
      ctx.save();
      for (const lv of levels) {
        if (lv.on === false) continue;
        const k = lv.r;
        const bx = P[0][0] + k * (P[2][0] - P[0][0]), by = P[0][1] + k * (P[2][1] - P[0][1]);
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        ctx.lineWidth = 1;
        ctx.setLineDash(U.dashFor(d.opts.style || 'solid', 1));
        const eL = !!d.opts.extendLeft, eR = d.opts.extendRight !== false;
        const sp = fibChanSpan(v, P, bx, by, vx, vy, eL, eR);
        const seg = U.clipLine(sp[0], sp[1], sp[2], sp[3], v.pw, v.ph);
        if (seg) { ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke(); }
        if (d.opts.showRatio !== false) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.font = '10px "Segoe UI", Arial, sans-serif';
          ctx.textBaseline = 'bottom';
          ctx.fillText(lv.r.toFixed(3), Math.min(Math.max(seg ? seg[0] : bx, 4), v.pw - 40), (seg ? seg[1] : by) - 2);
        }
      }
      ctx.restore();
      const p0 = P[0];
      drawAnnotation(v, d, p0[0], p0[1], { x0: p0[0], x1: p0[0], y0: p0[1], y1: p0[1] });
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        /* ROUND245: test the painted channel lines, not the anchor tripod —
           the old tripod test made channels nearly unselectable. */
        const P = polyPts(v, d);
        const vx = P[1][0] - P[0][0], vy = P[1][1] - P[0][1];
        const eL = !!d.opts.extendLeft, eR = d.opts.extendRight !== false;
        for (const lv of levelsOfF(d, FIBC_LEVELS)) {
          if (lv.on === false) continue;
          const bx = P[0][0] + lv.r * (P[2][0] - P[0][0]), by = P[0][1] + lv.r * (P[2][1] - P[0][1]);
          const sp = fibChanSpan(v, P, bx, by, vx, vy, eL, eR);
          const seg = U.clipLine(sp[0], sp[1], sp[2], sp[3], v.pw, v.ph) || sp;
          if (U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < 6) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };
  function levelsOfF(d, fallback) {
    const ls = Array.isArray(d.opts.levels) ? d.opts.levels : null;
    /* ROUND256 (TV parity): Use one color — same mapping as levelsOf. */
    const base = d.opts.color;
    const paint = (arr) => (d.opts.useOneColor && base)
      ? arr.map((l) => Object.assign({}, l, { c: base })) : arr;
    if (ls && ls.length) return paint(ls.filter((l) => l && isFinite(l.r)));
    return paint(fallback.map((r) => ({ r, c: d.opts.color || '#2962ff', on: true })));
  }

  /* ---------------- Fib Circles ---------------- */
  TOOLS.fibcircles = {
    name: 'Fib Circles', icon: 'fibcircles', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = polyPts(v, d);
      const rx = Math.abs(b[0] - a[0]), ry = Math.abs(b[1] - a[1]);
      ctx.save();
      for (const lv of levelsOfF(d, [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618])) {
        if (lv.on === false) continue;
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.ellipse(a[0], a[1], rx * lv.r, ry * lv.r, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      drawAnnotation(v, d, a[0] + 5, a[1] + 5);
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b] = polyPts(v, d);
        return U.distSeg(x, y, a[0], a[1], b[0], b[1]) < 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Gann Box / Square / Fixed / Fan ----------------
     ROUND246 (TV parity — official support doc): the box divides the chosen
     price + time ranges into a CONFIGURABLE number of equal partitions (was a
     fixed 8x8), with edge labels (price left/right, time top/bottom), optional
     corner angles and Reverse (diagonal mirror). */
  function gannLevelsN(v, fb) { return isFinite(v) ? Math.min(32, Math.max(1, Math.round(v))) : fb; }
  function gannTimeLabel(t) {
    const d = new Date(Math.round(t) * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  }
  function gannBoxDraw(v, d, xL, yT, xR, yB) {
    const ctx = v.ctx;
    const nT = gannLevelsN(d.opts.timeLevels, 8), nP = gannLevelsN(d.opts.priceLevels, 8);
    const rev = !!d.opts.reverse;
    /* ROUND254 (TV parity): Background + corner Angles (diagonals run past
       the corners when on). */
    if (d.opts.fill) {
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d);
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(xL, yT, xR - xL, yB - yT);
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = d.opts.color || '#787b86';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(xL, yT, xR - xL, yB - yT);
    ctx.strokeStyle = 'rgba(120,123,134,.55)';
    for (let k = 1; k < nT; k++) {
      const x = xL + ((xR - xL) * k) / nT;
      ctx.beginPath(); ctx.moveTo(x, yT); ctx.lineTo(x, yB); ctx.stroke();
    }
    for (let k = 1; k < nP; k++) {
      const y = yT + ((yB - yT) * k) / nP;
      ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y); ctx.stroke();
    }
    const c1 = d.opts.diagColor || '#2962ff', c2 = d.opts.diag2Color || '#f23645';
    const diag = (x0, y0, x1, y1, col) => {
      ctx.strokeStyle = col;
      ctx.beginPath();
      if (d.opts.showAngles) {
        /* corner rays: run past both corners to the viewport edge */
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const T = (v.w + v.h) * 3;
        const seg = U.clipLine(x0 - (dx / len) * T, y0 - (dy / len) * T,
          x1 + (dx / len) * T, y1 + (dy / len) * T, v.pw, v.ph);
        if (!seg) return;
        ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]);
      } else {
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    };
    diag(xL, yT, xR, yB, rev ? c2 : c1);
    diag(xL, yB, xR, yT, rev ? c1 : c2);
    /* edge labels (TV Labels toggle): price on the sides, time on top/bottom */
    if (d.opts.showLabels !== false) {
      const n = normRect(d);
      ctx.fillStyle = 'rgba(120,123,134,.95)';
      ctx.font = '9.5px "Segoe UI", Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let k = 0; k <= nP; k++) {
        const p = n.pT + ((n.pB - n.pT) * (rev ? nP - k : k)) / nP;
        const y = yT + ((yB - yT) * k) / nP;
        const s = U.fmtPrice(p, v.digits);
        ctx.fillText(s, xL + 3, y - 6);
        ctx.textAlign = 'right';
        ctx.fillText(s, xR - 3, y - 6);
        ctx.textAlign = 'left';
      }
      ctx.textBaseline = 'top';
      for (let k = 0; k <= nT; k++) {
        const t = n.tL + ((n.tR - n.tL) * (rev ? nT - k : k)) / nT;
        const x = xL + ((xR - xL) * k) / nT;
        ctx.fillText(gannTimeLabel(t), x + 3, yT + 2);
      }
    }
    ctx.restore();
  }
  TOOLS.gannbox = {
    name: 'Gann Box', icon: 'gannbox', pts: 2,
    draw(v, d) {
      const n = normRect(d);
      gannBoxDraw(v, d, v.xOf(n.tL), v.yOf(n.pT), v.xOf(n.tR), v.yOf(n.pB));
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
        const x0 = Math.min(xL, xR), x1 = Math.max(xL, xR), y0 = Math.min(yT, yB), y1 = Math.max(yT, yB);
        return x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  function gannSquareDraw(v, d, cx, cy, w, h) {
    const ctx = v.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,123,134,.42)';
    ctx.setLineDash([]);
    /* bounded grid (round 20 hardening): step >= 1px, line count capped —
       a degenerate cell (w or h = 0) must NEVER loop forever */
    const stepX = Math.max(1, Math.abs(w) / 8);
    const stepY = Math.max(1, Math.abs(h) / 8);
    const cols = Math.min(3000, Math.ceil((v.pw + 8 * stepX) / stepX) + 16);
    for (let k = -8; k <= cols; k++) {
      const x = cx + k * stepX;
      if (x < -1 || x > v.pw + 1) continue;
      ctx.globalAlpha = k % 8 === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.ph); ctx.stroke();
    }
    const kFrom = Math.floor((-cy) / stepY) - 1;
    const rows = Math.min(3000, kFrom + Math.ceil(v.ph / stepY) + 17);
    for (let k = kFrom; k <= rows; k++) {
      const y = cy + k * stepY;
      if (y < -1 || y > v.ph + 1) continue;
      ctx.globalAlpha = k % 8 === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(v.pw, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = d.opts.diagColor || '#2962ff';
    let seg = U.clipLine(cx, cy, cx + w * 40, cy + h * 40, v.pw, v.ph);
    if (seg) { ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke(); }
    ctx.strokeStyle = d.opts.diag2Color || '#f23645';
    seg = U.clipLine(cx, cy + h, cx + w * 40, cy + h - h * 40, v.pw, v.ph);
    if (seg) { ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke(); }
    ctx.restore();
  }
  TOOLS.gannsquare = {
    name: 'Gann Square', icon: 'gannsquare', pts: 2,
    draw(v, d) {
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      gannSquareDraw(v, d, xL, yT, xR - xL, yB - yT);
      gannBoxDraw(v, d, xL, yT, xR, yB);
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
        const x0 = Math.min(xL, xR), x1 = Math.max(xL, xR), y0 = Math.min(yT, yB), y1 = Math.max(yT, yB);
        if (x >= x0 - 5 && x <= x1 + 5 && y >= y0 - 5 && y <= y1 + 5) return true;
        return U.distSeg(x, y, xL, yT, xL + (xR - xL) * 40, yT + (yB - yT) * 40) < 5 ||
               U.distSeg(x, y, xL, yB, xL + (xR - xL) * 40, yB - (yB - yT) * 40) < 5;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };
  TOOLS.gannsquaref = {
    name: 'Gann Square Fixed', icon: 'gannsquaref', pts: 2,
    draw(v, d) {
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT);
      const w = Math.max(8, xR - xL);
      gannSquareDraw(v, d, xL, yT, w, w);
      gannBoxDraw(v, d, xL, yT, xL + w, yT + w);
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT);
        const w = Math.max(8, Math.abs(xR - xL));
        return x >= xL - 4 && x <= xL + w + 4 && y >= yT - 4 && y <= yT + w + 4;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  const GANN_RATIOS = [[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]];
  TOOLS.gannfan = {
    name: 'Gann Fan', icon: 'gannfan', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const O = ptXY(v, d.points[0]);
      const P1 = ptXY(v, d.points[1]);
      const dL = U.timeToLogical(v.times, d.points[1].t) - U.timeToLogical(v.times, d.points[0].t);
      const dP = d.points[1].p - d.points[0].p;
      ctx.save();
      ctx.font = '10px "Segoe UI", Arial, sans-serif';
      ctx.lineWidth = d.opts.width || 1;
      for (const [a, b] of GANN_RATIOS) {
        const isMain = a === 1 && b === 1;
        /* a price units per b bars, in px space */
        const l2 = U.timeToLogical(v.times, d.points[0].t) + dL * b * 4000;
        const t2 = U.logicalToTime(v.times, l2);
        const p2 = d.points[0].p + dP * a * 4000;
        const E = [v.xOf(t2), v.yOf(p2)];
        ctx.strokeStyle = isMain ? '#2962ff' : 'rgba(120,123,134,.7)';
        ctx.lineWidth = isMain ? (d.opts.width || 1) + 0.4 : (d.opts.width || 1);
        ctx.setLineDash([]);
        const seg = U.clipLine(O[0], O[1], E[0], E[1], v.pw, v.ph);
        if (seg) { ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke(); }
        if (d.opts.showLabels !== false) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillText(`${a}x${b}`, (seg ? seg[2] : E[0]) - 22, (seg ? seg[3] : E[1]) - 3);
        }
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const O = ptXY(v, d.points[0]);
        const dL = U.timeToLogical(v.times, d.points[1].t) - U.timeToLogical(v.times, d.points[0].t);
        const dP = d.points[1].p - d.points[0].p;
        for (const [a, b] of GANN_RATIOS) {
          const t2 = U.logicalToTime(v.times, U.timeToLogical(v.times, d.points[0].t) + dL * b * 4000);
          const E = [v.xOf(t2), v.yOf(d.points[0].p + dP * a * 4000)];
          if (U.distSeg(x, y, O[0], O[1], E[0], E[1]) < 5) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- ROUND 58: TV Fibonacci flyout additions ----------------
     Researched from TradingView behaviour:
     - Fib Time Zone: two anchors set one time unit; full-height vertical
       lines at Fibonacci-number multiples (0,1,2,3,5,8,13,21,...) of it.
     - Fib Speed Resistance Fan: the A->B trend line is the 1:1 base; rays
       from A whose slope = coefficient x trend slope, mirrored on both
       sides of the base (level 1 = the trend line itself).
     - Trend-Based Fib Time: trend A->B + anchor C; full-height vertical
       lines at tC + coefficient x (tB - tA); the defining trend is drawn.
     - Fib Spiral: golden logarithmic spiral centred on A — radius grows by
       the coefficient (phi by default) every quarter turn; starting radius
       and angle come from the A->B line; the trend line is drawn too.
     - Fib Speed Resistance Arcs: elliptical arcs centred on A with radii =
       coefficient x the A->B deltas, spanning the B-facing semicircle
       (full ellipses with the Fullscreen option, like TV).
     - Fib Wedge: the A-B-C triangle with parallel fib lines drawn inside
       from each side toward the opposite vertex (sides = levels 0 and 1).
     - Pitchfan: all rays emanate from the middle handle B — to A, to C and
       the fib-level rays interpolated between those two directions. */
  const FIB_TZ_LEVELS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
  function vLineFib(v, d, x, label) {
    const ctx = v.ctx;
    if (x < -2 || x > v.pw + 2) return;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.ph); ctx.stroke();
    if (d.opts.showRatio && label) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '10px "Segoe UI", Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(label, Math.min(Math.max(x + 3, 4), v.pw - 26), 4);
    }
  }
  TOOLS.fibtz = {
    name: 'Fib Time Zone', icon: 'fibtz', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const t1 = d.points[0].t, t2 = d.points[1].t;
      const dt = Math.abs(t2 - t1) || 1;
      const sgn = t2 >= t1 ? 1 : -1;
      ctx.save();
      ctx.lineWidth = 1;
      for (const lv of levelsOfF(d, FIB_TZ_LEVELS)) {
        if (lv.on === false) continue;
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        vLineFib(v, d, v.xOf(t1 + sgn * dt * lv.r), String(lv.r));
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const t1 = d.points[0].t, t2 = d.points[1].t;
        const dt = Math.abs(t2 - t1) || 1;
        const sgn = t2 >= t1 ? 1 : -1;
        for (const lv of levelsOfF(d, FIB_TZ_LEVELS)) {
          if (lv.on === false) continue;
          if (Math.abs(x - v.xOf(t1 + sgn * dt * lv.r)) < 4) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ROUND245 (TV parity — official support doc): a speed fan is rays from the
     FIRST extreme through an invisible vertical at the second extreme, at
     time/price percentages (thirds + fib ratios). The old code scaled the
     slope by k and mirrored every ray — neither exists on TV. levelsOfF keeps
     every line user-customizable per drawing. */
  const FIBFAN_LEVELS = [0, 1 / 3, 0.382, 0.5, 0.618, 2 / 3, 1];
  function speedFanRay(v, a, b, k) {
    /* ray from A through the k-point of the invisible vertical at B.x */
    const ex = b[0], ey = a[1] + (b[1] - a[1]) * k;
    const dx = ex - a[0], dy = ey - a[1];
    return U.clipLine(a[0], a[1], a[0] + dx * 4000, a[1] + dy * 4000, v.pw, v.ph);
  }
  TOOLS.fibspeedfan = {
    name: 'Fib Speed Resistance Fan', icon: 'fibspeedfan', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = polyPts(v, d);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.font = '10px "Segoe UI", Arial, sans-serif';
      for (const lv of levelsOfF(d, FIBFAN_LEVELS)) {
        if (lv.on === false) continue;
        const seg = speedFanRay(v, a, b, lv.r);
        if (!seg) continue;
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke();
        if (d.opts.showRatio !== false) {
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
        const [a, b] = polyPts(v, d);
        for (const lv of levelsOfF(d, FIBFAN_LEVELS)) {
          if (lv.on === false) continue;
          const seg = speedFanRay(v, a, b, lv.r);
          if (seg && U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < 5) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.fibttime = {
    name: 'Trend-Based Fib Time', icon: 'fibttime', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const P = polyPts(v, d);
      const dtT = d.points[1].t - d.points[0].t;
      ctx.save();
      ctx.lineWidth = 1;
      /* the defining trend A->B (subtle, like TV — visibility toggle) */
      if (d.opts.showTrend !== false) {
        applyStroke(ctx, d);
        ctx.save();
        ctx.globalAlpha *= 0.6;
        ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
        ctx.restore();
      }
      for (const lv of levelsOfF(d, [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618])) {
        if (lv.on === false) continue;
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        vLineFib(v, d, v.xOf(d.points[2].t + dtT * lv.r), lv.r.toFixed(3));
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const P = polyPts(v, d);
        const dtT = d.points[1].t - d.points[0].t;
        for (const lv of levelsOfF(d, [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618])) {
          if (lv.on === false) continue;
          if (Math.abs(x - v.xOf(d.points[2].t + dtT * lv.r)) < 4) return true;
        }
        return distToPath(x, y, [P[0], P[1]], 6);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.fibspiral = {
    name: 'Fib Spiral', icon: 'fibspiral', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = polyPts(v, d);
      const r0 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (r0 < 0.5) return;
      const th0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const k = isFinite(d.opts.coeff) ? Math.max(1.01, d.opts.coeff) : 1.6180339887;
      const turns = isFinite(d.opts.turns) ? U.clamp(d.opts.turns, 1, 8) : 3;
      const grow = Math.log(k) / (Math.PI / 2);
      ctx.save();
      applyStroke(ctx, d);
      if (d.opts.showTrend !== false) {
        ctx.save();
        ctx.globalAlpha *= 0.65;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.restore();
      }
      const STEPS = Math.min(1440, Math.max(48, turns * 96));
      ctx.beginPath();
      for (let i = 0; i <= STEPS; i++) {
        const th = (i / STEPS) * turns * Math.PI * 2;
        const r = r0 * Math.exp(grow * th);
        const x = a[0] + Math.cos(th0 + th) * r;
        const y = a[1] + Math.sin(th0 + th) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b] = polyPts(v, d);
        return U.distSeg(x, y, a[0], a[1], b[0], b[1]) < 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.fibarcs = {
    name: 'Fib Speed Resistance Arcs', icon: 'fibarcs', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = polyPts(v, d);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      /* ellipse-parameter angle of the B-facing direction (k-invariant) */
      const phiB = Math.atan2(Math.sign(dy) || 1, Math.sign(dx) || 1);
      const full = d.opts.fullscreen === true;
      ctx.save();
      /* the defining trend A->B (subtle, like TV — visibility toggle) */
      if (d.opts.showTrend !== false) {
        applyStroke(ctx, d);
        ctx.save();
        ctx.globalAlpha *= 0.6;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.restore();
      }
      ctx.lineWidth = 1;
      for (const lv of levelsOfF(d, [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618])) {
        if (lv.on === false) continue;
        const k = lv.r;
        const rx = Math.max(0.5, Math.abs(dx) * k), ry = Math.max(0.5, Math.abs(dy) * k);
        ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
        ctx.setLineDash([]);
        ctx.beginPath();
        if (full) ctx.ellipse(a[0], a[1], rx, ry, 0, 0, Math.PI * 2);
        else ctx.ellipse(a[0], a[1], rx, ry, 0, phiB - Math.PI / 2, phiB + Math.PI / 2);
        ctx.stroke();
        if (d.opts.showRatio !== false) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.font = '10px "Segoe UI", Arial, sans-serif';
          ctx.textBaseline = 'bottom';
          const lx = a[0] + Math.cos(phiB) * rx, ly = a[1] + Math.sin(phiB) * ry;
          ctx.fillText(k.toFixed(3), Math.min(Math.max(lx + 3, 4), v.pw - 36), Math.min(Math.max(ly - 2, 12), v.ph - 4));
        }
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b] = polyPts(v, d);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        for (const lv of levelsOfF(d, [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618])) {
          if (lv.on === false) continue;
          const k = lv.r;
          const ex = Math.abs(dx) || 1, ey = Math.abs(dy) || 1;
          const nx = (x - a[0]) / (ex * k), ny = (y - a[1]) / (ey * k);
          if (Math.abs(Math.hypot(nx, ny) - 1) < 0.05) return true;
        }
        return U.distSeg(x, y, a[0], a[1], b[0], b[1]) < 5;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.fibwedge = {
    name: 'Fib Wedge', icon: 'fibwedge', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const P = polyPts(v, d);
      ctx.save();
      /* ROUND256 (TV parity): Background fills the wedge triangle. */
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[2][0], P[2][1]);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      /* the A-B-C triangle */
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[2][0], P[2][1]); ctx.closePath();
      ctx.stroke();
      /* parallel fib lines from each side toward the opposite vertex */
      ctx.lineWidth = 1;
      for (let s = 0; s < 3; s++) {
        const A = P[s], B = P[(s + 1) % 3], C = P[(s + 2) % 3];
        for (const lv of levelsOfF(d, [0.382, 0.5, 0.618])) {
          if (lv.on === false) continue;
          const f = U.clamp(lv.r, 0, 1);
          if (f <= 0.005 || f >= 0.995) continue; // sides already drawn
          ctx.strokeStyle = lv.c || d.opts.color || '#2962ff';
          ctx.setLineDash(U.dashFor(d.opts.style || 'solid', 1));
          ctx.beginPath();
          ctx.moveTo(A[0] + (C[0] - A[0]) * f, A[1] + (C[1] - A[1]) * f);
          ctx.lineTo(B[0] + (C[0] - B[0]) * f, B[1] + (C[1] - B[1]) * f);
          ctx.stroke();
        }
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const P = polyPts(v, d);
        return distToPath(x, y, [P[0], P[1], P[2], P[0]], 6);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

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
        return U.distSeg(x, y, a[0], a[1], b[0], b[1]) < 6 ||
               U.distSeg(x, y, c[0], c[1], b[0], b[1]) < 6 ||
               U.distSeg(x, y, a[0], a[1], c[0], c[1]) < 6;
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
      ctx.fillStyle = d.opts.fillColor || d.opts.color || '#2962ff';
      ctx.globalAlpha = typeof d.opts.fillOpacity === 'number' ? d.opts.fillOpacity : 0.9;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6); else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.globalAlpha = 1;
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
      ctx.fillStyle = d.opts.fillColor || d.opts.color || '#2962ff';
      ctx.beginPath();
      ctx.moveTo(x, y - s / 2); ctx.lineTo(x + s * 0.8, y - s / 4); ctx.lineTo(x, y);
      ctx.closePath(); ctx.fill();
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
  function TH(k, fallback) { return (Theme.c) ? Theme.c(k) : fallback; }

  /* ---------------- Regression Trend ---------------- */
  function regress(bars, times, t0, t1, src) {
    /* LSQ over the chosen source (TV Source row; default close) */
    const yOf = src === 'hlc3' ? (b) => (b.high + b.low + b.close) / 3
      : src === 'hl2' ? (b) => (b.high + b.low) / 2
      : src === 'ohlc4' ? (b) => (b.open + b.high + b.low + b.close) / 4
      : (b) => b.close;
    const i0 = Math.max(0, Math.floor(U.timeToLogical(times, Math.min(t0, t1))));
    const i1 = Math.min(bars.length - 1, Math.ceil(U.timeToLogical(times, Math.max(t0, t1))));
    const n = i1 - i0 + 1;
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = i0; i <= i1; i++) {
      const x = i, y = yOf(bars[i]);
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (!denom) return null;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    let varSum = 0;
    for (let i = i0; i <= i1; i++) varSum += Math.pow(yOf(bars[i]) - (intercept + slope * i), 2);
    const sd = Math.sqrt(varSum / n);
    return { i0, i1, slope, intercept, sd };
  }
  /* ROUND247: painted spans shared by draw + hit — the base direction in
     pixels with true parallel bands (offset along the pixel normal). Extend
     runs the full viewport span (the old code clamped the index to the edge
     bars, drawing a stub). Fractional indexes ride logicalToTime, which
     extrapolates past the history by bar spacing. */
  function regressSegs(v, d) {
    const r = regress(v.bars, v.times, d.points[0].t, d.points[1].t, d.opts.source);
    if (!r) return null;
    const devs = Array.isArray(d.opts.devs) ? d.opts.devs : [1, 2, 3];
    /* ROUND255 (TV parity): upper/lower bands toggle independently (both on
       for existing drawings). */
    const upOn = d.opts.upShow !== false, dnOn = d.opts.downShow !== false;
    const extend = !!d.opts.extend;
    const Xf = (i) => v.xOf(U.logicalToTime(v.times, i));
    const Y = (i, k) => v.yOf(r.intercept + r.slope * i + k * r.sd);
    const A = [Xf(r.i0), Y(r.i0, 0)], B = [Xf(r.i1), Y(r.i1, 0)];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const sdPx = Math.abs(v.yOf(r.intercept) - v.yOf(r.intercept + r.sd));
    const T = (v.w + v.h) * 3;
    const band = (k) => {
      const ox = nx * k * sdPx, oy = ny * k * sdPx;
      const sx = extend ? A[0] + ox - ux * T : A[0] + ox;
      const sy = extend ? A[1] + oy - uy * T : A[1] + oy;
      const ex = extend ? B[0] + ox + ux * T : B[0] + ox;
      const ey = extend ? B[1] + oy + uy * T : B[1] + oy;
      return U.clipLine(sx, sy, ex, ey, v.pw, v.ph) || [sx, sy, ex, ey];
    };
    const segs = [{ k: 0, seg: band(0) }];
    for (const k of devs) {
      if (!isFinite(k) || k === 0) continue;
      if (upOn) segs.push({ k, seg: band(k) });
      if (dnOn) segs.push({ k: -k, seg: band(-k) });
    }
    const ks = segs.map((s) => s.k);
    return { segs, kmax: ks.length ? Math.max(...ks.map((k) => Math.abs(k))) : 0,
      up: upOn, dn: dnOn,
      upColor: d.opts.upColor || null, dnColor: d.opts.downColor || null };
  }
  TOOLS.regression = {
    name: 'Regression Trend', icon: 'regression', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const rs = regressSegs(v, d);
      if (!rs) return;
      ctx.save();
      applyStroke(ctx, d);
      /* round 52: TV Background fill between the OUTER deviation bands
         (default off — existing drawings render unchanged) */
      if (d.opts.fill && rs.kmax > 0) {
        const top = rs.segs.find((s) => s.k === rs.kmax), bot = rs.segs.find((s) => s.k === -rs.kmax);
        if (top && bot) {
          ctx.save();
          ctx.globalAlpha = fillAlphaOf(d);
          ctx.fillStyle = fillColorOf(d);
          ctx.beginPath();
          ctx.moveTo(top.seg[0], top.seg[1]); ctx.lineTo(top.seg[2], top.seg[3]);
          ctx.lineTo(bot.seg[2], bot.seg[3]); ctx.lineTo(bot.seg[0], bot.seg[1]);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
      for (const { k, seg } of rs.segs) {
        if (k !== 0) {
          /* ROUND255 (TV parity): upper/lower bands carry their own colors
             (fall back to the base line when unset). */
          ctx.globalAlpha = 0.65;
          ctx.lineWidth = 1;
          ctx.strokeStyle = (k > 0 ? (rs.upColor || d.opts.color) : (rs.dnColor || d.opts.color)) || '#2962ff';
        }
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
        if (k !== 0) {
          ctx.globalAlpha = 1;
          applyStroke(ctx, d);
        }
      }
      ctx.restore();
      drawAnnotation(v, d, v.xOf(d.points[0].t), v.yOf(d.points[0].p) - 16);
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        /* ROUND247: every painted band is grabbable (the old test only knew
           the anchor segment). */
        const rs = regressSegs(v, d);
        if (!rs) return false;
        const m = Math.max(6, 3 + (d.opts.width || 2));
        for (const { seg } of rs.segs) {
          if (U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < m) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Volume Profile (fixed range) — ROUND 62: TV name ---------------- */
  TOOLS.volprofile = {
    name: 'Fixed range volume profile', icon: 'fixedvp', pts: 2,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 4) return;
      const ctx = v.ctx;
      const i0 = Math.max(0, Math.floor(U.timeToLogical(v.times, Math.min(d.points[0].t, d.points[1].t))));
      const i1 = Math.min(bars.length - 1, Math.ceil(U.timeToLogical(v.times, Math.max(d.points[0].t, d.points[1].t))));
      if (i1 - i0 < 2) return;
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high);
      }
      if (!(hi > lo)) return;
      const NB = d.opts.bins || 24;
      const step = (hi - lo) / NB;
      const bins = new Array(NB).fill(0);
      let maxV = 0, totV = 0;
      for (let i = i0; i <= i1; i++) {
        const b = bars[i];
        const vol = (b.volume != null && b.volume > 0) ? b.volume : 1; // fallback: bar count weight
        const mid = (b.high + b.low) / 2;
        const bi = U.clamp(Math.floor((mid - lo) / step), 0, NB - 1);
        bins[bi] += vol; totV += vol;
        maxV = Math.max(maxV, bins[bi]);
      }
      if (!maxV) return;
      // POC + Value Area (70%)
      let poc = 0;
      for (let i = 1; i < NB; i++) if (bins[i] > bins[poc]) poc = i;
      let acc = bins[poc], a = poc, b2 = poc;
      while (acc < totV * 0.7 && (a > 0 || b2 < NB - 1)) {
        const va = a > 0 ? bins[a - 1] : -1;
        const vb = b2 < NB - 1 ? bins[b2 + 1] : -1;
        if (vb >= va) { b2++; acc += Math.max(0, vb); } else { a--; acc += Math.max(0, va); }
      }
      const yOf = (p) => v.yOf(p);
      const x0 = v.xOf(d.points[0].t), x1 = v.xOf(d.points[1].t);
      const baseX = Math.min(x0, x1);
      const maxW = Math.max(30, Math.abs(x1 - x0) * 0.5);
      ctx.save();
      for (let i = 0; i < NB; i++) {
        if (!bins[i]) continue;
        const y1 = yOf(lo + i * step), y2 = yOf(lo + (i + 1) * step);
        const w = (bins[i] / maxV) * maxW;
        ctx.globalAlpha = i >= a && i <= b2 ? 0.55 : 0.3;
        ctx.fillStyle = bins[i] === bins[poc] ? '#f7c948' : '#2962ff';
        ctx.fillRect(baseX, Math.min(y1, y2), w, Math.max(1, Math.abs(y2 - y1) - 1));
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      chipLabel(ctx, baseX + 24, yOf(lo + (poc + 0.5) * step), `POC ${U.fmtPrice(lo + (poc + 0.5) * step, v.digits)}`, 'rgba(24,28,39,.92)');
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
        return x >= Math.min(xL, xR) - 5 && x <= Math.max(xL, xR) + 5 &&
               y >= Math.min(yT, yB) - 5 && y <= Math.max(yT, yB) + 5;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ================= ROUND 62: TV Forecasting & Measurement additions =================
     Researched per tool (TV behaviour) and implemented on the same contract:
     - Position forecast  (2 pts): entry A -> forecast target B; stop derived
       from the Risk/Reward coefficient; profit/loss boxes + % chips.
     - Bars pattern       (3 pts): the REAL close path of the bars between
       anchors A..B is copied and projected from anchor C (Mirror setting).
     - Ghost feed         (1 pt) : projects N translucent continuation candles
       from the anchor using the LSQ slope + average range of recent bars.
     - Sector             (3 pts): circular sector around anchor A; B sets
       radius + start angle, C the end angle (pixel-space wedge, TV look).
     - Anchored VWAP      (1 pt) : cumulative hlc3 VWAP from the anchor bar to
       the newest bar, recalculated every frame (works on live ticks).
     - Anchored volume profile (1 pt): the fixed-range histogram, anchored at
       one point and extending to the latest bar.
     - Price range / Date range / Date and price range (2 pts each): TV
       measurers — delta chips for price (+%), time span (+ bars) or both. */

  /* ---------------- Position forecast ---------------- */
  TOOLS.posforecast = {
    name: 'Position forecast', icon: 'posforecast', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = d.points;
      const rr = Number(d.opts.coeff) > 0 ? Number(d.opts.coeff) : 2;
      const dp = b.p - a.p;
      const stop = a.p - dp / rr;
      const x0 = v.xOf(a.t), x1 = v.xOf(b.t);
      const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
      const yA = v.yOf(a.p), yB = v.yOf(b.p), yS = v.yOf(stop);
      const win = dp >= 0 ? '#089981' : '#f23645';
      const loss = dp >= 0 ? '#f23645' : '#089981';
      const box = (ya, yb, col) => {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d) === d.opts.color ? col : fillColorOf(d);
        ctx.fillRect(xa, Math.min(ya, yb), Math.max(1, xb - xa), Math.abs(yb - ya));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.strokeRect(xa, Math.min(ya, yb), Math.max(1, xb - xa), Math.abs(yb - ya));
        ctx.restore();
      };
      box(yA, yB, win);
      box(yA, yS, loss);
      const pct = (dp / a.p) * 100, pctS = ((stop - a.p) / a.p) * 100;
      chipLabel(ctx, (xa + xb) / 2, (yA + yB) / 2, `Target ${dp >= 0 ? '+' : ''}${pct.toFixed(2)}%`, 'rgba(8,153,129,.92)');
      chipLabel(ctx, (xa + xb) / 2, (yA + yS) / 2, `Stop ${pctS.toFixed(2)}%`, 'rgba(242,54,69,.92)');
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b] = d.points;
        const rr = Number(d.opts.coeff) > 0 ? Number(d.opts.coeff) : 2;
        const stop = a.p - (b.p - a.p) / rr;
        const xa = Math.min(v.xOf(a.t), v.xOf(b.t)), xb = Math.max(v.xOf(a.t), v.xOf(b.t));
        const ys = [v.yOf(a.p), v.yOf(b.p), v.yOf(stop)];
        return x >= xa - 5 && x <= xb + 5 && y >= Math.min(...ys) - 5 && y <= Math.max(...ys) + 5;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Bars pattern ---------------- */
  TOOLS.barspattern = {
    name: 'Bars pattern', icon: 'barspattern', pts: 3,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 4) return;
      const ctx = v.ctx;
      const [A, B, C] = d.points;
      const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, Math.min(A.t, B.t))));
      const i1 = Math.min(bars.length - 1, Math.round(U.timeToLogical(v.times, Math.max(A.t, B.t))));
      if (i1 - i0 < 1) return;
      const src = [];
      for (let i = i0; i <= i1; i++) src.push(bars[i].close);
      if (d.opts.mirror) src.reverse();
      const sp = (v.spacing > 0 ? v.spacing : 8);
      const xC = v.xOf(C.t), yC = v.yOf(C.p), base = src[0];
      const P = src.map((c, k) => [xC + k * sp, yC + (v.yOf(C.p + (c - base)) - yC)]);
      ctx.save();
      if (d.opts.fill) {
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]);
        for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
        ctx.lineTo(P[P.length - 1][0], yC); ctx.lineTo(P[0][0], yC);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      }
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
      ctx.stroke();
      ctx.restore();
      chipLabel(ctx, P[0][0], P[0][1] - 14, `${src.length} bars${d.opts.mirror ? ' · mirrored' : ''}`, 'rgba(24,28,39,.92)');
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => distToPath(x, y, polyPts(v, d), 8);
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Ghost feed ---------------- */
  TOOLS.ghostfeed = {
    name: 'Ghost feed', icon: 'ghostfeed', pts: 1,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 10) return;
      const ctx = v.ctx;
      const N = U.clamp(Math.round(d.opts.bars || 20), 1, 300);
      const look = Math.min(bars.length, 20);
      const s0 = bars.length - look;
      let sx = 0, sy = 0, sxx = 0, sxy = 0, rng = 0;
      for (let i = s0; i < bars.length; i++) {
        const y = bars[i].close;
        sx += i; sy += y; sxx += i * i; sxy += i * y;
        rng += bars[i].high - bars[i].low;
      }
      const den = look * sxx - sx * sx;
      const slope = den ? (look * sxy - sx * sy) / den : 0;
      const avgR = rng / look || 0;
      const x0 = v.xOf(d.points[0].t);
      const sp = (v.spacing > 0 ? v.spacing : 8);
      const w = Math.max(1.5, sp * 0.62);
      let open = d.points[0].p;
      ctx.save();
      ctx.globalAlpha = 0.5;
      for (let k = 0; k < N; k++) {
        const close = open + slope;
        const hi = Math.max(open, close) + avgR * 0.35;
        const lo = Math.min(open, close) - avgR * 0.35;
        const x = x0 + k * sp;
        const yO = v.yOf(open), yC = v.yOf(close), yH = v.yOf(hi), yL = v.yOf(lo);
        ctx.strokeStyle = ctx.fillStyle = close >= open ? '#089981' : '#f23645';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
        ctx.fillRect(x - w / 2, Math.min(yO, yC), w, Math.max(1, Math.abs(yC - yO)));
        open = close;
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [px, py] = ptXY(v, d.points[0]);
        const sp = (v.spacing > 0 ? v.spacing : 8);
        const N = U.clamp(Math.round(d.opts.bars || 20), 1, 300);
        return x > px - 6 && x < px + N * sp + 6 && Math.abs(y - py) < 80;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Sector ---------------- */
  TOOLS.sector = {
    name: 'Sector', icon: 'sector', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const [A, B, C] = polyPts(v, d);
      const r = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (!(r > 2)) return;
      let a0 = Math.atan2(B[1] - A[1], B[0] - A[0]);
      let a1 = Math.atan2(C[1] - A[1], C[0] - A[0]);
      let sweep = a1 - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(A[0], A[1]);
      ctx.arc(A[0], A[1], r, a0, a0 + sweep, sweep < 0);
      ctx.closePath();
      ctx.globalAlpha = fillAlphaOf(d);
      ctx.fillStyle = fillColorOf(d);
      ctx.fill();
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.stroke();
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [A, B, C] = polyPts(v, d);
        const r = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const dx = x - A[0], dy = y - A[1];
        const rr = Math.hypot(dx, dy);
        if (rr > r + 5) return false;
        if (rr < Math.max(2, r - 5)) {
          /* inside the pie: also accept when between the two radii */
        }
        const a = Math.atan2(dy, dx);
        let a0 = Math.atan2(B[1] - A[1], B[0] - A[0]);
        let sweep = Math.atan2(C[1] - A[1], C[0] - A[0]) - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        let rel = a - a0;
        while (rel > Math.PI) rel -= 2 * Math.PI;
        while (rel < -Math.PI) rel += 2 * Math.PI;
        const lo = Math.min(0, sweep), hi = Math.max(0, sweep);
        return rel >= lo - 0.05 && rel <= hi + 0.05;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Anchored VWAP ---------------- */
  /* ROUND246: hit-testing rides the PAINTED line — the old code measured the
     single anchor point (distToPath over one point is always false), so the
     line was grabbable only by its handle. The painted polyline is cached per
     drawing (WeakMap: dies with the drawing, never persisted) and downsampled
     so hover stays cheap on deep histories. */
  const _vwapLines = new WeakMap();
  function _vwapDown(P) {
    if (P.length <= 600) return P;
    const stride = Math.ceil(P.length / 600), out = [];
    for (let i = 0; i < P.length; i += stride) out.push(P[i]);
    if (out[out.length - 1] !== P[P.length - 1]) out.push(P[P.length - 1]);
    return out;
  }
  TOOLS.avwap = {
    name: 'Anchored VWAP', icon: 'avwap', pts: 1,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 2) return;
      const ctx = v.ctx;
      const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, d.points[0].t)));
      if (i0 >= bars.length - 1) return;
      let pv = 0, vv = 0;
      const P = [];
      for (let i = i0; i < bars.length; i++) {
        const b = bars[i];
        const src = d.opts.source === 'close' ? b.close : (b.high + b.low + b.close) / 3;
        const vol = (b.volume != null && b.volume > 0) ? b.volume : 1;
        pv += src * vol; vv += vol;
        P.push([v.xOf(v.times[i]), v.yOf(pv / vv)]);
      }
      if (P.length < 2) return;
      _vwapLines.set(d, _vwapDown(P));
      ctx.save();
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
      ctx.stroke();
      ctx.restore();
      const last = P[P.length - 1];
      chipLabel(ctx, last[0] - 34, last[1] - 13, `VWAP ${U.fmtPrice(pv / vv, v.digits)}`, 'rgba(24,28,39,.92)');
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const line = _vwapLines.get(d);
        if (line && line.length > 1 && distToPath(x, y, line, Math.max(6, 3 + (d.opts.width || 2)))) return true;
        /* no painted line yet (or a 1-bar stub): the anchor is the fallback */
        const P = polyPts(v, d);
        return P.length === 1 && Math.hypot(x - P[0][0], y - P[0][1]) < 10;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Anchored volume profile ---------------- */
  TOOLS.avolprofile = {
    name: 'Anchored volume profile', icon: 'anchoredvp', pts: 1,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 4) return;
      const ctx = v.ctx;
      const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, d.points[0].t)));
      const i1 = bars.length - 1;
      if (i1 - i0 < 2) return;
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high);
      }
      if (!(hi > lo)) return;
      const NB = U.clamp(Math.round(d.opts.bins || 24), 6, 120);
      const step = (hi - lo) / NB;
      const bins = new Array(NB).fill(0);
      let maxV = 0, totV = 0;
      for (let i = i0; i <= i1; i++) {
        const b = bars[i];
        const vol = (b.volume != null && b.volume > 0) ? b.volume : 1;
        const mid = (b.high + b.low) / 2;
        const bi = U.clamp(Math.floor((mid - lo) / step), 0, NB - 1);
        bins[bi] += vol; totV += vol;
        maxV = Math.max(maxV, bins[bi]);
      }
      if (!maxV) return;
      let poc = 0;
      for (let i = 1; i < NB; i++) if (bins[i] > bins[poc]) poc = i;
      let acc = bins[poc], a = poc, b2 = poc;
      while (acc < totV * 0.7 && (a > 0 || b2 < NB - 1)) {
        const va = a > 0 ? bins[a - 1] : -1;
        const vb = b2 < NB - 1 ? bins[b2 + 1] : -1;
        if (vb >= va) { b2++; acc += Math.max(0, vb); } else { a--; acc += Math.max(0, va); }
      }
      const baseX = v.xOf(d.points[0].t);
      const maxW = Math.max(30, Math.min(240, (v.pw - baseX) * 0.5));
      ctx.save();
      for (let i = 0; i < NB; i++) {
        if (!bins[i]) continue;
        const y1 = v.yOf(lo + i * step), y2 = v.yOf(lo + (i + 1) * step);
        const w = (bins[i] / maxV) * maxW;
        ctx.globalAlpha = i >= a && i <= b2 ? 0.55 : 0.3;
        ctx.fillStyle = bins[i] === bins[poc] ? '#f7c948' : '#2962ff';
        ctx.fillRect(baseX, Math.min(y1, y2), w, Math.max(1, Math.abs(y2 - y1) - 1));
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      chipLabel(ctx, baseX + 24, v.yOf(lo + (poc + 0.5) * step), `POC ${U.fmtPrice(lo + (poc + 0.5) * step, v.digits)}`, 'rgba(24,28,39,.92)');
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [ax, ay] = ptXY(v, d.points[0]);
        return x > ax - 6 && x < ax + 260 && Math.abs(y - ay) < 140;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Measurers (TV) ---------------- */
  function measurerHit(v, d) {
    return (x, y) => {
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      return x >= Math.min(xL, xR) - 5 && x <= Math.max(xL, xR) + 5 &&
             y >= Math.min(yT, yB) - 5 && y <= Math.max(yT, yB) + 5;
    };
  }
  TOOLS.pricerange = {
    name: 'Price range', icon: 'pricerange', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d) * 0.8;
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.strokeRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.restore();
      if (d.opts.showLabel !== false) {
        const a = d.points[0], b = d.points[1];
        const dp = b.p - a.p;
        const pct = a.p ? (dp / a.p) * 100 : 0;
        const col = dp >= 0 ? '#089981' : '#f23645';
        chipLabel(ctx, (Math.min(xL, xR) + Math.max(xL, xR)) / 2, (yT + yB) / 2,
          `${dp >= 0 ? '+' : ''}${U.fmtPrice(dp, v.digits)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`, col);
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) { return measurerHit(v, d); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };
  TOOLS.daterange = {
    name: 'Date range', icon: 'daterange', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d) * 0.8;
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(Math.min(xL, xR), 0, Math.max(1, Math.abs(xR - xL)), v.ph);
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.strokeRect(Math.min(xL, xR), 0, Math.max(1, Math.abs(xR - xL)), v.ph);
      ctx.restore();
      if (d.opts.showLabel !== false) {
        const bars = Math.round(Math.abs(U.timeToLogical(v.times, d.points[1].t) - U.timeToLogical(v.times, d.points[0].t)));
        const dur = U.durHuman(Math.abs(d.points[1].t - d.points[0].t));
        chipLabel(ctx, (Math.min(xL, xR) + Math.max(xL, xR)) / 2, v.ph / 2,
          `${bars} bars · ${dur}`, TH('chipBg', 'rgba(24,28,39,.94)'));
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) { return measurerHit(v, d); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };
  TOOLS.datepricerange = {
    name: 'Date and price range', icon: 'datepricerange', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d) * 0.8;
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.strokeRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.restore();
      if (d.opts.showLabel !== false) {
        const a = d.points[0], b = d.points[1];
        const dp = b.p - a.p;
        const pct = a.p ? (dp / a.p) * 100 : 0;
        const bars = Math.round(Math.abs(U.timeToLogical(v.times, b.t) - U.timeToLogical(v.times, a.t)));
        const dur = U.durHuman(Math.abs(b.t - a.t));
        chipLabel(ctx, (Math.min(xL, xR) + Math.max(xL, xR)) / 2, (yT + yB) / 2,
          `${dp >= 0 ? '+' : ''}${U.fmtPrice(dp, v.digits)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ·  ${bars} bars · ${dur}`,
          TH('chipBg', 'rgba(24,28,39,.94)'));
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) { return measurerHit(v, d); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Poly-line patterns (Elliott + harmonics) ---------------- */
  function polyDraw(v, d, labels, ratios) {
    const ctx = v.ctx;
    const P = polyPts(v, d);
    applyStroke(ctx, d);
    ctx.beginPath();
    P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.save();
    ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = d.opts.color || '#2962ff';
    ctx.textAlign = 'center';
    labels.forEach((lab, i) => {
      if (!P[i]) return;
      ctx.fillText(lab, P[i][0], P[i][1] - 8);
    });
    if (ratios && d.opts.showRatio) {
      ctx.font = '9.5px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = 'rgba(120,123,134,.9)';
      /* ROUND244 (TV parity): leg ratios are PRICE retracements (|dp| ratios
         in data space) — the old pixel hypot changed with every zoom/scroll.
         Positions still come from the pixel polyline. */
      for (let i = 1; i < P.length - 1; i++) {
        const q0 = d.points[i - 1], q1 = d.points[i], q2 = d.points[i + 1];
        if (!q0 || !q1 || !q2) continue;
        const leg0 = Math.abs(q1.p - q0.p), leg1 = Math.abs(q2.p - q1.p);
        if (leg0 > 0) ctx.fillText((leg1 / leg0).toFixed(2), P[i][0], P[i][1] + 14);
      }
    }
    ctx.restore();
  }
  function polyTool(id, name, icon, pts, labels, ratios) {
    TOOLS[id] = {
      name, icon, pts,
      draw(v, d) {
        polyDraw(v, d, labels, ratios);
        const pp = polyPts(v, d)[0];
        drawAnnotation(v, d, pp[0], pp[1], { x0: pp[0], x1: pp[0], y0: pp[1], y1: pp[1] });
      },
      handles(v, d) { return polyPts(v, d); },
      hitBody(v, d) { return (x, y) => distToPath(x, y, polyPts(v, d), Math.max(6, 3 + (d.opts.width || 2))); },
      dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
    };
  }
  /* ROUND 61: names now match the TradingView flyout text EXACTLY
     (ids/engines/labels/ratios untouched)
     ROUND244 (TV parity): every Elliott tool was one anchor short — the last
     label never had a point (impulse drew 0-4, never 5). pts now equals the
     label count, like every TV Elliott degree. */
  polyTool('elliott_i', 'Elliott impulse wave (1-2-3-4-5)', 'elliott_i', 6, ['0', '1', '2', '3', '4', '5'], true);
  polyTool('elliott_c', 'Elliott correction wave (A-B-C)', 'elliott_c', 4, ['0', 'A', 'B', 'C'], true);
  polyTool('elliott_t', 'Elliott triangle wave (A-B-C-D-E)', 'elliott_t', 6, ['0', 'A', 'B', 'C', 'D', 'E'], true);
  polyTool('elliott_wxy', 'Elliott double combo wave (W-X-Y)', 'elliott_wxy', 4, ['0', 'W', 'X', 'Y'], true);
  polyTool('elliott_wxyxz', 'Elliott triple combo wave (W-X-Y-Z)', 'elliott_wxyxz', 6, ['0', 'W', 'X', 'Y', 'X', 'Z'], true);
  polyTool('xabcd', 'XABCD pattern', 'xabcd', 5, ['X', 'A', 'B', 'C', 'D'], true);
  polyTool('abcd', 'ABCD pattern', 'abcd', 4, ['A', 'B', 'C', 'D'], true);
  polyTool('cypher', 'Cypher pattern', 'cypher', 5, ['X', 'A', 'B', 'C', 'D'], true);
  polyTool('trianglepat', 'Triangle pattern', 'trianglepat', 3, ['A', 'B', 'C'], false);
  polyTool('threedrives', 'Three drives pattern', 'threedrives', 6, ['1', '2', '3', '4', '5', '6'], true);
  polyTool('hs', 'Head and shoulders', 'hs', 7, ['', 'LS', 'LT', 'H', 'RT', 'RS', ''], false);

  /* ---------------- ROUND 61: CYCLES (TV flyout, third section) ----------------
     Research summary (TV behaviour):
     - Cyclic lines: TWO anchors set the cycle length (t2 - t1); vertical
       lines then repeat at that interval. Settings: Line, Coeff (interval
       multiplier), Cycles (how many lines), Extend left/right.
     - Time cycles: THREE anchors — boundary lines at anchors 1 and 3, a
       middle line at anchor 2; the whole cycle then repeats to the right
       (and left on demand). Settings: Line, Cycles (repetitions).
     - Sine line: TWO anchors — the wave starts at anchor 1, anchor 2 sets
       the period (time) and the amplitude (price delta); the wave rides on
       the A->B trend line and repeats. Settings: Line, Coeff (cycles per
       A->B span), Trend line on/off, Extend. */
  TOOLS.cycliclines = {
    name: 'Cyclic lines', icon: 'cycliclines', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const t1 = d.points[0].t, t2 = d.points[1].t;
      const coeff = isFinite(d.opts.coeff) ? Math.max(0.05, d.opts.coeff) : 1;
      const dt = Math.abs(t2 - t1) * coeff || 1;
      const sgn = t2 >= t1 ? 1 : -1;
      const n = isFinite(d.opts.cycles) ? U.clamp(Math.round(d.opts.cycles), 1, 500) : 12;
      ctx.save();
      ctx.lineWidth = 1;
      /* the defining anchors A->B (subtle connector, like TV) */
      const P = polyPts(v, d);
      applyStroke(ctx, d);
      ctx.save(); ctx.globalAlpha *= 0.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      ctx.restore();
      /* ROUND245: ONE family — the old extendRight branch re-drew the base
         lines one period over (exact duplicates under the default
         extendRight:true). Extends continue the same family past the base. */
      const kMin = d.opts.extendLeft ? -n : 0;
      const kMax = d.opts.extendRight ? 2 * n : n;
      for (let k = kMin; k < kMax; k++) {
        vLineFib(v, d, v.xOf(t1 + sgn * dt * k), null);
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const t1 = d.points[0].t, t2 = d.points[1].t;
        const coeff = isFinite(d.opts.coeff) ? Math.max(0.05, d.opts.coeff) : 1;
        const dt = Math.abs(t2 - t1) * coeff || 1;
        const sgn = t2 >= t1 ? 1 : -1;
        const n = isFinite(d.opts.cycles) ? U.clamp(Math.round(d.opts.cycles), 1, 500) : 12;
        const kMin = d.opts.extendLeft ? -n : 0;
        const kMax = d.opts.extendRight ? 2 * n : n;
        for (let k = kMin; k < kMax; k++) {
          if (Math.abs(x - v.xOf(t1 + sgn * dt * k)) < 4) return true;
        }
        const P = polyPts(v, d);
        return distToPath(x, y, [P[0], P[1]], 6);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  TOOLS.timecycles = {
    name: 'Time cycles', icon: 'timecycles', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const [A, B, C] = d.points;
      const per = C.t - A.t || 1;
      const mid = B.t - A.t;
      const n = isFinite(d.opts.cycles) ? U.clamp(Math.round(d.opts.cycles), 1, 200) : 5;
      ctx.save();
      ctx.lineWidth = 1;
      const seen = {};
      for (let k = 0; k < n; k++) {
        const ts = [A.t + per * k, A.t + mid + per * k, A.t + per * (k + 1)];
        for (const t of ts) {
          const key = Math.round(t);
          if (seen[key]) continue;
          seen[key] = 1;
          vLineFib(v, d, v.xOf(t), null);
        }
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [A, B, C] = d.points;
        const per = C.t - A.t || 1;
        const mid = B.t - A.t;
        const n = isFinite(d.opts.cycles) ? U.clamp(Math.round(d.opts.cycles), 1, 200) : 5;
        for (let k = 0; k < n; k++) {
          for (const t of [A.t + per * k, A.t + mid + per * k, A.t + per * (k + 1)]) {
            if (Math.abs(x - v.xOf(t)) < 4) return true;
          }
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ROUND245: data-space sine parameters shared by draw + hit — amplitude is
     the A->B price delta and the period is seconds-per-cycle, so zoom/scroll
     never reshape the wave (the old pixel version did). */
  function sineWave(v, d) {
    const A = d.points[0], B = d.points[1];
    const coeff = isFinite(d.opts.coeff) ? Math.max(0.1, d.opts.coeff) : 1;
    let amp = Math.abs(B.p - A.p);
    if (!(amp > 0)) {
      const pT = v.pOf(0), pB = v.pOf(v.ph);
      amp = (isFinite(pT) && isFinite(pB)) ? Math.abs(pT - pB) / 8 : 0;
    }
    const spanT = (B.t - A.t) || 1;
    return { A, B, amp, periodT: spanT / coeff, slopeP: (B.p - A.p) / spanT };
  }
  function sinePrice(w, t) {
    return w.A.p + w.slopeP * (t - w.A.t) + w.amp * Math.sin(((t - w.A.t) / w.periodT) * Math.PI * 2);
  }
  TOOLS.sineline = {
    name: 'Sine line', icon: 'sineline', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = polyPts(v, d);
      const w = sineWave(v, d);
      ctx.save();
      applyStroke(ctx, d);
      /* A->B trend line (subtle, like TV) */
      if (d.opts.showTrend !== false) {
        ctx.save(); ctx.globalAlpha *= 0.6;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.restore();
      }
      /* the wave rides the A->B trend in TIME — evaluated per bar-time so
         gaps never desync it (no more ±1e5px hack) */
      const ext = d.opts.extend || 'both';
      let t0 = w.A.t, t1 = w.B.t;
      const eL = v.tOf(0), eR = v.tOf(v.pw);
      if ((ext === 'left' || ext === 'both') && isFinite(eL)) t0 = Math.min(t0, eL);
      if ((ext === 'right' || ext === 'both') && isFinite(eR)) t1 = Math.max(t1, eR);
      if (!(t1 > t0)) { t0 = w.A.t; t1 = w.B.t; }
      const STEPS = 720;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= STEPS; i++) {
        const t = t0 + (i / STEPS) * (t1 - t0);
        const x = v.xOf(t), y = v.yOf(sinePrice(w, t));
        if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [a, b] = polyPts(v, d);
        if (U.distSeg(x, y, a[0], a[1], b[0], b[1]) < 6) return true;
        const w = sineWave(v, d);
        const t = v.tOf(x);
        if (!isFinite(t)) return false;
        const yy = v.yOf(sinePrice(w, t));
        return isFinite(yy) && Math.abs(y - yy) < 8;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- ROUND 69: TV SHAPES FLYOUT ADDITIONS ----------------
     Research summary (TradingView behaviour, per tool):
     - Arrow marker: ONE solid arrow glyph on the chart. Click 1 anchors the
       tail, the preview rotates toward the cursor, click 2 fixes the
       direction. Settings: Color + Size (Small/Medium/Large/X-Large).
     - Rotated rectangle: click 1+2 = the FIRST EDGE (sets width AND the
       rotation angle), click 3 = the height perpendicular to that edge.
       Same Border + Background settings as the Box.
     - Path: every click adds a point; PRESSING ON A POINT AND DRAGGING
       bends the segment being placed into a quadratic curve (TV mixes
       straight and curved segments). Double-click or Enter finishes,
       Escape cancels. Line settings.
     - Circle: click 1 = CENTER, click 2 = the radius point — always a
       perfect circle on screen (unlike the Ellipse, which fills its
       bounding box). Border + Background.
     - Polyline: Path with straight segments only (no bend on drag).
       Double-click / Enter finishes. Line settings.
     - Arc: click 1+2 = the full ellipse (bounding box), click 3 = the arc
       START angle ray, click 4 = the arc END angle ray (the drawn sweep is
       the ≤180° arc between the two rays). Line settings.
     - Curve: ONE quadratic Bezier — click 1 = start, click 2 = end,
       click 3 = the bend (control point). TV: "draw a line, then bend it".
     - Double curve: TWO joined quadratic spans — click 1+2 = the first
       chord, click 3 = its bend, click 4 = the second span's end (its
       control point mirrors the first one for TV's smooth S joint). */
  function quadPt(a, c, b, u) {
    const w = 1 - u;
    return [w * w * a[0] + 2 * w * u * c[0] + u * u * b[0],
            w * w * a[1] + 2 * w * u * c[1] + u * u * b[1]];
  }
  function quadHit(x, y, a, c, b) {
    const S = [];
    for (let k = 0; k <= 24; k++) S.push(quadPt(a, c, b, k / 24));
    return distToPath(x, y, S, 6);
  }

  /* ---- Arrow marker ---- */
  TOOLS.arrowmarker = {
    name: 'Arrow marker', icon: 'arrowmarker', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [x0, y0] = ptXY(v, d.points[0]);
      const [x1, y1] = ptXY(v, d.points[1]);
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      const s = Number(d.opts.markSize) || 18;
      const ux = dx / len, uy = dy / len;
      const head = s * 0.46, ang = Math.atan2(dy, dx);
      const tx = x0 + ux * s, ty = y0 + uy * s;
      const a1 = ang + Math.PI * 0.86, a2 = ang - Math.PI * 0.86;
      ctx.save();
      ctx.strokeStyle = d.opts.color || '#f23645';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(1.6, s * 0.13);
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(a1) * head, ty + Math.sin(a1) * head);
      ctx.lineTo(tx + Math.cos(a2) * head, ty + Math.sin(a2) * head);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },
    handles(v, d) { return [ptXY(v, d.points[0]), ptXY(v, d.points[1])]; },
    hitBody(v, d) {
      return (x, y) => {
        const [x0, y0] = ptXY(v, d.points[0]);
        const [x1, y1] = ptXY(v, d.points[1]);
        return U.distSeg(x, y, x0, y0, x1, y1) < Math.max(8, (Number(d.opts.markSize) || 18) * 0.5);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Rotated rectangle: A,B = first edge, C = the opposite side ---- */
  function rotRectGeo(v, d) {
    const A = ptXY(v, d.points[0]), B = ptXY(v, d.points[1]), C = ptXY(v, d.points[2]);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const off = (C[0] - A[0]) * nx + (C[1] - A[1]) * ny;
    return { A, B, len, ux, uy, nx, ny, off };
  }
  TOOLS.rotrect = {
    name: 'Rotated rectangle', icon: 'rotrect', pts: 3,
    draw(v, d) {
      if (d.points.length < 3) return;
      const ctx = v.ctx;
      const g = rotRectGeo(v, d);
      const q1 = [g.B[0] + g.nx * g.off, g.B[1] + g.ny * g.off];
      const q0 = [g.A[0] + g.nx * g.off, g.A[1] + g.ny * g.off];
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(g.A[0], g.A[1]); ctx.lineTo(g.B[0], g.B[1]);
        ctx.lineTo(q1[0], q1[1]); ctx.lineTo(q0[0], q0[1]);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(g.A[0], g.A[1]); ctx.lineTo(g.B[0], g.B[1]);
      ctx.lineTo(q1[0], q1[1]); ctx.lineTo(q0[0], q0[1]);
      ctx.closePath();
      ctx.stroke();
    },
    handles(v, d) {
      const g = rotRectGeo(v, d);
      const mid = [g.A[0] + g.ux * g.len / 2 + g.nx * g.off, g.A[1] + g.uy * g.len / 2 + g.ny * g.off];
      return [g.A, g.B, mid]; // TV: 3rd handle slides the opposite edge
    },
    hitBody(v, d) {
      return (x, y) => {
        const g = rotRectGeo(v, d);
        const rx = x - g.A[0], ry = y - g.A[1];
        const along = rx * g.ux + ry * g.uy;
        const perp = rx * g.nx + ry * g.ny;
        const m = Math.max(5, 3 + (d.opts.width || 1));
        const inAlong = along >= -m && along <= g.len + m;
        const lo = Math.min(0, g.off), hi = Math.max(0, g.off);
        const edge = inAlong && Math.min(Math.abs(perp), Math.abs(perp - g.off)) < m;
        const ends = perp >= lo - m && perp <= hi + m && (Math.abs(along) < m || Math.abs(along - g.len) < m);
        const insideFill = !!(d.opts.fill && inAlong && perp >= lo && perp <= hi);
        return edge || ends || insideFill;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Path (multi-point, drag-bendable segments, dblclick/Enter ends) ---- */
  TOOLS.path = {
    name: 'Path', icon: 'path', pts: 2, polyFinish: true, polyCurves: true,
    draw(v, d) {
      const P = polyPts(v, d);
      if (!P.length) return;
      const ctx = v.ctx;
      const ctrls = Array.isArray(d.opts.ctrls) ? d.opts.ctrls : [];
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let i = 1; i < P.length; i++) {
        const c = ctrls[i - 1] ? ptXY(v, ctrls[i - 1]) : null;
        if (c) ctx.quadraticCurveTo(c[0], c[1], P[i][0], P[i][1]);
        else ctx.lineTo(P[i][0], P[i][1]);
      }
      ctx.stroke();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const P = polyPts(v, d);
        const ctrls = Array.isArray(d.opts.ctrls) ? d.opts.ctrls : [];
        for (let i = 1; i < P.length; i++) {
          const c = ctrls[i - 1] ? ptXY(v, ctrls[i - 1]) : null;
          if (c) { if (quadHit(x, y, P[i - 1], c, P[i])) return true; }
          else if (U.distSeg(x, y, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]) < 6) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Polyline (Path, straight segments only) ---- */
  TOOLS.polyline = {
    name: 'Polyline', icon: 'polyline', pts: 2, polyFinish: true,
    draw(v, d) {
      const P = polyPts(v, d);
      if (!P.length) return;
      const ctx = v.ctx;
      /* ROUND252 (TV parity): Background fills the closed polyline. */
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]);
        for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
      ctx.stroke();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => distToPath(x, y, polyPts(v, d), 6);
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Circle: center + radius point (always a circle on screen) ---- */
  TOOLS.circle = {
    name: 'Circle', icon: 'circle', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const [cx, cy] = ptXY(v, d.points[0]);
      const [px, py] = ptXY(v, d.points[1]);
      const r = Math.hypot(px - cx, py - cy);
      if (r < 1) return;
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (d.opts.fill) {
        ctx.save(); ctx.globalAlpha = fillAlphaOf(d); ctx.fillStyle = fillColorOf(d); ctx.fill(); ctx.restore();
      }
      ctx.stroke();
    },
    handles(v, d) {
      const [cx, cy] = ptXY(v, d.points[0]);
      const [px, py] = ptXY(v, d.points[1]);
      const r = Math.hypot(px - cx, py - cy) || 1;
      const ux = (px - cx) / r, uy = (py - cy) / r;
      return [[cx, cy], [cx + ux * r, cy + uy * r]];
    },
    hitBody(v, d) {
      return (x, y) => {
        const [cx, cy] = ptXY(v, d.points[0]);
        const [px, py] = ptXY(v, d.points[1]);
        const r = Math.hypot(px - cx, py - cy);
        const q = Math.hypot(x - cx, y - cy);
        if (d.opts.fill) return q <= r + 4;
        return Math.abs(q - r) < 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Arc: bbox (2 clicks) + start ray + end ray ---- */
  function arcGeo(v, d) {
    const n = normRect(d);
    const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
    return { cx: (xL + xR) / 2, cy: (yT + yB) / 2, rx: Math.abs(xR - xL) / 2, ry: Math.abs(yB - yT) / 2 };
  }
  function arcSweep(v, d) {
    let a0 = 0, sw = Math.PI * 2;
    if (d.points[2]) {
      const g = arcGeo(v, d);
      a0 = Math.atan2(v.yOf(d.points[2].p) - g.cy, v.xOf(d.points[2].t) - g.cx);
      sw = 0;
      if (d.points[3]) {
        const a1 = Math.atan2(v.yOf(d.points[3].p) - g.cy, v.xOf(d.points[3].t) - g.cx);
        sw = a1 - a0;
        while (sw <= -Math.PI) sw += Math.PI * 2; // the ≤180° arc between rays
        while (sw > Math.PI) sw -= Math.PI * 2;
      }
    }
    return { a0, sw };
  }
  TOOLS.arc = {
    name: 'Arc', icon: 'arc', pts: 4,
    draw(v, d) {
      if (d.points.length < 2) return;
      const ctx = v.ctx;
      const g = arcGeo(v, d);
      if (g.rx < 1 || g.ry < 1) return;
      const { a0, sw } = arcSweep(v, d);
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, a0, a0 + sw, sw < 0);
      ctx.stroke();
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        if (d.points.length < 2) return false;
        const g = arcGeo(v, d);
        if (g.rx < 1 || g.ry < 1) return false;
        const { a0, sw } = arcSweep(v, d);
        const S = [];
        const K = 40;
        for (let k = 0; k <= K; k++) {
          const a = a0 + (sw * k) / K;
          S.push([g.cx + Math.cos(a) * g.rx, g.cy + Math.sin(a) * g.ry]);
        }
        return distToPath(x, y, S, 6);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Curve: one quadratic Bezier (A, B, bend) ---- */
  TOOLS.curve = {
    name: 'Curve', icon: 'curve', pts: 3,
    draw(v, d) {
      if (d.points.length < 2) return;
      const ctx = v.ctx;
      const P = polyPts(v, d);
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]);
        if (P[2]) ctx.quadraticCurveTo(P[2][0], P[2][1], P[1][0], P[1][1]);
        else ctx.lineTo(P[1][0], P[1][1]);
      };
      /* ROUND252 (TV parity): Background fills the closed curve. */
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        trace(); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      trace();
      ctx.stroke();
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        const P = polyPts(v, d);
        if (P.length < 2) return false;
        if (P[2]) return quadHit(x, y, P[0], P[2], P[1]);
        return U.distSeg(x, y, P[0][0], P[0][1], P[1][0], P[1][1]) < 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---- Double curve: two joined quadratic spans (smooth S joint) ---- */
  TOOLS.dblcurve = {
    name: 'Double curve', icon: 'dblcurve', pts: 4,
    draw(v, d) {
      if (d.points.length < 2) return;
      const ctx = v.ctx;
      const P = polyPts(v, d);
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]);
        if (P[2]) {
          ctx.quadraticCurveTo(P[2][0], P[2][1], P[1][0], P[1][1]);
          const D = P[3] || P[1];
          const c2 = [2 * P[1][0] - P[2][0], 2 * P[1][1] - P[2][1]]; // mirrored control
          ctx.quadraticCurveTo(c2[0], c2[1], D[0], D[1]);
        } else ctx.lineTo(P[1][0], P[1][1]);
      };
      /* ROUND252 (TV parity): Background fills the closed curve. */
      if (d.opts.fill) {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        trace(); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      applyStroke(ctx, d);
      trace();
      ctx.stroke();
    },
    handles(v, d) { return d.points.map((p) => ptXY(v, p)); },
    hitBody(v, d) {
      return (x, y) => {
        const P = polyPts(v, d);
        if (P.length < 2) return false;
        if (!P[2]) return U.distSeg(x, y, P[0][0], P[0][1], P[1][0], P[1][1]) < 6;
        if (quadHit(x, y, P[0], P[2], P[1])) return true;
        const D = P[3] || P[1];
        const c2 = [2 * P[1][0] - P[2][0], 2 * P[1][1] - P[2][1]];
        return quadHit(x, y, P[1], c2, D);
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- factory opts (per-tool defaults) ---------------- */
  const ANN = { text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' };
  const FACTORY = {
    pitchfork: Object.assign({ color: '#2962ff', width: 2, style: 'solid', extendLeft: false, extendRight: true }, ANN),
    pitchfork_s: Object.assign({ color: '#2962ff', width: 2, style: 'solid', extendLeft: false, extendRight: true }, ANN),
    pitchfork_ms: Object.assign({ color: '#2962ff', width: 2, style: 'solid', extendLeft: false, extendRight: true }, ANN),
    pitchfork_i: Object.assign({ color: '#2962ff', width: 2, style: 'solid', extendLeft: false, extendRight: true }, ANN),
    fibchannel: Object.assign({ color: '#2962ff', width: 1, style: 'solid', showRatio: true, levels: FIBC_LEVELS.map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    fibcircles: Object.assign({ color: '#2962ff', width: 1, style: 'solid', showRatio: true, levels: [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618].map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    gannbox: Object.assign({ color: '#787b86', width: 1, style: 'solid', diagColor: '#2962ff', diag2Color: '#f23645', timeLevels: 8, priceLevels: 8, showLabels: true, reverse: false, showAngles: false }, ANN),
    gannsquare: Object.assign({ color: '#787b86', width: 1, style: 'solid', diagColor: '#2962ff', diag2Color: '#f23645' }, ANN),
    gannsquaref: Object.assign({ color: '#787b86', width: 1, style: 'solid', diagColor: '#2962ff', diag2Color: '#f23645' }, ANN),
    gannfan: Object.assign({ color: '#787b86', width: 1, style: 'solid', showLabels: true }, ANN),
    /* round 58: TV Fibonacci flyout additions (defaults = TV look) */
    fibtz: Object.assign({ color: '#2962ff', width: 1, style: 'solid', showRatio: true, levels: FIB_TZ_LEVELS.map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    fibspeedfan: Object.assign({ color: '#2962ff', width: 1, style: 'solid', showRatio: true, levels: [0, 1 / 3, 0.382, 0.5, 0.618, 2 / 3, 1].map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    fibttime: Object.assign({ color: '#2962ff', width: 1, style: 'solid', showRatio: false, showTrend: true, levels: [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618].map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    fibspiral: Object.assign({ color: '#2962ff', width: 1.5, style: 'solid', coeff: 1.6180339887, turns: 3, showTrend: true }, ANN),
    fibarcs: Object.assign({ color: '#2962ff', width: 1, style: 'solid', showRatio: true, fullscreen: false, showTrend: true, levels: [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618].map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    fibwedge: Object.assign({ color: '#2962ff', width: 2, style: 'solid', levels: [0.382, 0.5, 0.618].map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    pitchfan: Object.assign({ color: '#2962ff', width: 2, style: 'solid', showRatio: true, levels: [0, 0.382, 0.5, 0.618, 1].map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
    callout: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fillColor: '#2962ff', fillOpacity: 0.9, fontSize: 12, text: 'Callout' }, ANN),
    arrowmarku: Object.assign({ color: '#f23645', width: 2, markSize: 22 }, ANN),
    arrowmarkd: Object.assign({ color: '#089981', width: 2, markSize: 22 }, ANN),
    arrowmarkl: Object.assign({ color: '#f7c948', width: 2, markSize: 22 }, ANN),
    arrowmarkr: Object.assign({ color: '#f7c948', width: 2, markSize: 22 }, ANN),
    flagmark: Object.assign({ color: '#2962ff', width: 2, markSize: 26, fillColor: '#2962ff' }, ANN),
    /* ROUND248 (TV parity): Icons category — one glyph per drawing. */
    emoji: { ch: '👍', size: 24 },
    positionl: { color: '#089981', width: 1, style: 'solid' },
    positions: { color: '#f23645', width: 1, style: 'solid' },
    infoline: Object.assign({ color: '#f7c948', width: 2, style: 'solid', showPrices: true, extendLeft: false, extendRight: false }, ANN),
    regression: Object.assign({ color: '#2962ff', width: 2, style: 'solid', devs: [1, 2, 3], extend: false, source: 'close', upShow: true, downShow: true }, ANN),
    /* round 52: TV channels-flyout additions (defaults = TV look) */
    trendangle: { color: '#2962ff', width: 2, style: 'solid', extendLeft: false, extendRight: false, showAngle: true },
    flattop: Object.assign({ color: '#2962ff', width: 2, style: 'solid', extendLeft: false, extendRight: false, fill: true, fillColor: '#2962ff', fillOpacity: 0.12 }, ANN),
    disjoint: Object.assign({ color: '#2962ff', color2: '#2962ff', width: 2, style: 'solid', width2: 2, style2: 'solid', extendLeft: false, extendRight: false, fill: true, fillColor: '#2962ff', fillOpacity: 0.12 }, ANN),
    volprofile: Object.assign({ color: '#2962ff', width: 1, style: 'solid', bins: 24 }, ANN),
    elliott_i: Object.assign({ color: '#f7c948', width: 2, style: 'solid', showRatio: true }, ANN),
    elliott_c: Object.assign({ color: '#f7c948', width: 2, style: 'solid', showRatio: true }, ANN),
    elliott_t: Object.assign({ color: '#f7c948', width: 2, style: 'solid', showRatio: true }, ANN),
    elliott_wxy: Object.assign({ color: '#f7c948', width: 2, style: 'solid', showRatio: true }, ANN),
    elliott_wxyxz: Object.assign({ color: '#f7c948', width: 2, style: 'solid', showRatio: true }, ANN),
    xabcd: Object.assign({ color: '#9c27b0', width: 2, style: 'solid', showRatio: true }, ANN),
    abcd: Object.assign({ color: '#9c27b0', width: 2, style: 'solid', showRatio: true }, ANN),
    cypher: Object.assign({ color: '#00bcd4', width: 2, style: 'solid', showRatio: true }, ANN),
    trianglepat: Object.assign({ color: '#ff9800', width: 2, style: 'solid', showRatio: false }, ANN),
    threedrives: Object.assign({ color: '#089981', width: 2, style: 'solid', showRatio: true }, ANN),
    hs: Object.assign({ color: '#2962ff', width: 2, style: 'solid', showRatio: false }, ANN),
    /* round 69: TV shapes-flyout additions (defaults = TV look) */
    arrowmarker: { color: '#f23645', width: 2, markSize: 18 },
    rotrect: { color: '#2962ff', width: 1, style: 'solid' },
    path: { color: '#2962ff', width: 2, style: 'solid', ctrls: [] },
    circle: { color: '#2962ff', width: 1, style: 'solid' },
    polyline: { color: '#2962ff', width: 2, style: 'solid' },
    arc: { color: '#2962ff', width: 1, style: 'solid' },
    curve: { color: '#2962ff', width: 2, style: 'solid' },
    dblcurve: { color: '#2962ff', width: 2, style: 'solid' },
    /* round 61: TV Cycles additions (defaults = TV look) */
    cycliclines: Object.assign({ color: '#2962ff', width: 1, style: 'solid', coeff: 1, cycles: 12, extendLeft: false, extendRight: true, showRatio: false }, ANN),
    timecycles: Object.assign({ color: '#2962ff', width: 1, style: 'solid', cycles: 5, showRatio: false }, ANN),
    sineline: Object.assign({ color: '#2962ff', width: 2, style: 'solid', coeff: 1, extend: 'both', showTrend: true }, ANN),
    /* round 62: TV Forecasting & Measurement additions (defaults = TV look) */
    posforecast: Object.assign({ color: '#2962ff', width: 1, style: 'solid', coeff: 2, fillOpacity: 0.16 }, ANN),
    barspattern: Object.assign({ color: '#2962ff', width: 2, style: 'solid', mirror: false, fill: true, fillColor: '#2962ff', fillOpacity: 0.12 }, ANN),
    ghostfeed: Object.assign({ color: '#2962ff', width: 1, style: 'solid', bars: 20 }, ANN),
    sector: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fillColor: '#2962ff', fillOpacity: 0.15 }, ANN),
    avwap: Object.assign({ color: '#f7c948', width: 2, style: 'solid', source: 'hlc3' }, ANN),
    avolprofile: Object.assign({ color: '#2962ff', width: 1, style: 'solid', bins: 24 }, ANN),
    pricerange: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fillColor: '#2962ff', fillOpacity: 0.12, showLabel: true }, ANN),
    daterange: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fillColor: '#2962ff', fillOpacity: 0.12, showLabel: true }, ANN),
    datepricerange: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fillColor: '#2962ff', fillOpacity: 0.12, showLabel: true }, ANN),
  };
  for (const [type, opts] of Object.entries(FACTORY)) {
    if (App && App.registerFactoryOpts) App.registerFactoryOpts(type, opts);
  }


  /* ---------------- Brush + Highlighter (freehand, engine mode) ---------------- */
  function freehandTool(id, name, iconN, extra) {
    /* uses ptXY + distToPath from above */
    TOOLS[id] = Object.assign({
      name, icon: iconN, pts: 1, freehand: true,
      draw(v, d) {
        const ctx = v.ctx;
        const P = d.points.map((p) => ptXY(v, p));
        if (P.length < 2) return;
        /* ROUND252 (TV parity): Background fills the closed stroke. */
        if (d.opts.fill) {
          ctx.save();
          ctx.globalAlpha = fillAlphaOf(d);
          ctx.fillStyle = fillColorOf(d);
          ctx.beginPath();
          P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        applyStroke(ctx, d);
        ctx.beginPath();
        P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      },
      handles(v, d) { return d.points.length ? [d.points.map((p) => ptXY(v, p))[0], d.points.map((p) => ptXY(v, p))[d.points.length - 1]] : []; },
      hitBody(v, d) { return (x, y) => distToPath(x, y, d.points.map((p) => ptXY(v, p)), Math.max(6, 3 + (d.opts.width || 2))); },
      /* ROUND249: the two handles are FIRST and LAST point — the old code
         wrote d.points[i], so the "end" handle dragged the SECOND point. */
      dragHandle(v, d, i, pt) {
        const j = i === 0 ? 0 : d.points.length - 1;
        if (d.points[j]) d.points[j] = { t: pt.t, p: pt.p };
      },
    }, extra || {});
  }
  freehandTool('brush', 'Brush', 'brush', { color: '#f23645', width: 2, style: 'solid' });
  /* ROUND249: dropped the dead fillOpacity key (the highlighter reads
     borderOpacity via applyStroke + its schema slider). */
  freehandTool('highlighter', 'Highlighter', 'highlighter', { color: '#f7c948', width: 14, style: 'solid' });
  if (App && App.registerFactoryOpts) {
    App.registerFactoryOpts('brush', { color: '#f23645', width: 2, style: 'solid' });
    /* ROUND69: TV Highlighter = thick translucent stroke (Opacity setting) */
    App.registerFactoryOpts('highlighter', { color: '#f7c948', width: 14, style: 'solid', borderOpacity: 0.35 });
  }
