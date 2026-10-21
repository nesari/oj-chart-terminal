/**
 * Drawing tools batch 2 — common concern.
 *
 * Moved verbatim out of drawing/tools2.js in F4.3; the module registers the
 * same tools on the shared TOOLS registry (no logic changes).
 *
 * @module drawing/tools2/common
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { Theme } from '../../core/theme.js';
import { App } from '../../../../core/state.js';
import { TOOLS, segWithExtend } from '../tools.js';

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
  /* Ray-cast fill test for closed shapes; P is already in screen space. */
  function insidePoly(x, y, P) {
    let hit = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) hit = !hit;
    }
    return hit;
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

export { ptXY, normRect, arrowHead, drawAnnotation, polyPts, distToPath, insidePoly, applyStroke, fillAlphaOf, fillColorOf, chipLabel, forkMid, forkOrigin, forkMedianEnd, forkProngStarts, forkSegs, forkDraw, forkTool };
