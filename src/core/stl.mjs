/**
 * Binary & ASCII STL Parser, Topology Analyzer, and Orientation-Invariant Unwrapper.
 * Isomorphic pure ES module (Node.js v24 + browsers).
 * Imports ONLY ./types.mjs and ./geometry.mjs (acyclic DAG).
 */

import { SCHEMA_VERSION, ValidationError } from './types.mjs';
import {
  vec2,
  add2,
  sub2,
  scale2,
  dot2,
  cross2,
  dist2,
  norm2,
  vec3,
  add3,
  sub3,
  scale3,
  dot3,
  cross3,
  len3,
  dist3,
  norm3,
  polygonArea,
  signedPolygonArea,
  polygonBounds,
  polygonCentroid,
  ensureCCW,
  deduplicateConsecutivePoints,
  polygonSelfIntersects,
  offsetPolygonOutward,
} from './geometry.mjs';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function finiteOr(v, fallback) {
  if (
    v === null ||
    v === undefined ||
    typeof v === 'boolean' ||
    typeof v === 'symbol' ||
    typeof v === 'bigint' ||
    typeof v === 'object'
  ) {
    return fallback;
  }
  if (typeof v === 'string' && v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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

function pointToSegmentDist2D(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return dist2(p, a);
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq, 0, 1);
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

function rdpOpen(pts, tol) {
  if (pts.length <= 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  let maxDist = -1;
  let splitIdx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegmentDist2D(pts[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      splitIdx = i;
    }
  }
  if (maxDist > tol && splitIdx > 0) {
    const left = rdpOpen(pts.slice(0, splitIdx + 1), tol);
    const right = rdpOpen(pts.slice(splitIdx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function stripCollinearLoop(pts, eps = 1e-3) {
  if (pts.length <= 3) return pts;
  let cur = deduplicateConsecutivePoints(pts, 1e-4);
  let changed = true;
  let guard = 0;
  while (changed && cur.length > 3 && guard++ < 8) {
    changed = false;
    const next = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const prev = cur[(i - 1 + n) % n];
      const curr = cur[i];
      const nxt = cur[(i + 1) % n];
      const d = pointToSegmentDist2D(curr, prev, nxt);
      const ab = sub2(curr, prev);
      const bc = sub2(nxt, curr);
      if (d <= eps && dot2(ab, bc) >= 0) {
        changed = true;
      } else {
        next.push(curr);
      }
    }
    if (next.length >= 3) cur = next;
    else break;
  }
  return cur;
}

function simplifyClosedPolygon(points, toleranceMm = 1.2, minEdgeMm = 5.0) {
  let loop = stripCollinearLoop(points, 1e-3);
  if (loop.length <= 4) return ensureCCW(loop);

  // Rotate to sharpest corner so RDP split is deterministic across rotations
  const n0 = loop.length;
  let sharpIdx = 0;
  let minDot = Infinity;
  for (let i = 0; i < n0; i++) {
    const pPrev = loop[(i - 1 + n0) % n0];
    const pCurr = loop[i];
    const pNext = loop[(i + 1) % n0];
    const d1 = norm2(sub2(pCurr, pPrev));
    const d2 = norm2(sub2(pNext, pCurr));
    const d = dot2(d1, d2);
    if (d < minDot - 1e-6) {
      minDot = d;
      sharpIdx = i;
    }
  }
  loop = [...loop.slice(sharpIdx), ...loop.slice(0, sharpIdx)];

  // Split closed loop at vertex 0 and farthest vertex
  let farIdx = 1;
  let maxD = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = dist2(loop[0], loop[i]);
    if (d > maxD) {
      maxD = d;
      farIdx = i;
    }
  }
  if (farIdx > 0 && farIdx < loop.length - 1) {
    const chainA = rdpOpen(loop.slice(0, farIdx + 1), toleranceMm);
    const chainB = rdpOpen([...loop.slice(farIdx), loop[0]], toleranceMm);
    const merged = [...chainA.slice(0, -1), ...chainB.slice(0, -1)];
    if (merged.length >= 3 && !polygonSelfIntersects(merged)) {
      loop = stripCollinearLoop(merged, 1e-3);
    }
  }

  // Collapse tiny bevel/chamfer micro-edges without destroying real recesses
  if (minEdgeMm > 0 && loop.length > 4) {
    let changed = true;
    let iter = 0;
    while (changed && loop.length > 4 && iter++ < 32) {
      changed = false;
      for (let i = 0; i < loop.length; i++) {
        const n = loop.length;
        const a = loop[i];
        const b = loop[(i + 1) % n];
        const edgeLen = dist2(a, b);
        if (edgeLen < minEdgeMm) {
          const prev = loop[(i - 1 + n) % n];
          const next = loop[(i + 2) % n];
          const mid = scale2(add2(a, b), 0.5);
          const areaLost =
            Math.abs(cross2(sub2(a, prev), sub2(b, prev))) * 0.5 +
            Math.abs(cross2(sub2(b, next), sub2(a, next))) * 0.5;
          if (areaLost < Math.max(12, minEdgeMm * minEdgeMm * 0.45)) {
            const candidate = loop.filter((_, idx) => idx !== i && idx !== (i + 1) % n);
            const insertAt = i > (i + 1) % n ? 0 : i;
            candidate.splice(insertAt, 0, mid);
            if (candidate.length >= 3 && !polygonSelfIntersects(candidate)) {
              loop = candidate;
              changed = true;
              break;
            }
          }
        }
      }
    }
  }

  return ensureCCW(stripCollinearLoop(loop, 1e-3));
}

function convexHull2D(points) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross2(sub2(lower[lower.length - 1], lower[lower.length - 2]), sub2(p, lower[lower.length - 2])) <= 1e-9) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross2(sub2(upper[upper.length - 1], upper[upper.length - 2]), sub2(p, upper[upper.length - 2])) <= 1e-9) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return ensureCCW([...lower, ...upper]);
}

function buildBasisFromNormal(normal, refHint = null) {
  const n = len3(normal) > 1e-6 ? norm3(normal) : vec3(0, 0, 1);
  let up = refHint && len3(refHint) > 1e-6 ? norm3(refHint) : null;
  if (!up || len3(cross3(up, n)) < 1e-4) {
    up = Math.abs(n.y) > 0.9 ? vec3(0, 0, 1) : vec3(0, 1, 0);
  }
  const ex = norm3(cross3(up, n)); // 2D +X in 3D
  const upOrtho = norm3(cross3(n, ex)); // 3D up (+Y_3d)
  const ey = scale3(upOrtho, -1); // 2D +Y in 3D (Canvas Y-down matches -up)
  return { n, up: upOrtho, ex, ey };
}

function makeSafePlacement3D(offset, normal, exHint = null) {
  const n = len3(normal) > 1e-6 ? norm3(normal) : vec3(0, 0, 1);
  let ex;
  if (exHint && len3(exHint) > 1e-6) {
    // Orthogonalize exHint against n
    const proj = sub3(exHint, scale3(n, dot3(exHint, n)));
    ex = len3(proj) > 1e-5 ? norm3(proj) : null;
  }
  if (!ex) {
    const basis = buildBasisFromNormal(n);
    return { offset, normal: basis.n, up: basis.up };
  }
  const up = norm3(cross3(n, ex));
  return { offset, normal: n, up };
}

function sanitizePolygonOffset(ccwPoints, offsetMm, miterLimit = 3.0) {
  const clean = ensureCCW(deduplicateConsecutivePoints(ccwPoints, 1e-4));
  if (!Number.isFinite(offsetMm) || offsetMm <= 1e-5 || clean.length < 3) return clean;
  const off = offsetPolygonOutward(clean, offsetMm, null, miterLimit);
  if (Array.isArray(off) && off.length >= 3 && !polygonSelfIntersects(off) && polygonArea(off) > polygonArea(clean) * 0.5) {
    return ensureCCW(off);
  }
  // Fallback: miter-limited to 1.5
  const offTight = offsetPolygonOutward(clean, offsetMm, null, 1.5);
  if (Array.isArray(offTight) && offTight.length >= 3 && !polygonSelfIntersects(offTight)) {
    return ensureCCW(offTight);
  }
  // Safe centroid-radial expansion fallback if extreme concave pocket collapsed
  const c = polygonCentroid(clean);
  const perim = clean.reduce((s, p, i) => s + dist2(p, clean[(i + 1) % clean.length]), 0);
  const scaleFactor = Number.isFinite(perim) ? 1 + (2 * Math.PI * offsetMm) / Math.max(1, perim) : 1;
  if (!Number.isFinite(scaleFactor) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return clean;
  const expanded = ensureCCW(clean.map((p) => add2(c, scale2(sub2(p, c), scaleFactor))));
  return expanded.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? expanded : clean;
}

// ============================================================================
// STL Serialization & Synthetic Generators
// ============================================================================

function isFiniteVec3(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

function validateAndNormalizeTriangle(tri, idx, pathPrefix = 'triangles') {
  if (Array.isArray(tri)) {
    if (
      tri.length < 3 ||
      !(0 in tri) ||
      !(1 in tri) ||
      !(2 in tri) ||
      !isFiniteVec3(tri[0]) ||
      !isFiniteVec3(tri[1]) ||
      !isFiniteVec3(tri[2])
    ) {
      throw new ValidationError(`Invalid triangle entry at ${pathPrefix}[${idx}].`, {
        code: 'INVALID_STL',
        path: `${pathPrefix}[${idx}]`,
      });
    }
    return [
      vec3(tri[0].x, tri[0].y, tri[0].z),
      vec3(tri[1].x, tri[1].y, tri[1].z),
      vec3(tri[2].x, tri[2].y, tri[2].z),
    ];
  }
  if (tri && typeof tri === 'object') {
    const v0 = tri.a ?? tri.v0;
    const v1 = tri.b ?? tri.v1;
    const v2 = tri.c ?? tri.v2;
    if (isFiniteVec3(v0) && isFiniteVec3(v1) && isFiniteVec3(v2)) {
      return [
        vec3(v0.x, v0.y, v0.z),
        vec3(v1.x, v1.y, v1.z),
        vec3(v2.x, v2.y, v2.z),
      ];
    }
  }
  throw new ValidationError(`Invalid triangle entry at ${pathPrefix}[${idx}].`, {
    code: 'INVALID_STL',
    path: `${pathPrefix}[${idx}]`,
  });
}

function validateNormalizedTriangles(triangles, pathPrefix = 'triangles') {
  const out = new Array(triangles.length);
  for (let i = 0; i < triangles.length; i++) {
    if (!(i in triangles)) {
      throw new ValidationError(`Sparse/missing triangle entry at ${pathPrefix}[${i}].`, {
        code: 'INVALID_STL',
        path: `${pathPrefix}[${i}]`,
      });
    }
    out[i] = validateAndNormalizeTriangle(triangles[i], i, pathPrefix);
  }
  return out;
}

function validateMeshObjectForUnwrap(meshInput) {
  if (meshInput.triangles.length === 0 || meshInput.faces.length === 0) {
    throw new ValidationError('STL mesh contains no valid non-degenerate faces to unwrap.', {
      code: 'EMPTY_STL',
      path: 'mesh',
    });
  }
  validateNormalizedTriangles(meshInput.triangles, 'mesh.triangles');
  if (!Array.isArray(meshInput.vertices) || meshInput.vertices.length === 0) {
    throw new ValidationError('STL mesh requires a non-empty vertices array.', {
      code: 'INVALID_STL',
      path: 'mesh.vertices',
    });
  }
  for (let i = 0; i < meshInput.vertices.length; i++) {
    const v = meshInput.vertices[i];
    if (
      !(i in meshInput.vertices) ||
      !isFiniteVec3(v) ||
      !Number.isFinite(v.x * 1e3) ||
      !Number.isFinite(v.y * 1e3) ||
      !Number.isFinite(v.z * 1e3)
    ) {
      throw new ValidationError(`Invalid vertex at mesh.vertices[${i}].`, {
        code: 'INVALID_STL',
        path: `mesh.vertices[${i}]`,
      });
    }
  }
  for (let i = 0; i < meshInput.faces.length; i++) {
    const f = meshInput.faces[i];
    if (
      !(i in meshInput.faces) ||
      !f ||
      typeof f !== 'object' ||
      Array.isArray(f) ||
      !Number.isFinite(f.area) ||
      f.area < 0 ||
      !isFiniteVec3(f.normal) ||
      !isFiniteVec3(f.centroid) ||
      !Array.isArray(f.indices) ||
      f.indices.length < 3
    ) {
      throw new ValidationError(`Invalid face entry at mesh.faces[${i}].`, {
        code: 'INVALID_STL',
        path: `mesh.faces[${i}]`,
      });
    }
    for (let k = 0; k < 3; k++) {
      const idx = f.indices[k];
      if (!(k in f.indices) || !Number.isInteger(idx) || idx < 0 || idx >= meshInput.vertices.length) {
        throw new ValidationError(`Invalid face vertex index at mesh.faces[${i}].indices[${k}].`, {
          code: 'INVALID_STL',
          path: `mesh.faces[${i}].indices[${k}]`,
        });
      }
    }
  }
  if (!Array.isArray(meshInput.adjacency) || meshInput.adjacency.length < meshInput.faces.length) {
    throw new ValidationError('STL mesh requires a valid adjacency array matching faces.', {
      code: 'INVALID_STL',
      path: 'mesh.adjacency',
    });
  }
  for (let i = 0; i < meshInput.faces.length; i++) {
    const adjList = meshInput.adjacency[i];
    if (!(i in meshInput.adjacency) || !Array.isArray(adjList)) {
      throw new ValidationError(`Invalid adjacency entry at mesh.adjacency[${i}].`, {
        code: 'INVALID_STL',
        path: `mesh.adjacency[${i}]`,
      });
    }
    for (let j = 0; j < adjList.length; j++) {
      const edge = adjList[j];
      if (
        !(j in adjList) ||
        !edge ||
        typeof edge !== 'object' ||
        Array.isArray(edge) ||
        !Number.isInteger(edge.neighbor) ||
        edge.neighbor < 0 ||
        edge.neighbor >= meshInput.faces.length ||
        !Number.isFinite(edge.dihedralDeg) ||
        !Number.isFinite(edge.edgeLength) ||
        !Array.isArray(edge.edgeVertices) ||
        edge.edgeVertices.length < 2 ||
        !(0 in edge.edgeVertices) ||
        !(1 in edge.edgeVertices) ||
        !Number.isInteger(edge.edgeVertices[0]) ||
        edge.edgeVertices[0] < 0 ||
        edge.edgeVertices[0] >= meshInput.vertices.length ||
        !Number.isInteger(edge.edgeVertices[1]) ||
        edge.edgeVertices[1] < 0 ||
        edge.edgeVertices[1] >= meshInput.vertices.length
      ) {
        throw new ValidationError(`Invalid adjacency edge at mesh.adjacency[${i}][${j}].`, {
          code: 'INVALID_STL',
          path: `mesh.adjacency[${i}][${j}]`,
        });
      }
    }
  }
}

export function serializeTrianglesToSTL(triangles, solidName = 'model', binary = false) {
  if (!Array.isArray(triangles) || triangles.length === 0) {
    throw new ValidationError('serializeTrianglesToSTL requires a non-empty triangle array.', {
      code: 'INVALID_STL',
      path: 'triangles',
    });
  }

  const isBinary = parseBoolFlag(binary);
  const safeSolidName = typeof solidName === 'string' && solidName.length > 0 ? solidName : 'model';
  const safeBinaryHeader = typeof solidName === 'string' && solidName.length > 0 ? solidName : 'binary_stl';

  const validatedTris = validateNormalizedTriangles(triangles, 'triangles');
  const normalized = validatedTris.map(([v0, v1, v2]) => {
    const n = norm3(cross3(sub3(v1, v0), sub3(v2, v0)));
    return { v0, v1, v2, n };
  });

  if (isBinary) {
    const buf = new ArrayBuffer(84 + normalized.length * 50);
    const view = new DataView(buf);
    const headerStr = safeBinaryHeader.slice(0, 79);
    for (let i = 0; i < headerStr.length; i++) {
      view.setUint8(i, headerStr.charCodeAt(i) & 0x7f);
    }
    view.setUint32(80, normalized.length, true);
    let offset = 84;
    for (const tri of normalized) {
      view.setFloat32(offset, tri.n.x, true);
      view.setFloat32(offset + 4, tri.n.y, true);
      view.setFloat32(offset + 8, tri.n.z, true);
      view.setFloat32(offset + 12, tri.v0.x, true);
      view.setFloat32(offset + 16, tri.v0.y, true);
      view.setFloat32(offset + 20, tri.v0.z, true);
      view.setFloat32(offset + 24, tri.v1.x, true);
      view.setFloat32(offset + 28, tri.v1.y, true);
      view.setFloat32(offset + 32, tri.v1.z, true);
      view.setFloat32(offset + 36, tri.v2.x, true);
      view.setFloat32(offset + 40, tri.v2.y, true);
      view.setFloat32(offset + 44, tri.v2.z, true);
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
    return new Uint8Array(buf);
  }

  const lines = [`solid ${safeSolidName}`];
  for (const { v0, v1, v2, n } of normalized) {
    lines.push(`  facet normal ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${v0.x.toFixed(6)} ${v0.y.toFixed(6)} ${v0.z.toFixed(6)}`);
    lines.push(`      vertex ${v1.x.toFixed(6)} ${v1.y.toFixed(6)} ${v1.z.toFixed(6)}`);
    lines.push(`      vertex ${v2.x.toFixed(6)} ${v2.y.toFixed(6)} ${v2.z.toFixed(6)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${safeSolidName}`);
  return lines.join('\n');
}

export function createBoxSTL(width = 120, depth = 80, height = 60, binary = false) {
  const hx = Math.max(0.5, finiteOr(width, 120)) * 0.5;
  const hy = Math.max(0.5, finiteOr(height, 60)) * 0.5;
  const hz = Math.max(0.5, finiteOr(depth, 80)) * 0.5;
  const p = [
    vec3(-hx, -hy, -hz), // 0
    vec3(hx, -hy, -hz),  // 1
    vec3(hx, hy, -hz),   // 2
    vec3(-hx, hy, -hz),  // 3
    vec3(-hx, -hy, hz),  // 4
    vec3(hx, -hy, hz),   // 5
    vec3(hx, hy, hz),    // 6
    vec3(-hx, hy, hz),   // 7
  ];
  const quad = (a, b, c, d) => [
    [p[a], p[b], p[c]],
    [p[a], p[c], p[d]],
  ];
  const tris = [
    ...quad(4, 5, 6, 7), // +Z
    ...quad(1, 0, 3, 2), // -Z
    ...quad(5, 1, 2, 6), // +X
    ...quad(0, 4, 7, 3), // -X
    ...quad(7, 6, 2, 3), // +Y
    ...quad(0, 1, 5, 4), // -Y
  ];
  return serializeTrianglesToSTL(tris, 'box', parseBoolFlag(binary));
}

export function createWedgeSTL(length = 152.4, width = 152.4, height = 51.2, tipHeight = 13.5, binary = false) {
  const L = Math.max(1, finiteOr(length, 152.4));
  const W = Math.max(1, finiteOr(width, 152.4));
  const H = Math.max(1, finiteOr(height, 51.2));
  const tH = clamp(finiteOr(tipHeight, 13.5), 0.5, H);

  // Matches cutting_mat_wedge convention: X in [0..L], Y in [0..W], Z in [-H..0]
  // Back edge at x=0 goes from z=-H to z=0; front tip at x=L goes from z=-tH to z=0
  const v = [
    vec3(0, 0, 0),      // 0: back-left top
    vec3(L, 0, 0),      // 1: front-left top
    vec3(L, 0, -tH),    // 2: front-left bottom
    vec3(0, 0, -H),     // 3: back-left bottom
    vec3(0, W, 0),      // 4: back-right top
    vec3(L, W, 0),      // 5: front-right top
    vec3(L, W, -tH),    // 6: front-right bottom
    vec3(0, W, -H),     // 7: back-right bottom
  ];
  const quad = (a, b, c, d) => [
    [v[a], v[b], v[c]],
    [v[a], v[c], v[d]],
  ];
  const tris = [
    ...quad(0, 3, 2, 1), // -Y end-cap (outward -Y)
    ...quad(4, 5, 6, 7), // +Y end-cap (outward +Y)
    ...quad(0, 1, 5, 4), // +Z top cutting surface
    ...quad(3, 7, 6, 2), // sloped bottom surface
    ...quad(0, 4, 7, 3), // -X back wall
    ...quad(1, 2, 6, 5), // +X front tip wall
  ];
  return serializeTrianglesToSTL(tris, 'wedge', parseBoolFlag(binary));
}

// ============================================================================
// STL Parsing & Topology Analysis (F15)
// ============================================================================

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function parseBinarySTLBytes(bytes, triCount) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = new Array(triCount);
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    const x0 = view.getFloat32(offset + 12, true);
    const y0 = view.getFloat32(offset + 16, true);
    const z0 = view.getFloat32(offset + 20, true);
    const x1 = view.getFloat32(offset + 24, true);
    const y1 = view.getFloat32(offset + 28, true);
    const z1 = view.getFloat32(offset + 32, true);
    const x2 = view.getFloat32(offset + 36, true);
    const y2 = view.getFloat32(offset + 40, true);
    const z2 = view.getFloat32(offset + 44, true);
    if (
      !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0) ||
      !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1) ||
      !Number.isFinite(x2) || !Number.isFinite(y2) || !Number.isFinite(z2)
    ) {
      throw new ValidationError(
        `Binary STL contains non-finite vertex coordinates at triangle ${i}.`,
        { code: 'INVALID_STL', path: 'stl' }
      );
    }
    triangles[i] = [vec3(x0, y0, z0), vec3(x1, y1, z1), vec3(x2, y2, z2)];
    offset += 50;
  }
  return triangles;
}

function parseAsciiSTLText(text, name = 'model.stl') {
  const safeName = typeof name === 'string' && name.length > 0 ? name : 'model.stl';
  const strictFloatRe = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const lines = String(text).split(/\r?\n/);
  const triangles = [];
  let inFacet = false;
  let inLoop = false;
  let loopDone = false;
  let loopVerts = [];
  let sawSolid = false;

  const failInvalid = (msg) => {
    throw new ValidationError(`${msg} (${safeName}).`, {
      code: 'INVALID_STL',
      path: 'stl',
    });
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const trimmed = lines[lineIdx].trim();
    if (!trimmed) continue;

    if (/^solid(?:\s|$)/i.test(trimmed)) {
      if (inFacet || inLoop) {
        failInvalid(`Unexpected 'solid' inside facet at line ${lineIdx + 1}`);
      }
      sawSolid = true;
      continue;
    }

    if (/^endsolid(?:\s|$)/i.test(trimmed)) {
      if (inFacet || inLoop) {
        failInvalid(`Unexpected 'endsolid' inside unclosed facet at line ${lineIdx + 1}`);
      }
      continue;
    }

    if (/^facet(?:\s|$)/i.test(trimmed)) {
      if (inFacet || inLoop) {
        failInvalid(`Nested or unclosed 'facet' at line ${lineIdx + 1}`);
      }
      const rest = trimmed.slice(5).trim();
      if (rest.length > 0) {
        const normalParts = rest.split(/\s+/);
        if (normalParts[0].toLowerCase() !== 'normal') {
          failInvalid(`Malformed facet header at line ${lineIdx + 1}`);
        }
        if (normalParts.length !== 4) {
          failInvalid(`Malformed facet normal vector at line ${lineIdx + 1}`);
        }
        for (let k = 1; k <= 3; k++) {
          if (!strictFloatRe.test(normalParts[k]) || !Number.isFinite(Number(normalParts[k]))) {
            failInvalid(`Non-finite facet normal component at line ${lineIdx + 1}`);
          }
        }
      }
      inFacet = true;
      inLoop = false;
      loopDone = false;
      loopVerts = [];
      continue;
    }

    if (/^outer\s+loop$/i.test(trimmed)) {
      if (!inFacet || inLoop || loopDone) {
        failInvalid(`Unexpected 'outer loop' at line ${lineIdx + 1}`);
      }
      inLoop = true;
      loopVerts = [];
      continue;
    }

    if (/^vertex(?:\s|$)/i.test(trimmed)) {
      if (!inFacet || !inLoop) {
        failInvalid(`Unexpected 'vertex' outside 'outer loop' at line ${lineIdx + 1}`);
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length !== 4) {
        failInvalid(`Malformed vertex coordinate count at line ${lineIdx + 1}`);
      }
      const x = strictFloatRe.test(parts[1]) ? Number(parts[1]) : NaN;
      const y = strictFloatRe.test(parts[2]) ? Number(parts[2]) : NaN;
      const z = strictFloatRe.test(parts[3]) ? Number(parts[3]) : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        failInvalid(`Non-finite vertex coordinate in ASCII STL at line ${lineIdx + 1}`);
      }
      if (loopVerts.length >= 3) {
        failInvalid(`Facet outer loop has more than 3 vertices at line ${lineIdx + 1}`);
      }
      loopVerts.push(vec3(x, y, z));
      continue;
    }

    if (/^endloop$/i.test(trimmed)) {
      if (!inFacet || !inLoop) {
        failInvalid(`Unexpected 'endloop' at line ${lineIdx + 1}`);
      }
      if (loopVerts.length !== 3) {
        failInvalid(`Facet outer loop ended with ${loopVerts.length} vertices (expected 3) at line ${lineIdx + 1}`);
      }
      inLoop = false;
      loopDone = true;
      continue;
    }

    if (/^endfacet$/i.test(trimmed)) {
      if (!inFacet || inLoop || !loopDone || loopVerts.length !== 3) {
        failInvalid(`Malformed or unclosed 'endfacet' at line ${lineIdx + 1}`);
      }
      triangles.push([loopVerts[0], loopVerts[1], loopVerts[2]]);
      inFacet = false;
      loopDone = false;
      loopVerts = [];
      continue;
    }

    if (!sawSolid && trimmed.length > 0) {
      failInvalid(`Unrecognized token '${trimmed.slice(0, 32)}' in ASCII STL at line ${lineIdx + 1}`);
    }
    failInvalid(`Unrecognized STL statement '${trimmed.slice(0, 32)}' at line ${lineIdx + 1}`);
  }

  if (inFacet || inLoop) {
    failInvalid('Unexpected EOF inside unclosed facet/loop in ASCII STL');
  }

  if (triangles.length === 0) {
    throw new ValidationError(`No valid triangles found in STL (${safeName}).`, {
      code: 'EMPTY_STL',
      path: 'stl',
    });
  }
  return triangles;
}

function computeTriangleStatsAndBounds(triangles) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let surfaceAreaMm2 = 0;
  let signedVolumeMm3 = 0;

  for (const [v0, v1, v2] of triangles) {
    for (const v of [v0, v1, v2]) {
      if (!Number.isFinite(v.x * 1e3) || !Number.isFinite(v.y * 1e3) || !Number.isFinite(v.z * 1e3)) {
        throw new ValidationError(
          'STL vertex coordinates exceed finite precision bounds.',
          { code: 'INVALID_STL', path: 'stl' }
        );
      }
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
    const e1 = sub3(v1, v0);
    const e2 = sub3(v2, v0);
    const cr = cross3(e1, e2);
    const crLen = Math.hypot(cr.x, cr.y, cr.z);
    const v12 = cross3(v1, v2);
    if (
      !Number.isFinite(e1.x) || !Number.isFinite(e1.y) || !Number.isFinite(e1.z) ||
      !Number.isFinite(e2.x) || !Number.isFinite(e2.y) || !Number.isFinite(e2.z) ||
      !Number.isFinite(cr.x) || !Number.isFinite(cr.y) || !Number.isFinite(cr.z) ||
      !Number.isFinite(crLen) ||
      !Number.isFinite(v12.x) || !Number.isFinite(v12.y) || !Number.isFinite(v12.z)
    ) {
      throw new ValidationError(
        'STL triangle geometry overflows finite float64 bounds.',
        { code: 'INVALID_STL', path: 'stl' }
      );
    }
    surfaceAreaMm2 += 0.5 * crLen;
    signedVolumeMm3 += dot3(v0, v12) / 6;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  if (
    !Number.isFinite(spanX) ||
    !Number.isFinite(spanY) ||
    !Number.isFinite(spanZ) ||
    !Number.isFinite(surfaceAreaMm2) ||
    !Number.isFinite(signedVolumeMm3)
  ) {
    throw new ValidationError(
      'STL bounds or aggregate geometry overflow finite float64 bounds.',
      { code: 'INVALID_STL', path: 'stl' }
    );
  }

  const size = vec3(spanX, spanY, spanZ);
  const center = vec3(minX * 0.5 + maxX * 0.5, minY * 0.5 + maxY * 0.5, minZ * 0.5 + maxZ * 0.5);
  return {
    bounds: {
      min: vec3(minX, minY, minZ),
      max: vec3(maxX, maxY, maxZ),
      size,
      center,
    },
    surfaceAreaMm2,
    signedVolumeMm3,
    volumeMm3: Math.abs(signedVolumeMm3),
  };
}

function buildWeldedTopology(triangles, weldEps = 1e-3) {
  const cell = Math.max(1e-5, weldEps);
  const invCell = 1 / cell;
  const grid = new Map();
  const weldedVertices = [];

  const weldVertex = (v) => {
    const gx = Math.floor(v.x * invCell);
    const gy = Math.floor(v.y * invCell);
    const gz = Math.floor(v.z * invCell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${gx + dx},${gy + dy},${gz + dz}`;
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const idx of bucket) {
            if (dist3(v, weldedVertices[idx]) <= weldEps) {
              return idx;
            }
          }
        }
      }
    }
    const idx = weldedVertices.length;
    weldedVertices.push(vec3(v.x, v.y, v.z));
    const key = `${gx},${gy},${gz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(idx);
    return idx;
  };

  const faces = [];
  for (let i = 0; i < triangles.length; i++) {
    const [v0, v1, v2] = triangles[i];
    const i0 = weldVertex(v0);
    const i1 = weldVertex(v1);
    const i2 = weldVertex(v2);
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    const p0 = weldedVertices[i0];
    const p1 = weldedVertices[i1];
    const p2 = weldedVertices[i2];
    const cr = cross3(sub3(p1, p0), sub3(p2, p0));
    const dblArea = len3(cr);
    if (dblArea < 1e-8) continue;
    faces.push({
      faceIndex: faces.length,
      sourceTriIndex: i,
      indices: [i0, i1, i2],
      normal: scale3(cr, 1 / dblArea),
      area: 0.5 * dblArea,
      centroid: scale3(add3(add3(p0, p1), p2), 1 / 3),
    });
  }

  const edgeMap = new Map();
  const addEdge = (u, v, faceIdx) => {
    const a = u < v ? u : v;
    const b = u < v ? v : u;
    const key = `${a}_${b}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push({ faceIdx, u: a, v: b });
  };

  for (const f of faces) {
    const [i0, i1, i2] = f.indices;
    addEdge(i0, i1, f.faceIndex);
    addEdge(i1, i2, f.faceIndex);
    addEdge(i2, i0, f.faceIndex);
  }

  const adjacency = Array.from({ length: faces.length }, () => []);
  const allEdgeNeighbors = Array.from({ length: faces.length }, () => []);
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;

  for (const [, entries] of edgeMap) {
    if (entries.length === 1) {
      boundaryEdgeCount++;
    } else if (entries.length === 2) {
      const fA = entries[0].faceIdx;
      const fB = entries[1].faceIdx;
      const d = clamp(dot3(faces[fA].normal, faces[fB].normal), -1, 1);
      const dihedralDeg = (Math.acos(d) * 180) / Math.PI;
      const edgeVertices = [entries[0].u, entries[0].v];
      const edgeLength = dist3(weldedVertices[edgeVertices[0]], weldedVertices[edgeVertices[1]]);
      adjacency[fA].push({ neighbor: fB, dihedralDeg, edgeVertices, edgeLength });
      adjacency[fB].push({ neighbor: fA, dihedralDeg, edgeVertices, edgeLength });
      allEdgeNeighbors[fA].push(fB);
      allEdgeNeighbors[fB].push(fA);
    } else {
      nonManifoldEdgeCount++;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const fA = entries[i].faceIdx;
          const fB = entries[j].faceIdx;
          allEdgeNeighbors[fA].push(fB);
          allEdgeNeighbors[fB].push(fA);
        }
      }
    }
  }

  // Connected shells via BFS across all shared edges
  const visited = new Uint8Array(faces.length);
  const shells = [];
  for (let start = 0; start < faces.length; start++) {
    if (visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    const faceIndices = [];
    const vertSet = new Set();
    let areaMm2 = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let head = 0; head < queue.length; head++) {
      const fIdx = queue[head];
      faceIndices.push(fIdx);
      const f = faces[fIdx];
      areaMm2 += f.area;
      for (const vi of f.indices) {
        vertSet.add(vi);
        const pt = weldedVertices[vi];
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.z < minZ) minZ = pt.z;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
        if (pt.z > maxZ) maxZ = pt.z;
      }
      for (const nb of allEdgeNeighbors[fIdx]) {
        if (!visited[nb]) {
          visited[nb] = 1;
          queue.push(nb);
        }
      }
    }

    shells.push({
      id: `shell_${shells.length + 1}`,
      faceIndices,
      faceCount: faceIndices.length,
      triangleCount: faceIndices.length,
      vertexCount: vertSet.size,
      areaMm2,
      bounds: {
        min: vec3(minX, minY, minZ),
        max: vec3(maxX, maxY, maxZ),
        size: vec3(maxX - minX, maxY - minY, maxZ - minZ),
        center: vec3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
      },
    });
  }

  const weldedVertexCount = weldedVertices.length;
  const edgeCount = edgeMap.size;
  const faceCount = faces.length;
  const eulerCharacteristic = weldedVertexCount - edgeCount + faceCount;

  return {
    vertices: weldedVertices,
    faces,
    edgeMap,
    adjacency,
    shells,
    shellCount: shells.length,
    weldedVertexCount,
    vertexCount: weldedVertexCount,
    edgeCount,
    faceCount,
    boundaryEdgeCount,
    boundaryEdges: boundaryEdgeCount,
    openEdgeCount: boundaryEdgeCount,
    openEdges: boundaryEdgeCount,
    nonManifoldEdgeCount,
    nonManifoldEdges: nonManifoldEdgeCount,
    isManifold: nonManifoldEdgeCount === 0,
    isWatertight: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0 && faceCount > 0,
    euler: eulerCharacteristic,
    eulerCharacteristic,
  };
}

export function parseSTL(input, name = 'model.stl') {
  const safeName = typeof name === 'string' && name.length > 0 ? name : 'model.stl';
  if (input === null || input === undefined) {
    throw new ValidationError('STL input is null or undefined.', { code: 'EMPTY_STL', path: 'stl' });
  }

  let format = 'ascii';
  let triangles = [];

  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      throw new ValidationError('STL text input is empty.', { code: 'EMPTY_STL', path: 'stl' });
    }
    triangles = parseAsciiSTLText(input, safeName);
  } else {
    const bytes = toUint8Array(input);
    if (!bytes) {
      throw new ValidationError('Unsupported STL input type (expected string, ArrayBuffer, or Uint8Array/Buffer).', {
        code: 'INVALID_STL',
        path: 'stl',
      });
    }
    if (bytes.byteLength < 15) {
      throw new ValidationError(`STL buffer is too short (${bytes.byteLength} bytes).`, {
        code: 'TRUNCATED_STL',
        path: 'stl',
      });
    }

    const previewLen = Math.min(512, bytes.byteLength);
    const preview = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, previewLen));
    const looksLikeAscii = /^\s*solid\b/i.test(preview) && /\bfacet\b/i.test(preview) && /\bvertex\b/i.test(preview);
    const tailStart = bytes.byteLength >= 84 ? Math.max(80, bytes.byteLength - 512) : Math.max(0, bytes.byteLength - 512);
    const tailText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(tailStart));
    const hasEndsolid = /\bendsolid\b/i.test(tailText);

    if (bytes.byteLength >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const triCount = view.getUint32(80, true);
      const expectedBytes = 84 + triCount * 50;
      if (triCount > 0 && expectedBytes === bytes.byteLength && !(hasEndsolid && looksLikeAscii)) {
        format = 'binary';
        triangles = parseBinarySTLBytes(bytes, triCount);
      } else if (bytes.byteLength === 84 && triCount === 0 && !hasEndsolid) {
        throw new ValidationError(
          `STL (${safeName}) contains 0 triangles.`,
          { code: 'EMPTY_STL', path: 'stl' }
        );
      } else if (!looksLikeAscii) {
        const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (/\bfacet\b/i.test(fullText) && /\bvertex\b/i.test(fullText)) {
          format = 'ascii';
          triangles = parseAsciiSTLText(fullText, safeName);
        } else if (/^\s*solid\b/i.test(fullText) && /\bendsolid\b/i.test(fullText)) {
          format = 'ascii';
          triangles = parseAsciiSTLText(fullText, safeName);
        } else if (triCount === 0) {
          throw new ValidationError(
            `STL (${safeName}) contains 0 triangles.`,
            { code: 'EMPTY_STL', path: 'stl' }
          );
        } else if (triCount > 0 && expectedBytes <= bytes.byteLength) {
          format = 'binary';
          triangles = parseBinarySTLBytes(bytes, triCount);
        } else {
          throw new ValidationError(
            `Invalid or truncated binary STL (${safeName}): expected ${expectedBytes} bytes for ${triCount} triangles, got ${bytes.byteLength}.`,
            { code: 'TRUNCATED_STL', path: 'stl' }
          );
        }
      } else {
        const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        format = 'ascii';
        triangles = parseAsciiSTLText(fullText, safeName);
      }
    } else {
      const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (
        (/\bfacet\b/i.test(fullText) && /\bvertex\b/i.test(fullText)) ||
        (/^\s*solid\b/i.test(fullText) && /\bendsolid\b/i.test(fullText))
      ) {
        format = 'ascii';
        triangles = parseAsciiSTLText(fullText, safeName);
      } else {
        throw new ValidationError(`Truncated binary STL (${safeName}): ${bytes.byteLength} bytes (< 84).`, {
          code: 'TRUNCATED_STL',
          path: 'stl',
        });
      }
    }
  }

  const stats = computeTriangleStatsAndBounds(triangles);
  const topo = buildWeldedTopology(triangles, 1e-3);

  return {
    name: safeName,
    format,
    triangleCount: triangles.length,
    faceCount: topo.faces.length,
    edgeCount: topo.edgeCount,
    vertexCount: topo.weldedVertexCount,
    weldedVertexCount: topo.weldedVertexCount,
    vertices: topo.vertices,
    faces: topo.faces,
    triangles,
    adjacency: topo.adjacency,
    bounds: stats.bounds,
    dimensions: stats.bounds.size,
    center: stats.bounds.center,
    surfaceAreaMm2: stats.surfaceAreaMm2,
    signedVolumeMm3: stats.signedVolumeMm3,
    volumeMm3: stats.volumeMm3,
    shellCount: topo.shellCount,
    boundaryEdges: topo.boundaryEdgeCount,
    nonManifoldEdges: topo.nonManifoldEdgeCount,
    euler: topo.euler,
  };
}

export function analyzeSTLTopology(meshOrInput, options = {}) {
  const weldEps = Math.max(1e-5, finiteOr(options?.weldEps, 1e-3));
  let triangles;
  if (meshOrInput && typeof meshOrInput === 'object' && !Array.isArray(meshOrInput) && Array.isArray(meshOrInput.triangles)) {
    if (meshOrInput.triangles.length === 0) {
      throw new ValidationError('STL mesh contains 0 triangles.', {
        code: 'EMPTY_STL',
        path: 'triangles',
      });
    }
    triangles = validateNormalizedTriangles(meshOrInput.triangles, 'triangles');
  } else {
    const mesh = parseSTL(meshOrInput, options?.name || 'model.stl');
    triangles = mesh.triangles;
  }
  const stats = computeTriangleStatsAndBounds(triangles);
  const topo = buildWeldedTopology(triangles, weldEps);
  return {
    ...topo,
    triangleCount: triangles.length,
    bounds: stats.bounds,
    dimensions: stats.bounds.size,
    center: stats.bounds.center,
    surfaceAreaMm2: stats.surfaceAreaMm2,
    signedVolumeMm3: stats.signedVolumeMm3,
    volumeMm3: stats.volumeMm3,
  };
}

// ============================================================================
// Orientation-Invariant Unwrapping: form_shell_cover & surface_panels (F16)
// ============================================================================

function getCoord(v, axis) {
  return axis === 0 ? v.x : axis === 1 ? v.y : v.z;
}

function stitchSegmentsToLoops(segments, snapEps = 1e-2) {
  if (segments.length === 0) return [];
  const unused = segments.map((s, idx) => ({ p: s.p, q: s.q, idx, used: false }));
  const keyOf = (pt) => `${Math.round(pt.x / snapEps)}_${Math.round(pt.y / snapEps)}`;

  const startMap = new Map();
  for (let i = 0; i < unused.length; i++) {
    const k = keyOf(unused[i].p);
    if (!startMap.has(k)) startMap.set(k, []);
    startMap.get(k).push(i);
  }

  const loops = [];
  for (let i = 0; i < unused.length; i++) {
    if (unused[i].used) continue;
    unused[i].used = true;
    const loop = [unused[i].p, unused[i].q];
    let head = unused[i].q;
    const first = unused[i].p;
    let steps = 0;

    while (dist2(head, first) > 0.25 && steps++ < unused.length + 2) {
      let nextIdx = -1;
      const cand = startMap.get(keyOf(head));
      if (cand) {
        let bestD = Infinity;
        for (const ci of cand) {
          if (unused[ci].used) continue;
          const d = dist2(head, unused[ci].p);
          if (d < bestD) {
            bestD = d;
            nextIdx = ci;
          }
        }
      }
      if (nextIdx === -1) {
        let bestD = 0.5;
        for (let ci = 0; ci < unused.length; ci++) {
          if (unused[ci].used) continue;
          const d = dist2(head, unused[ci].p);
          if (d < bestD) {
            bestD = d;
            nextIdx = ci;
          }
        }
      }
      if (nextIdx === -1) break;
      unused[nextIdx].used = true;
      head = unused[nextIdx].q;
      if (dist2(head, first) <= 0.25) break;
      loop.push(head);
    }

    if (loop.length >= 3 && dist2(head, first) <= 0.6) {
      const cleaned = deduplicateConsecutivePoints(loop, 1e-3);
      if (cleaned.length >= 3) loops.push(cleaned);
    }
  }
  return loops;
}

function sliceMeshAtPlaneBasis(mesh, sAxis3D, uAxis3D, vAxis3D, planeVal) {
  const segments = [];

  for (const f of mesh.faces) {
    const pts = f.indices.map((vi) => mesh.vertices[vi]);
    const vals = pts.map((p) => dot3(p, sAxis3D) - planeVal);
    // Slight deterministic offset if a vertex sits right on plane
    const adj = vals.map((val) => (Math.abs(val) < 1e-6 ? 1e-6 : val));
    const pos = [];
    const neg = [];
    for (let k = 0; k < 3; k++) {
      if (adj[k] >= 0) pos.push(k);
      else neg.push(k);
    }
    if (pos.length === 0 || neg.length === 0) continue;

    const hits = [];
    for (let k = 0; k < 3; k++) {
      const kNext = (k + 1) % 3;
      if ((adj[k] >= 0) !== (adj[kNext] >= 0)) {
        const t = adj[k] / (adj[k] - adj[kNext]);
        const pA = pts[k];
        const pB = pts[kNext];
        const ua = dot3(pA, uAxis3D);
        const va = dot3(pA, vAxis3D);
        const ub = dot3(pB, uAxis3D);
        const vb = dot3(pB, vAxis3D);
        hits.push(vec2(ua + (ub - ua) * t, va + (vb - va) * t));
      }
    }
    if (hits.length === 2 && dist2(hits[0], hits[1]) > 1e-5) {
      let p = hits[0];
      let q = hits[1];
      // Orient p -> q so outward normal (q.y - p.y, -(q.x - p.x)) aligns with triangle normal (n_u, n_v)
      const nu = dot3(f.normal, uAxis3D);
      const nv = dot3(f.normal, vAxis3D);
      const outX = q.y - p.y;
      const outY = -(q.x - p.x);
      if (outX * nu + outY * nv < 0) {
        const tmp = p;
        p = q;
        q = tmp;
      }
      segments.push({ p, q });
    }
  }

  return stitchSegmentsToLoops(segments);
}

function buildBasisForSpanAxis(sAxis3D, worldAxis = -1) {
  if (worldAxis === 0) return { sAxis3D: vec3(1, 0, 0), uAxis3D: vec3(0, 1, 0), vAxis3D: vec3(0, 0, 1) };
  if (worldAxis === 1) return { sAxis3D: vec3(0, 1, 0), uAxis3D: vec3(0, 0, 1), vAxis3D: vec3(1, 0, 0) };
  if (worldAxis === 2) return { sAxis3D: vec3(0, 0, 1), uAxis3D: vec3(1, 0, 0), vAxis3D: vec3(0, 1, 0) };
  const s = norm3(sAxis3D);
  const ref = Math.abs(s.y) > 0.9 ? vec3(0, 0, 1) : vec3(0, 1, 0);
  const uAxis3D = norm3(cross3(ref, s));
  const vAxis3D = norm3(cross3(s, uAxis3D));
  return { sAxis3D: s, uAxis3D, vAxis3D };
}

function computeAreaWeightedPCA3D(mesh) {
  let totalA = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const f of mesh.faces) {
    const a = Math.max(1e-8, f.area);
    totalA += a;
    mx += f.centroid.x * a;
    my += f.centroid.y * a;
    mz += f.centroid.z * a;
  }
  if (totalA <= 1e-8) return [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  mx /= totalA;
  my /= totalA;
  mz /= totalA;

  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const f of mesh.faces) {
    const a = Math.max(1e-8, f.area);
    const dx = f.centroid.x - mx;
    const dy = f.centroid.y - my;
    const dz = f.centroid.z - mz;
    M[0][0] += a * dx * dx;
    M[0][1] += a * dx * dy;
    M[0][2] += a * dx * dz;
    M[1][1] += a * dy * dy;
    M[1][2] += a * dy * dz;
    M[2][2] += a * dz * dz;
  }
  M[1][0] = M[0][1];
  M[2][0] = M[0][2];
  M[2][1] = M[1][2];

  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 24; iter++) {
    let p = 0;
    let q = 1;
    let maxOff = Math.abs(M[0][1]);
    if (Math.abs(M[0][2]) > maxOff) {
      maxOff = Math.abs(M[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(M[1][2]) > maxOff) {
      maxOff = Math.abs(M[1][2]);
      p = 1;
      q = 2;
    }
    if (maxOff < 1e-10) break;
    const diff = M[q][q] - M[p][p];
    const t = Math.abs(diff) < 1e-12
      ? 1
      : (() => {
          const tau = diff / (2 * M[p][q]);
          return tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
        })();
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const app = M[p][p];
    const aqq = M[q][q];
    const apq = M[p][q];
    M[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    M[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    M[p][q] = 0;
    M[q][p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r !== p && r !== q) {
        const arp = M[r][p];
        const arq = M[r][q];
        M[r][p] = c * arp - s * arq;
        M[p][r] = M[r][p];
        M[r][q] = s * arp + c * arq;
        M[q][r] = M[r][q];
      }
      const vrp = V[r][p];
      const vrq = V[r][q];
      V[r][p] = c * vrp - s * vrq;
      V[r][q] = s * vrp + c * vrq;
    }
  }
  return [0, 1, 2].map((col) => norm3(vec3(V[0][col], V[1][col], V[2][col])));
}

function detectSpanAxis(mesh) {
  const fractions = [0.12, 0.22, 0.32, 0.42, 0.5, 0.58, 0.68, 0.78, 0.88];

  // Collect candidate 3D directions: world {X,Y,Z}, dominant antiparallel face-normal clusters, 3D PCA
  const rawCandidates = [
    { dir: vec3(1, 0, 0), isWorld: true, worldAxis: 0 },
    { dir: vec3(0, 1, 0), isWorld: true, worldAxis: 1 },
    { dir: vec3(0, 0, 1), isWorld: true, worldAxis: 2 },
  ];

  // Dominant antiparallel face-normal clusters
  const normalClusters = [];
  for (const f of mesh.faces) {
    if (!f || !f.normal || !Number.isFinite(f.area) || f.area <= 1e-8) continue;
    const n = f.normal;
    let matched = null;
    for (const cl of normalClusters) {
      if (Math.abs(dot3(n, cl.dir)) > 0.96) {
        matched = cl;
        break;
      }
    }
    if (!matched) {
      normalClusters.push({
        dir: n,
        sumDir: scale3(n, f.area),
        posA: f.area,
        negA: 0,
      });
    } else {
      const dp = dot3(n, matched.dir);
      const sign = dp >= 0 ? 1 : -1;
      matched.sumDir = add3(matched.sumDir, scale3(n, f.area * sign));
      if (sign > 0) matched.posA += f.area;
      else matched.negA += f.area;
      if (len3(matched.sumDir) > 1e-6) matched.dir = norm3(matched.sumDir);
    }
  }
  normalClusters.sort((a, b) => {
    const symA = Math.min(a.posA, a.negA);
    const symB = Math.min(b.posA, b.negA);
    if (Math.abs(symB - symA) > 1e-3) return symB - symA;
    return (b.posA + b.negA) - (a.posA + a.negA);
  });
  for (const cl of normalClusters.slice(0, 8)) {
    if (len3(cl.sumDir) > 1e-6) {
      rawCandidates.push({ dir: norm3(cl.sumDir), isWorld: false, worldAxis: -1 });
    }
  }

  for (const ev of computeAreaWeightedPCA3D(mesh)) {
    rawCandidates.push({ dir: ev, isWorld: false, worldAxis: -1 });
  }

  // Deduplicate candidates (prefer world axes on ties within 1e-4 / ~0.8 deg)
  const candidates = [];
  for (const cand of rawCandidates) {
    const d = norm3(cand.dir);
    if (!candidates.some((c) => Math.abs(dot3(c.dir, d)) > 0.9999)) {
      candidates.push({ dir: d, isWorld: cand.isWorld, worldAxis: cand.worldAxis });
    }
  }

  let bestIdx = 1;
  let bestScore = -1;
  const candResults = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    const { sAxis3D, uAxis3D, vAxis3D } = buildBasisForSpanAxis(cand.dir, cand.worldAxis);
    let minS = Infinity;
    let maxS = -Infinity;
    for (const v of mesh.vertices) {
      const sv = dot3(v, sAxis3D);
      if (sv < minS) minS = sv;
      if (sv > maxS) maxS = sv;
    }
    const spanLen = Number.isFinite(minS) && Number.isFinite(maxS) ? Math.max(0, maxS - minS) : 0;

    const perims = [];
    const areas = [];
    const sliceSamples = [];

    if (spanLen > 1e-3) {
      for (const frac of fractions) {
        const val = minS + spanLen * frac;
        const loops = sliceMeshAtPlaneBasis(mesh, sAxis3D, uAxis3D, vAxis3D, val);
        const posLoops = loops.filter((lp) => signedPolygonArea(lp) > 1e-2);
        if (posLoops.length > 0) {
          let totalP = 0;
          let totalNetA = 0;
          for (const lp of loops) {
            const sa = signedPolygonArea(lp);
            totalNetA += sa;
            if (sa > 0) {
              for (let i = 0; i < lp.length; i++) {
                totalP += dist2(lp[i], lp[(i + 1) % lp.length]);
              }
            }
          }
          perims.push(totalP);
          areas.push(Math.max(1e-3, totalNetA));
          posLoops.sort((a, b) => signedPolygonArea(b) - signedPolygonArea(a));
          sliceSamples.push({ frac, outerLoop: posLoops[0], perim: totalP, netArea: totalNetA });
        }
      }
    }

    const stats = (arr) => {
      if (arr.length < 2) return 999;
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      if (mean <= 1e-6) return 999;
      const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
      return Math.sqrt(variance) / mean;
    };

    const cvP = stats(perims);
    const cvA = stats(areas);

    let posA = 0;
    let negA = 0;
    for (const f of mesh.faces) {
      const nc = dot3(f.normal, sAxis3D);
      if (nc > 0.92) posA += f.area;
      else if (nc < -0.92) negA += f.area;
    }
    const maxCap = Math.max(posA, negA);
    const capSym = maxCap > 1e-3 ? Math.min(posA, negA) / maxCap : 0;

    const score = (1 / (1 + 10 * (cvP + cvA))) * (0.5 + 0.5 * capSym);
    const entry = {
      ax: cand.worldAxis,
      isWorld: cand.isWorld,
      sAxis3D,
      uAxis3D,
      vAxis3D,
      minS,
      maxS,
      score,
      sliceSamples,
      spanLen,
    };
    candResults.push(entry);

    if (idx === 0) {
      bestIdx = 0;
      bestScore = score;
    } else {
      const best = candResults[bestIdx];
      const worldTie = cand.isWorld && best.isWorld && Math.abs(score - bestScore) <= 0.02;
      const nearTie = Math.abs(score - bestScore) <= 1e-4;
      if (score > bestScore + (cand.isWorld && best.isWorld ? 0.02 : 1e-4)) {
        bestScore = score;
        bestIdx = idx;
      } else if (worldTie) {
        if (cand.worldAxis === 1 || (best.worldAxis !== 1 && spanLen > best.spanLen)) {
          bestScore = score;
          bestIdx = idx;
        }
      } else if (nearTie) {
        if (cand.isWorld && !best.isWorld) {
          bestScore = score;
          bestIdx = idx;
        } else if (cand.isWorld === best.isWorld && spanLen > best.spanLen) {
          bestScore = score;
          bestIdx = idx;
        }
      }
    }
  }

  return { spanAxis: candResults[bestIdx].ax, axisData: candResults[bestIdx] };
}

function rasterizeProjectedOuterLoopBasis(mesh, uAxis3D, vAxis3D, gridRes = 128) {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of mesh.vertices) {
    const pu = dot3(v, uAxis3D);
    const pv = dot3(v, vAxis3D);
    if (pu < minU) minU = pu;
    if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv;
    if (pv > maxV) maxV = pv;
  }
  const spanU = Math.max(1e-3, maxU - minU);
  const spanV = Math.max(1e-3, maxV - minV);
  const cell = Math.max(spanU, spanV) / (gridRes - 6);
  const w = Math.min(gridRes, Math.max(16, Math.ceil(spanU / cell) + 6));
  const h = Math.min(gridRes, Math.max(16, Math.ceil(spanV / cell) + 6));
  const ox = minU - 3 * cell;
  const oy = minV - 3 * cell;
  const occ = new Uint8Array(w * h);

  for (const f of mesh.faces) {
    const va = mesh.vertices[f.indices[0]];
    const vb = mesh.vertices[f.indices[1]];
    const vc = mesh.vertices[f.indices[2]];
    const a = vec2(dot3(va, uAxis3D), dot3(va, vAxis3D));
    const b = vec2(dot3(vb, uAxis3D), dot3(vb, vAxis3D));
    const c = vec2(dot3(vc, uAxis3D), dot3(vc, vAxis3D));
    const ix0 = clamp(Math.floor((Math.min(a.x, b.x, c.x) - ox) / cell), 1, w - 2);
    const ix1 = clamp(Math.ceil((Math.max(a.x, b.x, c.x) - ox) / cell), 1, w - 2);
    const iy0 = clamp(Math.floor((Math.min(a.y, b.y, c.y) - oy) / cell), 1, h - 2);
    const iy1 = clamp(Math.ceil((Math.max(a.y, b.y, c.y) - oy) / cell), 1, h - 2);
    const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denom) < 1e-9) continue;

    for (let gy = iy0; gy <= iy1; gy++) {
      const py = oy + (gy + 0.5) * cell;
      for (let gx = ix0; gx <= ix1; gx++) {
        const px = ox + (gx + 0.5) * cell;
        const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / denom;
        const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / denom;
        const l3 = 1 - l1 - l2;
        if (l1 >= -0.05 && l2 >= -0.05 && l3 >= -0.05) {
          occ[gy * w + gx] = 1;
        }
      }
    }
  }

  // Exterior flood fill from (0, 0)
  const ext = new Uint8Array(w * h);
  const q = [0];
  ext[0] = 1;
  for (let head = 0; head < q.length; head++) {
    const idx = q[head];
    const gx = idx % w;
    const gy = (idx - gx) / w;
    const nbs = [
      gx > 0 ? idx - 1 : -1,
      gx + 1 < w ? idx + 1 : -1,
      gy > 0 ? idx - w : -1,
      gy + 1 < h ? idx + w : -1,
    ];
    for (const ni of nbs) {
      if (ni >= 0 && !ext[ni] && !occ[ni]) {
        ext[ni] = 1;
        q.push(ni);
      }
    }
  }

  // Extract directed boundary segments between !ext (inside) and ext (outside)
  const segs = [];
  for (let gy = 1; gy < h - 1; gy++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const idx = gy * w + gx;
      if (ext[idx]) continue;
      const x0 = ox + gx * cell;
      const x1 = x0 + cell;
      const y0 = oy + gy * cell;
      const y1 = y0 + cell;
      if (ext[idx - w]) segs.push({ p: vec2(x1, y0), q: vec2(x0, y0) }); // bottom edge
      if (ext[idx + w]) segs.push({ p: vec2(x0, y1), q: vec2(x1, y1) }); // top edge
      if (ext[idx - 1]) segs.push({ p: vec2(x0, y0), q: vec2(x0, y1) }); // left edge
      if (ext[idx + 1]) segs.push({ p: vec2(x1, y1), q: vec2(x1, y0) }); // right edge
    }
  }
  const loops = stitchSegmentsToLoops(segs, cell * 0.1);
  loops.sort((a, b) => signedPolygonArea(b) - signedPolygonArea(a));
  if (loops.length > 0 && signedPolygonArea(loops[0]) > 0) {
    return loops[0];
  }

  // Last resort fallback: convex hull
  const pts2 = mesh.vertices.map((v) => vec2(dot3(v, uAxis3D), dot3(v, vAxis3D)));
  return convexHull2D(pts2);
}

function canonicalizeProfile2D(loopUV, uAxis3D, vAxis3D) {
  // Compute 2D PCA over boundary vertices weighted by adjacent edge length
  const n = loopUV.length;
  const weights = new Array(n).fill(0);
  let wSum = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const prev = loopUV[(i - 1 + n) % n];
    const curr = loopUV[i];
    const next = loopUV[(i + 1) % n];
    const w = (dist2(prev, curr) + dist2(curr, next)) * 0.5;
    weights[i] = w;
    wSum += w;
    cx += curr.x * w;
    cy += curr.y * w;
  }
  cx /= Math.max(1e-6, wSum);
  cy /= Math.max(1e-6, wSum);

  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = loopUV[i].x - cx;
    const dy = loopUV[i].y - cy;
    cxx += weights[i] * dx * dx;
    cyy += weights[i] * dy * dy;
    cxy += weights[i] * dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  let ax1 = vec2(Math.cos(theta), Math.sin(theta));
  let ax2 = vec2(-ax1.y, ax1.x);

  // Check skewness to make orientation deterministic across arbitrary 3D rotations
  let skew1 = 0;
  let skew2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = loopUV[i].x - cx;
    const dy = loopUV[i].y - cy;
    const p1 = dx * ax1.x + dy * ax1.y;
    const p2 = dx * ax2.x + dy * ax2.y;
    skew1 += weights[i] * p1 * p1 * p1;
    skew2 += weights[i] * p2 * p2 * p2;
  }
  if (skew1 < -1e-3) {
    ax1 = scale2(ax1, -1);
    ax2 = scale2(ax2, -1);
    skew2 = -skew2;
  }

  // Project and ensure widest dimension along X
  let pts = loopUV.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return vec2(dx * ax1.x + dy * ax1.y, dx * ax2.x + dy * ax2.y);
  });
  let eX3D = add3(scale3(uAxis3D, ax1.x), scale3(vAxis3D, ax1.y));
  let eY3D = add3(scale3(uAxis3D, ax2.x), scale3(vAxis3D, ax2.y));

  const b = polygonBounds(pts);
  if (b.height > b.width + 1e-3) {
    // Rotate -90 deg
    pts = pts.map((p) => vec2(p.y, -p.x));
    const oldX = eX3D;
    eX3D = eY3D;
    eY3D = scale3(oldX, -1);
  }

  return {
    points: ensureCCW(pts),
    eX3D: norm3(eX3D),
    eY3D: norm3(eY3D),
    centerUV: vec2(cx, cy),
  };
}

function unwrapFormShellCoverMode(mesh, opts) {
  const { axisData } = detectSpanAxis(mesh);
  const { sAxis3D, uAxis3D, vAxis3D, minS: spanMin, maxS: spanMax } = axisData;

  // Planar / zero-thickness fallback (e.g., single planar XY triangle)
  if (axisData.spanLen < 1e-2 && axisData.sliceSamples.length === 0) {
    return unwrapSurfacePanelsMode(mesh, opts);
  }

  // Extract raw concave outer profile in (u, v)
  let rawProfileUV;
  if (axisData.sliceSamples.length > 0) {
    const sorted = [...axisData.sliceSamples].sort((a, b) => a.perim - b.perim);
    const medianSample = sorted[Math.floor(sorted.length * 0.5)];
    rawProfileUV = medianSample.outerLoop;
  } else {
    rawProfileUV = rasterizeProjectedOuterLoopBasis(mesh, uAxis3D, vAxis3D, 128);
  }

  if (!Array.isArray(rawProfileUV) || rawProfileUV.length < 3 || polygonArea(rawProfileUV) < 1e-2) {
    return unwrapSurfacePanelsMode(mesh, opts);
  }

  const rawBoundsUV = polygonBounds(rawProfileUV);
  const maxDim = Math.max(rawBoundsUV.width, rawBoundsUV.height, 1);
  const tolMm = clamp(maxDim * 0.008, 0.2, 1.5);
  const minEdgeMm = clamp(maxDim * 0.032, 0.5, 5.5);

  const canonical = canonicalizeProfile2D(rawProfileUV, uAxis3D, vAxis3D);
  const simplifiedUnscaled = simplifyClosedPolygon(canonical.points, tolMm, minEdgeMm);

  // Apply linear scale BEFORE outward ease+thickness offset
  const scaledProfile = ensureCCW(
    simplifiedUnscaled.map((p) => vec2(p.x * opts.scale, p.y * opts.scale))
  );
  const offsetMm = opts.easeMm + opts.thicknessMm;
  const coverProfile = sanitizePolygonOffset(scaledProfile, offsetMm, 3.0);
  const coverArea = Array.isArray(coverProfile) ? polygonArea(coverProfile) : NaN;
  if (
    !Array.isArray(coverProfile) ||
    coverProfile.length < 3 ||
    !Number.isFinite(coverArea) ||
    coverArea < 1e-2 ||
    coverProfile.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  ) {
    return unwrapSurfacePanelsMode(mesh, opts);
  }

  // Normalize local 2D coordinates to minX=0, minY=0
  const bLeft = polygonBounds(coverProfile);
  const leftPoints = coverProfile.map((p) => vec2(p.x - bLeft.minX, p.y - bLeft.minY));

  const spanCenter = (spanMin + spanMax) * 0.5;
  const rawSpan = Math.max(0.5, spanMax - spanMin);
  const spanLength = Math.max(0.5, rawSpan * opts.scale + offsetMm * 2);

  // Compute raw 3D centroid of the actual cover polygon in (u, v) for exact raw-STL-frame placement3D
  const leftCentroid2 = polygonCentroid(leftPoints);
  const cCanonX = (leftCentroid2.x + bLeft.minX) / opts.scale;
  const cCanonY = (leftCentroid2.y + bLeft.minY) / opts.scale;
  const centerU = canonical.centerUV.x;
  const centerV = canonical.centerUV.y;
  const baseCenter3D = add3(
    add3(scale3(uAxis3D, centerU), scale3(vAxis3D, centerV)),
    scale3(sAxis3D, spanCenter)
  );
  const profileCentroid3D = add3(
    baseCenter3D,
    add3(scale3(canonical.eX3D, cCanonX), scale3(canonical.eY3D, cCanonY))
  );

  const nEdges = leftPoints.length;
  const sa = opts.seamAllowance;
  const clearance3D = offsetMm + 2.0;

  // Ensure (eX3D, eY3D, leftNormal3D) forms a consistent 2D-to-3D frame where -up = +eY3D
  const planeNormal = norm3(cross3(canonical.eX3D, canonical.eY3D));
  const leftNormal3D = scale3(planeNormal, -1);
  const rightNormal3D = planeNormal;
  const leftIsMin = dot3(leftNormal3D, sAxis3D) < 0;
  const leftSpanCoord = leftIsMin ? spanMin - clearance3D : spanMax + clearance3D;
  const rightSpanCoord = leftIsMin ? spanMax + clearance3D : spanMin - clearance3D;

  const capAnchorUV3D = add3(
    add3(scale3(uAxis3D, centerU), scale3(vAxis3D, centerV)),
    add3(scale3(canonical.eX3D, cCanonX), scale3(canonical.eY3D, cCanonY))
  );

  const leftPlacement = makeSafePlacement3D(
    add3(capAnchorUV3D, scale3(sAxis3D, leftSpanCoord)),
    leftNormal3D,
    canonical.eX3D
  );

  const leftPiece = {
    id: 'stl_side_left',
    name: 'Left Profile Panel',
    role: 'stl_profile',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    distortionPct: 0,
    points: leftPoints,
    edges: leftPoints.map((_, i) => ({ name: `Profile Edge ${i + 1}`, seamAllowance: sa })),
    notches: [
      { id: 'notch_left_0', edgeIndex: 0, t: 0.5, type: 'double' },
      ...(nEdges > 2 ? [{ id: 'notch_left_mid', edgeIndex: Math.floor(nEdges / 2), t: 0.5, type: 'single' }] : []),
    ],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 0 },
    placement3D: leftPlacement,
  };

  // Right Profile Panel: mirror X then ensureCCW
  // Note: reversing [p0, p1, ..., p_{n-1}] after X-mirror yields edge idx mapping:
  // Left edge i (leftPoints[i] -> leftPoints[(i+1)%n]) corresponds to Right edge (n - 2 - i + n) % n
  const mirroredRight = leftPoints.map((p) => vec2(bLeft.width - (p.x), p.y));
  const rightRawCCW = ensureCCW(mirroredRight);
  // Find which edge of rightRawCCW corresponds to leftPoints[0]->leftPoints[1]
  const findMappedRightEdge = (leftEdgeIdx) => {
    const aL = leftPoints[leftEdgeIdx];
    const bL = leftPoints[(leftEdgeIdx + 1) % nEdges];
    const aR = vec2(bLeft.width - aL.x, aL.y);
    const bR = vec2(bLeft.width - bL.x, bL.y);
    for (let j = 0; j < nEdges; j++) {
      const p0 = rightRawCCW[j];
      const p1 = rightRawCCW[(j + 1) % nEdges];
      if ((dist2(p0, bR) < 1e-3 && dist2(p1, aR) < 1e-3) || (dist2(p0, aR) < 1e-3 && dist2(p1, bR) < 1e-3)) {
        return j;
      }
    }
    return (nEdges - 2 - leftEdgeIdx + nEdges) % nEdges;
  };

  const rightPlacement = makeSafePlacement3D(
    add3(capAnchorUV3D, scale3(sAxis3D, rightSpanCoord)),
    rightNormal3D,
    scale3(canonical.eX3D, -1)
  );

  const rightPiece = {
    id: 'stl_side_right',
    name: 'Right Profile Panel',
    role: 'stl_profile',
    quantity: 1,
    onFold: false,
    position: { x: 40 + bLeft.width + 60, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    distortionPct: 0,
    points: rightRawCCW,
    edges: rightRawCCW.map((_, i) => ({ name: `Profile Edge ${i + 1}`, seamAllowance: sa })),
    notches: [
      { id: 'notch_right_0', edgeIndex: findMappedRightEdge(0), t: 0.5, type: 'double' },
      ...(nEdges > 2 ? [{ id: 'notch_right_mid', edgeIndex: findMappedRightEdge(Math.floor(nEdges / 2)), t: 0.5, type: 'single' }] : []),
    ],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 0 },
    placement3D: rightPlacement,
  };

  const pieces = [leftPiece, rightPiece];
  const seams = [];
  let gussetX = 40;
  const gussetY = 40 + bLeft.height + 70;

  for (let i = 0; i < nEdges; i++) {
    const p0 = leftPoints[i];
    const p1 = leftPoints[(i + 1) % nEdges];
    const edgeVec2 = sub2(p1, p0);
    const segLen = Math.max(0.1, Math.hypot(edgeVec2.x, edgeVec2.y));

    const gId = `stl_gusset_${i + 1}`;
    const gPts = [
      vec2(0, 0),
      vec2(spanLength, 0),
      vec2(spanLength, segLen),
      vec2(0, segLen),
    ];

    // Map edge midpoint and outward normal into raw 3D STL coordinates
    const edgeMid2 = scale2(add2(p0, p1), 0.5);
    const rel2 = sub2(edgeMid2, leftCentroid2);
    const dir2 = norm2(edgeVec2);
    // Outward 2D normal for CCW polygon is (dir.y, -dir.x)
    const out2 = vec2(dir2.y, -dir2.x);

    const relMid3D = add3(scale3(canonical.eX3D, rel2.x / opts.scale), scale3(canonical.eY3D, rel2.y / opts.scale));
    const outNormal3D = norm3(add3(scale3(canonical.eX3D, out2.x), scale3(canonical.eY3D, out2.y)));
    const rawEdgeMid3D = add3(profileCentroid3D, relMid3D);
    const gOffset3D = add3(rawEdgeMid3D, scale3(outNormal3D, clearance3D));

    pieces.push({
      id: gId,
      name: `Perimeter Gusset ${i + 1}`,
      role: 'stl_gusset',
      quantity: 1,
      onFold: false,
      position: { x: gussetX, y: gussetY },
      rotation: 0,
      seamAllowance: sa,
      distortionPct: 0,
      points: gPts,
      edges: [
        { name: 'Gusset Join Prev', seamAllowance: sa },
        { name: 'Right Cap Seam', seamAllowance: sa },
        { name: 'Gusset Join Next', seamAllowance: sa },
        { name: 'Left Cap Seam', seamAllowance: sa },
      ],
      notches: [{ id: `notch_g_${i + 1}`, edgeIndex: 3, t: 0.5, type: 'single' }],
      darts: [],
      internalLines: [],
      grainline: { angleDeg: 90 },
      placement3D: makeSafePlacement3D(gOffset3D, outNormal3D, rightNormal3D),
    });

    gussetX += spanLength + 40;

    // Gusset edge 3 (0,segLen)->(0,0) mates with leftPiece edge i
    seams.push({
      id: `seam_gusset_${i + 1}_left`,
      name: `Left Cap to Gusset ${i + 1}`,
      pieceA: leftPiece.id,
      edgeA: i,
      pieceB: gId,
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    });

    // Gusset edge 1 (spanLength,0)->(spanLength,segLen) mates with rightPiece mapped edge
    seams.push({
      id: `seam_gusset_${i + 1}_right`,
      name: `Right Cap to Gusset ${i + 1}`,
      pieceA: rightPiece.id,
      edgeA: findMappedRightEdge(i),
      pieceB: gId,
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    });

    // Gusset edge 2 mates with next gusset edge 0
    const nextGId = `stl_gusset_${((i + 1) % nEdges) + 1}`;
    seams.push({
      id: `seam_gusset_join_${i + 1}`,
      name: `Gusset ${i + 1} to Gusset ${((i + 1) % nEdges) + 1}`,
      pieceA: gId,
      edgeA: 2,
      pieceB: nextGId,
      edgeB: 0,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    });
  }

  return { pieces, seams };
}

// ============================================================================
// Mode 2: surface_panels (Dihedral-Angle Chart BFS + Isometric Hinge Unfolding)
// ============================================================================

function placeThirdVertex2D(a2, b2, dAB, dAC, dBC, opp2) {
  const ab = sub2(b2, a2);
  const L = Math.hypot(ab.x, ab.y);
  if (L < 1e-8) return add2(a2, vec2(dAC, 0));
  const ux = ab.x / L;
  const uy = ab.y / L;
  const x = (L * L + dAC * dAC - dBC * dBC) / (2 * L);
  const hSq = Math.max(0, dAC * dAC - x * x);
  const h = Math.sqrt(hSq);

  const cand1 = vec2(a2.x + ux * x - uy * h, a2.y + uy * x + ux * h);
  const cand2 = vec2(a2.x + ux * x + uy * h, a2.y + uy * x - ux * h);
  if (!opp2) return cand1;

  // Choose the candidate on the OPPOSITE side of line (a2 -> b2) from opp2
  const sOpp = cross2(ab, sub2(opp2, a2));
  const s1 = cross2(ab, sub2(cand1, a2));
  const s2 = cross2(ab, sub2(cand2, a2));
  return s1 * sOpp <= s2 * sOpp ? cand1 : cand2;
}

function pointInPoly2D(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = (yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function syncDedupAndCCW(rawPts, rawEdgeKeys, eps = 1e-3) {
  let pts = rawPts.map((p) => vec2(p.x, p.y));
  let keys = [...rawEdgeKeys];
  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 64) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const nxt = (i + 1) % pts.length;
      if (dist2(pts[i], pts[nxt]) < eps) {
        if (nxt === 0) {
          pts.pop();
          keys.pop();
        } else {
          pts.splice(nxt, 1);
          keys.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
  }
  if (signedPolygonArea(pts) < 0 && pts.length >= 3) {
    const n = pts.length;
    pts = [...pts].reverse();
    keys = keys.map((_, k) => keys[(n - 2 - k + n) % n]);
  }
  return { pts, edgeKeys: keys };
}

function unfoldChartTo2D(mesh, faceIndices, chartAvgNormal) {
  const faceSet = new Set(faceIndices);
  if (faceIndices.length === 0) return null;

  let seedFace = faceIndices[0];
  let maxArea = -1;
  let minNormalDot = 1;
  for (const fi of faceIndices) {
    const f = mesh.faces[fi];
    if (f.area > maxArea) {
      maxArea = f.area;
      seedFace = fi;
    }
    const nd = dot3(f.normal, chartAvgNormal);
    if (nd < minNormalDot) minNormalDot = nd;
  }

  const face2D = new Map();
  let bestEx3D = null;

  if (minNormalDot >= 0.9995) {
    // Planar chart: project directly into chart plane with zero chaining drift
    const f0 = mesh.faces[seedFace];
    const vA = mesh.vertices[f0.indices[0]];
    const vB = mesh.vertices[f0.indices[1]];
    const exHint = dist3(vA, vB) > 1e-6 ? norm3(sub3(vB, vA)) : null;
    const plBasis = makeSafePlacement3D(f0.centroid, chartAvgNormal, exHint);
    const n = norm3(plBasis.normal);
    const up = norm3(plBasis.up);
    const u = norm3(cross3(up, n));
    const v = norm3(cross3(n, u));
    const origin3D = f0.centroid;
    bestEx3D = u;

    for (const fi of faceIndices) {
      const f = mesh.faces[fi];
      const idx = f.indices;
      const pts = idx.map((vi) => {
        const rel = sub3(mesh.vertices[vi], origin3D);
        return vec2(dot3(rel, u), -dot3(rel, v));
      });
      const area2D = cross2(sub2(pts[1], pts[0]), sub2(pts[2], pts[0]));
      face2D.set(fi, {
        indices: area2D >= 0 ? [...idx] : [idx[0], idx[2], idx[1]],
        pts: area2D >= 0 ? pts : [pts[0], pts[2], pts[1]],
      });
    }
  } else {
    // Isometric hinge unfolding across spanning tree of faces in Canvas Y-down coordinates
    const f0 = mesh.faces[seedFace];
    const [i0, i1, i2] = f0.indices;
    const v0 = mesh.vertices[i0];
    const v1 = mesh.vertices[i1];
    const v2 = mesh.vertices[i2];
    const d01 = dist3(v0, v1);
    const d02 = dist3(v0, v2);
    const d12 = dist3(v1, v2);

    const p0 = vec2(0, 0);
    const p1 = vec2(Math.max(1e-6, d01), 0);
    const x2 = (p1.x * p1.x + d02 * d02 - d12 * d12) / (2 * p1.x);
    const h2 = Math.sqrt(Math.max(0, d02 * d02 - x2 * x2));
    // Canvas Y-down: physics.mjs maps dy = -(v2.y - c2D.y), so +up in 3D maps to -h in 2D
    const p2 = vec2(x2, -h2);
    const seedEx3D = d01 > 1e-6 ? norm3(sub3(v1, v0)) : null;

    const seedArea2D = cross2(sub2(p1, p0), sub2(p2, p0));
    face2D.set(seedFace, {
      indices: seedArea2D >= 0 ? [i0, i1, i2] : [i0, i2, i1],
      pts: seedArea2D >= 0 ? [p0, p1, p2] : [p0, p2, p1],
    });

    const queue = [seedFace];
    for (let head = 0; head < queue.length; head++) {
      const fIdx = queue[head];
      const curData = face2D.get(fIdx);
      for (const edge of mesh.adjacency[fIdx]) {
        const nb = edge.neighbor;
        if (!faceSet.has(nb) || face2D.has(nb)) continue;
        const nbFace = mesh.faces[nb];
        const [u, v] = edge.edgeVertices;

        const posU = curData.indices.indexOf(u);
        const posV = curData.indices.indexOf(v);
        if (posU === -1 || posV === -1) continue;
        const oppCur = curData.pts[3 - posU - posV];
        const a2 = curData.pts[posU];
        const b2 = curData.pts[posV];

        const nbIdx = nbFace.indices;
        const w = nbIdx.find((x) => x !== u && x !== v);
        if (w === undefined) continue;

        const dUV = dist3(mesh.vertices[u], mesh.vertices[v]);
        const dUW = dist3(mesh.vertices[u], mesh.vertices[w]);
        const dVW = dist3(mesh.vertices[v], mesh.vertices[w]);
        const w2 = placeThirdVertex2D(a2, b2, dUV, dUW, dVW, oppCur);

        const mapNb = new Map([
          [u, a2],
          [v, b2],
          [w, w2],
        ]);
        const nbPts = nbIdx.map((vi) => mapNb.get(vi));
        const area2D = cross2(sub2(nbPts[1], nbPts[0]), sub2(nbPts[2], nbPts[0]));
        face2D.set(nb, {
          indices: area2D >= 0 ? nbIdx : [nbIdx[0], nbIdx[2], nbIdx[1]],
          pts: area2D >= 0 ? nbPts : [nbPts[0], nbPts[2], nbPts[1]],
        });
        queue.push(nb);
      }
    }

    // Optimal area-weighted 2D +X -> 3D axis across all unfolded faces
    let sumEx = vec3(0, 0, 0);
    for (const [fi, data] of face2D) {
      const va = mesh.vertices[data.indices[0]];
      const vb = mesh.vertices[data.indices[1]];
      const vc = mesh.vertices[data.indices[2]];
      const pa = data.pts[0];
      const pb = data.pts[1];
      const pc = data.pts[2];
      const e1 = sub2(pb, pa);
      const e2 = sub2(pc, pa);
      const det = e1.x * e2.y - e1.y * e2.x;
      if (Math.abs(det) > 1e-8) {
        const exF = scale3(sub3(scale3(sub3(vb, va), e2.y), scale3(sub3(vc, va), e1.y)), 1 / det);
        if (len3(exF) > 1e-6) {
          sumEx = add3(sumEx, scale3(norm3(exF), mesh.faces[fi].area));
        }
      }
    }
    bestEx3D = len3(sumEx) > 1e-6 ? norm3(sumEx) : seedEx3D;
  }

  const area3DTotal = faceIndices.reduce((s, fi) => s + mesh.faces[fi].area, 0);

  // Extract outer boundary of unfolded 2D triangles by cancelling shared topological 3D directed edges
  if (face2D.size === faceIndices.length) {
    const dirMap = new Map();
    const boundaryEdges = [];

    for (const [fi, data] of face2D) {
      for (let k = 0; k < 3; k++) {
        const kn = (k + 1) % 3;
        const pA = data.pts[k];
        const pB = data.pts[kn];
        const vA = data.indices[k];
        const vB = data.indices[kn];
        const fwd = `${vA}->${vB}`;
        const rev = `${vB}->${vA}`;
        if (dirMap.has(rev)) {
          dirMap.delete(rev);
        } else {
          dirMap.set(fwd, {
            p: pA,
            q: pB,
            vA,
            vB,
            edge3DKey: vA < vB ? `${vA}_${vB}` : `${vB}_${vA}`,
            faceIdx: fi,
          });
        }
      }
    }

    for (const item of dirMap.values()) boundaryEdges.push(item);

    // Stitch directed boundary edges into closed loops by topological vertex ID (fallback: 2D proximity)
    const unused = boundaryEdges.map((e) => ({ ...e, used: false }));
    const posLoops = [];
    const negLoops = [];
    for (let i = 0; i < unused.length; i++) {
      if (unused[i].used) continue;
      unused[i].used = true;
      const pts = [unused[i].p];
      const edgeKeys = [unused[i].edge3DKey];
      let head = unused[i].q;
      let headVert = unused[i].vB;
      const first = unused[i].p;
      const firstVert = unused[i].vA;
      let steps = 0;

      while (headVert !== firstVert && steps++ < unused.length + 2) {
        let bestIdx = -1;
        for (let j = 0; j < unused.length; j++) {
          if (!unused[j].used && unused[j].vA === headVert) {
            bestIdx = j;
            break;
          }
        }
        if (bestIdx === -1) {
          let bestD = 0.25;
          for (let j = 0; j < unused.length; j++) {
            if (unused[j].used) continue;
            const d = dist2(head, unused[j].p);
            if (d < bestD) {
              bestD = d;
              bestIdx = j;
            }
          }
        }
        if (bestIdx === -1) break;
        unused[bestIdx].used = true;
        pts.push(unused[bestIdx].p);
        edgeKeys.push(unused[bestIdx].edge3DKey);
        head = unused[bestIdx].q;
        headVert = unused[bestIdx].vB;
        if (headVert === firstVert || dist2(head, first) <= 1e-4) break;
      }

      if (pts.length >= 3 && (headVert === firstVert || dist2(head, first) <= 0.4)) {
        const area = signedPolygonArea(pts);
        if (area > 1e-2) {
          posLoops.push({ pts, edgeKeys, area });
        } else if (area < -1e-2) {
          negLoops.push({ pts, edgeKeys, area });
        }
      }
    }

    posLoops.sort((a, b) => b.area - a.area);
    if (posLoops.length > 0) {
      const outer = posLoops[0];
      const synced = syncDedupAndCCW(outer.pts, outer.edgeKeys, 1e-3);
      const ccw = synced.pts;
      let holeAreaSum = 0;
      for (const nl of negLoops) {
        if (nl.pts.length > 0 && pointInPoly2D(nl.pts[0], ccw)) {
          holeAreaSum += Math.abs(nl.area);
        }
      }
      const netArea = Math.max(0, polygonArea(ccw) - holeAreaSum);
      if (
        ccw.length >= 3 &&
        synced.edgeKeys.length === ccw.length &&
        !polygonSelfIntersects(ccw) &&
        netArea >= area3DTotal * 0.55 &&
        netArea <= area3DTotal * 1.85
      ) {
        return {
          points: ccw,
          edge3DKeysPerEdge: synced.edgeKeys,
          area3D: area3DTotal,
          isIsometric: true,
          ex3D: bestEx3D,
        };
      }
    }
  }

  // Fallback for non-developable / saddle / self-overlapping charts: tangent-plane projection + outer contour
  const basis = buildBasisFromNormal(chartAvgNormal);
  const origin3D = mesh.faces[seedFace].centroid;
  const projPts = [];
  for (const fi of faceIndices) {
    for (const vi of mesh.faces[fi].indices) {
      const rel = sub3(mesh.vertices[vi], origin3D);
      projPts.push(vec2(dot3(rel, basis.ex), dot3(rel, basis.ey)));
    }
  }
  const hull = convexHull2D(projPts);
  const projArea = Math.max(1e-3, polygonArea(hull));
  const areaScale = clamp(Math.sqrt(area3DTotal / projArea), 0.7, 2.5);
  const cHull = polygonCentroid(hull);
  const scaled = ensureCCW(hull.map((p) => add2(cHull, scale2(sub2(p, cHull), areaScale))));
  return {
    points: scaled,
    edge3DKeysPerEdge: null,
    area3D: area3DTotal,
    isIsometric: false,
    ex3D: basis.ex,
  };
}

function unwrapSurfacePanelsMode(mesh, opts) {
  const thresh = clamp(finiteOr(opts.dihedralThresholdDeg ?? opts.angleThresholdDeg ?? opts.angleThreshold, 28), 0.1, 179.9);
  const maxNormalDevDeg = Math.min(88, Math.max(thresh * 1.8, 18));
  const minChartAreaMm2 = Math.max(1, finiteOr(opts.minChartAreaMm2, 22));

  const faceChart = new Int32Array(mesh.faces.length).fill(-1);
  const charts = [];

  for (let start = 0; start < mesh.faces.length; start++) {
    if (faceChart[start] !== -1) continue;
    const chartId = charts.length;
    faceChart[start] = chartId;
    const queue = [start];
    const faces = [];
    let sumN = scale3(mesh.faces[start].normal, mesh.faces[start].area);

    for (let head = 0; head < queue.length; head++) {
      const fIdx = queue[head];
      faces.push(fIdx);
      const avgN = len3(sumN) > 1e-6 ? norm3(sumN) : mesh.faces[start].normal;

      for (const edge of mesh.adjacency[fIdx]) {
        const nb = edge.neighbor;
        if (faceChart[nb] !== -1) continue;
        if (edge.dihedralDeg > thresh) continue;
        const devDeg = (Math.acos(clamp(dot3(avgN, mesh.faces[nb].normal), -1, 1)) * 180) / Math.PI;
        if (devDeg > maxNormalDevDeg) continue;
        faceChart[nb] = chartId;
        sumN = add3(sumN, scale3(mesh.faces[nb].normal, mesh.faces[nb].area));
        queue.push(nb);
      }
    }

    charts.push({ id: chartId, faces });
  }

  // Merge tiny slivers (< minChartAreaMm2) into smooth neighbor sharing longest 3D boundary edge
  // Avoid merging across sharp (>= 75 deg) corners which fold onto adjacent faces and self-intersect
  if (charts.length > 2) {
    const chartNormalOf = (faces) => {
      let sn = vec3(0, 0, 0);
      for (const fi of faces) {
        const f = mesh.faces[fi];
        sn = add3(sn, scale3(f.normal, f.area));
      }
      return len3(sn) > 1e-6 ? norm3(sn) : mesh.faces[faces[0]].normal;
    };
    const maxSliverMergeDeg = Math.min(75, Math.max(thresh * 1.5, 50));
    let mergedAny = true;
    let guard = 0;
    while (mergedAny && guard++ < 500) {
      mergedAny = false;
      const activeCount = charts.filter((c) => c.faces.length > 0).length;
      if (activeCount <= 2) break;

      for (const ch of charts) {
        if (ch.faces.length === 0) continue;
        const area = ch.faces.reduce((s, fi) => s + mesh.faces[fi].area, 0);
        if (area >= minChartAreaMm2) continue;

        const chN = chartNormalOf(ch.faces);
        const nbLen = new Map();
        for (const fi of ch.faces) {
          for (const edge of mesh.adjacency[fi]) {
            const nbChart = faceChart[edge.neighbor];
            if (nbChart !== ch.id && nbChart >= 0) {
              nbLen.set(nbChart, (nbLen.get(nbChart) || 0) + edge.edgeLength);
            }
          }
        }
        let bestNb = -1;
        let bestLen = -1;
        for (const [nbId, len] of nbLen) {
          if (len <= bestLen || charts[nbId].faces.length === 0) continue;
          const nbN = chartNormalOf(charts[nbId].faces);
          const angDeg = (Math.acos(clamp(dot3(chN, nbN), -1, 1)) * 180) / Math.PI;
          if (angDeg > maxSliverMergeDeg) continue;
          bestLen = len;
          bestNb = nbId;
        }
        if (bestNb !== -1) {
          for (const fi of ch.faces) {
            faceChart[fi] = bestNb;
            charts[bestNb].faces.push(fi);
          }
          ch.faces = [];
          mergedAny = true;
          break;
        }
      }
    }
  }

  const activeCharts = charts.filter((c) => c.faces.length > 0);
  const chartAvgNormals = new Map();
  for (const ch of activeCharts) {
    let sn = vec3(0, 0, 0);
    for (const fi of ch.faces) {
      const f = mesh.faces[fi];
      sn = add3(sn, scale3(f.normal, f.area));
    }
    chartAvgNormals.set(ch.id, len3(sn) > 1e-5 ? norm3(sn) : mesh.faces[ch.faces[0]].normal);
  }

  const offsetMm = opts.easeMm + opts.thicknessMm;
  const sa = opts.seamAllowance;
  const pieces = [];
  const pieceStates = [];
  const edge3DToRefs = new Map();

  let packX = 40;
  let packY = 40;
  let rowMaxH = 0;

  // Helper: collapse ONLY strictly collinear consecutive edges sharing the exact same neighbor chart
  const simplifyPreservingSeamJunctions = (rawPts, rawKeys, keyToNb) => {
    const M = rawPts.length;
    if (!rawKeys || rawKeys.length !== M || M <= 3) {
      return {
        pts: rawPts,
        edgeGroups: rawPts.map((_, i) => [{ k3: rawKeys ? rawKeys[i] : null, t0: 0, t1: 1 }]),
      };
    }
    const items = rawPts.map((pt, i) => {
      const nxt = rawPts[(i + 1) % M];
      const len = Math.max(1e-6, dist2(pt, nxt));
      const dir = scale2(sub2(nxt, pt), 1 / len);
      const k3 = rawKeys[i];
      const info = keyToNb.get(k3);
      return {
        start: pt,
        end: nxt,
        dir,
        len,
        nbChart: info ? info.nbChart : -1,
        nbAvgN: info ? info.nbAvgN : null,
        k3,
      };
    });

    const canMerge = (a, b) => {
      if (a.nbChart === -1 || a.nbChart !== b.nbChart) return false;
      return Math.abs(cross2(a.dir, b.dir)) < 1e-3 && dot2(a.dir, b.dir) > 0.9999;
    };

    const runs = [];
    for (let i = 0; i < items.length; i++) {
      const cur = items[i];
      if (runs.length > 0 && canMerge(runs[runs.length - 1].last, cur)) {
        const r = runs[runs.length - 1];
        r.items.push(cur);
        r.last = cur;
      } else {
        runs.push({ items: [cur], last: cur });
      }
    }
    if (runs.length > 1 && canMerge(runs[runs.length - 1].last, runs[0].items[0])) {
      const lastRun = runs.pop();
      runs[0].items = [...lastRun.items, ...runs[0].items];
    }

    if (runs.length < 3) {
      return {
        pts: rawPts,
        edgeGroups: rawPts.map((_, i) => [{ k3: rawKeys[i], t0: 0, t1: 1, nbAvgN: items[i].nbAvgN }]),
      };
    }

    const pts = runs.map((r) => r.items[0].start);
    const edgeGroups = runs.map((r) => {
      const totalL = Math.max(1e-6, r.items.reduce((s, it) => s + it.len, 0));
      let acc = 0;
      return r.items.map((it) => {
        const t0 = clamp(acc / totalL, 0, 1);
        acc += it.len;
        const t1 = clamp(acc / totalL, 0, 1);
        return { k3: it.k3, t0, t1, nbAvgN: it.nbAvgN };
      });
    });
    return { pts, edgeGroups };
  };

  const applyPanelOffsetWithScale = (st, scaleFactor) => {
    const effOff = offsetMm * scaleFactor;
    const basePts = st.scaledBase;
    if (!Number.isFinite(effOff) || effOff <= 1e-5) {
      const b0 = polygonBounds(basePts);
      const pts0 = basePts.map((p) => vec2(p.x - b0.minX, p.y - b0.minY));
      return { finalPts: pts0, bounds: b0 };
    }
    const perEdge = st.edgeSignedWeights.map((w) => w * effOff);
    let cand = offsetPolygonOutward(basePts, 0, perEdge, 2.5);
    cand = ensureCCW(deduplicateConsecutivePoints(cand, 1e-3));
    const candArea = cand.length >= 3 ? polygonArea(cand) : NaN;
    if (
      cand.length !== basePts.length ||
      cand.length < 3 ||
      !Number.isFinite(candArea) ||
      cand.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)) ||
      polygonSelfIntersects(cand) ||
      candArea < st.baseArea * 0.35
    ) {
      return null;
    }
    // Reject if any edge shrank below 30% of original length (e.g. deepNarrowU slot collapse)
    for (let i = 0; i < cand.length; i++) {
      const origL = dist2(basePts[i], basePts[(i + 1) % basePts.length]);
      const newL = dist2(cand[i], cand[(i + 1) % cand.length]);
      if (origL > 1e-3 && newL < origL * 0.3) return null;
    }
    const bCov = polygonBounds(cand);
    const pts = cand.map((p) => vec2(p.x - bCov.minX, p.y - bCov.minY));
    return { finalPts: pts, bounds: bCov };
  };

  for (let idx = 0; idx < activeCharts.length; idx++) {
    const ch = activeCharts[idx];
    let sumN = vec3(0, 0, 0);
    let sumC = vec3(0, 0, 0);
    let sumA = 0;
    for (const fi of ch.faces) {
      const f = mesh.faces[fi];
      sumN = add3(sumN, scale3(f.normal, f.area));
      sumC = add3(sumC, scale3(f.centroid, f.area));
      sumA += f.area;
    }
    const avgN = len3(sumN) > 1e-5 ? norm3(sumN) : mesh.faces[ch.faces[0]].normal;
    const centroid3D = scale3(sumC, 1 / Math.max(1e-6, sumA));

    const unfolded = unfoldChartTo2D(mesh, ch.faces, avgN);
    if (!unfolded || unfolded.points.length < 3) continue;

    // Collect 3D boundary edge info for this chart
    const chBoundary3DEdges = [];
    const keyToNb = new Map();
    for (const fi of ch.faces) {
      for (const adj of mesh.adjacency[fi]) {
        const nbC = faceChart[adj.neighbor];
        if (nbC !== ch.id) {
          const [u, v] = adj.edgeVertices;
          const k3 = u < v ? `${u}_${v}` : `${v}_${u}`;
          const nbAvgN = chartAvgNormals.get(nbC) || mesh.faces[adj.neighbor].normal;
          chBoundary3DEdges.push({ k3, u, v, len: adj.edgeLength, nbChart: nbC, nbAvgN });
          keyToNb.set(k3, { nbChart: nbC, nbAvgN });
        }
      }
    }

    const simplified = simplifyPreservingSeamJunctions(
      unfolded.points,
      unfolded.edge3DKeysPerEdge,
      keyToNb
    );
    const scaledBase = ensureCCW(simplified.pts.map((p) => vec2(p.x * opts.scale, p.y * opts.scale)));
    const baseArea = Math.max(1e-3, polygonArea(scaledBase));

    const placement = makeSafePlacement3D(
      add3(centroid3D, scale3(avgN, offsetMm + 2.0)),
      avgN,
      unfolded.ex3D
    );
    const plN = norm3(placement.normal);
    const plUp = norm3(placement.up);
    const plU = norm3(cross3(plUp, plN));
    const plV = norm3(cross3(plN, plU));

    // Signed 3D dihedral miter factor per edge: +tan(theta/2) convex, -tan(theta/2) concave
    const nE = scaledBase.length;
    const edgeSignedWeights = new Array(nE).fill(1);
    for (let ei = 0; ei < nE; ei++) {
      const grp = simplified.edgeGroups[ei];
      const nbN = grp && grp[0] && grp[0].nbAvgN ? grp[0].nbAvgN : null;
      if (!nbN) {
        edgeSignedWeights[ei] = 1;
        continue;
      }
      const pA = scaledBase[ei];
      const pB = scaledBase[(ei + 1) % nE];
      const dx = pB.x - pA.x;
      const dy = pB.y - pA.y;
      const e3 = sub3(scale3(plU, dx), scale3(plV, dy));
      if (len3(e3) < 1e-6) {
        edgeSignedWeights[ei] = 0;
        continue;
      }
      const out3D = norm3(cross3(plN, norm3(e3)));
      const foldSign = dot3(out3D, nbN);
      const cosTheta = clamp(dot3(plN, nbN), -1, 1);
      const theta = Math.acos(cosTheta);
      const miterTan = clamp(Math.tan(theta * 0.5), 0, 1.2);
      if (Math.abs(foldSign) < 0.08) {
        edgeSignedWeights[ei] = 0;
      } else {
        edgeSignedWeights[ei] = (foldSign >= 0 ? 1 : -1) * miterTan;
      }
    }

    const st = {
      chartId: ch.id,
      scaledBase,
      baseArea,
      edgeSignedWeights,
      offsetScale: 1.0,
      avgN,
      sumA,
    };

    let applied = null;
    for (const sCand of [1.0, 0.5, 0.25, 0.0]) {
      st.offsetScale = sCand;
      applied = applyPanelOffsetWithScale(st, sCand);
      if (applied) break;
    }
    if (!applied) {
      st.offsetScale = 0.0;
      applied = applyPanelOffsetWithScale(st, 0.0);
    }
    if (!applied) {
      const b0 = polygonBounds(st.scaledBase);
      applied = {
        finalPts: st.scaledBase.map((p) => vec2(p.x - b0.minX, p.y - b0.minY)),
        bounds: b0,
      };
    }

    const pieceId = `stl_panel_${pieces.length + 1}`;
    const finalPts = applied.finalPts;
    const bCov = applied.bounds;
    const netArea2D = polygonArea(finalPts);
    const rawTargetArea3D = sumA * opts.scale * opts.scale;
    const targetArea3D = Number.isFinite(rawTargetArea3D) ? Math.max(1e-3, rawTargetArea3D) : Number.MAX_VALUE;
    const rawDistortion = (Math.abs(netArea2D - targetArea3D) / targetArea3D) * 100;
    const distortionPct = Number.isFinite(rawDistortion) ? Number(rawDistortion.toFixed(2)) : 0;

    if (packX > 1200) {
      packX = 40;
      packY += rowMaxH + 55;
      rowMaxH = 0;
    }

    const piece = {
      id: pieceId,
      name: `Surface Panel ${pieces.length + 1}`,
      role: 'stl_panel',
      chartId: ch.id,
      quantity: 1,
      onFold: false,
      position: { x: packX, y: packY },
      rotation: 0,
      seamAllowance: sa,
      distortionPct,
      points: finalPts,
      edges: finalPts.map((_, ei) => ({ name: `Panel Edge ${ei + 1}`, seamAllowance: sa })),
      notches: [{ id: `notch_${pieceId}`, edgeIndex: 0, t: 0.5, type: 'single' }],
      darts: [],
      internalLines: [],
      grainline: { angleDeg: 90 },
      placement3D: placement,
    };
    st.piece = piece;
    st.pieceIdx = pieces.length;
    pieces.push(piece);
    pieceStates.push(st);

    packX += bCov.width + 50;
    if (bCov.height > rowMaxH) rowMaxH = bCov.height;

    // Register 3D edge -> piece edge interval mappings
    const hasExactGroups = unfolded.edge3DKeysPerEdge && simplified.pts.length === finalPts.length;
    if (hasExactGroups) {
      for (let ei = 0; ei < finalPts.length; ei++) {
        const grp = simplified.edgeGroups[ei];
        for (const sub of grp) {
          if (!sub.k3) continue;
          if (!edge3DToRefs.has(sub.k3)) edge3DToRefs.set(sub.k3, []);
          edge3DToRefs.get(sub.k3).push({
            pieceIdx: st.pieceIdx,
            pieceId,
            edgeIndex: ei,
            t0: sub.t0,
            t1: sub.t1,
            len3D: dist2(scaledBase[ei], scaledBase[(ei + 1) % scaledBase.length]) * (sub.t1 - sub.t0),
          });
        }
      }
    } else {
      const finalCentroid = polygonCentroid(finalPts);
      for (const be of chBoundary3DEdges) {
        if (!edge3DToRefs.has(be.k3)) edge3DToRefs.set(be.k3, []);
        const mid3 = scale3(add3(mesh.vertices[be.u], mesh.vertices[be.v]), 0.5);
        const rel = sub3(mid3, placement.offset);
        const target2 = vec2(dot3(rel, plU) * opts.scale, -dot3(rel, plV) * opts.scale);
        let bestEdgeIdx = 0;
        let bestD = Infinity;
        for (let ei = 0; ei < finalPts.length; ei++) {
          const fMid = sub2(scale2(add2(finalPts[ei], finalPts[(ei + 1) % finalPts.length]), 0.5), finalCentroid);
          const d = dist2(target2, fMid);
          if (d < bestD) {
            bestD = d;
            bestEdgeIdx = ei;
          }
        }
        edge3DToRefs.get(be.k3).push({
          pieceIdx: st.pieceIdx,
          pieceId,
          edgeIndex: bestEdgeIdx,
          t0: 0,
          t1: 1,
          len3D: be.len * opts.scale,
        });
      }
    }
  }

  // Helper: check whether two sub-edges should be reversed by comparing 3D endpoints in placement3D
  const computeReversed3D = (pA, eA, t0A, t1A, pB, eB, t0B, t1B) => {
    const to3D = (piece, pt) => {
      const c2 = polygonCentroid(piece.points);
      const pl = piece.placement3D;
      const n = norm3(pl.normal);
      const up = norm3(pl.up);
      const u = norm3(cross3(up, n));
      const v = norm3(cross3(n, u));
      return add3(pl.offset, add3(scale3(u, pt.x - c2.x), scale3(v, -(pt.y - c2.y))));
    };
    const lerp2 = (a, b, t) => vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    const nA = pA.points.length;
    const nB = pB.points.length;
    const aStart = to3D(pA, lerp2(pA.points[eA], pA.points[(eA + 1) % nA], t0A));
    const aEnd = to3D(pA, lerp2(pA.points[eA], pA.points[(eA + 1) % nA], t1A));
    const bStart = to3D(pB, lerp2(pB.points[eB], pB.points[(eB + 1) % nB], t0B));
    const bEnd = to3D(pB, lerp2(pB.points[eB], pB.points[(eB + 1) % nB], t1B));
    const directGap = dist3(aStart, bStart) + dist3(aEnd, bEnd);
    const revGap = dist3(aStart, bEnd) + dist3(aEnd, bStart);
    return revGap <= directGap;
  };

  // Wire seams from shared 3D boundary edges (avoiding overlapping [t0, t1] intervals per piece edge)
  const rawPairs = [];
  for (const [, refs] of edge3DToRefs) {
    if (refs.length < 2) continue;
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        const a = refs[i];
        const b = refs[j];
        if (a.pieceId === b.pieceId) continue;
        rawPairs.push({ a, b, score: Math.min(a.len3D, b.len3D) });
      }
    }
  }
  rawPairs.sort((x, y) => y.score - x.score);

  const edgeIntervals = new Map();
  const overlapsUsed = (key, t0, t1) => {
    const list = edgeIntervals.get(key) || [];
    for (const iv of list) {
      if (Math.min(t1, iv.t1) - Math.max(t0, iv.t0) > 1e-3) return true;
    }
    return false;
  };
  const markInterval = (key, t0, t1) => {
    if (!edgeIntervals.has(key)) edgeIntervals.set(key, []);
    edgeIntervals.get(key).push({ t0, t1 });
  };

  // Deduplicate exact pair keys and merge contiguous sub-intervals if same two edges share multiple k3
  const selectedPairs = [];
  const pairSeen = new Set();
  for (const cand of rawPairs) {
    const a = cand.a;
    const b = cand.b;
    if (!(a.t1 - a.t0 > 1e-12) || !(b.t1 - b.t0 > 1e-12)) continue;
    const kA = `${a.pieceId}:${a.edgeIndex}`;
    const kB = `${b.pieceId}:${b.edgeIndex}`;
    const pairKey = kA < kB
      ? `${kA}|${a.t0.toFixed(12)}-${a.t1.toFixed(12)}|${kB}|${b.t0.toFixed(12)}-${b.t1.toFixed(12)}`
      : `${kB}|${b.t0.toFixed(12)}-${b.t1.toFixed(12)}|${kA}|${a.t0.toFixed(12)}-${a.t1.toFixed(12)}`;
    if (pairSeen.has(pairKey)) continue;
    if (overlapsUsed(kA, a.t0, a.t1) || overlapsUsed(kB, b.t0, b.t1)) continue;
    pairSeen.add(pairKey);
    markInterval(kA, a.t0, a.t1);
    markInterval(kB, b.t0, b.t1);
    selectedPairs.push({ a, b });
  }

  // Enforce zero invalid seam mismatches under easeMm + thicknessMm > 0 by clamping conflicting panels' offsetScale
  if (offsetMm > 1e-5) {
    const subEdgeLen = (piece, eIdx, t0, t1) => {
      const n = piece.points.length;
      return dist2(piece.points[eIdx], piece.points[(eIdx + 1) % n]) * (t1 - t0);
    };
    for (let pass = 0; pass < 4; pass++) {
      let anyMismatch = false;
      for (const { a, b } of selectedPairs) {
        const pA = pieces[a.pieceIdx];
        const pB = pieces[b.pieceIdx];
        const lenA = subEdgeLen(pA, a.edgeIndex, a.t0, a.t1);
        const lenB = subEdgeLen(pB, b.edgeIndex, b.t0, b.t1);
        const deltaMm = Math.abs(lenA - lenB);
        const deltaPct = (deltaMm / Math.max(1, (lenA + lenB) * 0.5)) * 100;
        if (deltaMm > 4.5 && deltaPct > 16.0) {
          anyMismatch = true;
          for (const st of [pieceStates[a.pieceIdx], pieceStates[b.pieceIdx]]) {
            if (st.offsetScale > 0) {
              const nextScale = st.offsetScale <= 0.26 ? 0.0 : st.offsetScale * 0.5;
              const nextApp = applyPanelOffsetWithScale(st, nextScale);
              if (nextApp) {
                st.offsetScale = nextScale;
                st.piece.points = nextApp.finalPts;
                const netA = polygonArea(nextApp.finalPts);
                const tgtA = Math.max(1e-3, st.sumA * opts.scale * opts.scale);
                st.piece.distortionPct = Number(((Math.abs(netA - tgtA) / tgtA) * 100).toFixed(2));
              }
            }
          }
        }
      }
      if (!anyMismatch) break;
    }
  }

  // If non-isometric fallback charts still have an edge length disparity, match sub-edge interval on the longer side
  for (const { a, b } of selectedPairs) {
    const pA = pieces[a.pieceIdx];
    const pB = pieces[b.pieceIdx];
    const nA = pA.points.length;
    const nB = pB.points.length;
    const lenA = dist2(pA.points[a.edgeIndex], pA.points[(a.edgeIndex + 1) % nA]) * (a.t1 - a.t0);
    const lenB = dist2(pB.points[b.edgeIndex], pB.points[(b.edgeIndex + 1) % nB]) * (b.t1 - b.t0);
    const deltaMm = Math.abs(lenA - lenB);
    const deltaPct = (deltaMm / Math.max(1, (lenA + lenB) * 0.5)) * 100;
    if (deltaMm > 4.5 && deltaPct > 16.0) {
      if (lenA > lenB && lenB > 1e-2) {
        a.t1 = a.t0 + (a.t1 - a.t0) * (lenB / lenA);
      } else if (lenB > lenA && lenA > 1e-2) {
        b.t1 = b.t0 + (b.t1 - b.t0) * (lenA / lenB);
      }
    }
  }

  const roundSeamT = (t) => clamp(Number(clamp(finiteOr(t, 0), 0, 1).toFixed(12)), 0, 1);
  const seams = [];
  for (const { a, b } of selectedPairs) {
    const tStartA = roundSeamT(a.t0);
    const tEndA = roundSeamT(a.t1);
    const tStartB = roundSeamT(b.t0);
    const tEndB = roundSeamT(b.t1);
    if (
      !(tEndA > tStartA) ||
      !(tEndB > tStartB) ||
      tEndA - tStartA <= 1e-12 ||
      tEndB - tStartB <= 1e-12
    ) {
      continue;
    }
    const pA = pieces[a.pieceIdx];
    const pB = pieces[b.pieceIdx];
    const rev = computeReversed3D(pA, a.edgeIndex, tStartA, tEndA, pB, b.edgeIndex, tStartB, tEndB);
    const sNum = seams.length + 1;
    seams.push({
      id: `seam_panel_${sNum}`,
      name: `Panel Seam ${sNum}`,
      pieceA: a.pieceId,
      edgeA: a.edgeIndex,
      pieceB: b.pieceId,
      edgeB: b.edgeIndex,
      reversed: rev,
      allowEase: true,
      tStartA,
      tEndA,
      tStartB,
      tEndB,
    });
  }

  return { pieces, seams };
}

export function unwrapSTLToPattern(meshInput, options = {}) {
  const optsObj = options && typeof options === 'object' ? options : {};
  let mesh;
  if (
    meshInput &&
    typeof meshInput === 'object' &&
    !Array.isArray(meshInput) &&
    Array.isArray(meshInput.triangles) &&
    Array.isArray(meshInput.faces)
  ) {
    validateMeshObjectForUnwrap(meshInput);
    mesh = meshInput;
  } else {
    mesh = parseSTL(meshInput, optsObj.name || optsObj.stlName || 'model.stl');
  }

  if (!mesh || !Array.isArray(mesh.faces) || mesh.faces.length === 0) {
    throw new ValidationError('STL mesh contains no valid non-degenerate faces to unwrap.', {
      code: 'EMPTY_STL',
      path: 'mesh',
    });
  }

  const mode =
    optsObj.mode === 'surface_panels' || optsObj.mode === 'chart_unfold'
      ? 'surface_panels'
      : 'form_shell_cover';
  const easeMm = clamp(finiteOr(optsObj.easeMm, 2.0), 0, 500);
  const thicknessMm = clamp(
    finiteOr(optsObj.thicknessMm ?? optsObj.materialThicknessMm ?? optsObj.material?.thicknessMm, 0),
    0,
    100
  );
  const seamAllowance = clamp(finiteOr(optsObj.seamAllowance, 10), 0, 200);
  const scale = clamp(finiteOr(optsObj.scale, 1.0), 0.01, 100);
  const materialId = typeof optsObj.materialId === 'string' && optsObj.materialId.length > 0 ? optsObj.materialId : 'veg_leather';

  const normalizedOpts = {
    ...optsObj,
    mode,
    easeMm,
    thicknessMm,
    seamAllowance,
    scale,
    materialId,
  };

  const result =
    mode === 'surface_panels'
      ? unwrapSurfacePanelsMode(mesh, normalizedOpts)
      : unwrapFormShellCoverMode(mesh, normalizedOpts);

  const safeMeshName = typeof mesh.name === 'string' && mesh.name.length > 0 ? mesh.name : 'model.stl';
  return {
    id: `stl_cover_${Date.now()}`,
    name: typeof optsObj.name === 'string' && optsObj.name.length > 0 ? optsObj.name : `${safeMeshName} Cover`,
    templateId: 'stl_cover',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId,
    material: null,
    avatar: null,
    isStub: false,
    stlMetadata: {
      name: safeMeshName,
      format: mesh.format,
      triangleCount: mesh.triangleCount,
      vertexCount: mesh.vertexCount,
      surfaceAreaMm2: mesh.surfaceAreaMm2,
      volumeMm3: mesh.volumeMm3,
      bounds: mesh.bounds,
      mode,
    },
    params: {
      mode,
      easeMm,
      thicknessMm,
      seamAllowance,
      scale,
    },
    parameters: {
      mode,
      easeMm,
      thicknessMm,
      seamAllowance,
      scale,
    },
    pieces: result.pieces,
    seams: result.seams,
  };
}
