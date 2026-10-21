/**
 * Drawing tools batch 2 — fib-gann concern.
 *
 * Moved verbatim out of drawing/tools2.js in F4.3; the module registers the
 * same tools on the shared TOOLS registry (no logic changes).
 *
 * @module drawing/tools2/fib-gann
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { Theme } from '../../core/theme.js';
import { App } from '../../../../core/state.js';
import { TOOLS, segWithExtend } from '../tools.js';
import { applyStroke, distToPath, drawAnnotation, fillAlphaOf, fillColorOf, normRect, polyPts, ptXY } from './common.js';

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
        const rx = Math.abs(b[0] - a[0]), ry = Math.abs(b[1] - a[1]);
        for (const lv of levelsOfF(d, [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618])) {
          if (lv.on === false) continue;
          const ex = rx * lv.r, ey = ry * lv.r;
          if (ex < 0.5 || ey < 0.5) continue;
          const P = [];
          for (let k = 0; k <= 64; k++) {
            const th = (k / 64) * Math.PI * 2;
            P.push([a[0] + Math.cos(th) * ex, a[1] + Math.sin(th) * ey]);
          }
          if (distToPath(x, y, P, 6)) return true;
        }
        return false;
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
        ctx.save();
        ctx.globalAlpha = isMain ? 1 : 0.62;
        ctx.strokeStyle = isMain ? (d.opts.mainColor || '#2962ff') : (d.opts.color || '#787b86');
        ctx.lineWidth = isMain ? (d.opts.width || 1) + 0.4 : (d.opts.width || 1);
        ctx.setLineDash([]);
        const seg = U.clipLine(O[0], O[1], E[0], E[1], v.pw, v.ph);
        if (seg) { ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke(); }
        if (d.opts.showLabels !== false) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillText(`${a}x${b}`, (seg ? seg[2] : E[0]) - 22, (seg ? seg[3] : E[1]) - 3);
        }
        ctx.restore();
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
        const r0 = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (r0 < 0.5) return false;
        const th0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const k = isFinite(d.opts.coeff) ? Math.max(1.01, d.opts.coeff) : 1.6180339887;
        const turns = isFinite(d.opts.turns) ? U.clamp(d.opts.turns, 1, 8) : 3;
        const grow = Math.log(k) / (Math.PI / 2);
        const steps = Math.min(720, Math.max(96, Math.round(turns * 72)));
        let prev = null;
        for (let i = 0; i <= steps; i++) {
          const th = (i / steps) * turns * Math.PI * 2;
          const r = r0 * Math.exp(grow * th);
          const p = [a[0] + Math.cos(th0 + th) * r, a[1] + Math.sin(th0 + th) * r];
          if (prev && U.distSeg(x, y, prev[0], prev[1], p[0], p[1]) < 6) return true;
          prev = p;
        }
        return false;
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
        if (d.opts.showTrend !== false && U.distSeg(x, y, a[0], a[1], b[0], b[1]) < 5) return true;
        const full = d.opts.fullscreen === true;
        const phiB = Math.atan2(Math.sign(dy) || 1, Math.sign(dx) || 1);
        for (const lv of levelsOfF(d, [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618])) {
          if (lv.on === false) continue;
          const rx = Math.max(0.5, Math.abs(dx) * lv.r);
          const ry = Math.max(0.5, Math.abs(dy) * lv.r);
          const a0 = full ? 0 : phiB - Math.PI / 2;
          const a1 = full ? Math.PI * 2 : phiB + Math.PI / 2;
          const P = [];
          for (let k = 0; k <= 64; k++) {
            const th = a0 + ((a1 - a0) * k) / 64;
            P.push([a[0] + Math.cos(th) * rx, a[1] + Math.sin(th) * ry]);
          }
          if (distToPath(x, y, P, 6)) return true;
        }
        return false;
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

export { FIBC_LEVELS, fibChanSpan, levelsOfF, gannLevelsN, gannTimeLabel, gannBoxDraw, gannSquareDraw, GANN_RATIOS, FIB_TZ_LEVELS, vLineFib, FIBFAN_LEVELS, speedFanRay };
