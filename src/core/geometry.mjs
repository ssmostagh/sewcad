/**
 * Core 2D/3D Computational Geometry Engine for Pattern Drafting & Cloth Meshing.
 * All internal physical units are canonical millimeters (mm).
 * Re-exports unit helpers from ./types.mjs (single source of truth).
 */

import {
  UNIT_FACTORS,
  mmToUnit,
  unitToMm,
  formatUnitValue,
  ValidationError,
} from './types.mjs';

const MAX_SAFE_OFFSET_MM = 1e15;

export { UNIT_FACTORS, mmToUnit, unitToMm, formatUnitValue };

export const convertFromMm = mmToUnit;
export const convertToMm = unitToMm;

export function formatLength(valueMm, unit = 'mm', decimals = 1) {
  return formatUnitValue(valueMm, unit, decimals);
}

const safeNumber = (val) => {
  if (typeof val === 'symbol' || typeof val === 'bigint') return NaN;
  try {
    return Number(val);
  } catch {
    return NaN;
  }
};

const finiteOr = (val, fallback = 0) => {
  const n = safeNumber(val);
  return Number.isFinite(n) ? n : fallback;
};

const sanitizeSegments = (val, fallback = 16, min = 2, max = 4096) => {
  const raw = val === null || val === undefined ? fallback : finiteOr(val, fallback);
  return Math.min(max, Math.max(min, Math.floor(raw)));
};

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function parseBoolFlag(val) {
  if (typeof val === 'string') {
    const norm = val.trim().toLowerCase();
    if (norm === '' || norm === 'false' || norm === '0' || norm === 'no' || norm === 'off') {
      return false;
    }
    return true;
  }
  return Boolean(val);
}

const isFinitePt2 = (p) =>
  p !== null &&
  typeof p === 'object' &&
  !Array.isArray(p) &&
  Number.isFinite(safeNumber(p.x)) &&
  Number.isFinite(safeNumber(p.y));

function allFinitePt2(arr) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr) || !isFinitePt2(arr[i])) return false;
  }
  return true;
}

const safePt2 = (p) => ({
  x: finiteOr(p?.x, 0),
  y: finiteOr(p?.y, 0),
});

const safePt3 = (p) => ({
  x: finiteOr(p?.x, 0),
  y: finiteOr(p?.y, 0),
  z: finiteOr(p?.z, 0),
});

// ============================================================================
// 2D Vector Operations
// ============================================================================

export function vec2(x = 0, y = 0) {
  return { x: finiteOr(x, 0), y: finiteOr(y, 0) };
}

export function add2(a, b) {
  const pa = safePt2(a);
  const pb = safePt2(b);
  return { x: pa.x + pb.x, y: pa.y + pb.y };
}

export function sub2(a, b) {
  const pa = safePt2(a);
  const pb = safePt2(b);
  return { x: pa.x - pb.x, y: pa.y - pb.y };
}

export function scale2(a, s) {
  const pa = safePt2(a);
  const k = finiteOr(s, 0);
  return { x: pa.x * k, y: pa.y * k };
}

export function dot2(a, b) {
  const pa = safePt2(a);
  const pb = safePt2(b);
  return pa.x * pb.x + pa.y * pb.y;
}

export function cross2(a, b) {
  const pa = safePt2(a);
  const pb = safePt2(b);
  return pa.x * pb.y - pa.y * pb.x;
}

export function len2(a) {
  const pa = safePt2(a);
  return Math.hypot(pa.x, pa.y);
}

export function dist2D(a, b) {
  const pa = safePt2(a);
  const pb = safePt2(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

export const dist2 = dist2D;

export function norm2(a) {
  const pa = safePt2(a);
  const m = Math.max(Math.abs(pa.x), Math.abs(pa.y));
  if (m === 0) return { x: 0, y: 0 };
  const sx = pa.x / m;
  const sy = pa.y / m;
  const lScaled = Math.hypot(sx, sy);
  if (m < 1e-12 && m * lScaled < 1e-12) return { x: 0, y: 0 };
  return { x: sx / lScaled, y: sy / lScaled };
}

const lerpScalar = (u, v, k) => {
  if (u === v || k === 0) return u;
  if (k === 1) return v;
  if (k > 0 && k < 1) return u * (1 - k) + v * k;
  const d = v - u;
  return Number.isFinite(d) ? u + d * k : u * (1 - k) + v * k;
};

export function lerp2(a, b, t) {
  const pa = safePt2(a);
  const pb = safePt2(b);
  const k = finiteOr(t, 0);
  return {
    x: lerpScalar(pa.x, pb.x, k),
    y: lerpScalar(pa.y, pb.y, k),
  };
}

export function rotate2(p, angleRad, center = { x: 0, y: 0 }) {
  const pp = safePt2(p);
  const pc = safePt2(center);
  const ang = finiteOr(angleRad, 0);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const dx = pp.x - pc.x;
  const dy = pp.y - pc.y;
  return {
    x: pc.x + dx * cos - dy * sin,
    y: pc.y + dx * sin + dy * cos,
  };
}

export function perp2(v) {
  const pv = safePt2(v);
  return { x: -pv.y, y: pv.x };
}

// ============================================================================
// 3D Vector Operations
// ============================================================================

export function vec3(x = 0, y = 0, z = 0) {
  return { x: finiteOr(x, 0), y: finiteOr(y, 0), z: finiteOr(z, 0) };
}

export function add3(a, b) {
  const pa = safePt3(a);
  const pb = safePt3(b);
  return { x: pa.x + pb.x, y: pa.y + pb.y, z: pa.z + pb.z };
}

export function sub3(a, b) {
  const pa = safePt3(a);
  const pb = safePt3(b);
  return { x: pa.x - pb.x, y: pa.y - pb.y, z: pa.z - pb.z };
}

export function scale3(a, s) {
  const pa = safePt3(a);
  const k = finiteOr(s, 0);
  return { x: pa.x * k, y: pa.y * k, z: pa.z * k };
}

export function dot3(a, b) {
  const pa = safePt3(a);
  const pb = safePt3(b);
  return pa.x * pb.x + pa.y * pb.y + pa.z * pb.z;
}

export function cross3(a, b) {
  const pa = safePt3(a);
  const pb = safePt3(b);
  return {
    x: pa.y * pb.z - pa.z * pb.y,
    y: pa.z * pb.x - pa.x * pb.z,
    z: pa.x * pb.y - pa.y * pb.x,
  };
}

export function len3(a) {
  const pa = safePt3(a);
  return Math.hypot(pa.x, pa.y, pa.z);
}

export function dist3(a, b) {
  const pa = safePt3(a);
  const pb = safePt3(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

export function norm3(a) {
  const pa = safePt3(a);
  const m = Math.max(Math.abs(pa.x), Math.abs(pa.y), Math.abs(pa.z));
  if (m === 0) return { x: 0, y: 0, z: 0 };
  const sx = pa.x / m;
  const sy = pa.y / m;
  const sz = pa.z / m;
  const lScaled = Math.hypot(sx, sy, sz);
  if (m < 1e-12 && m * lScaled < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: sx / lScaled, y: sy / lScaled, z: sz / lScaled };
}

export function lerp3(a, b, t) {
  const pa = safePt3(a);
  const pb = safePt3(b);
  const k = finiteOr(t, 0);
  return {
    x: lerpScalar(pa.x, pb.x, k),
    y: lerpScalar(pa.y, pb.y, k),
    z: lerpScalar(pa.z, pb.z, k),
  };
}

// ============================================================================
// Bezier Curves, Analytical Derivatives, De Casteljau & Arc-Length
// ============================================================================

export function evalQuadBezier(p0, cp, p1, t) {
  const a = safePt2(p0);
  const c = safePt2(cp);
  const b = safePt2(p1);
  const tc = finiteOr(t, 0);
  const mt = 1 - tc;
  return {
    x: mt * mt * a.x + 2 * mt * tc * c.x + tc * tc * b.x,
    y: mt * mt * a.y + 2 * mt * tc * c.y + tc * tc * b.y,
  };
}

export const evalQuadraticBezier = evalQuadBezier;

export function evalCubicBezier(p0, cp1, cp2, p1, t) {
  const a = safePt2(p0);
  const c1 = safePt2(cp1);
  const c2 = safePt2(cp2);
  const b = safePt2(p1);
  const tc = finiteOr(t, 0);
  const mt = 1 - tc;
  const mt2 = mt * mt;
  const t2 = tc * tc;
  return {
    x: mt2 * mt * a.x + 3 * mt2 * tc * c1.x + 3 * mt * t2 * c2.x + t2 * tc * b.x,
    y: mt2 * mt * a.y + 3 * mt2 * tc * c1.y + 3 * mt * t2 * c2.y + t2 * tc * b.y,
  };
}

export function evalEdgeAt(p0, p1, curve, t) {
  if (!curve) return lerp2(p0, p1, t);
  if (curve.cp1 && curve.cp2) {
    return evalCubicBezier(p0, curve.cp1, curve.cp2, p1, t);
  }
  if (curve.cp) {
    return evalQuadBezier(p0, curve.cp, p1, t);
  }
  return lerp2(p0, p1, t);
}

export function evalEdgeTangentAt(p0, p1, curve, t) {
  const a0 = safePt2(p0);
  const b1 = safePt2(p1);
  const tc = clamp(finiteOr(t, 0.5), 0, 1);
  let d;
  if (curve?.cp1 && curve?.cp2) {
    const c1 = safePt2(curve.cp1);
    const c2 = safePt2(curve.cp2);
    const mt = 1 - tc;
    const w0 = 3 * mt * mt;
    const w1 = 6 * mt * tc;
    const w2 = 3 * tc * tc;
    d = {
      x: w0 * (c1.x - a0.x) + w1 * (c2.x - c1.x) + w2 * (b1.x - c2.x),
      y: w0 * (c1.y - a0.y) + w1 * (c2.y - c1.y) + w2 * (b1.y - c2.y),
    };
  } else if (curve?.cp) {
    const c = safePt2(curve.cp);
    const mt = 1 - tc;
    d = {
      x: 2 * mt * (c.x - a0.x) + 2 * tc * (b1.x - c.x),
      y: 2 * mt * (c.y - a0.y) + 2 * tc * (b1.y - c.y),
    };
  } else {
    d = sub2(b1, a0);
  }

  if (len2(d) >= 1e-9) {
    return norm2(d);
  }

  // Fallback for degenerate Bezier handle (e.g., cp1 === p0 at t=0)
  const eps = 1e-3;
  const a = evalEdgeAt(a0, b1, curve, Math.max(0, tc - eps));
  const b = evalEdgeAt(a0, b1, curve, Math.min(1, tc + eps));
  const sec = sub2(b, a);
  if (len2(sec) >= 1e-9) {
    return norm2(sec);
  }
  return norm2(sub2(b1, a0));
}

export function evalEdgeNormalAt(p0, p1, curve, t, windingSign = 1) {
  const tan = evalEdgeTangentAt(p0, p1, curve, t);
  return {
    x: tan.y * windingSign,
    y: -tan.x * windingSign,
  };
}

export function splitQuadBezier(p0, cp, p1, t) {
  const tc = clamp(finiteOr(t, 0.5), 1e-6, 1 - 1e-6);
  const q0 = lerp2(p0, cp, tc);
  const q1 = lerp2(cp, p1, tc);
  const mid = lerp2(q0, q1, tc);
  return {
    mid,
    curveA: { cp: q0 },
    curveB: { cp: q1 },
  };
}

export function splitCubicBezier(p0, cp1, cp2, p1, t) {
  const tc = clamp(finiteOr(t, 0.5), 1e-6, 1 - 1e-6);
  const q0 = lerp2(p0, cp1, tc);
  const q1 = lerp2(cp1, cp2, tc);
  const q2 = lerp2(cp2, p1, tc);
  const r0 = lerp2(q0, q1, tc);
  const r1 = lerp2(q1, q2, tc);
  const mid = lerp2(r0, r1, tc);
  return {
    mid,
    curveA: { cp1: q0, cp2: r0 },
    curveB: { cp1: r1, cp2: q2 },
  };
}

export function splitEdgeCurve(p0, p1, curve, t) {
  const tc = clamp(finiteOr(t, 0.5), 1e-6, 1 - 1e-6);
  if (curve?.cp1 && curve?.cp2) {
    return splitCubicBezier(p0, curve.cp1, curve.cp2, p1, tc);
  }
  if (curve?.cp) {
    return splitQuadBezier(p0, curve.cp, p1, tc);
  }
  return {
    mid: lerp2(p0, p1, tc),
    curveA: null,
    curveB: null,
  };
}

export function sampleEdgePoints(p0, p1, curve, segments = 16) {
  const a = safePt2(p0);
  const b = safePt2(p1);
  if (!curve || (!curve.cp && !(curve.cp1 && curve.cp2))) {
    return [vec2(a.x, a.y), vec2(b.x, b.y)];
  }
  const n = sanitizeSegments(segments, 16, 2, 4096);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    pts.push(evalEdgeAt(a, b, curve, i / n));
  }
  return pts;
}

export function edgeArcLength(p0, p1, curve = null, segments = 64) {
  if (!curve || (!curve.cp && !(curve.cp1 && curve.cp2))) {
    return dist2D(p0, p1);
  }
  const samples = sampleEdgePoints(p0, p1, curve, sanitizeSegments(segments, 64, 2, 4096));
  let total = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    total += dist2D(samples[i], samples[i + 1]);
  }
  return total;
}

export const computeEdgeLength = edgeArcLength;

export function buildEdgeArcTable(p0, p1, curve = null, segments = 64, tStart = 0, tEnd = 1) {
  const t0 = clamp(finiteOr(tStart, 0), 0, 1);
  const t1 = clamp(finiteOr(tEnd, 1), t0, 1);
  const n = !curve || (!curve.cp && !(curve.cp1 && curve.cp2)) ? 1 : sanitizeSegments(segments, 64, 4, 4096);
  const ts = new Array(n + 1);
  const cumLen = new Array(n + 1);
  ts[0] = t0;
  cumLen[0] = 0;
  let prev = evalEdgeAt(p0, p1, curve, t0);
  let acc = 0;
  for (let i = 1; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const pt = evalEdgeAt(p0, p1, curve, t);
    acc += dist2D(prev, pt);
    ts[i] = t;
    cumLen[i] = acc;
    prev = pt;
  }
  return { ts, cumLen, totalLen: acc, tStart: t0, tEnd: t1 };
}

export function arcLengthAtT(table, t) {
  const { ts, cumLen, totalLen } = table;
  const n = ts.length - 1;
  if (n <= 0) return 0;
  if (t <= ts[0]) return 0;
  if (t >= ts[n]) return totalLen;
  let lo = 0;
  let hi = n;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const frac = span > 1e-12 ? (t - ts[lo]) / span : 0;
  return cumLen[lo] + (cumLen[hi] - cumLen[lo]) * frac;
}

export function tAtArcLength(table, targetDistMm) {
  const { ts, cumLen, totalLen } = table;
  const n = ts.length - 1;
  if (n <= 0) return ts[0] ?? 0;
  if (targetDistMm <= 0) return ts[0];
  if (targetDistMm >= totalLen) return ts[n];
  let lo = 0;
  let hi = n;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] <= targetDistMm) lo = mid;
    else hi = mid;
  }
  const span = cumLen[hi] - cumLen[lo];
  const frac = span > 1e-12 ? (targetDistMm - cumLen[lo]) / span : 0;
  return ts[lo] + (ts[hi] - ts[lo]) * frac;
}

export function evalEdgeAtArcLength(p0, p1, curve, targetDistMm, table = null) {
  const lut = table || buildEdgeArcTable(p0, p1, curve, 64);
  const t = tAtArcLength(lut, targetDistMm);
  return {
    t,
    point: evalEdgeAt(p0, p1, curve, t),
    tangent: evalEdgeTangentAt(p0, p1, curve, t),
  };
}

// ============================================================================
// Polygon Metrics, Winding & Self-Intersection
// ============================================================================

export function deduplicateConsecutivePoints(points, eps = 1e-4) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (out.length === 0 || dist2D(p, out[out.length - 1]) > eps) {
      out.push({ x: p.x, y: p.y });
    }
  }
  if (out.length > 1 && dist2D(out[0], out[out.length - 1]) <= eps) {
    out.pop();
  }
  return out;
}

export function signedPolygonArea(points) {
  if (!Array.isArray(points) || points.length < 3 || !allFinitePt2(points)) return 0;
  const n = points.length;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(points[i].x);
    const ay = Math.abs(points[i].y);
    if (ax > maxAbs) maxAbs = ax;
    if (ay > maxAbs) maxAbs = ay;
  }
  if (maxAbs === 0) return 0;

  const ox = points[0].x;
  const oy = points[0].y;
  if (maxAbs <= 1e150) {
    const dx = new Array(n);
    const dy = new Array(n);
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const vx = points[i].x - ox;
      const vy = points[i].y - oy;
      dx[i] = vx;
      dy[i] = vy;
      const avx = Math.abs(vx);
      const avy = Math.abs(vy);
      if (avx > maxDelta) maxDelta = avx;
      if (avy > maxDelta) maxDelta = avy;
    }
    if (maxDelta === 0) return 0;
    if (maxDelta >= 1e-140 && maxDelta <= 1e140) {
      let area2 = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area2 += dx[i] * dy[j] - dx[j] * dy[i];
      }
      const raw = area2 * 0.5;
      if (Number.isFinite(raw)) return raw;
    }
    let scaledArea2 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = dx[i] / maxDelta;
      const ay = dy[i] / maxDelta;
      const bx = dx[j] / maxDelta;
      const by = dy[j] / maxDelta;
      scaledArea2 += ax * by - bx * ay;
    }
    if (scaledArea2 === 0) return 0;
    const scaled = scaledArea2 * 0.5 * maxDelta * maxDelta;
    if (Number.isFinite(scaled)) return scaled;
    return scaledArea2 > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
  }

  const oxq = ox * 0.25;
  const oyq = oy * 0.25;
  const dxq = new Array(n);
  const dyq = new Array(n);
  let maxDeltaQ = 0;
  for (let i = 0; i < n; i++) {
    const vx = points[i].x * 0.25 - oxq;
    const vy = points[i].y * 0.25 - oyq;
    dxq[i] = vx;
    dyq[i] = vy;
    const avx = Math.abs(vx);
    const avy = Math.abs(vy);
    if (avx > maxDeltaQ) maxDeltaQ = avx;
    if (avy > maxDeltaQ) maxDeltaQ = avy;
  }
  if (maxDeltaQ === 0) return 0;
  let scaledArea2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = dxq[i] / maxDeltaQ;
    const ay = dyq[i] / maxDeltaQ;
    const bx = dxq[j] / maxDeltaQ;
    const by = dyq[j] / maxDeltaQ;
    scaledArea2 += ax * by - bx * ay;
  }
  if (scaledArea2 === 0) return 0;
  const scaled = scaledArea2 * 8 * maxDeltaQ * maxDeltaQ;
  if (Number.isFinite(scaled)) return scaled;
  return scaledArea2 > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

export const polygonSignedArea = signedPolygonArea;

export function polygonArea(points) {
  const area = Math.abs(signedPolygonArea(points));
  return Number.isFinite(area) ? area : Number.MAX_VALUE;
}

export function polygonPerimeter(points) {
  if (!Array.isArray(points) || points.length < 2 || !allFinitePt2(points)) return 0;
  let total = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    total += dist2D(points[i], points[(i + 1) % n]);
  }
  return Number.isFinite(total) ? total : Number.MAX_VALUE;
}

export function ensureCCW(points) {
  if (!Array.isArray(points)) return [];
  const valid = points.filter(isFinitePt2).map((p) => ({ x: safeNumber(p.x), y: safeNumber(p.y) }));
  if (valid.length < 3) {
    return valid;
  }
  if (signedPolygonArea(valid) < 0) {
    valid.reverse();
  }
  return valid;
}

export const ensureCounterClockwise = ensureCCW;

export function polygonCentroid(points) {
  const valid = Array.isArray(points)
    ? points.filter(isFinitePt2).map((p) => ({ x: safeNumber(p.x), y: safeNumber(p.y) }))
    : [];
  if (valid.length === 0) return { x: 0, y: 0 };
  const n = valid.length;
  const clampMax = (v, fallbackSign) =>
    Number.isFinite(v) ? v : fallbackSign >= 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;

  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(valid[i].x);
    const ay = Math.abs(valid[i].y);
    if (ax > maxAbs) maxAbs = ax;
    if (ay > maxAbs) maxAbs = ay;
  }
  if (maxAbs === 0) return { x: 0, y: 0 };

  const ox = valid[0].x;
  const oy = valid[0].y;

  if (maxAbs <= 1e150) {
    const dx = new Array(n);
    const dy = new Array(n);
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const vx = valid[i].x - ox;
      const vy = valid[i].y - oy;
      dx[i] = vx;
      dy[i] = vy;
      const avx = Math.abs(vx);
      const avy = Math.abs(vy);
      if (avx > maxDelta) maxDelta = avx;
      if (avy > maxDelta) maxDelta = avy;
    }
    const meanShifted = () => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += dx[i] / n;
        sy += dy[i] / n;
      }
      const rx = ox + sx;
      const ry = oy + sy;
      return {
        x: Number.isFinite(rx) ? rx : 0,
        y: Number.isFinite(ry) ? ry : 0,
      };
    };
    if (n < 3 || maxDelta === 0) return meanShifted();

    if (maxDelta >= 1e-3 && maxDelta <= 1e100) {
      let area2 = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cross = dx[i] * dy[j] - dx[j] * dy[i];
        area2 += cross;
        cx += (dx[i] + dx[j]) * cross;
        cy += (dy[i] + dy[j]) * cross;
      }
      const signedA = area2 * 0.5;
      if (Math.abs(signedA) < 1e-8 || Math.abs(area2) <= 1e-14 * maxDelta * maxDelta) {
        return meanShifted();
      }
      if (Number.isFinite(area2) && Number.isFinite(cx) && Number.isFinite(cy)) {
        const inv3A2 = 1 / (3 * area2);
        const rx = ox + cx * inv3A2;
        const ry = oy + cy * inv3A2;
        if (Number.isFinite(rx) && Number.isFinite(ry)) {
          return { x: rx, y: ry };
        }
      }
    }

    let scaledArea2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = dx[i] / maxDelta;
      const ay = dy[i] / maxDelta;
      const bx = dx[j] / maxDelta;
      const by = dy[j] / maxDelta;
      const cross = ax * by - bx * ay;
      scaledArea2 += cross;
      cx += (ax + bx) * cross;
      cy += (ay + by) * cross;
    }
    if (Math.abs(scaledArea2) < 1e-12) return meanShifted();
    const factor = 1 / (3 * scaledArea2);
    const offX = cx * factor * maxDelta;
    const offY = cy * factor * maxDelta;
    if (!Number.isFinite(offX) || !Number.isFinite(offY)) return meanShifted();
    const rx = ox + offX;
    const ry = oy + offY;
    return {
      x: clampMax(rx, ox + offX),
      y: clampMax(ry, oy + offY),
    };
  }

  const oxq = ox * 0.25;
  const oyq = oy * 0.25;
  const dxq = new Array(n);
  const dyq = new Array(n);
  let maxDeltaQ = 0;
  for (let i = 0; i < n; i++) {
    const vx = valid[i].x * 0.25 - oxq;
    const vy = valid[i].y * 0.25 - oyq;
    dxq[i] = vx;
    dyq[i] = vy;
    const avx = Math.abs(vx);
    const avy = Math.abs(vy);
    if (avx > maxDeltaQ) maxDeltaQ = avx;
    if (avy > maxDeltaQ) maxDeltaQ = avy;
  }
  const meanShiftedQ = () => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += dxq[i] / n;
      sy += dyq[i] / n;
    }
    const qx = oxq + sx;
    const qy = oyq + sy;
    return {
      x: clampMax(qx * 4, qx),
      y: clampMax(qy * 4, qy),
    };
  };
  if (n < 3 || maxDeltaQ === 0) return meanShiftedQ();

  let scaledArea2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = dxq[i] / maxDeltaQ;
    const ay = dyq[i] / maxDeltaQ;
    const bx = dxq[j] / maxDeltaQ;
    const by = dyq[j] / maxDeltaQ;
    const cross = ax * by - bx * ay;
    scaledArea2 += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (Math.abs(scaledArea2) < 1e-12) return meanShiftedQ();
  const factor = 1 / (3 * scaledArea2);
  const dqx = cx * factor * maxDeltaQ;
  const dqy = cy * factor * maxDeltaQ;
  if (!Number.isFinite(dqx) || !Number.isFinite(dqy)) return meanShiftedQ();
  const qx = oxq + dqx;
  const qy = oyq + dqy;
  return {
    x: clampMax(qx * 4, qx),
    y: clampMax(qy * 4, qy),
  };
}

export function polygonBounds(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function pointInPolygon(pt, polygon) {
  if (!isFinitePt2(pt) || !Array.isArray(polygon) || polygon.length < 3 || !allFinitePt2(polygon)) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInTriangle2D(p, a, b, c) {
  const c1 = cross2(sub2(b, a), sub2(p, a));
  const c2 = cross2(sub2(c, b), sub2(p, b));
  const c3 = cross2(sub2(a, c), sub2(p, c));
  const hasNeg = c1 < -1e-9 || c2 < -1e-9 || c3 < -1e-9;
  const hasPos = c1 > 1e-9 || c2 > 1e-9 || c3 > 1e-9;
  return !(hasNeg && hasPos);
}

export function segmentIntersection2D(a1, a2, b1, b2) {
  const pa1 = safePt2(a1);
  const pa2 = safePt2(a2);
  const pb1 = safePt2(b1);
  const pb2 = safePt2(b2);
  const maxAbs = Math.max(
    Math.abs(pa1.x),
    Math.abs(pa1.y),
    Math.abs(pa2.x),
    Math.abs(pa2.y),
    Math.abs(pb1.x),
    Math.abs(pb1.y),
    Math.abs(pb2.x),
    Math.abs(pb2.y)
  );
  const rawUlpTol = maxAbs * Number.EPSILON * 16;
  const tolDist = Number.isFinite(rawUlpTol) ? Math.max(1e-6, rawUlpTol) : Number.MAX_VALUE;

  if (maxAbs > 1e140) {
    const safeDiff = (p, q) => {
      let dx = p.x - q.x;
      let dy = p.y - q.y;
      let factor = 1;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        dx = p.x * 0.5 - q.x * 0.5;
        dy = p.y * 0.5 - q.y * 0.5;
        factor = 2;
      }
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      if (m === 0) {
        return { dx: 0, dy: 0, factor, m: 0, nLen: 0, ux: 0, uy: 0 };
      }
      const nx = dx / m;
      const ny = dy / m;
      const nLen = Math.hypot(nx, ny);
      return {
        dx,
        dy,
        factor,
        m,
        nLen,
        ux: nx / nLen,
        uy: ny / nLen,
      };
    };

    const r = safeDiff(pa2, pa1);
    const s = safeDiff(pb2, pb1);
    if (r.m === 0 || s.m === 0) return null;

    const qp = safeDiff(pb1, pa1);
    const normDenom = r.ux * s.uy - r.uy * s.ux;
    const rHalf = r.m * r.nLen * (r.factor * 0.5);
    const sHalf = s.m * s.nLen * (s.factor * 0.5);
    const halfTol = tolDist * 0.5;
    const epsT = rHalf > 0 && Number.isFinite(halfTol / rHalf) ? Math.min(1e-6, halfTol / rHalf) : 1e-6;
    const epsU = sHalf > 0 && Number.isFinite(halfTol / sHalf) ? Math.min(1e-6, halfTol / sHalf) : 1e-6;

    if (Math.abs(normDenom) >= 1e-12) {
      const computeParam = (dirU, target) => {
        let c = qp.dx * dirU.y - qp.dy * dirU.x;
        let qFactor = qp.factor;
        if (!Number.isFinite(c)) {
          c = qp.dx * 0.5 * dirU.y - qp.dy * 0.5 * dirU.x;
          qFactor *= 2;
        }
        return (((c / target.m) / target.nLen) * (qFactor / target.factor)) / normDenom;
      };

      const t = computeParam({ x: s.ux, y: s.uy }, r);
      const u = computeParam({ x: r.ux, y: r.uy }, s);
      if (t >= -epsT && t <= 1 + epsT && u >= -epsU && u <= 1 + epsU) {
        const tc = clamp(t, 0, 1);
        const uc = clamp(u, 0, 1);
        const ptX = Number.isFinite(pa2.x - pa1.x)
          ? pa1.x + (pa2.x - pa1.x) * tc
          : pa1.x * (1 - tc) + pa2.x * tc;
        const ptY = Number.isFinite(pa2.y - pa1.y)
          ? pa1.y + (pa2.y - pa1.y) * tc
          : pa1.y * (1 - tc) + pa2.y * tc;
        return {
          point: { x: ptX, y: ptY },
          t: tc,
          u: uc,
          collinear: false,
        };
      }
      return null;
    }

    const qHalf = qp.m * qp.nLen * (qp.factor * 0.5);
    const maxHalf = Math.max(rHalf, sHalf, qHalf);
    if (!(rHalf > 0) || !(maxHalf > 0)) return null;

    let perpHalf = Math.abs(qp.dx * r.uy - qp.dy * r.ux) * (qp.factor * 0.5);
    if (!Number.isFinite(perpHalf)) {
      perpHalf = Math.abs(qp.dx * 0.5 * r.uy - qp.dy * 0.5 * r.ux) * qp.factor;
    }
    if (perpHalf > 1e-7 * maxHalf) {
      return null;
    }

    const qp2 = safeDiff(pb2, pa1);
    const projOnR = (vec) => {
      if (vec.m === 0) return 0;
      let d = vec.dx * r.ux + vec.dy * r.uy;
      let vFactor = vec.factor;
      if (!Number.isFinite(d)) {
        d = vec.dx * 0.5 * r.ux + vec.dy * 0.5 * r.uy;
        vFactor *= 2;
      }
      return ((d / r.m) / r.nLen) * (vFactor / r.factor);
    };
    const u0 = projOnR(qp);
    const u1 = projOnR(qp2);
    const lo = Math.max(0, Math.min(u0, u1));
    const hi = Math.min(1, Math.max(u0, u1));
    const colEps = rHalf > 0 && Number.isFinite(halfTol / rHalf) ? Math.min(1e-7, halfTol / rHalf) : 1e-7;

    if (hi >= lo - colEps) {
      const tMid = clamp((lo + hi) * 0.5, 0, 1);
      const point = {
        x: Number.isFinite(pa2.x - pa1.x)
          ? pa1.x + (pa2.x - pa1.x) * tMid
          : pa1.x * (1 - tMid) + pa2.x * tMid,
        y: Number.isFinite(pa2.y - pa1.y)
          ? pa1.y + (pa2.y - pa1.y) * tMid
          : pa1.y * (1 - tMid) + pa2.y * tMid,
      };
      const pDiff = safeDiff(point, pb1);
      let sDot = pDiff.dx * s.ux + pDiff.dy * s.uy;
      let pFactor = pDiff.factor;
      if (!Number.isFinite(sDot)) {
        sDot = pDiff.dx * 0.5 * s.ux + pDiff.dy * 0.5 * s.uy;
        pFactor *= 2;
      }
      const uMid = s.m > 0
        ? clamp(((sDot / s.m) / s.nLen) * (pFactor / s.factor), 0, 1)
        : 0;
      return {
        point,
        t: tMid,
        u: uMid,
        collinear: true,
      };
    }
    return null;
  }

  const r = sub2(pa2, pa1);
  const s = sub2(pb2, pb1);
  const mr = Math.max(Math.abs(r.x), Math.abs(r.y));
  const ms = Math.max(Math.abs(s.x), Math.abs(s.y));
  if (mr === 0 || ms === 0) return null;

  const nrx = r.x / mr;
  const nry = r.y / mr;
  const nLenR = Math.hypot(nrx, nry);
  const ur = { x: nrx / nLenR, y: nry / nLenR };
  const lenR = mr * nLenR;

  const nsx = s.x / ms;
  const nsy = s.y / ms;
  const nLenS = Math.hypot(nsx, nsy);
  const us = { x: nsx / nLenS, y: nsy / nLenS };
  const lenS = ms * nLenS;

  const qp = sub2(pb1, pa1);
  const normDenom = ur.x * us.y - ur.y * us.x;

  if (Math.abs(normDenom) >= 1e-12) {
    const t = ((qp.x * us.y - qp.y * us.x) / mr / nLenR) / normDenom;
    const u = ((qp.x * ur.y - qp.y * ur.x) / ms / nLenS) / normDenom;
    const epsT = lenR > 0 && Number.isFinite(tolDist / lenR) ? Math.min(1e-6, tolDist / lenR) : 1e-6;
    const epsU = lenS > 0 && Number.isFinite(tolDist / lenS) ? Math.min(1e-6, tolDist / lenS) : 1e-6;
    if (t >= -epsT && t <= 1 + epsT && u >= -epsU && u <= 1 + epsU) {
      const tc = clamp(t, 0, 1);
      const uc = clamp(u, 0, 1);
      return {
        point: add2(pa1, scale2(r, tc)),
        t: tc,
        u: uc,
        collinear: false,
      };
    }
    return null;
  }

  // Collinear check: perpendicular distance in physical coordinates + scale-aware ULP tolerance
  const perpDist = Math.abs(qp.x * ur.y - qp.y * ur.x);
  const tolPerp = Number.isFinite(rawUlpTol) ? Math.max(1e-7, rawUlpTol) : Number.MAX_VALUE;
  if (perpDist > tolPerp) {
    return null;
  }

  const qp2 = sub2(pb2, pa1);
  const u0 = ((qp.x * ur.x + qp.y * ur.y) / mr) / nLenR;
  const u1 = ((qp2.x * ur.x + qp2.y * ur.y) / mr) / nLenR;
  const lo = Math.max(0, Math.min(u0, u1));
  const hi = Math.min(1, Math.max(u0, u1));
  const colEps = lenR > 0 && Number.isFinite(tolDist / lenR) ? Math.min(1e-7, tolDist / lenR) : 1e-7;

  if (hi >= lo - colEps) {
    const tMid = clamp((lo + hi) * 0.5, 0, 1);
    const point = lerp2(pa1, pa2, tMid);
    const pDiff = sub2(point, pb1);
    const uMid = clamp((((pDiff.x * us.x + pDiff.y * us.y) / ms) / nLenS), 0, 1);
    return {
      point,
      t: tMid,
      u: uMid,
      collinear: true,
    };
  }
  return null;
}

export function polygonSelfIntersects(points) {
  const clean = deduplicateConsecutivePoints(points, 1e-6);
  const n = clean.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = clean[i];
    const a2 = clean[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = clean[j];
      const b2 = clean[(j + 1) % n];
      if (segmentIntersection2D(a1, a2, b1, b2)) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// Piece Transforms (`piece.rotation` + `piece.position`)
// ============================================================================

export function getPieceTransformPivot(piece, options = {}) {
  if (options?.pivot && Number.isFinite(options.pivot.x) && Number.isFinite(options.pivot.y)) {
    return { x: options.pivot.x, y: options.pivot.y };
  }
  if (piece?.rotationOrigin && Number.isFinite(piece.rotationOrigin.x) && Number.isFinite(piece.rotationOrigin.y)) {
    return { x: piece.rotationOrigin.x, y: piece.rotationOrigin.y };
  }
  if (Array.isArray(piece?.points) && piece.points.length >= 3) {
    return polygonCentroid(piece.points);
  }
  return { x: 0, y: 0 };
}

export function transformPiecePoints(points, piece, options = {}) {
  if (!Array.isArray(points)) return [];
  const rotDeg = finiteOr(piece?.rotation, 0);
  const rotRad = (rotDeg * Math.PI) / 180;
  const pos = piece?.position || { x: 0, y: 0 };
  const ox = finiteOr(pos.x, 0);
  const oy = finiteOr(pos.y, 0);
  const hasRot = Math.abs(rotRad) > 1e-9;
  const pivot = hasRot ? getPieceTransformPivot(piece, options) : { x: 0, y: 0 };

  return Array.from(points, (pt) => {
    const base = { x: finiteOr(pt?.x, 0), y: finiteOr(pt?.y, 0) };
    const r = hasRot ? rotate2(base, rotRad, pivot) : base;
    return { x: r.x + ox, y: r.y + oy };
  });
}

function rotateDirection2D(vec, piece) {
  const rotDeg = finiteOr(piece?.rotation, 0);
  const rotRad = (rotDeg * Math.PI) / 180;
  if (Math.abs(rotRad) <= 1e-9) return { x: vec.x, y: vec.y };
  return rotate2(vec, rotRad, { x: 0, y: 0 });
}

// ============================================================================
// Seam Allowance Polygon Offsetting, Loop Clipping & Dart Cut-Boundary Handling
// ============================================================================

function stripBacktrackingSpikes(poly) {
  let pts = deduplicateConsecutivePoints(poly, 1e-4);
  let changed = true;
  let guard = 0;
  while (changed && pts.length >= 4 && guard++ < pts.length * 4) {
    changed = false;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const curr = pts[i];
      const next = pts[(i + 1) % n];
      const d1 = norm2(sub2(curr, prev));
      const d2 = norm2(sub2(next, curr));
      if (Math.abs(cross2(d1, d2)) < 1e-4 && dot2(d1, d2) < -0.999) {
        pts.splice(i, 1);
        pts = deduplicateConsecutivePoints(pts, 1e-4);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

const cmpPts = (a, b) => (Math.abs(a.x - b.x) > 1e-9 ? a.x - b.x : a.y - b.y);

function reverseCurveSpec(curve) {
  if (!curve) return null;
  if (curve.cp1 && curve.cp2) {
    return { cp1: { x: curve.cp2.x, y: curve.cp2.y }, cp2: { x: curve.cp1.x, y: curve.cp1.y } };
  }
  if (curve.cp) {
    return { cp: { x: curve.cp.x, y: curve.cp.y } };
  }
  return null;
}

function windingNumber(pt, poly) {
  let wn = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a.y <= pt.y) {
      if (b.y > pt.y && cross2(sub2(b, a), sub2(pt, a)) > 0) wn++;
    } else {
      if (b.y <= pt.y && cross2(sub2(b, a), sub2(pt, a)) < 0) wn--;
    }
  }
  return wn;
}

function pointToSegmentDist(p, a, b) {
  const ab = sub2(b, a);
  const m = Math.max(Math.abs(ab.x), Math.abs(ab.y));
  if (m === 0) return dist2D(p, a);
  if (m > 1e150) {
    const sab = { x: ab.x / m, y: ab.y / m };
    const slenSq = sab.x * sab.x + sab.y * sab.y;
    if (slenSq < 1e-24) return dist2D(p, a);
    const pa = sub2(p, a);
    const t = clamp(((pa.x / m) * sab.x + (pa.y / m) * sab.y) / slenSq, 0, 1);
    return dist2D(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
  }
  const lenSq = dot2(ab, ab);
  if (lenSq < 1e-12) return dist2D(p, a);
  const t = clamp(dot2(sub2(p, a), ab) / lenSq, 0, 1);
  return dist2D(p, add2(a, scale2(ab, t)));
}

function allVertsInsideOrOn(innerPoly, outerPoly, eps = 1e-3) {
  const n = outerPoly.length;
  let maxCoord = 1;
  for (const pt of innerPoly) {
    maxCoord = Math.max(maxCoord, Math.abs(pt.x), Math.abs(pt.y));
  }
  for (const pt of outerPoly) {
    maxCoord = Math.max(maxCoord, Math.abs(pt.x), Math.abs(pt.y));
  }
  const effEps = Math.max(eps, maxCoord * Number.EPSILON * 16);
  for (const pt of innerPoly) {
    let onEdge = false;
    for (let i = 0; i < n; i++) {
      if (pointToSegmentDist(pt, outerPoly[i], outerPoly[(i + 1) % n]) <= effEps) {
        onEdge = true;
        break;
      }
    }
    if (!onEdge && windingNumber(pt, outerPoly) === 0) return false;
  }
  return true;
}

function extractWindingLoopsAtScale(segs, splits, inRegionFn, clusterEps) {
  let maxAbsCoord = 1;
  for (const s of segs) {
    maxAbsCoord = Math.max(
      maxAbsCoord,
      Math.abs(s.a.x),
      Math.abs(s.a.y),
      Math.abs(s.b.x),
      Math.abs(s.b.y)
    );
  }
  const cellSize = Math.max(clusterEps * 4, 1e-3, maxAbsCoord * 1e-12);
  const verts = [];
  const grid = new Map();
  const getVid = (pt) => {
    const cx = Math.floor(pt.x / cellSize);
    const cy = Math.floor(pt.y / cellSize);
    let bestId = -1;
    let bestD = clusterEps;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx}_${cy + dy}`);
        if (!bucket) continue;
        for (const vid of bucket) {
          const d = dist2D(pt, verts[vid]);
          if (d < bestD) {
            bestD = d;
            bestId = vid;
          }
        }
      }
    }
    if (bestId !== -1) return bestId;
    const vid = verts.length;
    verts.push({ x: pt.x, y: pt.y });
    const key = `${cx}_${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(vid);
    return vid;
  };

  const seenSub = new Set();
  const subEdges = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = splits[i];
    const sdx = s.b.x - s.a.x;
    const sdy = s.b.y - s.a.y;
    const sm = Math.max(Math.abs(sdx), Math.abs(sdy));
    const sLen =
      sm > 0 && Number.isFinite(sm) ? sm * Math.hypot(sdx / sm, sdy / sm) : dist2D(s.a, s.b);
    const minDt =
      Number.isFinite(sLen) && sLen > 0 ? Math.min(1e-9, (clusterEps * 0.1) / sLen) : 1e-9;
    let prevVid = getVid(s.a);
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - ts[k - 1] < minDt && k < ts.length - 1) continue;
      const pt = k === ts.length - 1 ? s.b : lerp2(s.a, s.b, ts[k]);
      const nextVid = getVid(pt);
      if (nextVid !== prevVid) {
        const key = `${prevVid}_${nextVid}`;
        if (!seenSub.has(key)) {
          seenSub.add(key);
          const a = verts[prevVid];
          const b = verts[nextVid];
          subEdges.push({
            u: prevVid,
            v: nextVid,
            a,
            b,
            minX: Math.min(a.x, b.x),
            maxX: Math.max(a.x, b.x),
            minY: Math.min(a.y, b.y),
            maxY: Math.max(a.y, b.y),
          });
        }
        prevVid = nextVid;
      }
    }
  }

  const boundaryEdges = [];
  const adj = new Map();
  for (const se of subEdges) {
    const segLen = dist2D(se.a, se.b);
    if (segLen < 1e-6) continue;
    const rawDx = se.b.x - se.a.x;
    const rawDy = se.b.y - se.a.y;
    const segVec =
      Number.isFinite(rawDx) && Number.isFinite(rawDy)
        ? { x: rawDx, y: rawDy }
        : { x: se.b.x * 0.5 - se.a.x * 0.5, y: se.b.y * 0.5 - se.a.y * 0.5 };
    const dir = norm2(segVec);
    if (dir.x === 0 && dir.y === 0) continue;
    const leftN = { x: -dir.y, y: dir.x };
    const mid = lerp2(se.a, se.b, 0.5);
    const midMag = Math.max(Math.abs(mid.x), Math.abs(mid.y), 1);
    const minUlpStep = midMag * Number.EPSILON * 8;
    const maxEpsCap = Math.max(1e-2, midMag * 1e-9);
    const aabbCheckPad = Math.max(0.05, maxEpsCap * 4);

    let minOther = Infinity;
    for (const other of subEdges) {
      if ((other.u === se.u && other.v === se.v) || (other.u === se.v && other.v === se.u)) continue;
      if (
        mid.x + aabbCheckPad < other.minX ||
        mid.x - aabbCheckPad > other.maxX ||
        mid.y + aabbCheckPad < other.minY ||
        mid.y - aabbCheckPad > other.maxY
      ) {
        continue;
      }
      const d = pointToSegmentDist(mid, other.a, other.b);
      if (d > Math.max(1e-6, minUlpStep * 0.25) && d < minOther) minOther = d;
    }

    const minFloor = Math.max(1e-6, minUlpStep);
    const upperStep = Math.min(
      maxEpsCap,
      Number.isFinite(segLen) ? segLen * 0.1 : maxEpsCap,
      minOther * 0.25
    );
    const eps = Math.max(minFloor, upperStep);
    const pIn = add2(mid, scale2(leftN, eps));
    const pOut = add2(mid, scale2(leftN, -eps));
    if (inRegionFn(pIn) && !inRegionFn(pOut)) {
      const edge = { u: se.u, v: se.v, a: se.a, b: se.b, dir, used: false };
      boundaryEdges.push(edge);
      if (!adj.has(se.u)) adj.set(se.u, []);
      adj.get(se.u).push(edge);
    }
  }

  const loops = [];
  const maxSteps = boundaryEdges.length + 4;
  for (const startEdge of boundaryEdges) {
    if (startEdge.used) continue;
    const traceEdges = [startEdge];
    const loopVerts = [startEdge.a];
    const visitedAt = new Map([[startEdge.u, 0]]);
    startEdge.used = true;
    let curr = startEdge;
    let closedSlice = null;

    for (let step = 0; step < maxSteps; step++) {
      const v = curr.v;
      if (visitedAt.has(v)) {
        const idx = visitedAt.get(v);
        for (let p = 0; p < idx; p++) {
          traceEdges[p].used = false;
        }
        closedSlice = loopVerts.slice(idx);
        break;
      }
      const candidates = (adj.get(v) || []).filter((e) => !e.used);
      if (candidates.length === 0) {
        for (const e of traceEdges) e.used = false;
        break;
      }
      let nextEdge = candidates[0];
      if (candidates.length > 1) {
        let bestAng = Infinity;
        for (const cand of candidates) {
          let ang = Math.atan2(cross2(curr.dir, cand.dir), dot2(curr.dir, cand.dir));
          if (ang > Math.PI - 1e-7) ang -= 2 * Math.PI;
          if (ang < bestAng) {
            bestAng = ang;
            nextEdge = cand;
          }
        }
      }
      visitedAt.set(v, loopVerts.length);
      loopVerts.push(curr.b);
      nextEdge.used = true;
      traceEdges.push(nextEdge);
      curr = nextEdge;
    }

    if (closedSlice && closedSlice.length >= 3) {
      const cleanLoop = stripBacktrackingSpikes(closedSlice);
      if (cleanLoop.length >= 3) {
        loops.push(cleanLoop);
      }
    }
  }

  loops.sort((a, b) => signedPolygonArea(b) - signedPolygonArea(a));
  return loops;
}

function extractWindingLoops(inputPolys, inRegionFn) {
  const segs = [];
  let maxCoord = 1;
  let minSegLen = Infinity;
  for (const poly of inputPolys) {
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const sl = dist2D(a, b);
      if (sl <= 1e-6) continue;
      maxCoord = Math.max(maxCoord, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y));
      if (sl < minSegLen) minSegLen = sl;
      segs.push({
        a,
        b,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
  }
  if (segs.length < 3) return [];

  const minSplitParam = (seg) => {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (!(m > 0) || !Number.isFinite(m)) return 1e-7;
    const len = m * Math.hypot(dx / m, dy / m);
    if (!(len > 0) || !Number.isFinite(len)) return 1e-7;
    const segCoord = Math.max(
      Math.abs(seg.a.x),
      Math.abs(seg.a.y),
      Math.abs(seg.b.x),
      Math.abs(seg.b.y)
    );
    const physTol = Math.max(1e-7 * Math.min(1, len), segCoord * Number.EPSILON * 16);
    return Math.min(1e-7, Math.max(1e-15, physTol / len));
  };

  const ulpScale = maxCoord * Number.EPSILON;
  const splits = Array.from({ length: segs.length }, () => [0, 1]);
  const aabbEps = Math.max(1e-4, ulpScale * 16);
  for (let i = 0; i < segs.length; i++) {
    const s1 = segs[i];
    const eps1 = minSplitParam(s1);
    for (let j = i + 1; j < segs.length; j++) {
      const s2 = segs[j];
      if (
        s1.maxX + aabbEps < s2.minX ||
        s2.maxX + aabbEps < s1.minX ||
        s1.maxY + aabbEps < s2.minY ||
        s2.maxY + aabbEps < s1.minY
      ) {
        continue;
      }
      const hit = segmentIntersection2D(s1.a, s1.b, s2.a, s2.b);
      if (!hit) continue;
      const eps2 = minSplitParam(s2);
      if (!hit.collinear) {
        if (hit.t > eps1 && hit.t < 1 - eps1) splits[i].push(hit.t);
        if (hit.u > eps2 && hit.u < 1 - eps2) splits[j].push(hit.u);
      } else {
        const projCollinear = (baseA, baseB, targetPt) => {
          const r = sub2(baseB, baseA);
          const m = Math.max(Math.abs(r.x), Math.abs(r.y));
          if (m === 0) return null;
          if (m > 1e150) {
            const sr = { x: r.x / m, y: r.y / m };
            const srr = sr.x * sr.x + sr.y * sr.y;
            if (srr <= 1e-24) return null;
            const d = sub2(targetPt, baseA);
            return ((d.x / m) * sr.x + (d.y / m) * sr.y) / srr;
          }
          const rr = dot2(r, r);
          return rr > 1e-12 ? dot2(sub2(targetPt, baseA), r) / rr : null;
        };
        const tA = projCollinear(s1.a, s1.b, s2.a);
        const tB = projCollinear(s1.a, s1.b, s2.b);
        if (tA !== null && tA > eps1 && tA < 1 - eps1) splits[i].push(tA);
        if (tB !== null && tB > eps1 && tB < 1 - eps1) splits[i].push(tB);
        const uA = projCollinear(s2.a, s2.b, s1.a);
        const uB = projCollinear(s2.a, s2.b, s1.b);
        if (uA !== null && uA > eps2 && uA < 1 - eps2) splits[j].push(uA);
        if (uB !== null && uB > eps2 && uB < 1 - eps2) splits[j].push(uB);
      }
    }
  }
  for (let i = 0; i < splits.length; i++) {
    splits[i].sort((a, b) => a - b);
  }

  let cepsList = [5e-3, 1e-3, 2e-4];
  if (ulpScale * 32 > 2e-4) {
    const cap = Number.isFinite(minSegLen) ? Math.max(ulpScale * 4, minSegLen * 0.2) : Infinity;
    const baseEps = Math.min(cap, Math.max(5e-3, ulpScale * 32));
    cepsList = [
      Math.min(cap, baseEps * 4),
      baseEps,
      Math.max(ulpScale * 4, baseEps * 0.2),
    ];
  }

  for (const ceps of cepsList) {
    const loops = extractWindingLoopsAtScale(segs, splits, inRegionFn, ceps);
    if (loops.length > 0 && !polygonSelfIntersects(loops[0])) {
      return loops;
    }
  }
  return extractWindingLoopsAtScale(segs, splits, inRegionFn, cepsList[0]);
}

export function clipSelfIntersectingLoops(poly, origWindingSign = 1, unionPoly = null) {
  let pts = stripBacktrackingSpikes(poly);
  if (pts.length < 4) return pts;

  const ccwPts = origWindingSign < 0 ? [...pts].reverse() : pts;
  const rawUnion = Array.isArray(unionPoly) && unionPoly.length >= 3 ? stripBacktrackingSpikes(unionPoly) : null;
  const ccwUnion =
    rawUnion && rawUnion.length >= 3
      ? signedPolygonArea(rawUnion) < 0
        ? [...rawUnion].reverse()
        : rawUnion
      : null;

  const refBounds = polygonBounds(ccwUnion ? [...ccwPts, ...ccwUnion] : ccwPts);
  const centerX = refBounds.minX * 0.5 + refBounds.maxX * 0.5;
  const centerY = refBounds.minY * 0.5 + refBounds.maxY * 0.5;
  const maxCenter = Math.max(Math.abs(centerX), Math.abs(centerY));
  const maxSpan = Math.max(refBounds.width, refBounds.height, 1);
  let workPts = ccwPts;
  let workUnion = ccwUnion;
  let shiftedOrigin = null;
  if (
    Number.isFinite(centerX) &&
    Number.isFinite(centerY) &&
    maxCenter > 1e6 &&
    maxCenter > maxSpan * 0.5
  ) {
    const sPts = ccwPts.map((p) => ({ x: p.x - centerX, y: p.y - centerY }));
    const sUnion = ccwUnion ? ccwUnion.map((p) => ({ x: p.x - centerX, y: p.y - centerY })) : null;
    if (allFinitePt2(sPts) && (!sUnion || allFinitePt2(sUnion))) {
      workPts = sPts;
      workUnion = sUnion;
      shiftedOrigin = { x: centerX, y: centerY };
    }
  }

  let bestWork = workPts;
  let modified = false;
  if (polygonSelfIntersects(workPts)) {
    const loops = extractWindingLoops([workPts], (pt) => windingNumber(pt, workPts) > 0);
    if (loops.length > 0) {
      bestWork = loops[0];
      modified = true;
    }
  }

  if (workUnion && !allVertsInsideOrOn(workUnion, bestWork)) {
    const unionLoops = extractWindingLoops(
      [workPts, workUnion],
      (pt) => windingNumber(pt, workPts) > 0 || windingNumber(pt, workUnion) > 0
    );
    if (unionLoops.length > 0 && signedPolygonArea(unionLoops[0]) > 1e-3) {
      bestWork = unionLoops[0];
      modified = true;
    }
  }

  let bestCCW = ccwPts;
  if (modified) {
    if (shiftedOrigin) {
      const restored = bestWork.map((p) => ({ x: p.x + shiftedOrigin.x, y: p.y + shiftedOrigin.y }));
      bestCCW = allFinitePt2(restored) ? restored : ccwPts;
    } else {
      bestCCW = bestWork;
    }
  }

  return origWindingSign < 0 ? [...bestCCW].reverse() : bestCCW;
}

function buildOffsetEdge(p0, p1, allowance, windingSign) {
  const dir = norm2(sub2(p1, p0));
  const normal = {
    x: dir.y * windingSign,
    y: -dir.x * windingSign,
  };
  return {
    p0: add2(p0, scale2(normal, allowance)),
    p1: add2(p1, scale2(normal, allowance)),
    dir,
    len: dist2D(p0, p1),
    normal,
    allowance,
    origStart: p0,
    origEnd: p1,
  };
}

function emitCornerPoints(prevEdge, currEdge, vertex, windingSign, miterLimit, out) {
  const localAllowance = Math.max(Math.abs(prevEdge.allowance), Math.abs(currEdge.allowance), 1e-3);
  const denom = cross2(prevEdge.dir, currEdge.dir);
  const dotDir = dot2(prevEdge.dir, currEdge.dir);
  const hasDiffSA = Math.abs(prevEdge.allowance - currEdge.allowance) > 1e-4;

  // Use a wider near-collinear threshold when adjacent allowances differ to prevent miter spikes
  const collinearThresh = hasDiffSA ? 0.08 : 1e-5;
  if (Math.abs(denom) < collinearThresh) {
    if (dotDir >= 0) {
      if (hasDiffSA) {
        out.push(prevEdge.p1, currEdge.p0);
      } else {
        out.push(currEdge.p0);
      }
    } else {
      // 180-degree reversal: flat cap across tip
      out.push(prevEdge.p1, currEdge.p0);
    }
    return;
  }

  const diff = sub2(currEdge.p0, prevEdge.p0);
  const tPrev = cross2(diff, currEdge.dir) / denom;
  const tCurr = cross2(diff, prevEdge.dir) / denom;
  const miterPt = add2(prevEdge.p0, scale2(prevEdge.dir, tPrev));
  const miterDist = dist2D(vertex, miterPt);
  const isConvex = denom * windingSign > 0;
  const safeMiterLimit = Math.max(
    1.0,
    miterLimit === null || miterLimit === undefined ? 3.0 : finiteOr(miterLimit, 3.0)
  );
  const maxMiterDist = localAllowance * safeMiterLimit;
  if (localAllowance > MAX_SAFE_OFFSET_MM || !Number.isFinite(maxMiterDist)) {
    throw new ValidationError(
      `Seam allowance exceeds maximum finite geometry bounds (${MAX_SAFE_OFFSET_MM} mm).`,
      {
        code: 'INVALID_DIMENSIONS',
        path: 'seamAllowance',
      }
    );
  }
  const diffSaOvershoot =
    hasDiffSA &&
    (tPrev < -1e-4 ||
      tCurr > currEdge.len + 1e-4 ||
      (!isConvex && (tPrev > prevEdge.len + 1e-4 || tCurr < -1e-4)));

  if (!Number.isFinite(miterDist) || !isFinitePt2(miterPt) || miterDist > maxMiterDist || diffSaOvershoot) {
    if (isConvex && !diffSaOvershoot) {
      const bisectorSum = add2(prevEdge.normal, currEdge.normal);
      if (len2(bisectorSum) > 1e-6) {
        const bNormal = norm2(bisectorSum);
        const dBevel = maxMiterDist;
        const d1 = dot2(prevEdge.dir, bNormal);
        const d2 = dot2(currEdge.dir, bNormal);
        if (Math.abs(d1) > 1e-4 && Math.abs(d2) > 1e-4) {
          const s1 = (dBevel - dot2(sub2(prevEdge.p0, vertex), bNormal)) / d1;
          const s2 = (dBevel - dot2(sub2(currEdge.p0, vertex), bNormal)) / d2;
          const bevel1 = add2(prevEdge.p0, scale2(prevEdge.dir, s1));
          const bevel2 = add2(currEdge.p0, scale2(currEdge.dir, s2));
          if (
            isFinitePt2(bevel1) &&
            isFinitePt2(bevel2) &&
            dist2D(vertex, bevel1) <= maxMiterDist * 1.5 + 1 &&
            dist2D(vertex, bevel2) <= maxMiterDist * 1.5 + 1
          ) {
            out.push(bevel1);
            if (dist2D(bevel1, bevel2) > 1e-3) {
              out.push(bevel2);
            }
            return;
          }
        }
      }
    }
    // Bounded step/cap for concave miter-limit exceedance, diff-SA overshoot, or degenerate bevels
    out.push(prevEdge.p1);
    if (dist2D(prevEdge.p1, currEdge.p0) > 0.25) {
      out.push(currEdge.p0);
    }
  } else {
    out.push(miterPt);
  }
}

export function offsetPolygonOutward(points, defaultAllowanceMm = 10, edgeAllowances = null, miterLimit = 3.0) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const safeMiterLimit = Math.max(
    1.0,
    miterLimit === null || miterLimit === undefined ? 3.0 : finiteOr(miterLimit, 3.0)
  );

  const rawHasPerEdge = Array.isArray(edgeAllowances) && edgeAllowances.length === points.length;
  const clean = [];
  const cleanAllowances = [];
  const eps = 1e-4;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    if (clean.length === 0 || dist2D(pt, clean[clean.length - 1]) > eps) {
      clean.push({ x: pt.x, y: pt.y });
      if (rawHasPerEdge) {
        cleanAllowances.push(edgeAllowances[i]);
      }
    } else if (rawHasPerEdge) {
      // Lockstep replacement: outgoing edge from this duplicate point uses edgeAllowances[i]
      cleanAllowances[cleanAllowances.length - 1] = edgeAllowances[i];
    }
  }

  if (clean.length > 1 && dist2D(clean[0], clean[clean.length - 1]) <= eps) {
    clean.pop();
    if (rawHasPerEdge) cleanAllowances.pop();
  }

  if (clean.length < 3) return clean;

  const hasPerEdge = rawHasPerEdge && cleanAllowances.length === clean.length;
  const safeDefault =
    defaultAllowanceMm !== undefined && defaultAllowanceMm !== null
      ? finiteOr(defaultAllowanceMm, 10)
      : 10;
  const signedA = signedPolygonArea(clean);
  const origWindingSign = signedA >= 0 ? 1 : -1;
  const n = clean.length;

  const ccw = origWindingSign < 0 ? [...clean].reverse() : clean;
  const ccwAllowances = hasPerEdge
    ? origWindingSign < 0
      ? cleanAllowances.map((_, i) => cleanAllowances[(n - 2 - i + n) % n])
      : cleanAllowances
    : null;

  const resolvedAllowances = new Array(n);
  let minAllowance = Infinity;
  let maxAbsAllowance = 0;
  for (let i = 0; i < n; i++) {
    const a = ccwAllowances
      ? ccwAllowances[i] !== undefined && ccwAllowances[i] !== null
        ? finiteOr(ccwAllowances[i], safeDefault)
        : safeDefault
      : safeDefault;
    resolvedAllowances[i] = a;
    if (a < minAllowance) minAllowance = a;
    if (Math.abs(a) > maxAbsAllowance) maxAbsAllowance = Math.abs(a);
  }

  if (maxAbsAllowance < 1e-6) {
    return clean.map((p) => ({ x: p.x, y: p.y }));
  }

  if (maxAbsAllowance > MAX_SAFE_OFFSET_MM || !Number.isFinite(maxAbsAllowance * safeMiterLimit)) {
    throw new ValidationError(
      `Seam allowance exceeds maximum finite geometry bounds (${MAX_SAFE_OFFSET_MM} mm).`,
      {
        code: 'INVALID_DIMENSIONS',
        path: 'seamAllowance',
      }
    );
  }

  const offsetEdges = [];
  for (let i = 0; i < n; i++) {
    const p0 = ccw[i];
    const p1 = ccw[(i + 1) % n];
    const edge = buildOffsetEdge(p0, p1, resolvedAllowances[i], 1);
    if (!isFinitePt2(edge.p0) || !isFinitePt2(edge.p1)) {
      throw new ValidationError('Offset polygon edge overflows finite geometry bounds.', {
        code: 'INVALID_DIMENSIONS',
        path: 'seamAllowance',
      });
    }
    offsetEdges.push(edge);
  }

  const result = [];
  for (let i = 0; i < n; i++) {
    const prevEdge = offsetEdges[(i - 1 + n) % n];
    const currEdge = offsetEdges[i];
    emitCornerPoints(prevEdge, currEdge, ccw[i], 1, safeMiterLimit, result);
  }

  if (!allFinitePt2(result)) {
    throw new ValidationError('Offset polygon vertices overflow finite geometry bounds.', {
      code: 'INVALID_DIMENSIONS',
      path: 'seamAllowance',
    });
  }

  const clippedCCW = clipSelfIntersectingLoops(result, 1, minAllowance >= -1e-6 ? ccw : null);
  if (!allFinitePt2(clippedCCW)) {
    throw new ValidationError('Clipped offset polygon overflows finite geometry bounds.', {
      code: 'INVALID_DIMENSIONS',
      path: 'seamAllowance',
    });
  }
  return origWindingSign < 0 ? [...clippedCCW].reverse() : clippedCCW;
}

// ============================================================================
// Dart Resolution, Piece Outline & Cut Boundary (V-Cutouts & Folded Cap Truing)
// ============================================================================

export function resolveEdgeDarts(p0, p1, curve, rawDarts, edgeIndex, windingSign = 1) {
  const edgeDarts = (Array.isArray(rawDarts) ? rawDarts : []).filter(
    (d) =>
      d &&
      typeof d === 'object' &&
      d.edgeIndex === edgeIndex &&
      Number.isFinite(safeNumber(d.widthMm)) &&
      safeNumber(d.widthMm) > 0 &&
      Number.isFinite(safeNumber(d.depthMm)) &&
      safeNumber(d.depthMm) > 0
  );

  if (edgeDarts.length === 0) return [];

  const flip = cmpPts(p0, p1) > 0;
  const cP0 = flip ? p1 : p0;
  const cP1 = flip ? p0 : p1;
  const cCurve = flip ? reverseCurveSpec(curve) : curve;

  const table = buildEdgeArcTable(cP0, cP1, cCurve, 64);
  const edgeLen = table.totalLen;
  if (edgeLen < 1e-3) return [];

  const sorted = edgeDarts
    .map((dart) => {
      const rawT = clamp(finiteOr(dart.t, 0.5), 0.005, 0.995);
      return { dart, ct: flip ? 1 - rawT : rawT };
    })
    .sort((a, b) => a.ct - b.ct);

  const sMinEdge = edgeLen * 0.005;
  const sMaxEdge = edgeLen * 0.995;
  const usableSpan = sMaxEdge - sMinEdge;
  const minGap = Math.min(0.5, edgeLen * 0.002);

  const resolved = [];
  let hasPrev = false;
  let curS = 0;

  for (const { dart, ct } of sorted) {
    const halfW = Math.min(safeNumber(dart.widthMm) * 0.5, usableSpan * 0.48);
    const minSMid = hasPrev ? Math.max(sMinEdge + halfW, curS + minGap + halfW) : sMinEdge + halfW;
    const maxSMid = sMaxEdge - halfW;
    if (minSMid > maxSMid + 1e-6) continue;

    const sTarget = arcLengthAtT(table, ct);
    const sMid = clamp(sTarget, minSMid, maxSMid);
    const sStart = Math.max(sMinEdge, sMid - halfW);
    const sEnd = Math.min(sMaxEdge, sMid + halfW);

    const ctStart = tAtArcLength(table, sStart);
    const ctMid = tAtArcLength(table, sMid);
    const ctEnd = tAtArcLength(table, sEnd);
    if (ctEnd - ctStart <= 1e-6) continue;

    const tStart = flip ? 1 - ctEnd : ctStart;
    const tMid = flip ? 1 - ctMid : ctMid;
    const tEnd = flip ? 1 - ctStart : ctEnd;

    const dStart = evalEdgeAt(p0, p1, curve, tStart);
    const dMid = evalEdgeAt(p0, p1, curve, tMid);
    const dEnd = evalEdgeAt(p0, p1, curve, tEnd);
    const tanMid = evalEdgeTangentAt(p0, p1, curve, tMid);
    const inwardNormal = { x: -tanMid.y * windingSign, y: tanMid.x * windingSign };
    const depthMm = safeNumber(dart.depthMm);
    const apex = add2(dMid, scale2(inwardNormal, depthMm));

    resolved.push({
      dart,
      tStart,
      tMid,
      tEnd,
      sStart,
      sEnd,
      intakeMm: Math.max(0, sEnd - sStart),
      dStart,
      dMid,
      dEnd,
      apex,
      inwardNormal,
      depthMm,
      folded: parseBoolFlag(dart.folded),
    });
    curS = sEnd;
    hasPrev = true;
  }

  if (flip) resolved.reverse();
  return resolved;
}

function buildPieceBaseBoundaryData(pts, edges, curveSegments) {
  const segs = sanitizeSegments(curveSegments, 16, 2, 4096);
  const n = pts.length;
  const edgePolys = new Array(n);
  const baseOutline = [];
  for (let i = 0; i < n; i++) {
    const samples = sampleEdgePoints(pts[i], pts[(i + 1) % n], edges[i]?.curve, segs);
    edgePolys[i] = samples;
    for (let j = 0; j < samples.length - 1; j++) {
      baseOutline.push(samples[j]);
    }
  }
  return { edgePolys, baseOutline: deduplicateConsecutivePoints(baseOutline, 1e-4) };
}

function clampDartApexToBoundary(
  p0,
  p1,
  curve,
  rd,
  allEdgeDarts,
  edgeIndex,
  edgePolys,
  baseOutline,
  curveSegments,
  priorUnfoldedDarts = []
) {
  if (rd.folded) return;

  const sameEdgeOutsidePolys = [];
  const sampleSpan = (tA, tB) => {
    if (tB - tA <= 1e-4) return;
    const steps = curve ? Math.max(2, Math.ceil((tB - tA) * curveSegments)) : 1;
    const arr = [];
    for (let s = 0; s <= steps; s++) {
      arr.push(evalEdgeAt(p0, p1, curve, tA + ((tB - tA) * s) / steps));
    }
    sameEdgeOutsidePolys.push(arr);
  };

  let curT = 0;
  for (const r of allEdgeDarts) {
    sampleSpan(curT, r.tStart);
    curT = Math.max(curT, r.tEnd);
  }
  sampleSpan(curT, 1);

  const testCross = (apexPt) => {
    if (!pointInPolygon(apexPt, baseOutline)) return true;
    const checkLegsAgainstPoly = (poly) => {
      for (let k = 0; k < poly.length - 1; k++) {
        const b1 = poly[k];
        const b2 = poly[k + 1];
        const h1 = segmentIntersection2D(rd.dStart, apexPt, b1, b2);
        if (h1 && h1.t > 1e-3 && h1.t <= 1 + 1e-6) return true;
        const h2 = segmentIntersection2D(rd.dEnd, apexPt, b1, b2);
        if (h2 && h2.t > 1e-3 && h2.t <= 1 + 1e-6) return true;
      }
      return false;
    };
    for (let j = 0; j < edgePolys.length; j++) {
      if (j === edgeIndex) continue;
      if (checkLegsAgainstPoly(edgePolys[j])) return true;
    }
    for (const poly of sameEdgeOutsidePolys) {
      if (checkLegsAgainstPoly(poly)) return true;
    }
    for (const other of priorUnfoldedDarts) {
      const oLegs = [
        [other.dStart, other.apex],
        [other.apex, other.dEnd],
      ];
      for (const [b1, b2] of oLegs) {
        const h1 = segmentIntersection2D(rd.dStart, apexPt, b1, b2);
        if (h1 && !(h1.t <= 1e-5 && (h1.u <= 1e-5 || h1.u >= 1 - 1e-5))) return true;
        const h2 = segmentIntersection2D(rd.dEnd, apexPt, b1, b2);
        if (h2 && !(h2.t <= 1e-5 && (h2.u <= 1e-5 || h2.u >= 1 - 1e-5))) return true;
      }
      if (pointInTriangle2D(apexPt, other.dStart, other.apex, other.dEnd)) {
        return true;
      }
      if (pointInTriangle2D(other.apex, rd.dStart, apexPt, rd.dEnd)) {
        return true;
      }
    }
    return false;
  };

  if (!testCross(rd.apex)) return;

  const nLen = Math.hypot(rd.inwardNormal.x, rd.inwardNormal.y);
  if (!Number.isFinite(nLen) || nLen <= 1e-12) return;
  const unitNormal = { x: rd.inwardNormal.x / nLen, y: rd.inwardNormal.y / nLen };

  const bounds = polygonBounds(baseOutline);
  const diag = Math.hypot(bounds.width, bounds.height);
  const maxDepth = Number.isFinite(diag) && diag > 0 ? Math.min(rd.depthMm, diag) : rd.depthMm;

  const rayHitDist = (a, b) => {
    const scaleMax = Math.max(
      Math.abs(rd.dMid.x),
      Math.abs(rd.dMid.y),
      Math.abs(a.x),
      Math.abs(a.y),
      Math.abs(b.x),
      Math.abs(b.y)
    );
    const inv = scaleMax > 1e140 ? 1 / scaleMax : 1;
    const ox = rd.dMid.x * inv;
    const oy = rd.dMid.y * inv;
    const ax = a.x * inv;
    const ay = a.y * inv;
    const bx = b.x * inv;
    const by = b.y * inv;
    const sx = bx - ax;
    const sy = by - ay;
    const sLen = Math.hypot(sx, sy);
    if (!(sLen > 0)) return Infinity;
    const snx = sx / sLen;
    const sny = sy / sLen;
    const denom = unitNormal.x * sny - unitNormal.y * snx;
    if (Math.abs(denom) < 1e-12) return Infinity;
    const wx = ax - ox;
    const wy = ay - oy;
    const dScaled = (wx * sny - wy * snx) / denom;
    const uScaled = (wx * unitNormal.y - wy * unitNormal.x) / denom;
    if (uScaled < -1e-6 * sLen || uScaled > sLen * (1 + 1e-6)) return Infinity;
    const d = inv === 1 ? dScaled : dScaled * scaleMax;
    return Number.isFinite(d) && d > 1e-6 ? d : Infinity;
  };

  let hi = maxDepth;
  const checkPolyRay = (poly) => {
    for (let k = 0; k < poly.length - 1; k++) {
      const d = rayHitDist(poly[k], poly[k + 1]);
      if (d < hi) hi = d;
    }
  };
  for (let j = 0; j < edgePolys.length; j++) {
    if (j === edgeIndex) continue;
    checkPolyRay(edgePolys[j]);
  }
  for (const poly of sameEdgeOutsidePolys) {
    checkPolyRay(poly);
  }
  for (const other of priorUnfoldedDarts) {
    for (const [b1, b2] of [
      [other.dStart, other.apex],
      [other.apex, other.dEnd],
    ]) {
      const d = rayHitDist(b1, b2);
      if (d < hi) hi = d;
    }
  }

  let lo = 0;
  for (let iter = 0; iter < 64; iter++) {
    if (iter >= 24 && lo > 0 && hi - lo <= Math.max(1e-6, lo * 1e-6)) break;
    const mid = (lo + hi) * 0.5;
    if (!(mid > lo && mid < hi)) break;
    const cand = add2(rd.dMid, scale2(unitNormal, mid));
    if (testCross(cand)) hi = mid;
    else lo = mid;
  }
  const safeCand = add2(rd.dMid, scale2(unitNormal, lo * 0.92));
  rd.apex = !testCross(safeCand) ? safeCand : add2(rd.dMid, scale2(unitNormal, lo));
}

function computePieceSampledSignedArea(pts, edges = [], curveSegments = 16) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const segs = sanitizeSegments(curveSegments, 16, 12, 4096);
  const { baseOutline } = buildPieceBaseBoundaryData(pts, edges || [], segs);
  if (baseOutline.length >= 3) {
    const sampledArea = signedPolygonArea(baseOutline);
    if (Math.abs(sampledArea) > 1e-9) {
      return sampledArea;
    }
  }
  return signedPolygonArea(pts);
}

function canonicalizePieceToCCW(piece) {
  const rawPts = piece.points;
  const n = rawPts.length;
  const rawEdges = Array.isArray(piece.edges) ? piece.edges : [];
  const rawDarts = Array.isArray(piece.darts) ? piece.darts : [];
  const wasCW = computePieceSampledSignedArea(rawPts, rawEdges, 16) < 0;

  let ccwPts;
  let ccwEdges;
  let ccwDarts;

  if (wasCW) {
    ccwPts = [...rawPts].reverse().map((p) => ({ x: p.x, y: p.y }));
    ccwEdges = Array.from({ length: n }, (_, i) => {
      const srcIdx = (n - 2 - i + n) % n;
      const rawSrc = rawEdges[srcIdx];
      const srcEdge = rawSrc && typeof rawSrc === 'object' ? rawSrc : {};
      return {
        ...srcEdge,
        curve: reverseCurveSpec(srcEdge.curve),
      };
    });
    ccwDarts = rawDarts.map((d) => {
      if (!d || typeof d !== 'object' || typeof d.edgeIndex !== 'number') return d;
      const eIdx = ((Math.trunc(d.edgeIndex) % n) + n) % n;
      return {
        ...d,
        edgeIndex: (n - 2 - eIdx + n) % n,
        t: 1 - clamp(finiteOr(d.t, 0.5), 0.005, 0.995),
      };
    });
  } else {
    ccwPts = rawPts.map((p) => ({ x: p.x, y: p.y }));
    ccwEdges = Array.from({ length: n }, (_, i) =>
      rawEdges[i] && typeof rawEdges[i] === 'object' ? rawEdges[i] : {}
    );
    ccwDarts = rawDarts;
  }

  let minIdx = 0;
  for (let i = 1; i < n; i++) {
    if (cmpPts(ccwPts[i], ccwPts[minIdx]) < 0) minIdx = i;
  }
  if (minIdx !== 0) {
    ccwPts = [...ccwPts.slice(minIdx), ...ccwPts.slice(0, minIdx)];
    ccwEdges = [...ccwEdges.slice(minIdx), ...ccwEdges.slice(0, minIdx)];
    ccwDarts = ccwDarts.map((d) => {
      if (!d || typeof d.edgeIndex !== 'number') return d;
      return {
        ...d,
        edgeIndex: (d.edgeIndex - minIdx + n) % n,
      };
    });
  }

  return { wasCW, pts: ccwPts, edges: ccwEdges, darts: ccwDarts };
}

export function samplePieceOutline(piece, curveSegments = 16, options = {}) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3 || !allFinitePt2(piece.points)) {
    return [];
  }
  const segs = sanitizeSegments(curveSegments, 16, 2, 4096);
  const rawDarts = Array.isArray(piece.darts) ? piece.darts : [];
  const hasAnyDart = rawDarts.some((d) => d && typeof d === 'object' && safeNumber(d.widthMm) > 0 && safeNumber(d.depthMm) > 0);
  const canon = hasAnyDart ? canonicalizePieceToCCW(piece) : null;
  const pts = canon ? canon.pts : piece.points;
  const n = pts.length;
  const edges = canon ? canon.edges : Array.isArray(piece.edges) ? piece.edges : [];
  const darts = canon ? canon.darts : rawDarts;
  const windingSign = canon ? 1 : computePieceSampledSignedArea(pts, edges, segs) >= 0 ? 1 : -1;
  const baseData = hasAnyDart ? buildPieceBaseBoundaryData(pts, edges, segs) : null;
  const placedUnfoldedDarts = [];
  const result = [];

  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const edgeMeta = edges[i] || {};
    const resolvedDarts = resolveEdgeDarts(p0, p1, edgeMeta.curve, darts, i, windingSign);

    if (resolvedDarts.length === 0) {
      const edgeSamples = sampleEdgePoints(p0, p1, edgeMeta.curve, segs);
      for (let j = 0; j < edgeSamples.length - 1; j++) {
        result.push(edgeSamples[j]);
      }
    } else {
      for (const rd of resolvedDarts) {
        clampDartApexToBoundary(
          p0,
          p1,
          edgeMeta.curve,
          rd,
          resolvedDarts,
          i,
          baseData.edgePolys,
          baseData.baseOutline,
          segs,
          placedUnfoldedDarts
        );
        if (!rd.folded) {
          placedUnfoldedDarts.push(rd);
        }
      }

      const sampleSubCurve = (tFrom, tTo, includeEnd = false) => {
        if (tTo - tFrom <= 1e-6) return;
        const steps = edgeMeta.curve ? Math.max(2, Math.ceil((tTo - tFrom) * segs)) : 1;
        const limit = includeEnd ? steps : steps - 1;
        for (let s = 0; s <= limit; s++) {
          const t = tFrom + ((tTo - tFrom) * s) / steps;
          result.push(evalEdgeAt(p0, p1, edgeMeta.curve, t));
        }
      };

      let curT = 0;
      for (const rd of resolvedDarts) {
        sampleSubCurve(curT, rd.tStart, false);
        if (!rd.folded) {
          result.push(rd.dStart, rd.apex, rd.dEnd);
        } else {
          // Folded dart: bridge smoothly across the dart mouth along the seam curve
          sampleSubCurve(rd.tStart, rd.tEnd, false);
        }
        curT = rd.tEnd;
      }
      sampleSubCurve(curT, 1.0, false);
    }
  }

  let outline = deduplicateConsecutivePoints(result, 1e-4);
  if (canon?.wasCW) {
    outline = [...outline].reverse();
  }
  return parseBoolFlag(options?.worldSpace) ? transformPiecePoints(outline, piece, options) : outline;
}

function computeFoldedDartCapPeak(p0, p1, curve, rd, edgeSa, windingSign) {
  const nStart = evalEdgeNormalAt(p0, p1, curve, rd.tStart, windingSign);
  const nMid = evalEdgeNormalAt(p0, p1, curve, rd.tMid, windingSign);
  const nEnd = evalEdgeNormalAt(p0, p1, curve, rd.tEnd, windingSign);

  const cStart = add2(rd.dStart, scale2(nStart, edgeSa));
  const cMid = add2(rd.dMid, scale2(nMid, edgeSa));
  const cEnd = add2(rd.dEnd, scale2(nEnd, edgeSa));

  if (edgeSa <= 1e-6) {
    return { cStart, peak: rd.dMid, cEnd };
  }

  // Scale half-differences so theta and apex->cMid direction remain accurate even at 1e308 depth
  const hv1 = { x: rd.dStart.x * 0.5 - rd.apex.x * 0.5, y: rd.dStart.y * 0.5 - rd.apex.y * 0.5 };
  const hv2 = { x: rd.dEnd.x * 0.5 - rd.apex.x * 0.5, y: rd.dEnd.y * 0.5 - rd.apex.y * 0.5 };
  const scaleV = Math.max(Math.abs(hv1.x), Math.abs(hv1.y), Math.abs(hv2.x), Math.abs(hv2.y), 1);
  const nv1 = { x: hv1.x / scaleV, y: hv1.y / scaleV };
  const nv2 = { x: hv2.x / scaleV, y: hv2.y / scaleV };
  const theta = Math.atan2(cross2(nv2, nv1), dot2(nv2, nv1));

  const halfU = { x: cMid.x * 0.5 - rd.apex.x * 0.5, y: cMid.y * 0.5 - rd.apex.y * 0.5 };
  const halfR = len2(halfU);
  if (halfR < 1e-12) {
    return { cStart, peak: cMid, cEnd };
  }
  const dirMid = { x: halfU.x / halfR, y: halfU.y / halfR };
  const rMid = halfR * 2;
  const uApexToMid = sub2(cMid, rd.apex);

  const tL = evalEdgeTangentAt(p0, p1, curve, rd.tStart);
  const tR = evalEdgeTangentAt(p0, p1, curve, rd.tEnd);
  const tRRot = rotate2(tR, theta, { x: 0, y: 0 });

  let deltaR = 0;
  const denom = cross2(tL, tRRot);
  if (Math.abs(denom) > 1e-4 && Number.isFinite(uApexToMid.x) && Number.isFinite(uApexToMid.y)) {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const oneMinusCos = 2 * Math.sin(theta * 0.5) ** 2;
    const dEnd = sub2(cEnd, cMid);
    const dStart = sub2(cStart, cMid);
    const dEndRotRel = {
      x: dEnd.x * cosT - dEnd.y * sinT - oneMinusCos * uApexToMid.x - sinT * uApexToMid.y,
      y: dEnd.x * sinT + dEnd.y * cosT + sinT * uApexToMid.x - oneMinusCos * uApexToMid.y,
    };
    const s1 = cross2(sub2(dEndRotRel, dStart), tRRot) / denom;
    const mRel = add2(dStart, scale2(tL, s1));
    const mFolded = add2(cMid, mRel);
    if (dist2D(mFolded, cStart) < Math.max(rd.dart.widthMm * 2, edgeSa * 4, 20)) {
      const wDotW = dot2(mRel, mRel);
      const invR = Number.isFinite(rMid) && rMid > 0 ? 1 / rMid : 0;
      const wOverR = scale2(mRel, invR);
      const rawDelta =
        (2 * dot2(dirMid, mRel) + wDotW * invR) /
        (1 + Math.hypot(dirMid.x + wOverR.x, dirMid.y + wOverR.y));
      if (Number.isFinite(rawDelta) && rawDelta > 0) {
        deltaR = rawDelta;
      }
    }
  }

  const capPeak = add2(cMid, scale2(dirMid, deltaR));
  return { cStart, peak: capPeak, cEnd };
}

export function computePieceCutBoundary(piece, curveSegments = 16, options = {}) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3 || !allFinitePt2(piece.points)) {
    return [];
  }
  const segs = sanitizeSegments(curveSegments, 16, 2, 4096);
  const defaultAllowance =
    piece.seamAllowance !== undefined && piece.seamAllowance !== null
      ? finiteOr(piece.seamAllowance, 10)
      : 10;
  const miterLimit = Math.max(
    1.0,
    options?.miterLimit === null || options?.miterLimit === undefined ? 3.0 : finiteOr(options?.miterLimit, 3.0)
  );
  const canon = canonicalizePieceToCCW(piece);
  const pts = canon.pts;
  const n = pts.length;
  const edges = canon.edges;
  const darts = canon.darts;
  const windingSign = 1;

  // Fast path if no valid darts exist on any edge
  const hasAnyDart = Array.isArray(darts) && darts.some((d) => d && typeof d === 'object' && safeNumber(d.widthMm) > 0 && safeNumber(d.depthMm) > 0);
  if (!hasAnyDart) {
    const sampledPoints = [];
    const sampledAllowances = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];
      const edgeMeta = edges[i] || {};
      const edgeAllowance =
        edgeMeta.seamAllowance !== undefined && edgeMeta.seamAllowance !== null
          ? finiteOr(edgeMeta.seamAllowance, defaultAllowance)
          : defaultAllowance;

      const samples = sampleEdgePoints(p0, p1, edgeMeta.curve, segs);
      for (let j = 0; j < samples.length - 1; j++) {
        sampledPoints.push(samples[j]);
        sampledAllowances.push(edgeAllowance);
      }
    }
    let cutLocal = offsetPolygonOutward(sampledPoints, defaultAllowance, sampledAllowances, miterLimit);
    if (canon.wasCW) cutLocal = [...cutLocal].reverse();
    return parseBoolFlag(options?.worldSpace) ? transformPiecePoints(cutLocal, piece, options) : cutLocal;
  }

  // Dart-aware cut boundary: build sequence of normal offset segments and spliced dart caps/V-cutouts
  const baseData = buildPieceBaseBoundaryData(pts, edges, segs);
  const placedUnfoldedDarts = [];
  const items = [];
  let minAllowance = Infinity;
  let hasUnfoldedDart = false;

  const pushSampledRun = (p0, p1, curve, tFrom, tTo, edgeAllowance) => {
    if (tTo - tFrom <= 1e-6) return;
    const steps = curve ? Math.max(2, Math.ceil((tTo - tFrom) * segs)) : 1;
    let prevPt = evalEdgeAt(p0, p1, curve, tFrom);
    for (let s = 1; s <= steps; s++) {
      const t = tFrom + ((tTo - tFrom) * s) / steps;
      const nextPt = evalEdgeAt(p0, p1, curve, t);
      if (dist2D(prevPt, nextPt) > 1e-5) {
        items.push({
          kind: 'edge',
          edge: buildOffsetEdge(prevPt, nextPt, edgeAllowance, windingSign),
        });
        prevPt = nextPt;
      }
    }
  };

  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const edgeMeta = edges[i] || {};
    const edgeAllowance =
      edgeMeta.seamAllowance !== undefined && edgeMeta.seamAllowance !== null
        ? finiteOr(edgeMeta.seamAllowance, defaultAllowance)
        : defaultAllowance;
    if (
      Math.abs(edgeAllowance) > MAX_SAFE_OFFSET_MM ||
      !Number.isFinite(Math.abs(edgeAllowance) * miterLimit)
    ) {
      throw new ValidationError(
        `Seam allowance exceeds maximum finite geometry bounds (${MAX_SAFE_OFFSET_MM} mm).`,
        {
          code: 'INVALID_DIMENSIONS',
          path: 'seamAllowance',
        }
      );
    }
    if (edgeAllowance < minAllowance) minAllowance = edgeAllowance;

    const resolvedDarts = resolveEdgeDarts(p0, p1, edgeMeta.curve, darts, i, windingSign);
    if (resolvedDarts.length === 0) {
      pushSampledRun(p0, p1, edgeMeta.curve, 0, 1, edgeAllowance);
    } else {
      let curT = 0;
      for (const rd of resolvedDarts) {
        clampDartApexToBoundary(
          p0,
          p1,
          edgeMeta.curve,
          rd,
          resolvedDarts,
          i,
          baseData.edgePolys,
          baseData.baseOutline,
          segs,
          placedUnfoldedDarts
        );
        if (!rd.folded) {
          placedUnfoldedDarts.push(rd);
        }
        pushSampledRun(p0, p1, edgeMeta.curve, curT, rd.tStart, edgeAllowance);
        if (rd.folded) {
          const cap = computeFoldedDartCapPeak(p0, p1, edgeMeta.curve, rd, edgeAllowance, windingSign);
          items.push({ kind: 'dart', points: [cap.cStart, cap.peak, cap.cEnd] });
        } else {
          hasUnfoldedDart = true;
          const nStart = evalEdgeNormalAt(p0, p1, edgeMeta.curve, rd.tStart, windingSign);
          const nEnd = evalEdgeNormalAt(p0, p1, edgeMeta.curve, rd.tEnd, windingSign);
          const cStart = add2(rd.dStart, scale2(nStart, edgeAllowance));
          const cEnd = add2(rd.dEnd, scale2(nEnd, edgeAllowance));
          items.push({ kind: 'dart', points: [cStart, rd.apex, cEnd] });
        }
        curT = rd.tEnd;
      }
      pushSampledRun(p0, p1, edgeMeta.curve, curT, 1.0, edgeAllowance);
    }
  }

  if (items.length === 0) return [];

  const rawPoints = [];
  const m = items.length;
  for (let k = 0; k < m; k++) {
    const prevItem = items[(k - 1 + m) % m];
    const currItem = items[k];
    if (currItem.kind === 'dart') {
      rawPoints.push(...currItem.points);
    } else if (prevItem.kind === 'edge') {
      emitCornerPoints(
        prevItem.edge,
        currItem.edge,
        currItem.edge.origStart,
        windingSign,
        miterLimit,
        rawPoints
      );
    } else {
      // Transition from dart end directly into currItem.edge start
      rawPoints.push(currItem.edge.p0);
    }
  }

  if (!allFinitePt2(rawPoints)) {
    throw new ValidationError('Piece cut boundary vertices overflow finite geometry bounds.', {
      code: 'INVALID_DIMENSIONS',
      path: 'seamAllowance',
    });
  }

  let cutLocal = clipSelfIntersectingLoops(
    rawPoints,
    windingSign,
    !hasUnfoldedDart && minAllowance >= -1e-6 ? baseData.baseOutline : null
  );
  if (!allFinitePt2(cutLocal)) {
    throw new ValidationError('Clipped piece cut boundary overflows finite geometry bounds.', {
      code: 'INVALID_DIMENSIONS',
      path: 'seamAllowance',
    });
  }
  if (canon.wasCW) cutLocal = [...cutLocal].reverse();
  return parseBoolFlag(options?.worldSpace) ? transformPiecePoints(cutLocal, piece, options) : cutLocal;
}

// ============================================================================
// Notches, Grainlines & Measurements
// ============================================================================

export function computePieceNotches(piece, options = {}) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3 || !allFinitePt2(piece.points)) {
    return [];
  }
  const notches = Array.isArray(piece.notches) ? piece.notches.filter((nt) => nt && typeof nt === 'object') : [];
  const pts = piece.points;
  const n = pts.length;
  const edges = Array.isArray(piece.edges) ? piece.edges : [];
  const windingSign = computePieceSampledSignedArea(pts, edges, 16) >= 0 ? 1 : -1;

  const defaultSa =
    piece.seamAllowance !== undefined && piece.seamAllowance !== null
      ? finiteOr(piece.seamAllowance, 10)
      : 10;

  const computed = notches.map((notch, idx) => {
    const edgeIdx = ((Math.trunc(finiteOr(notch.edgeIndex, 0)) % n) + n) % n;
    const p0 = pts[edgeIdx];
    const p1 = pts[(edgeIdx + 1) % n];
    const curve = edges[edgeIdx]?.curve || null;
    const rawT = safeNumber(notch.t);
    const t = Number.isFinite(rawT) ? clamp(rawT, 0.01, 0.99) : 0.5;
    const pos = evalEdgeAt(p0, p1, curve, t);
    const tangent = evalEdgeTangentAt(p0, p1, curve, t);
    const outwardNormal = {
      x: tangent.y * windingSign,
      y: -tangent.x * windingSign,
    };

    const rawEdgeSa = edges[edgeIdx]?.seamAllowance;
    const edgeSa =
      rawEdgeSa !== undefined && rawEdgeSa !== null
        ? finiteOr(rawEdgeSa, defaultSa)
        : defaultSa;
    const defaultDepth = edgeSa > 0 ? Math.min(6, Math.max(3, edgeSa * 0.6)) : 5;
    const rawDepth = safeNumber(notch.depthMm);
    const depth = Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : defaultDepth;
    const type = ['single', 'double', 'v', 't'].includes(notch.type) ? notch.type : 'single';
    const lines = [];

    if (type === 'single') {
      lines.push([pos, add2(pos, scale2(outwardNormal, depth))]);
    } else if (type === 'double') {
      const table = buildEdgeArcTable(p0, p1, curve, 64);
      const edgeLen = table.totalLen;
      if (curve && edgeLen > 12) {
        const sMid = arcLengthAtT(table, t);
        let sA = sMid - 2.5;
        let sB = sMid + 2.5;
        if (sA < 0.05) {
          sA = 0.05;
          sB = Math.min(edgeLen - 0.05, sA + 5.0);
        } else if (sB > edgeLen - 0.05) {
          sB = edgeLen - 0.05;
          sA = Math.max(0.05, sB - 5.0);
        }
        const tA = clamp(tAtArcLength(table, sA), 0.002, 0.998);
        const tB = clamp(tAtArcLength(table, sB), 0.002, 0.998);
        const pA = evalEdgeAt(p0, p1, curve, tA);
        const pB = evalEdgeAt(p0, p1, curve, tB);
        const nA = evalEdgeNormalAt(p0, p1, curve, tA, windingSign);
        const nB = evalEdgeNormalAt(p0, p1, curve, tB, windingSign);
        lines.push([pA, add2(pA, scale2(nA, depth))]);
        lines.push([pB, add2(pB, scale2(nB, depth))]);
      } else if (edgeLen > 1e-6) {
        const minS = Math.min(0.05, edgeLen * 0.1);
        const maxS = Math.max(minS, edgeLen - minS);
        const sMid = arcLengthAtT(table, t);
        let sA = sMid - 2.5;
        let sB = sMid + 2.5;
        if (sA < minS) {
          sA = minS;
          sB = Math.min(maxS, sA + 5.0);
        } else if (sB > maxS) {
          sB = maxS;
          sA = Math.max(minS, sB - 5.0);
        }
        sA = clamp(sA, minS, maxS);
        sB = clamp(sB, minS, maxS);
        const tA = clamp(tAtArcLength(table, sA), 0.002, 0.998);
        const tB = clamp(tAtArcLength(table, sB), 0.002, 0.998);
        const pA = evalEdgeAt(p0, p1, curve, tA);
        const pB = evalEdgeAt(p0, p1, curve, tB);
        lines.push([pA, add2(pA, scale2(outwardNormal, depth))]);
        lines.push([pB, add2(pB, scale2(outwardNormal, depth))]);
      }
    } else if (type === 'v') {
      const halfW = depth * 0.6;
      const tip = add2(pos, scale2(outwardNormal, depth));
      const left = add2(pos, scale2(tangent, -halfW));
      const right = add2(pos, scale2(tangent, halfW));
      lines.push([left, tip], [right, tip]);
    } else if (type === 't') {
      const tip = add2(pos, scale2(outwardNormal, depth));
      const barHalf = depth * 0.5;
      lines.push([pos, tip]);
      lines.push([add2(tip, scale2(tangent, -barHalf)), add2(tip, scale2(tangent, barHalf))]);
    }

    if (parseBoolFlag(options?.worldSpace)) {
      const [wPos] = transformPiecePoints([pos], piece, options);
      const wLines = lines.map(([a, b]) => transformPiecePoints([a, b], piece, options));
      const wNorm = rotateDirection2D(outwardNormal, piece);
      return {
        id: notch.id || `notch_${idx}`,
        edgeIndex: edgeIdx,
        t,
        type,
        position: wPos,
        normal: wNorm,
        lines: wLines,
      };
    }

    return {
      id: notch.id || `notch_${idx}`,
      edgeIndex: edgeIdx,
      t,
      type,
      position: pos,
      normal: outwardNormal,
      lines,
    };
  });

  return computed;
}

export function computePieceGrainline(piece, options = {}) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3 || !allFinitePt2(piece.points)) {
    return { start: { x: 0, y: 0 }, end: { x: 0, y: 50 }, angleDeg: 90 };
  }

  let start;
  let end;
  let angleDeg;

  if (piece.grainline && isFinitePt2(piece.grainline.start) && isFinitePt2(piece.grainline.end)) {
    start = { x: finiteOr(piece.grainline.start.x, 0), y: finiteOr(piece.grainline.start.y, 0) };
    end = { x: finiteOr(piece.grainline.end.x, 0), y: finiteOr(piece.grainline.end.y, 50) };
    angleDeg = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  } else {
    const outline = samplePieceOutline(piece, 8);
    const bounds = polygonBounds(outline.length >= 3 ? outline : piece.points);
    const center = polygonCentroid(outline.length >= 3 ? outline : piece.points);
    angleDeg = finiteOr(piece.grainline?.angleDeg, 90);
    const angleRad = (angleDeg * Math.PI) / 180;
    const dir = { x: Math.cos(angleRad), y: Math.sin(angleRad) };

    const rayClipped = (() => {
      if (outline.length < 3 || !pointInPolygon(center, outline)) return null;
      const diag = Math.hypot(bounds.width, bounds.height) + 10;
      const posFar = add2(center, scale2(dir, diag));
      const negFar = sub2(center, scale2(dir, diag));
      let minPos = Infinity;
      let minNeg = Infinity;
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        const hitPos = segmentIntersection2D(center, posFar, a, b);
        if (hitPos && hitPos.t > 1e-4) {
          minPos = Math.min(minPos, hitPos.t * diag);
        }
        const hitNeg = segmentIntersection2D(center, negFar, a, b);
        if (hitNeg && hitNeg.t > 1e-4) {
          minNeg = Math.min(minNeg, hitNeg.t * diag);
        }
      }
      if (Number.isFinite(minPos) && Number.isFinite(minNeg) && minPos > 2 && minNeg > 2) {
        return {
          start: sub2(center, scale2(dir, minNeg * 0.65)),
          end: add2(center, scale2(dir, minPos * 0.65)),
        };
      }
      return null;
    })();

    if (rayClipped) {
      start = rayClipped.start;
      end = rayClipped.end;
    } else {
      const halfLen = Math.max(15, Math.min(bounds.width, bounds.height) * 0.32);
      start = sub2(center, scale2(dir, halfLen));
      end = add2(center, scale2(dir, halfLen));
    }
  }

  if (parseBoolFlag(options?.worldSpace)) {
    const [wStart, wEnd] = transformPiecePoints([start, end], piece, options);
    const wAngle = (((angleDeg + finiteOr(piece?.rotation, 0)) % 360) + 360) % 360;
    return { start: wStart, end: wEnd, angleDeg: wAngle };
  }

  return { start, end, angleDeg };
}

export function computePieceMeasurements(piece, unitOrOptions = 'mm') {
  const opts =
    typeof unitOrOptions === 'string'
      ? { unit: unitOrOptions }
      : unitOrOptions && typeof unitOrOptions === 'object' && !Array.isArray(unitOrOptions)
        ? unitOrOptions
        : {};
  const unit = opts.unit ?? 'mm';
  const curveSegments = sanitizeSegments(opts.curveSegments, 16, 2, 4096);

  // Validate unit via mmToUnit
  mmToUnit(0, unit);

  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3 || !allFinitePt2(piece.points)) {
    return {
      unit,
      vertexCount: 0,
      dartCount: 0,
      notchCount: 0,
      rotationDeg: 0,
      edges: [],
      netPerimeterMm: 0,
      netPerimeter: 0,
      sewnPerimeterMm: 0,
      sewnPerimeter: 0,
      cutPerimeterMm: 0,
      cutPerimeter: 0,
      netAreaMm2: 0,
      netAreaCm2: 0,
      cutAreaMm2: 0,
      cutAreaCm2: 0,
      netBoundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      cutBoundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      worldBoundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      netWidthMm: 0,
      netHeightMm: 0,
      width: 0,
      height: 0,
      cutWidthMm: 0,
      cutHeightMm: 0,
      centroidMm: { x: 0, y: 0 },
    };
  }

  const pts = piece.points;
  const n = pts.length;
  const defaultSa =
    piece.seamAllowance !== undefined && piece.seamAllowance !== null
      ? finiteOr(piece.seamAllowance, 10)
      : 10;
  const edges = [];
  let sewnPerimeterMm = 0;

  const rawEdges = Array.isArray(piece.edges) ? piece.edges : [];
  const rawDarts = Array.isArray(piece.darts) ? piece.darts : [];
  const rawNotches = Array.isArray(piece.notches) ? piece.notches : [];
  const windingSign = computePieceSampledSignedArea(pts, rawEdges, curveSegments) >= 0 ? 1 : -1;

  const finitePosMax = (v) => (Number.isFinite(v) ? v : Number.MAX_VALUE);
  const sanitizeBounds = (b) => ({
    ...b,
    minX: Number.isFinite(b.minX) ? b.minX : 0,
    minY: Number.isFinite(b.minY) ? b.minY : 0,
    maxX: Number.isFinite(b.maxX) ? b.maxX : 0,
    maxY: Number.isFinite(b.maxY) ? b.maxY : 0,
    width: finitePosMax(b.width),
    height: finitePosMax(b.height),
    centerX: Number.isFinite(b.centerX) ? b.centerX : 0,
    centerY: Number.isFinite(b.centerY) ? b.centerY : 0,
  });

  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const rawMeta = rawEdges[i];
    const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
    const lengthMm = finitePosMax(edgeArcLength(p0, p1, meta.curve || null, 64));
    const resolvedDarts = resolveEdgeDarts(p0, p1, meta.curve || null, rawDarts, i, windingSign);
    const dartIntakeMm = finitePosMax(
      resolvedDarts.reduce((acc, rd) => acc + finiteOr(rd.intakeMm, 0), 0)
    );
    const netLengthMm = finitePosMax(Math.max(0, lengthMm - dartIntakeMm));
    const seamAllowanceMm =
      meta.seamAllowance !== undefined && meta.seamAllowance !== null
        ? finiteOr(meta.seamAllowance, defaultSa)
        : defaultSa;
    sewnPerimeterMm = finitePosMax(sewnPerimeterMm + netLengthMm);

    edges.push({
      index: i,
      name: meta.name || `Edge ${i + 1}`,
      lengthMm,
      dartIntakeMm,
      netLengthMm,
      length: mmToUnit(lengthMm, unit),
      netLength: mmToUnit(netLengthMm, unit),
      seamAllowanceMm,
      isCurved: Boolean(meta.curve && (meta.curve.cp || (meta.curve.cp1 && meta.curve.cp2))),
    });
  }

  const netOutline = samplePieceOutline(piece, curveSegments);
  const cutBoundary = computePieceCutBoundary(piece, curveSegments);
  const worldOutline = transformPiecePoints(netOutline, piece);

  const netPerimeterMm = finitePosMax(polygonPerimeter(netOutline));
  const cutPerimeterMm = finitePosMax(polygonPerimeter(cutBoundary));
  const netAreaMm2 = finitePosMax(polygonArea(netOutline));
  const cutAreaMm2 = finitePosMax(polygonArea(cutBoundary));
  const netBoundsMm = sanitizeBounds(polygonBounds(netOutline));
  const cutBoundsMm = sanitizeBounds(polygonBounds(cutBoundary));
  const worldBoundsMm = sanitizeBounds(polygonBounds(worldOutline));
  const centroidMm = polygonCentroid(netOutline);

  return {
    unit,
    vertexCount: n,
    dartCount: rawDarts.filter((d) => d && typeof d === 'object').length,
    notchCount: rawNotches.filter((nt) => nt && typeof nt === 'object').length,
    rotationDeg: finiteOr(piece.rotation, 0),
    edges,
    netPerimeterMm,
    netPerimeter: mmToUnit(netPerimeterMm, unit),
    sewnPerimeterMm,
    sewnPerimeter: mmToUnit(sewnPerimeterMm, unit),
    cutPerimeterMm,
    cutPerimeter: mmToUnit(cutPerimeterMm, unit),
    netAreaMm2,
    netAreaCm2: netAreaMm2 / 100,
    cutAreaMm2,
    cutAreaCm2: cutAreaMm2 / 100,
    netBoundsMm,
    cutBoundsMm,
    worldBoundsMm,
    netWidthMm: netBoundsMm.width,
    netHeightMm: netBoundsMm.height,
    width: mmToUnit(netBoundsMm.width, unit),
    height: mmToUnit(netBoundsMm.height, unit),
    cutWidthMm: cutBoundsMm.width,
    cutHeightMm: cutBoundsMm.height,
    centroidMm,
  };
}

// ============================================================================
// 2D Polygon Triangulation (Ear-Clipping + Conforming Midpoint Bisection)
// ============================================================================

function isEar(poly, u, v, w, indices) {
  const a = poly[indices[u]];
  const b = poly[indices[v]];
  const c = poly[indices[w]];
  if (cross2(sub2(b, a), sub2(c, a)) <= 1e-9) {
    return false;
  }
  for (let p = 0; p < indices.length; p++) {
    if (p === u || p === v || p === w) continue;
    const pt = poly[indices[p]];
    if (dist2D(pt, a) <= 1e-7 || dist2D(pt, b) <= 1e-7 || dist2D(pt, c) <= 1e-7) {
      continue;
    }
    if (pointInTriangle2D(pt, a, b, c)) {
      return false;
    }
  }
  return true;
}

export function triangulatePolygon(points) {
  const clean = stripBacktrackingSpikes(deduplicateConsecutivePoints(points, 1e-4));
  if (clean.length < 3) {
    return { vertices: clean, triangles: [] };
  }
  const ccw = ensureCCW(clean);
  const n = ccw.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  const triangles = [];

  let count = 4 * n;
  let v = n - 1;
  while (indices.length > 3) {
    if (count-- <= 0) {
      for (let i = 1; i < indices.length - 1; i++) {
        triangles.push([indices[0], indices[i], indices[i + 1]]);
      }
      indices.length = 0;
      break;
    }
    const u = v >= indices.length ? 0 : v;
    v = u + 1 >= indices.length ? 0 : u + 1;
    const w = v + 1 >= indices.length ? 0 : v + 1;

    if (isEar(ccw, u, v, w, indices)) {
      triangles.push([indices[u], indices[v], indices[w]]);
      indices.splice(v, 1);
      count = 4 * indices.length;
    }
  }

  if (indices.length === 3) {
    const a = ccw[indices[0]];
    const b = ccw[indices[1]];
    const c = ccw[indices[2]];
    if (Math.abs(cross2(sub2(b, a), sub2(c, a))) > 1e-10) {
      triangles.push([indices[0], indices[1], indices[2]]);
    }
  }

  return { vertices: ccw, triangles };
}

export function generateClothMesh2D(points, maxEdgeLengthMm = 35) {
  const safeMaxEdge = Math.max(2, finiteOr(maxEdgeLengthMm, 35));
  const base = triangulatePolygon(points);
  if (base.triangles.length === 0) {
    return { vertices: base.vertices, triangles: [] };
  }

  const vertices = base.vertices.map((p) => ({ x: p.x, y: p.y }));
  let triangles = base.triangles.map((t) => [...t]);

  const maxIterations = 10;
  const HARD_MAX_VERTICES = 100000;
  const area = polygonArea(base.vertices);
  const rawMaxVertices = Number.isFinite(area)
    ? Math.ceil((area / (safeMaxEdge * safeMaxEdge)) * 6) + 4096
    : NaN;
  const isAstronomical =
    !Number.isFinite(area) || !Number.isFinite(rawMaxVertices) || area > 1e12;
  const maxVertices = isAstronomical
    ? 256
    : Math.max(32000, Math.min(HARD_MAX_VERTICES, rawMaxVertices));

  for (let iter = 0; iter < maxIterations; iter++) {
    if (vertices.length >= maxVertices) break;
    if (iter > 0 && vertices.length + Math.ceil(triangles.length * 0.75) > HARD_MAX_VERTICES) break;

    let splitCount = 0;
    const edgeMidpointCache = new Map();
    const nextTriangles = [];

    const getMidpointIndex = (i0, i1) => {
      const key = i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`;
      if (edgeMidpointCache.has(key)) return edgeMidpointCache.get(key);
      const vA = vertices[i0];
      const vB = vertices[i1];
      const mid = { x: vA.x * 0.5 + vB.x * 0.5, y: vA.y * 0.5 + vB.y * 0.5 };
      const idx = vertices.length;
      vertices.push(mid);
      edgeMidpointCache.set(key, idx);
      return idx;
    };

    for (const [a, b, c] of triangles) {
      const sab = dist2D(vertices[a], vertices[b]) > safeMaxEdge;
      const sbc = dist2D(vertices[b], vertices[c]) > safeMaxEdge;
      const sca = dist2D(vertices[c], vertices[a]) > safeMaxEdge;
      const numSplit = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0);

      if (numSplit === 0) {
        nextTriangles.push([a, b, c]);
        continue;
      }

      splitCount++;
      if (numSplit === 3) {
        const mab = getMidpointIndex(a, b);
        const mbc = getMidpointIndex(b, c);
        const mca = getMidpointIndex(c, a);
        nextTriangles.push(
          [a, mab, mca],
          [mab, b, mbc],
          [mca, mbc, c],
          [mab, mbc, mca]
        );
      } else if (numSplit === 2) {
        let v0 = a;
        let v1 = b;
        let v2 = c;
        if (sbc && sca) {
          v0 = b;
          v1 = c;
          v2 = a;
        } else if (sca && sab) {
          v0 = c;
          v1 = a;
          v2 = b;
        }
        const m01 = getMidpointIndex(v0, v1);
        const m12 = getMidpointIndex(v1, v2);
        nextTriangles.push([m01, v1, m12]);
        if (dist2D(vertices[m01], vertices[v2]) <= dist2D(vertices[v0], vertices[m12])) {
          nextTriangles.push([v0, m01, v2], [m01, m12, v2]);
        } else {
          nextTriangles.push([v0, m01, m12], [v0, m12, v2]);
        }
      } else {
        let v0 = a;
        let v1 = b;
        let v2 = c;
        if (sbc) {
          v0 = b;
          v1 = c;
          v2 = a;
        } else if (sca) {
          v0 = c;
          v1 = a;
          v2 = b;
        }
        const m01 = getMidpointIndex(v0, v1);
        nextTriangles.push([v0, m01, v2], [m01, v1, v2]);
      }
    }

    triangles = nextTriangles;
    if (splitCount === 0) break;
  }

  return { vertices, triangles };
}
