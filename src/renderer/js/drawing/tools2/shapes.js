/**
 * Drawing tools batch 2 — shapes concern.
 *
 * Moved verbatim out of drawing/tools2.js in F4.3; the module registers the
 * same tools on the shared TOOLS registry (no logic changes).
 *
 * @module drawing/tools2/shapes
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { Theme } from '../../core/theme.js';
import { App } from '../../../../core/state.js';
import { TOOLS, segWithExtend } from '../tools.js';
import { applyStroke, distToPath, drawAnnotation, fillAlphaOf, fillColorOf, normRect, polyPts, ptXY, insidePoly } from './common.js';
import { FIBC_LEVELS, FIB_TZ_LEVELS, vLineFib } from './fib-gann.js';

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
      return (x, y) => {
        const P = polyPts(v, d);
        return distToPath(x, y, P, 6) || (!!d.opts.fill && P.length > 2 && insidePoly(x, y, P));
      };
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
        const edge = P[2] ? quadHit(x, y, P[0], P[2], P[1])
          : U.distSeg(x, y, P[0][0], P[0][1], P[1][0], P[1][1]) < 6;
        if (edge) return true;
        if (!d.opts.fill || P.length < 2) return false;
        const S = [];
        for (let k = 0; k <= 24; k++) {
          S.push(P[2] ? quadPt(P[0], P[2], P[1], k / 24) : (k ? P[1] : P[0]));
        }
        return insidePoly(x, y, S);
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
        if (!P[2]) {
          const edge = U.distSeg(x, y, P[0][0], P[0][1], P[1][0], P[1][1]) < 6;
          return edge || (!!d.opts.fill && insidePoly(x, y, [P[0], P[1]]));
        }
        if (quadHit(x, y, P[0], P[2], P[1])) return true;
        const D = P[3] || P[1];
        const c2 = [2 * P[1][0] - P[2][0], 2 * P[1][1] - P[2][1]];
        if (quadHit(x, y, P[1], c2, D)) return true;
        if (!d.opts.fill) return false;
        const S = [];
        for (let k = 0; k <= 24; k++) S.push(quadPt(P[0], P[2], P[1], k / 24));
        for (let k = 1; k <= 24; k++) S.push(quadPt(P[1], c2, D, k / 24));
        return insidePoly(x, y, S);
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
    fibchannel: Object.assign({ color: '#2962ff', width: 1, style: 'solid', extendLeft: false, extendRight: true, showRatio: true, levels: FIBC_LEVELS.map((r) => ({ r, c: '#2962ff', on: true })) }, ANN),
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
    callout: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fill: true, fillColor: '#2962ff', fillOpacity: 0.9 }, ANN, { fontSize: 12, text: 'Callout' }),
    arrowmarku: Object.assign({ color: '#f23645', width: 2, markSize: 22 }, ANN),
    arrowmarkd: Object.assign({ color: '#089981', width: 2, markSize: 22 }, ANN),
    arrowmarkl: Object.assign({ color: '#f7c948', width: 2, markSize: 22 }, ANN),
    arrowmarkr: Object.assign({ color: '#f7c948', width: 2, markSize: 22 }, ANN),
    flagmark: Object.assign({ color: '#2962ff', width: 2, markSize: 26, fill: true, fillColor: '#2962ff' }, ANN),
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
    sector: Object.assign({ color: '#2962ff', width: 1, style: 'solid', fill: true, fillColor: '#2962ff', fillOpacity: 0.15 }, ANN),
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
      hitBody(v, d) {
        return (x, y) => {
          const P = d.points.map((p) => ptXY(v, p));
          if (distToPath(x, y, P, Math.max(6, 3 + (d.opts.width || 2)))) return true;
          /* ROUND258: Brush Background closes and fills the stroke, so its
             interior must be selectable like every other filled shape. */
          return !!(d.opts.fill && P.length > 2 && insidePoly(x, y, P));
        };
      },
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

export { polyDraw, polyTool, sineWave, sinePrice, quadPt, quadHit, rotRectGeo, arcGeo, arcSweep, ANN, FACTORY, freehandTool };
