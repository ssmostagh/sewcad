import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  V2_ROOT,
  WEDGE_ASSEMBLED_STL,
  WEDGE_PRINT_READY_STL,
  assert,
  assertNear,
  withTempDir,
  loadCore,
  startTestServer,
  runCli,
  dist2DIndependent,
  shoelaceSignedArea,
  shoelaceArea,
  calcBounds,
  polylinePerimeter,
  convexHull2DIndependent,
  countSelfIntersections,
  evalCubicBezierIndependent,
  sampleCubicArcLengthIndependent,
  samplePieceOutlineIndependent,
  buildSeamConnectivity,
  parseAsciiSTLIndependent,
  parseBinarySTLHeaderInfo,
  createSyntheticBinarySTLWithSolidHeader,
  pointToTriangleDist3D,
  verifyExportWithPython,
} from './helpers.mjs';

// ============================================================================
// Local Independent Test Helpers (Zero Static ../src/ Imports)
// ============================================================================

async function assertThrows(fn, checkErr, label = 'Expected function to throw') {
  assert(typeof checkErr === 'function', `${label}: checkErr predicate must be a function`);
  let threw = false;
  let caught = null;
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      await res;
    }
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert(threw, label);
  assert(
    !(caught instanceof ReferenceError) &&
      !(
        caught instanceof TypeError &&
        /is not a function|is not a constructor|cannot read properties of undefined/i.test(caught.message || '')
      ),
    `${label} (got unexpected JS runtime error ${caught?.name}: ${caught?.message})`
  );
  checkErr(caught);
  return caught;
}

function getPtXY(p) {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]) };
  return { x: Number(p?.x), y: Number(p?.y) };
}

function getPtXYZ(p) {
  if (!p) return { x: NaN, y: NaN, z: NaN };
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]) };
  if (p.pos) return getPtXYZ(p.pos);
  return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
}

function assertAllFinite2D(pts, label = 'points') {
  assert(Array.isArray(pts) && pts.length > 0, `${label}: expected non-empty point array`);
  for (let i = 0; i < pts.length; i++) {
    const p = getPtXY(pts[i]);
    assert(
      Number.isFinite(p.x) && Number.isFinite(p.y),
      `${label}[${i}] has non-finite coordinates (${p.x}, ${p.y})`
    );
  }
}

function assertValidClosedCCW(pts, label = 'polygon') {
  assertAllFinite2D(pts, label);
  assert(pts.length >= 3, `${label}: expected >= 3 vertices, got ${pts.length}`);
  const signed = shoelaceSignedArea(pts);
  assert(signed > 0, `${label}: expected CCW positive shoelace area, got ${signed}`);
  const si = countSelfIntersections(pts);
  assert(si === 0, `${label}: expected 0 self-intersections, got ${si}`);
  return signed;
}

function extractPointsResult(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.points)) return res.points;
  return [];
}

function getNetOutlinePoints(core, piece, segs = 24) {
  if (typeof core.samplePieceOutline === 'function') {
    const pts = extractPointsResult(core.samplePieceOutline(piece, segs));
    if (pts.length >= 3) return pts;
  }
  return samplePieceOutlineIndependent(piece, segs);
}

function getCutBoundaryPoints(core, piece, segs = 24) {
  const res = core.computePieceCutBoundary(piece, segs);
  return extractPointsResult(res);
}

function assertPatternPiecesValid(core, pattern, label = 'pattern') {
  assert(pattern && Array.isArray(pattern.pieces) && pattern.pieces.length > 0, `${label}: missing pieces`);
  for (const piece of pattern.pieces) {
    const netPts = getNetOutlinePoints(core, piece, 24);
    assertValidClosedCCW(netPts, `${label}.${piece.id}.net`);
    const cutPts = getCutBoundaryPoints(core, piece, 24);
    assertValidClosedCCW(cutPts, `${label}.${piece.id}.cut`);
  }
}

function assertEulerDiskMesh(mesh, label = 'mesh') {
  assert(mesh && Array.isArray(mesh.vertices) && Array.isArray(mesh.triangles), `${label}: invalid mesh object`);
  const V = mesh.vertices.length;
  const F = mesh.triangles.length;
  assert(V >= 3 && F >= 1, `${label}: expected V>=3, F>=1 (got V=${V}, F=${F})`);

  for (let i = 0; i < V; i++) {
    const p = getPtXY(mesh.vertices[i]);
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), `${label}.vertices[${i}] non-finite`);
  }

  const edges = new Set();
  let totalArea = 0;
  for (let f = 0; f < F; f++) {
    const tri = mesh.triangles[f];
    const i0 = Number(tri[0]);
    const i1 = Number(tri[1]);
    const i2 = Number(tri[2]);
    assert(i0 !== i1 && i1 !== i2 && i0 !== i2, `${label}.triangles[${f}] degenerate indices`);
    const a = getPtXY(mesh.vertices[i0]);
    const b = getPtXY(mesh.vertices[i1]);
    const c = getPtXY(mesh.vertices[i2]);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    assert(area2 > 1e-8, `${label}.triangles[${f}] has zero area`);
    totalArea += 0.5 * area2;

    for (const [u, v] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      edges.add(key);
    }
  }

  const E = edges.size;
  assert(V - E + F === 1, `${label}: Euler characteristic V-E+F=${V}-${E}+${F}=${V - E + F}, expected 1`);
  return { V, E, F, totalArea };
}

function countTJunctions(mesh, tol = 1e-4) {
  const verts = mesh.vertices.map(getPtXY);
  const tris = mesh.triangles;
  const edgeSet = new Set();
  for (const t of tris) {
    for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      edgeSet.add(`${a}:${b}`);
    }
  }
  let tjunc = 0;
  for (const key of edgeSet) {
    const [uStr, vStr] = key.split(':');
    const u = Number(uStr);
    const v = Number(vStr);
    const a = verts[u];
    const b = verts[v];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLen2 = abx * abx + aby * aby;
    if (abLen2 < 1e-12) continue;
    for (let k = 0; k < verts.length; k++) {
      if (k === u || k === v) continue;
      const p = verts[k];
      const apx = p.x - a.x;
      const apy = p.y - a.y;
      const t = (apx * abx + apy * aby) / abLen2;
      if (t <= tol || t >= 1 - tol) continue;
      const projX = a.x + t * abx;
      const projY = a.y + t * aby;
      if (Math.hypot(p.x - projX, p.y - projY) <= tol) {
        tjunc++;
      }
    }
  }
  return tjunc;
}

function makeSimpleRectPattern(core, width = 100, height = 80, sa = 10, extraOpts = {}) {
  const piece = core.createRectanglePiece('Rect', width, height, {
    seamAllowance: sa,
    ...extraOpts,
  });
  return {
    id: 'test_rect_proj',
    name: 'Test Rect Project',
    templateId: 'custom',
    version: '2.0.0',
    unit: 'mm',
    params: {},
    materialId: extraOpts.materialId || 'cotton_jersey',
    pieces: [piece],
    seams: [],
  };
}

function makeTwoPieceSeamPattern(core, wA = 100, hA = 80, wB = 100, hB = 80, seamOpts = {}) {
  const pA = core.createRectanglePiece('PieceA', wA, hA, { id: 'pA', seamAllowance: 10 });
  const pB = core.createRectanglePiece('PieceB', wB, hB, {
    id: 'pB',
    seamAllowance: 10,
    position: { x: 250, y: 40 },
  });
  const seam = {
    id: 'seam_1',
    name: 'Test Seam',
    pieceA: 'pA',
    edgeA: seamOpts.edgeA ?? 0,
    pieceB: 'pB',
    edgeB: seamOpts.edgeB ?? 0,
    reversed: seamOpts.reversed ?? false,
    allowEase: seamOpts.allowEase ?? false,
  };
  return {
    id: 'two_piece_proj',
    name: 'Two Piece Project',
    templateId: 'custom',
    version: '2.0.0',
    unit: 'mm',
    params: {},
    materialId: 'cotton_jersey',
    pieces: [pA, pB],
    seams: [seam],
  };
}

function extractParticlesXYZ(simResult) {
  const list = simResult?.particles || [];
  return list.map(getPtXYZ);
}

function rotateSTLTrianglesZ(triangles, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rotPt = (v) => ({
    x: v.x * c - v.y * s,
    y: v.x * s + v.y * c,
    z: v.z,
  });
  return triangles.map(([a, b, d]) => [rotPt(a), rotPt(b), rotPt(d)]);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function parseSvgCutPathsAndPolygons(svgText) {
  // Lightweight SVG path/polygon extractor to locate piece origin in SVG coordinates
  const results = [];
  const pathMatches = svgText.matchAll(/<path\b([^>]*)>/gi);
  for (const m of pathMatches) {
    const attrs = m[1];
    const dMatch = attrs.match(/\bd\s*=\s*"([^"]+)"/i) || attrs.match(/\bd\s*=\s*'([^']+)'/i);
    if (!dMatch) continue;
    const tokens = dMatch[1].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[a-zA-Z]/g) || [];
    const pts = [];
    let idx = 0;
    let cmd = '';
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    let hasCubic = false;
    while (idx < tokens.length) {
      if (/^[a-zA-Z]$/.test(tokens[idx])) {
        cmd = tokens[idx++];
        if (cmd === 'Z' || cmd === 'z') {
          cx = sx;
          cy = sy;
          continue;
        }
      }
      if (cmd === 'M' && idx + 1 < tokens.length) {
        cx = Number(tokens[idx++]);
        cy = Number(tokens[idx++]);
        sx = cx;
        sy = cy;
        pts.push({ x: cx, y: cy });
        cmd = 'L';
      } else if (cmd === 'm' && idx + 1 < tokens.length) {
        cx += Number(tokens[idx++]);
        cy += Number(tokens[idx++]);
        sx = cx;
        sy = cy;
        pts.push({ x: cx, y: cy });
        cmd = 'l';
      } else if (cmd === 'L' && idx + 1 < tokens.length) {
        cx = Number(tokens[idx++]);
        cy = Number(tokens[idx++]);
        pts.push({ x: cx, y: cy });
      } else if (cmd === 'l' && idx + 1 < tokens.length) {
        cx += Number(tokens[idx++]);
        cy += Number(tokens[idx++]);
        pts.push({ x: cx, y: cy });
      } else if (cmd === 'H' && idx < tokens.length) {
        cx = Number(tokens[idx++]);
        pts.push({ x: cx, y: cy });
      } else if (cmd === 'V' && idx < tokens.length) {
        cy = Number(tokens[idx++]);
        pts.push({ x: cx, y: cy });
      } else if (cmd === 'C' && idx + 5 < tokens.length) {
        hasCubic = true;
        const p0 = { x: cx, y: cy };
        const cp1 = { x: Number(tokens[idx++]), y: Number(tokens[idx++]) };
        const cp2 = { x: Number(tokens[idx++]), y: Number(tokens[idx++]) };
        const p1 = { x: Number(tokens[idx++]), y: Number(tokens[idx++]) };
        for (let k = 1; k <= 32; k++) {
          pts.push(evalCubicBezierIndependent(p0, cp1, cp2, p1, k / 32));
        }
        cx = p1.x;
        cy = p1.y;
      } else if (cmd === 'c' && idx + 5 < tokens.length) {
        hasCubic = true;
        const p0 = { x: cx, y: cy };
        const cp1 = { x: cx + Number(tokens[idx++]), y: cy + Number(tokens[idx++]) };
        const cp2 = { x: cx + Number(tokens[idx++]), y: cy + Number(tokens[idx++]) };
        const p1 = { x: cx + Number(tokens[idx++]), y: cy + Number(tokens[idx++]) };
        for (let k = 1; k <= 32; k++) {
          pts.push(evalCubicBezierIndependent(p0, cp1, cp2, p1, k / 32));
        }
        cx = p1.x;
        cy = p1.y;
      } else {
        idx++;
      }
    }
    if (pts.length >= 3) {
      results.push({ pts, bounds: calcBounds(pts), hasCubic });
    }
  }
  const polyMatches = svgText.matchAll(/<polygon\b([^>]*)>/gi);
  for (const m of polyMatches) {
    const attrs = m[1];
    const pMatch = attrs.match(/\bpoints\s*=\s*"([^"]+)"/i) || attrs.match(/\bpoints\s*=\s*'([^']+)'/i);
    if (!pMatch) continue;
    const nums = (pMatch[1].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      pts.push({ x: nums[i], y: nums[i + 1] });
    }
    if (pts.length >= 3) {
      results.push({ pts, bounds: calcBounds(pts), hasCubic: false });
    }
  }
  return results;
}

// ============================================================================
// Tier 2 Test Suite: 135 Boundary & Corner Cases (5 per F01..F27)
// ============================================================================

export function getTests() {
  return [
    // ========================================================================
    // F01: Canonical Pattern Project Schema
    // ========================================================================
    {
      id: 'T2-F01-1',
      tier: 2,
      feature: 'F01',
      name: 'Empty pieces:[] rejected by strict project validation & normalizer',
      fn: async () => {
        const core = await loadCore();
        const emptyProj = {
          id: 'empty_proj',
          name: 'Empty',
          templateId: 'custom',
          version: '2.0.0',
          unit: 'mm',
          pieces: [],
          seams: [],
        };
        assert(typeof core.validatePatternProject === 'function', 'validatePatternProject missing');
        await assertThrows(
          () => core.validatePatternProject(emptyProj, { throwOnError: true, requireNonEmpty: true }),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Expected validatePatternProject with requireNonEmpty:true to throw on empty pieces'
        );
        assert(typeof core.normalizePatternProject === 'function', 'normalizePatternProject missing');
        await assertThrows(
          () => core.normalizePatternProject({ unit: 'mm', pieces: [] }, { allowEmpty: false }),
          (err) =>
            assert(
              err?.name === 'ValidationError' || (core.ValidationError && err instanceof core.ValidationError),
              `Expected ValidationError, got ${err?.name}: ${err?.message}`
            ),
          'Expected normalizePatternProject with allowEmpty:false to throw on empty pieces'
        );
      },
    },
    {
      id: 'T2-F01-2',
      tier: 2,
      feature: 'F01',
      name: 'Piece with fewer than 3 vertices throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        const badProj = {
          id: 'bad_2pt',
          unit: 'mm',
          pieces: [
            {
              id: 'p1',
              name: 'TwoVerts',
              points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
              edges: [{ name: 'e0', seamAllowance: 10 }, { name: 'e1', seamAllowance: 10 }],
            },
          ],
          seams: [],
        };
        assert(typeof core.normalizePatternProject === 'function', 'normalizePatternProject missing');
        await assertThrows(
          () => core.normalizePatternProject(badProj),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Expected 2-vertex piece to throw ValidationError'
        );
      },
    },
    {
      id: 'T2-F01-3',
      tier: 2,
      feature: 'F01',
      name: 'Non-finite NaN or Infinity coordinate throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        const nanProj = {
          id: 'nan_proj',
          unit: 'mm',
          pieces: [
            {
              id: 'p1',
              name: 'NaNPiece',
              points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 50, y: 50 }],
            },
          ],
          seams: [],
        };
        assert(typeof core.normalizePatternProject === 'function', 'normalizePatternProject missing');
        await assertThrows(
          () => core.normalizePatternProject(nanProj),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Expected NaN coordinate to throw ValidationError'
        );
        const infProj = {
          id: 'inf_proj',
          unit: 'mm',
          pieces: [
            {
              id: 'p1',
              name: 'InfPiece',
              points: [{ x: 0, y: 0 }, { x: Infinity, y: 0 }, { x: 50, y: 50 }],
            },
          ],
          seams: [],
        };
        await assertThrows(
          () => core.normalizePatternProject(infProj),
          (err) =>
            assert(
              err?.name === 'ValidationError' || (core.ValidationError && err instanceof core.ValidationError),
              `Expected ValidationError, got ${err?.name}: ${err?.message}`
            ),
          'Expected Infinity coordinate to throw ValidationError'
        );
      },
    },
    {
      id: 'T2-F01-4',
      tier: 2,
      feature: 'F01',
      name: 'Inch unit input normalizes to canonical mm with exact 25.4x scaling',
      fn: async () => {
        const core = await loadCore();
        const inchProj = {
          id: 'inch_proj',
          name: 'Inch Box',
          unit: 'in',
          pieces: [
            {
              id: 'p1',
              name: 'Box10x5in',
              seamAllowance: 0.5,
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 5 },
                { x: 0, y: 5 },
              ],
            },
          ],
          seams: [],
        };
        const norm = core.normalizePatternProject(inchProj);
        assert(norm.unit === 'mm', `Expected unit 'mm', got ${norm.unit}`);
        const b = calcBounds(norm.pieces[0].points);
        assertNear(b.width, 254.0, 1e-4, '10 in normalized width');
        assertNear(b.height, 127.0, 1e-4, '5 in normalized height');
        assertNear(norm.pieces[0].seamAllowance, 12.7, 1e-4, '0.5 in normalized SA');
        assertNear(shoelaceArea(norm.pieces[0].points), 254.0 * 127.0, 1e-2, 'normalized area');
      },
    },
    {
      id: 'T2-F01-5',
      tier: 2,
      feature: 'F01',
      name: 'Seam referencing missing piece ID throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        const proj = makeSimpleRectPattern(core, 100, 100, 10);
        proj.seams = [
          {
            id: 'bad_seam',
            pieceA: proj.pieces[0].id,
            edgeA: 0,
            pieceB: 'does_not_exist',
            edgeB: 0,
          },
        ];
        assert(typeof core.validatePatternProject === 'function', 'validatePatternProject missing');
        await assertThrows(
          () => core.validatePatternProject(proj, { throwOnError: true }),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Expected seam referencing missing pieceB to throw ValidationError'
        );
      },
    },

    // ========================================================================
    // F02: Parametric T-Shirt (tshirt)
    // ========================================================================
    {
      id: 'T2-F02-1',
      tier: 2,
      feature: 'F02',
      name: 'Tiny toddler chestMm=400 generates 5 valid CCW non-self-intersecting pieces',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tshirt', { chestMm: 400, lengthMm: 360, sleeveLengthMm: 120 });
        assert(p.pieces.length === 5, `Expected 5 tshirt pieces, got ${p.pieces.length}`);
        assertPatternPiecesValid(core, p, 'tshirt_toddler');
        const report = core.validatePatternSeams(p);
        assert(report.every((r) => r.valid), `Invalid seams for toddler tshirt: ${JSON.stringify(report.filter((r) => !r.valid))}`);
      },
    },
    {
      id: 'T2-F02-2',
      tier: 2,
      feature: 'F02',
      name: 'XXL chestMm=1500 scales bodice wider than default 980mm cleanly',
      fn: async () => {
        const core = await loadCore();
        const defP = core.generateTemplatePattern('tshirt', { chestMm: 980 });
        const xxlP = core.generateTemplatePattern('tshirt', { chestMm: 1500, lengthMm: 820 });
        assertPatternPiecesValid(core, xxlP, 'tshirt_xxl');
        const defFront = defP.pieces.find((pc) => /front/i.test(pc.name) || pc.role === 'front');
        const xxlFront = xxlP.pieces.find((pc) => /front/i.test(pc.name) || pc.role === 'front');
        assert(
          calcBounds(xxlFront.points).width > calcBounds(defFront.points).width * 1.3,
          'XXL front bodice width should be substantially larger than default'
        );
        const report = core.validatePatternSeams(xxlP);
        assert(report.every((r) => r.valid), 'XXL tshirt seams should all be valid');
      },
    },
    {
      id: 'T2-F02-3',
      tier: 2,
      feature: 'F02',
      name: 'Zero easeMm=0 generates narrower bodice than easeMm=100 with valid seams',
      fn: async () => {
        const core = await loadCore();
        const zeroEase = core.generateTemplatePattern('tshirt', { chestMm: 960, easeMm: 0 });
        const highEase = core.generateTemplatePattern('tshirt', { chestMm: 960, easeMm: 100 });
        assertPatternPiecesValid(core, zeroEase, 'tshirt_ease0');
        const f0 = zeroEase.pieces.find((pc) => /front/i.test(pc.name) || /front/i.test(pc.role));
        const f1 = highEase.pieces.find((pc) => /front/i.test(pc.name) || /front/i.test(pc.role));
        assert(f0 && f1, 'Missing front bodice piece on tshirt');
        const w0 = calcBounds(f0.points).width;
        const w1 = calcBounds(f1.points).width;
        assert(w0 < w1, `easeMm=0 width (${w0}) should be strictly smaller than easeMm=100 (${w1})`);
        assert(core.validatePatternSeams(zeroEase).every((r) => r.valid), 'easeMm=0 seams must be valid');
      },
    },
    {
      id: 'T2-F02-4',
      tier: 2,
      feature: 'F02',
      name: 'Zero seamAllowance=0 yields cut boundaries matching net outline area',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tshirt', { seamAllowance: 0 });
        assertPatternPiecesValid(core, p, 'tshirt_sa0');
        for (const piece of p.pieces) {
          const netArea = shoelaceArea(getNetOutlinePoints(core, piece, 24));
          const cutArea = shoelaceArea(getCutBoundaryPoints(core, piece, 24));
          assertNear(cutArea, netArea, Math.max(2.0, netArea * 0.005), `SA=0 area match for ${piece.id}`);
        }
      },
    },
    {
      id: 'T2-F02-5',
      tier: 2,
      feature: 'F02',
      name: 'Extreme frontNeckDropMm=500 is clamped safely without inverting neckline below hem',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tshirt', { lengthMm: 650, frontNeckDropMm: 500 });
        assertPatternPiecesValid(core, p, 'tshirt_neckdrop');
        assert(buildSeamConnectivity(p).isFullyConnected, 'T-shirt seam graph must stay connected');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Extreme neck drop seams must stay valid');
      },
    },

    // ========================================================================
    // F03: Parametric Hoodie (hoodie)
    // ========================================================================
    {
      id: 'T2-F03-1',
      tier: 2,
      feature: 'F03',
      name: 'Small lengthMm=120 clamped safely above ribHeightMm=100 with valid CCW geometry',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('hoodie', { lengthMm: 120, ribHeightMm: 100 });
        assert(p.pieces.length >= 8, `Expected >=8 hoodie pieces, got ${p.pieces.length}`);
        assertPatternPiecesValid(core, p, 'hoodie_short');
        assert(buildSeamConnectivity(p).isFullyConnected, 'Hoodie seam graph must remain connected');
      },
    },
    {
      id: 'T2-F03-2',
      tier: 2,
      feature: 'F03',
      name: 'Zero easeMm=0 hoodie maintains connected seam graph and valid seams',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('hoodie', { easeMm: 0 });
        assertPatternPiecesValid(core, p, 'hoodie_ease0');
        assert(buildSeamConnectivity(p).isFullyConnected, 'Hoodie seam graph must be connected');
        const report = core.validatePatternSeams(p);
        assert(report.every((r) => r.valid), `Invalid seams on hoodie easeMm=0: ${JSON.stringify(report.filter((r) => !r.valid))}`);
      },
    },
    {
      id: 'T2-F03-3',
      tier: 2,
      feature: 'F03',
      name: 'Extreme hoodDepthMm=600 produces valid hood panels and valid hood-to-neck seams',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('hoodie', { hoodDepthMm: 600, hoodHeightMm: 450 });
        assertPatternPiecesValid(core, p, 'hoodie_deep_hood');
        const hoodPieces = p.pieces.filter((pc) => /hood/i.test(pc.name) || /hood/i.test(pc.role));
        assert(hoodPieces.length >= 2, 'Expected 2 hood panels');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Extreme hood depth seams must stay valid');
      },
    },
    {
      id: 'T2-F03-4',
      tier: 2,
      feature: 'F03',
      name: 'Oversized pocketWidthMm=800 clamps or produces valid pocket + placement lines',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('hoodie', { chestMm: 960, pocketWidthMm: 800 });
        assertPatternPiecesValid(core, p, 'hoodie_big_pocket');
        const front = p.pieces.find((pc) => /front/i.test(pc.name) || pc.role === 'front');
        assert(front && Array.isArray(front.internalLines) && front.internalLines.length > 0, 'Front bodice must include pocket placement internalLines');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Oversized pocket seams must stay valid');
      },
    },
    {
      id: 'T2-F03-5',
      tier: 2,
      feature: 'F03',
      name: 'Large seamAllowance=25 produces non-self-intersecting cut boundaries on all hoodie pieces',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('hoodie', { seamAllowance: 25 });
        assertPatternPiecesValid(core, p, 'hoodie_sa25');
        for (const piece of p.pieces) {
          const netA = shoelaceArea(getNetOutlinePoints(core, piece, 24));
          const cutA = shoelaceArea(getCutBoundaryPoints(core, piece, 24));
          assert(cutA > netA, `SA=25 cut area (${cutA}) must exceed net area (${netA}) for ${piece.id}`);
        }
      },
    },

    // ========================================================================
    // F04: Parametric Pants (pants)
    // ========================================================================
    {
      id: 'T2-F04-1',
      tier: 2,
      feature: 'F04',
      name: 'Extreme waistMm=1000, hipMm=600 (hip < waist*0.8) clamps without self-intersection',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('pants', { waistMm: 1000, hipMm: 600 });
        assert(p.pieces.length >= 5, `Expected >=5 pants pieces, got ${p.pieces.length}`);
        assertPatternPiecesValid(core, p, 'pants_hip_clamp');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Pants clamped hip seams must remain valid');
      },
    },
    {
      id: 'T2-F04-2',
      tier: 2,
      feature: 'F04',
      name: 'Very short inseamMm=150 produces valid shorts-length legs and connected seams',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('pants', { inseamMm: 150 });
        assertPatternPiecesValid(core, p, 'pants_short_inseam');
        assert(buildSeamConnectivity(p).isFullyConnected, 'Short-inseam pants seam graph must be connected');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Short-inseam seams must be valid');
      },
    },
    {
      id: 'T2-F04-3',
      tier: 2,
      feature: 'F04',
      name: 'Zero waistbandHeightMm=0 handled safely with 5 valid non-self-intersecting pieces',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('pants', { waistbandHeightMm: 0 });
        assertPatternPiecesValid(core, p, 'pants_wb0');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Zero waistband height seams must stay valid');
      },
    },
    {
      id: 'T2-F04-4',
      tier: 2,
      feature: 'F04',
      name: 'Large easeMm=150 widens legs vs default while preserving J-crotch curves and seams',
      fn: async () => {
        const core = await loadCore();
        const defP = core.generateTemplatePattern('pants', { hipMm: 1000 });
        const wideP = core.generateTemplatePattern('pants', { hipMm: 1000, easeMm: 150 });
        assertPatternPiecesValid(core, wideP, 'pants_ease150');
        const defLeg = defP.pieces.find((pc) => /front/i.test(pc.name) || /front_leg/i.test(pc.role));
        const wideLeg = wideP.pieces.find((pc) => /front/i.test(pc.name) || /front_leg/i.test(pc.role));
        assert(defLeg && wideLeg, 'Missing front leg piece on pants');
        assert(
          shoelaceArea(wideLeg.points) > shoelaceArea(defLeg.points),
          'High ease pants leg area must exceed default leg area'
        );
        assert(core.validatePatternSeams(wideP).every((r) => r.valid), 'Wide ease pants seams must be valid');
      },
    },
    {
      id: 'T2-F04-5',
      tier: 2,
      feature: 'F04',
      name: 'High hip-to-waist ratio (waistMm=600, hipMm=1200) keeps deep waist darts valid inside legs',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('pants', { waistMm: 600, hipMm: 1200 });
        assertPatternPiecesValid(core, p, 'pants_deep_darts');
        const hasDarts = p.pieces.some((pc) => Array.isArray(pc.darts) && pc.darts.length > 0);
        assert(hasDarts, 'Expected waist darts on high hip-to-waist pants');
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Deep dart pants seams must remain valid');
      },
    },

    // ========================================================================
    // F05: Parametric Tote Bag (tote_bag)
    // ========================================================================
    {
      id: 'T2-F05-1',
      tier: 2,
      feature: 'F05',
      name: 'Tiny pouch 80x80x20mm generates 7 valid CCW pieces with 0.0mm seam delta',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tote_bag', { widthMm: 80, heightMm: 80, gussetDepthMm: 20 });
        assert(p.pieces.length === 7, `Expected 7 tote_bag pieces, got ${p.pieces.length}`);
        assertPatternPiecesValid(core, p, 'tote_tiny');
        const report = core.validatePatternSeams(p);
        assert(report.every((r) => r.valid && r.deltaMm <= 0.1), `Tiny tote gusset seams must match within 0.1mm: ${JSON.stringify(report)}`);
      },
    },
    {
      id: 'T2-F05-2',
      tier: 2,
      feature: 'F05',
      name: 'Huge tote 800x700x250mm scales all panels cleanly with connected valid seams',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tote_bag', { widthMm: 800, heightMm: 700, gussetDepthMm: 250 });
        assertPatternPiecesValid(core, p, 'tote_huge');
        assert(buildSeamConnectivity(p).isFullyConnected, 'Huge tote seam graph must be connected');
        const front = p.pieces.find((pc) => /front/i.test(pc.name) || /front/i.test(pc.role));
        assert(front, 'Missing front panel on tote_bag');
        const b = calcBounds(front.points);
        assert(b.width >= 790 && b.height >= 690, `Expected >=790x690 front panel, got ${b.width}x${b.height}`);
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Huge tote seams must be valid');
      },
    },
    {
      id: 'T2-F05-3',
      tier: 2,
      feature: 'F05',
      name: 'Thin strapWidthMm=10 generates valid non-self-intersecting straps and seams',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tote_bag', { strapWidthMm: 10 });
        assertPatternPiecesValid(core, p, 'tote_thin_strap');
        const straps = p.pieces.filter((pc) => /strap/i.test(pc.name) || /strap/i.test(pc.role));
        assert(straps.length === 2, `Expected 2 straps, got ${straps.length}`);
        assert(core.validatePatternSeams(p).every((r) => r.valid), 'Thin strap tote seams must be valid');
      },
    },
    {
      id: 'T2-F05-4',
      tier: 2,
      feature: 'F05',
      name: 'Zero seamAllowance=0 tote yields exact net area on non-hemmed pieces and valid cut boundaries',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tote_bag', { seamAllowance: 0 });
        assertPatternPiecesValid(core, p, 'tote_sa0');
        let checked = 0;
        for (const pc of p.pieces) {
          const allEdgesZero = (pc.edges || []).every((e) => (e.seamAllowance ?? pc.seamAllowance) === 0);
          if (allEdgesZero) {
            checked++;
            assertNear(
              shoelaceArea(getCutBoundaryPoints(core, pc)),
              shoelaceArea(getNetOutlinePoints(core, pc)),
              0.5,
              `SA=0 cut/net mismatch on ${pc.id}`
            );
          }
        }
        assert(checked >= 1, 'Expected >=1 non-hemmed piece with SA=0');
      },
    },
    {
      id: 'T2-F05-5',
      tier: 2,
      feature: 'F05',
      name: 'Large seamAllowance=30 tote produces non-self-intersecting cut boundaries',
      fn: async () => {
        const core = await loadCore();
        const p = core.generateTemplatePattern('tote_bag', { seamAllowance: 30 });
        assertPatternPiecesValid(core, p, 'tote_sa30');
        for (const pc of p.pieces) {
          const netA = shoelaceArea(getNetOutlinePoints(core, pc));
          const cutA = shoelaceArea(getCutBoundaryPoints(core, pc));
          assert(cutA > netA, `Expected SA=30 cutArea > netArea on ${pc.id}`);
        }
      },
    },

    // ========================================================================
    // F06: Custom .STL Object Cover (stl_cover)
    // ========================================================================
    {
      id: 'T2-F06-1',
      tier: 2,
      feature: 'F06',
      name: 'stl_cover with easeMm=0 and thicknessMm=0 yields tight exact cover panels',
      fn: async () => {
        const core = await loadCore();
        const box = core.createBoxSTL(100, 80, 60, false);
        const mesh = core.parseSTL(box, 'box_100x80x60.stl');
        const p = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, seamAllowance: 10 });
        assertPatternPiecesValid(core, p, 'stl_cover_zero_ease');
        assert(p.stlMetadata && p.stlMetadata.triangleCount === mesh.triangleCount, 'stlMetadata must record triangleCount');
      },
    },
    {
      id: 'T2-F06-2',
      tier: 2,
      feature: 'F06',
      name: 'thicknessMm=6.0 expands stl_cover panel dimensions strictly larger than thicknessMm=0',
      fn: async () => {
        const core = await loadCore();
        const box = core.createBoxSTL(100, 80, 60, false);
        const mesh = core.parseSTL(box, 'box_thick.stl');
        const p0 = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, seamAllowance: 0 });
        const p6 = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 6.0, seamAllowance: 0 });
        const totalArea0 = p0.pieces.reduce((s, pc) => s + shoelaceArea(pc.points), 0);
        const totalArea6 = p6.pieces.reduce((s, pc) => s + shoelaceArea(pc.points), 0);
        assert(totalArea6 > totalArea0 * 1.05, `thicknessMm=6 area (${totalArea6}) should exceed thicknessMm=0 (${totalArea0})`);
      },
    },
    {
      id: 'T2-F06-3',
      tier: 2,
      feature: 'F06',
      name: 'scale=0.5 halves stl_cover panel dimensions vs scale=1.0',
      fn: async () => {
        const core = await loadCore();
        const box = core.createBoxSTL(120, 80, 60, false);
        const mesh = core.parseSTL(box, 'box_half.stl');
        const p1 = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 1.0 });
        const pHalf = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 0.5 });
        const area1 = p1.pieces.reduce((s, pc) => s + shoelaceArea(pc.points), 0);
        const areaHalf = pHalf.pieces.reduce((s, pc) => s + shoelaceArea(pc.points), 0);
        assertNear(areaHalf / area1, 0.25, 0.05, 'scale=0.5 should quarter total cover area');
      },
    },
    {
      id: 'T2-F06-4',
      tier: 2,
      feature: 'F06',
      name: 'scale=2.0 doubles stl_cover panel dimensions vs scale=1.0',
      fn: async () => {
        const core = await loadCore();
        const box = core.createBoxSTL(100, 60, 40, false);
        const mesh = core.parseSTL(box, 'box_2x.stl');
        const p1 = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 1.0 });
        const p2 = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 2.0 });
        const area1 = p1.pieces.reduce((s, pc) => s + shoelaceArea(pc.points), 0);
        const area2 = p2.pieces.reduce((s, pc) => s + shoelaceArea(pc.points), 0);
        assertNear(area2 / area1, 4.0, 0.15, 'scale=2.0 should quadruple total cover area');
      },
    },
    {
      id: 'T2-F06-5',
      tier: 2,
      feature: 'F06',
      name: 'Invalid or empty STL input passed to unwrapSTLToPattern throws',
      fn: async () => {
        const core = await loadCore();
        assert(typeof core.unwrapSTLToPattern === 'function', 'unwrapSTLToPattern missing');
        const checkInvalidStlErr = (err) =>
          assert(
            err instanceof Error &&
              err.name !== 'ReferenceError' &&
              !(err instanceof TypeError && /is not a function/i.test(err.message)),
            `Expected domain error from unwrapSTLToPattern, got ${err?.name}: ${err?.message}`
          );
        await assertThrows(
          () => core.unwrapSTLToPattern(''),
          checkInvalidStlErr,
          'Expected empty STL string to throw in unwrapSTLToPattern'
        );
        await assertThrows(
          () => core.unwrapSTLToPattern(null),
          checkInvalidStlErr,
          'Expected null STL input to throw in unwrapSTLToPattern'
        );
      },
    },

    // ========================================================================
    // F07: Freeform Polygon & Rect Drawing
    // ========================================================================
    {
      id: 'T2-F07-1',
      tier: 2,
      feature: 'F07',
      name: 'Minimum 3-vertex triangle created via createFreeformPiece has exact area and CCW winding',
      fn: async () => {
        const core = await loadCore();
        const tri = core.createFreeformPiece('MinTri', [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 50, y: 80 },
        ]);
        assert(tri.points.length === 3, `Expected 3 vertices, got ${tri.points.length}`);
        assertNear(shoelaceSignedArea(tri.points), 4000, 1e-3, 'Triangle signed CCW area');
        assert(countSelfIntersections(tri.points) === 0, 'Triangle must have 0 self-intersections');
      },
    },
    {
      id: 'T2-F07-2',
      tier: 2,
      feature: 'F07',
      name: '2-vertex input to createFreeformPiece throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        await assertThrows(
          () => core.createFreeformPiece('TwoPts', [{ x: 0, y: 0 }, { x: 50, y: 0 }]),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Expected <3 vertices to throw ValidationError'
        );
      },
    },
    {
      id: 'T2-F07-3',
      tier: 2,
      feature: 'F07',
      name: 'Collinear zero-area polygon rejected by createFreeformPiece',
      fn: async () => {
        const core = await loadCore();
        await assertThrows(
          () => core.createFreeformPiece('Collinear', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Expected collinear zero-area polygon to throw ValidationError'
        );
      },
    },
    {
      id: 'T2-F07-4',
      tier: 2,
      feature: 'F07',
      name: 'Duplicate consecutive points in freeform polygon handled safely with valid cut boundary',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createFreeformPiece('DupPts', [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ]);
        assertNear(shoelaceSignedArea(piece.points), 10000, 1e-2, 'Square area with duplicate vertex');
        assert(piece.edges.length === piece.points.length, 'edges.length must match points.length');
        const cut = getCutBoundaryPoints(core, piece);
        assertValidClosedCCW(cut, 'dup_pts_cut');
      },
    },
    {
      id: 'T2-F07-5',
      tier: 2,
      feature: 'F07',
      name: 'Concave L-shape polygon normalized to CCW with exact area and 0 self-intersections',
      fn: async () => {
        const core = await loadCore();
        // Given in CW order intentionally
        const cwL = [
          { x: 0, y: 0 },
          { x: 0, y: 120 },
          { x: 50, y: 120 },
          { x: 50, y: 50 },
          { x: 120, y: 50 },
          { x: 120, y: 0 },
        ];
        const piece = core.createFreeformPiece('ConcaveL', cwL);
        const signed = shoelaceSignedArea(piece.points);
        assertNear(signed, 120 * 50 + 70 * 50, 1e-2, 'L-shape CCW area = 9500');
        assert(countSelfIntersections(piece.points) === 0, 'L-shape must have 0 self-intersections');
      },
    },

    // ========================================================================
    // F08: Vertex, Edge & Bezier Editing
    // ========================================================================
    {
      id: 'T2-F08-1',
      tier: 2,
      feature: 'F08',
      name: 'splitPieceEdge with boundary t=0 clamps cleanly without zero-length edge',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('SplitT0', 100, 80);
        core.splitPieceEdge(piece, 0, 0);
        assert(piece.points.length === 5, `Expected 5 vertices after split, got ${piece.points.length}`);
        for (let i = 0; i < piece.points.length; i++) {
          const len = dist2DIndependent(piece.points[i], piece.points[(i + 1) % piece.points.length]);
          assert(len > 0.1, `Edge ${i} length (${len}) too small after t=0 split`);
        }
      },
    },
    {
      id: 'T2-F08-2',
      tier: 2,
      feature: 'F08',
      name: 'splitPieceEdge with boundary t=1 clamps cleanly without zero-length edge',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('SplitT1', 100, 80);
        core.splitPieceEdge(piece, 0, 1);
        assert(piece.points.length === 5, `Expected 5 vertices after split, got ${piece.points.length}`);
        for (let i = 0; i < piece.points.length; i++) {
          const len = dist2DIndependent(piece.points[i], piece.points[(i + 1) % piece.points.length]);
          assert(len > 0.1, `Edge ${i} length (${len}) too small after t=1 split`);
        }
      },
    },
    {
      id: 'T2-F08-3',
      tier: 2,
      feature: 'F08',
      name: 'deletePieceVertex on 3-vertex triangle throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        const tri = core.createFreeformPiece('Tri3', [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 50, y: 80 },
        ]);
        await assertThrows(
          () => core.deletePieceVertex(tri, 0),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Deleting vertex from 3-vertex triangle must throw ValidationError'
        );
        assert(tri.points.length === 3, 'Triangle must retain 3 vertices after rejected delete');
      },
    },
    {
      id: 'T2-F08-4',
      tier: 2,
      feature: 'F08',
      name: 'Zero-length Bezier handles (cp1=p0, cp2=p1) evaluate smoothly to chord length',
      fn: async () => {
        const core = await loadCore();
        const p0 = { x: 10, y: 20 };
        const p1 = { x: 130, y: 70 };
        const len = core.edgeArcLength(p0, p1, { cp1: p0, cp2: p1 });
        const straight = dist2DIndependent(p0, p1);
        assertNear(len, straight, 0.05, 'Degenerate handle Bezier length equals chord');
        const mid = core.evalCubicBezier(p0, p0, p1, p1, 0.5);
        assertNear(mid.x, 70, 0.05, 'Midpoint X');
        assertNear(mid.y, 45, 0.05, 'Midpoint Y');
      },
    },
    {
      id: 'T2-F08-5',
      tier: 2,
      feature: 'F08',
      name: 'Splitting a straight collinear edge preserves exact polygon area and perimeter',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('CollinearSplit', 140, 90);
        const areaBefore = shoelaceArea(piece.points);
        const perimBefore = polylinePerimeter(piece.points);
        core.splitPieceEdge(piece, 1, 0.35);
        assert(piece.points.length === 5, 'Expected 5 vertices');
        assertNear(shoelaceArea(piece.points), areaBefore, 1e-4, 'Area invariant after straight split');
        assertNear(polylinePerimeter(piece.points), perimBefore, 1e-4, 'Perimeter invariant after straight split');
      },
    },

    // ========================================================================
    // F09: Seam Allowance Offsetting
    // ========================================================================
    {
      id: 'T2-F09-1',
      tier: 2,
      feature: 'F09',
      name: '30mm narrow U-slot SA=20 clips inner self-intersecting loop (~57,600 mm², 0 intersections)',
      fn: async () => {
        const core = await loadCore();
        // 200x200 box with a 30mm wide x 100mm deep U-slot on top edge
        const piece = core.createFreeformPiece(
          'USlot',
          [
            { x: 0, y: 0 },
            { x: 200, y: 0 },
            { x: 200, y: 200 },
            { x: 115, y: 200 },
            { x: 115, y: 100 },
            { x: 85, y: 100 },
            { x: 85, y: 200 },
            { x: 0, y: 200 },
          ],
          { seamAllowance: 20 }
        );
        const cutPts = getCutBoundaryPoints(core, piece, 24);
        assertAllFinite2D(cutPts, 'uslot_cut');
        assert(countSelfIntersections(cutPts) === 0, 'U-slot SA=20 cut boundary must have 0 self-intersections');
        const cutArea = shoelaceArea(cutPts);
        // 200+40 x 200+40 = 240x240 = 57,600 mm² once narrow 30mm slot collapses under SA=20
        assertNear(cutArea, 57600, 1200, 'U-slot clipped cut area should match ~57,600 mm²');
      },
    },
    {
      id: 'T2-F09-2',
      tier: 2,
      feature: 'F09',
      name: 'Acute 200x10mm spike triangle SA=15 is miter-beveled without unbounded spike',
      fn: async () => {
        const core = await loadCore();
        const spike = core.createFreeformPiece(
          'AcuteSpike',
          [
            { x: 0, y: 0 },
            { x: 200, y: 0 },
            { x: 0, y: 10 },
          ],
          { seamAllowance: 15 }
        );
        const cutPts = getCutBoundaryPoints(core, spike, 16);
        assertValidClosedCCW(cutPts, 'acute_spike_cut');
        const b = calcBounds(cutPts);
        // Without miter beveling, 2.86-deg spike at SA=15 shoots > 600mm out!
        assert(b.width < 320, `Miter bevel failed: spike cut width=${b.width}mm exceeds bounded limit`);
        assert(b.height < 120, `Miter bevel failed: spike cut height=${b.height}mm exceeds bounded limit`);
      },
    },
    {
      id: 'T2-F09-3',
      tier: 2,
      feature: 'F09',
      name: 'Collinear split edge [0, 12] produces perpendicular stepped SA transition',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('SteppedSA', 200, 100, { seamAllowance: 10 });
        // Split bottom edge (edge 0: (0,0)->(200,0)) at t=0.5 -> (100,0)
        core.splitPieceEdge(piece, 0, 0.5);
        piece.edges[0].seamAllowance = 0;
        piece.edges[1].seamAllowance = 12;
        const cutPts = getCutBoundaryPoints(core, piece, 16);
        assertValidClosedCCW(cutPts, 'stepped_sa_cut');
        // computePieceCutBoundary returns local coords: step transition occurs near local x=100
        const pb = calcBounds(cutPts);
        const stepX = 100;
        const nearStep = cutPts.filter((pt) => Math.abs(getPtXY(pt).x - stepX) <= 1.0);
        assert(nearStep.length >= 2, `Expected >=2 step corner vertices near local x=${stepX}, got ${nearStep.length}`);
        const ys = nearStep.map((p) => getPtXY(p).y);
        const stepJump = Math.max(...ys) - Math.min(...ys);
        assertNear(stepJump, 12.0, 0.1, 'Perpendicular SA step height between [0, 12]');
        assertNear(pb.height, 122, 0.1, 'Total cut height (100+10+12)');
      },
    },
    {
      id: 'T2-F09-4',
      tier: 2,
      feature: 'F09',
      name: 'Duplicate consecutive vertices + 5-element per-edge seamAllowances lockstep cleanly',
      fn: async () => {
        const core = await loadCore();
        // Construct raw piece with duplicate vertex and 5 edges in lockstep
        const piece = {
          id: 'dup_lockstep',
          name: 'DupLockstep',
          role: 'custom',
          position: { x: 0, y: 0 },
          rotation: 0,
          seamAllowance: 10,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
          ],
          edges: [
            { name: 'Bottom', seamAllowance: 5 },
            { name: 'DupZero', seamAllowance: 25 },
            { name: 'Right', seamAllowance: 12 },
            { name: 'Top', seamAllowance: 8 },
            { name: 'Left', seamAllowance: 15 },
          ],
          notches: [],
          darts: [],
          internalLines: [],
          grainline: { angleDeg: 90 },
        };
        const cutPts = getCutBoundaryPoints(core, piece, 16);
        assertValidClosedCCW(cutPts, 'dup_lockstep_cut');
        const b = calcBounds(cutPts);
        // Expected width: 100 + Left(15) + Right(12) = 127; height: 80 + Bottom(5) + Top(8) = 93
        assertNear(b.width, 127, 0.1, 'Cut width preserves per-edge lockstep after duplicate vertex');
        assertNear(b.height, 93, 0.1, 'Cut height preserves per-edge lockstep after duplicate vertex');
      },
    },
    {
      id: 'T2-F09-5',
      tier: 2,
      feature: 'F09',
      name: 'piece.rotation=45 rotates both net outline and cut boundary accurately',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('Rot45', 100, 50, { seamAllowance: 10, rotation: 45 });
        const netWorld = core.transformPiecePoints(piece.points, piece);
        const cutWorld = core.transformPiecePoints(getCutBoundaryPoints(core, piece, 16), piece);
        assertValidClosedCCW(netWorld, 'rot45_net_world');
        assertValidClosedCCW(cutWorld, 'rot45_cut_world');
        const nb = calcBounds(netWorld);
        const cb = calcBounds(cutWorld);
        // Net rect 100x50 rotated 45° -> W = H = (100+50)/sqrt(2) ≈ 106.07
        assertNear(nb.width, (100 + 50) / Math.SQRT2, 0.1, '45° rotated net width');
        assertNear(nb.height, (100 + 50) / Math.SQRT2, 0.1, '45° rotated net height');
        // Cut rect 120x70 rotated 45° -> W = H = (120+70)/sqrt(2) ≈ 134.35
        const expectedSpan = (120 + 70) / Math.SQRT2;
        assertNear(cb.width, expectedSpan, 0.1, '45° rotated cut width');
        assertNear(cb.height, expectedSpan, 0.1, '45° rotated cut height');
      },
    },

    // ========================================================================
    // F10: V-Darts: Create, Fold & True
    // ========================================================================
    {
      id: 'T2-F10-1',
      tier: 2,
      feature: 'F10',
      name: 'addDartToPiece clamps oversized widthMm > edgeLen to <= 90% of edge length',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('WideDart', 100, 150, { seamAllowance: 10 });
        core.addDartToPiece(piece, { edgeIndex: 0, t: 0.5, widthMm: 500, depthMm: 60 });
        assert(piece.darts.length === 1, 'Expected 1 dart');
        assert(piece.darts[0].widthMm <= 90.0 + 1e-6, `Dart width (${piece.darts[0].widthMm}) must be clamped <= 90% of 100mm`);
        assertValidClosedCCW(getCutBoundaryPoints(core, piece), 'wide_dart_cut');
      },
    },
    {
      id: 'T2-F10-2',
      tier: 2,
      feature: 'F10',
      name: 'addDartToPiece clamps tiny depthMm < 5 to >= 5mm',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('TinyDepthDart', 120, 150, { seamAllowance: 10 });
        core.addDartToPiece(piece, { edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 1 });
        assert(piece.darts[0].depthMm >= 5, `Expected depthMm >= 5, got ${piece.darts[0].depthMm}`);
        assertValidClosedCCW(getCutBoundaryPoints(core, piece), 'tiny_depth_dart_cut');
      },
    },
    {
      id: 'T2-F10-3',
      tier: 2,
      feature: 'F10',
      name: 'addDartToPiece clamps t=0.0 and t=1.0 safely inside edge bounds',
      fn: async () => {
        const core = await loadCore();
        const p1 = core.createRectanglePiece('DartT0', 150, 150, { seamAllowance: 10 });
        core.addDartToPiece(p1, { edgeIndex: 0, t: 0.0, widthMm: 20, depthMm: 50 });
        assert(p1.darts[0].t > 0 && p1.darts[0].t < 1, `Expected clamped t in (0,1), got ${p1.darts[0].t}`);
        assertValidClosedCCW(getCutBoundaryPoints(core, p1), 'dart_t0_cut');

        const p2 = core.createRectanglePiece('DartT1', 150, 150, { seamAllowance: 10 });
        core.addDartToPiece(p2, { edgeIndex: 0, t: 1.0, widthMm: 20, depthMm: 50 });
        assert(p2.darts[0].t > 0 && p2.darts[0].t < 1, `Expected clamped t in (0,1), got ${p2.darts[0].t}`);
        assertValidClosedCCW(getCutBoundaryPoints(core, p2), 'dart_t1_cut');
      },
    },
    {
      id: 'T2-F10-4',
      tier: 2,
      feature: 'F10',
      name: 'Dart on curved Bezier edge produces valid cut boundary and net sewn length minus dart width',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('CurvedDartA', 140, 160, { id: 'pA', seamAllowance: 10 });
        pA.edges[0].curve = { cp1: { x: 40, y: -20 }, cp2: { x: 100, y: -20 } };
        const rawCurveLen = sampleCubicArcLengthIndependent(
          pA.points[0], pA.edges[0].curve.cp1, pA.edges[0].curve.cp2, pA.points[1], 64
        );
        core.addDartToPiece(pA, { edgeIndex: 0, t: 0.5, widthMm: 22, depthMm: 70 });
        const cutPts = getCutBoundaryPoints(core, pA, 24);
        assertValidClosedCCW(cutPts, 'curved_dart_cut');

        const pB = core.createRectanglePiece('MatchB', rawCurveLen - 22, 100, { id: 'pB', seamAllowance: 10 });
        const report = core.validatePatternSeams({
          id: 'cd_proj',
          unit: 'mm',
          pieces: [pA, pB],
          seams: [{ id: 's1', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 0 }],
        });
        assert(report[0].valid && report[0].deltaMm <= 0.1, `Expected net curved length minus 22mm dart to match, got ${JSON.stringify(report[0])}`);
      },
    },
    {
      id: 'T2-F10-5',
      tier: 2,
      feature: 'F10',
      name: 'Double-darted edge stays non-self-intersecting and subtracts both dart intakes',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('DoubleDart', 240, 180, { id: 'pA', seamAllowance: 10 });
        core.addDartToPiece(pA, { edgeIndex: 0, t: 0.3, widthMm: 20, depthMm: 70 });
        core.addDartToPiece(pA, { edgeIndex: 0, t: 0.7, widthMm: 20, depthMm: 70 });
        const cutPts = getCutBoundaryPoints(core, pA, 24);
        assertValidClosedCCW(cutPts, 'double_dart_cut');

        // Also test toggleDartFold on one dart
        core.toggleDartFold(pA, 0, true);
        assert(pA.darts[0].folded === true, 'Dart 0 should be marked folded');
        assertValidClosedCCW(getCutBoundaryPoints(core, pA, 24), 'double_dart_folded_cut');

        const pB = core.createRectanglePiece('Waistband', 200, 40, { id: 'pB', seamAllowance: 10 });
        const report = core.validatePatternSeams({
          id: 'dd_proj',
          unit: 'mm',
          pieces: [pA, pB],
          seams: [{ id: 's1', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 0 }],
        });
        assertNear(report[0].lengthAMm, 200, 0.1, '240mm minus two 20mm darts = 200mm');
        assert(report[0].valid, 'Double-darted edge should match 200mm waistband');
      },
    },

    // ========================================================================
    // F11: Alignment Notches
    // ========================================================================
    {
      id: 'T2-F11-1',
      tier: 2,
      feature: 'F11',
      name: 'addNotchToPiece clamps t=-0.5 into [0, 1] with finite notch lines',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('NotchNeg', 100, 100);
        core.addNotchToPiece(piece, { edgeIndex: 0, t: -0.5, type: 'single', depthMm: 5 });
        assert(piece.notches[0].t >= 0 && piece.notches[0].t <= 1, `Expected clamped t in [0,1], got ${piece.notches[0].t}`);
        const computed = core.computePieceNotches(piece);
        assert(computed.length === 1 && Array.isArray(computed[0].lines) && computed[0].lines.length >= 1, 'Expected valid notch line');
        assertAllFinite2D(computed[0].lines.flat(), 'notch_neg_lines');
      },
    },
    {
      id: 'T2-F11-2',
      tier: 2,
      feature: 'F11',
      name: 'addNotchToPiece clamps t=1.5 into [0, 1] with finite notch lines',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('NotchOver', 100, 100);
        core.addNotchToPiece(piece, { edgeIndex: 1, t: 1.5, type: 'double', depthMm: 5 });
        assert(piece.notches[0].t >= 0 && piece.notches[0].t <= 1, `Expected clamped t in [0,1], got ${piece.notches[0].t}`);
        const computed = core.computePieceNotches(piece);
        assert(computed.length === 1 && computed[0].lines.length >= 2, 'Expected double notch >=2 lines');
        assertAllFinite2D(computed[0].lines.flat(), 'notch_over_lines');
      },
    },
    {
      id: 'T2-F11-3',
      tier: 2,
      feature: 'F11',
      name: 'Unknown notch type falls back safely to valid notch geometry',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('NotchUnknown', 100, 100);
        core.addNotchToPiece(piece, { edgeIndex: 0, t: 0.5, type: 'zigzag_unknown', depthMm: 6 });
        assert(['single', 'double', 'v', 't'].includes(piece.notches[0].type), `Unexpected notch type ${piece.notches[0].type}`);
        const computed = core.computePieceNotches(piece);
        assert(computed.length === 1 && computed[0].lines.length >= 1, 'Fallback notch must render >=1 line');
        assertAllFinite2D(computed[0].lines.flat(), 'notch_unknown_lines');
      },
    },
    {
      id: 'T2-F11-4',
      tier: 2,
      feature: 'F11',
      name: 'Notch with depthMm=0 is handled safely with finite non-NaN coordinates',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('NotchZeroDepth', 100, 100);
        core.addNotchToPiece(piece, { edgeIndex: 2, t: 0.5, type: 'single', depthMm: 0 });
        const computed = core.computePieceNotches(piece);
        assert(computed.length === 1, 'Expected 1 computed notch');
        assert(Number.isFinite(computed[0].position.x) && Number.isFinite(computed[0].position.y), 'Notch position must be finite');
        if (computed[0].lines.length > 0) {
          assertAllFinite2D(computed[0].lines.flat(), 'notch_depth0_lines');
        }
      },
    },
    {
      id: 'T2-F11-5',
      tier: 2,
      feature: 'F11',
      name: 'Piece with seamAllowance=0 still computes valid finite notch geometry',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('NotchSA0', 100, 100, { seamAllowance: 0 });
        core.addNotchToPiece(piece, { edgeIndex: 0, t: 0.5, type: 'v', depthMm: 5 });
        const computed = core.computePieceNotches(piece);
        assert(computed.length === 1 && computed[0].lines.length >= 2, 'V-notch at SA=0 must still produce 2 angled lines');
        assertAllFinite2D(computed[0].lines.flat(), 'notch_sa0_lines');
      },
    },

    // ========================================================================
    // F12: Mirror / Unfold Across Edge
    // ========================================================================
    {
      id: 'T2-F12-1',
      tier: 2,
      feature: 'F12',
      name: 'Mirror across degenerate < 1e-3mm edge throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        const piece = {
          id: 'deg_mirror',
          name: 'DegMirror',
          position: { x: 0, y: 0 },
          rotation: 0,
          seamAllowance: 10,
          points: [
            { x: 0, y: 0 },
            { x: 0.0001, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
          ],
          edges: [
            { name: 'e0', seamAllowance: 10 },
            { name: 'e1', seamAllowance: 10 },
            { name: 'e2', seamAllowance: 10 },
            { name: 'e3', seamAllowance: 10 },
          ],
          notches: [],
          darts: [],
          internalLines: [],
        };
        await assertThrows(
          () => core.mirrorPieceAcrossEdge(piece, 0),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Mirror across degenerate edge must throw ValidationError'
        );
      },
    },
    {
      id: 'T2-F12-2',
      tier: 2,
      feature: 'F12',
      name: 'Mirroring piece with curved Bezier edge reflects CPs cleanly and preserves CCW',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('MirrorCurve', 80, 120);
        // Curve on top edge (edge 2: (80,120) -> (0,120))
        piece.edges[2].curve = { cp1: { x: 60, y: 150 }, cp2: { x: 20, y: 150 } };
        const areaBefore = shoelaceArea(getNetOutlinePoints(core, piece, 24));
        core.mirrorPieceAcrossEdge(piece, 3); // Left edge (0,120)->(0,0)
        const netAfter = getNetOutlinePoints(core, piece, 24);
        assertValidClosedCCW(netAfter, 'mirror_curve_net');
        assertNear(shoelaceArea(netAfter), areaBefore * 2, areaBefore * 0.02, 'Mirrored curved area should double');
        const curvedEdges = piece.edges.filter((e) => e.curve);
        assert(curvedEdges.length === 2, `Expected 2 mirrored curved edges, got ${curvedEdges.length}`);
      },
    },
    {
      id: 'T2-F12-3',
      tier: 2,
      feature: 'F12',
      name: 'Mirroring piece with darts and notches duplicates both symmetrically and preserves CCW',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('MirrorFeatures', 100, 140);
        core.addDartToPiece(piece, { edgeIndex: 0, t: 0.5, widthMm: 16, depthMm: 50 });
        core.addNotchToPiece(piece, { edgeIndex: 2, t: 0.4, type: 'single', depthMm: 5 });
        core.mirrorPieceAcrossEdge(piece, 3);
        assert(piece.darts.length === 2, `Expected 2 darts after mirror, got ${piece.darts.length}`);
        assert(piece.notches.length === 2, `Expected 2 notches after mirror, got ${piece.notches.length}`);
        assertValidClosedCCW(getNetOutlinePoints(core, piece), 'mirror_features_net');
        assertValidClosedCCW(getCutBoundaryPoints(core, piece), 'mirror_features_cut');
      },
    },
    {
      id: 'T2-F12-4',
      tier: 2,
      feature: 'F12',
      name: 'Double-mirroring produces closed valid CCW polygon with ~4x original area',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('DoubleMirror', 60, 50, { seamAllowance: 10 });
        const area0 = shoelaceArea(piece.points); // 3000
        core.mirrorPieceAcrossEdge(piece, 3); // mirror across left edge -> 120x50
        // Find an unsplit outer vertical edge (length 50mm) to mirror across cleanly
        const n = piece.points.length;
        let outerEdgeIdx = 0;
        for (let i = 0; i < n; i++) {
          const a = piece.points[i];
          const b = piece.points[(i + 1) % n];
          if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(Math.abs(b.y - a.y) - 50) < 1e-6) {
            outerEdgeIdx = i;
            break;
          }
        }
        core.mirrorPieceAcrossEdge(piece, outerEdgeIdx); // mirror across outer vertical edge -> 240x50
        assertValidClosedCCW(piece.points, 'double_mirror_net');
        assertNear(shoelaceArea(piece.points), area0 * 4, 5.0, 'Double-mirrored rect area = 4x');
        assertValidClosedCCW(getCutBoundaryPoints(core, piece), 'double_mirror_cut');
      },
    },
    {
      id: 'T2-F12-5',
      tier: 2,
      feature: 'F12',
      name: 'Mirroring rotated piece (rotation=30) preserves valid CCW geometry and fold internalLine',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('MirrorRot30', 80, 100, { rotation: 30 });
        core.mirrorPieceAcrossEdge(piece, 1);
        assertValidClosedCCW(piece.points, 'mirror_rot30_net');
        assertNear(shoelaceArea(piece.points), 16000, 5.0, 'Mirrored 80x100 area = 16000');
        const folds = (piece.internalLines || []).filter((il) => il.type === 'fold');
        assert(folds.length >= 1, 'Expected fold center line after mirror');
        assertAllFinite2D(folds[0].points, 'mirror_rot30_fold');
      },
    },

    // ========================================================================
    // F13: Seam-Length Matching & Walking
    // ========================================================================
    {
      id: 'T2-F13-1',
      tier: 2,
      feature: 'F13',
      name: 'Exact 0.0mm seam delta returns status=ok and valid=true',
      fn: async () => {
        const core = await loadCore();
        const proj = makeTwoPieceSeamPattern(core, 120, 80, 120, 80);
        const rep = core.validatePatternSeams(proj);
        assert(rep.length === 1 && rep[0].status === 'ok' && rep[0].valid === true, `Expected ok, got ${JSON.stringify(rep)}`);
        assertNear(rep[0].deltaMm, 0, 1e-6, 'Exact 0.0mm delta');
      },
    },
    {
      id: 'T2-F13-2',
      tier: 2,
      feature: 'F13',
      name: 'Boundary deltaMm == toleranceMm (5.0mm) is ok; 5.5mm without ease is mismatch',
      fn: async () => {
        const core = await loadCore();
        const projOk = makeTwoPieceSeamPattern(core, 100, 80, 105, 80);
        const repOk = core.validatePatternSeams(projOk, 5.0, 18.0);
        assert(repOk[0].status === 'ok' && repOk[0].valid === true, `Expected boundary 5.0==5.0 to be ok, got ${JSON.stringify(repOk[0])}`);

        const projBad = makeTwoPieceSeamPattern(core, 100, 80, 105.5, 80, { allowEase: false });
        const repBad = core.validatePatternSeams(projBad, 5.0, 18.0);
        assert(repBad[0].status === 'mismatch' && repBad[0].valid === false, `Expected 5.5>5.0 to be mismatch, got ${JSON.stringify(repBad[0])}`);
      },
    },
    {
      id: 'T2-F13-3',
      tier: 2,
      feature: 'F13',
      name: 'Boundary deltaPct > maxEasePct with allowEase=true returns mismatch',
      fn: async () => {
        const core = await loadCore();
        // 100 vs 125 -> avg 112.5 -> deltaPct ≈ 22.2% > 18%
        const proj = makeTwoPieceSeamPattern(core, 100, 80, 125, 80, { allowEase: true });
        const rep = core.validatePatternSeams(proj, 5.0, 18.0);
        assert(rep[0].status === 'mismatch' && rep[0].valid === false, `Expected ease>18% to be mismatch, got ${JSON.stringify(rep[0])}`);
      },
    },
    {
      id: 'T2-F13-4',
      tier: 2,
      feature: 'F13',
      name: 'validatePatternSeams flags missing_piece when referenced piece is absent',
      fn: async () => {
        const core = await loadCore();
        const proj = makeSimpleRectPattern(core, 100, 80);
        proj.seams = [{ id: 's_miss', pieceA: proj.pieces[0].id, edgeA: 0, pieceB: 'ghost_piece', edgeB: 0 }];
        const rep = core.validatePatternSeams(proj);
        assert(rep[0].status === 'missing_piece' && rep[0].valid === false, `Expected missing_piece, got ${JSON.stringify(rep[0])}`);
      },
    },
    {
      id: 'T2-F13-5',
      tier: 2,
      feature: 'F13',
      name: 'computeSeamWalkTransform aligns opposite endpoints for reversed=false vs reversed=true',
      fn: async () => {
        const core = await loadCore();
        const projFwd = makeTwoPieceSeamPattern(core, 100, 60, 100, 60, { reversed: false });
        const walkFwd = core.computeSeamWalkTransform(projFwd, 'seam_1', 0);
        assert(walkFwd && Array.isArray(walkFwd.transformedPointsB), 'Expected transformedPointsB');
        // At walkMm=0, reversed=false aligns pB[0] to pA_world[0]; reversed=true aligns pB[1] to pA_world[0]
        const pA0 = core.transformPiecePoints(projFwd.pieces[0].points, projFwd.pieces[0])[0];
        assertNear(dist2DIndependent(walkFwd.transformedPointsB[0], pA0), 0, 0.05, 'reversed=false aligns pB[0] to pA[0]');

        const projRev = makeTwoPieceSeamPattern(core, 100, 60, 100, 60, { reversed: true });
        const walkRev = core.computeSeamWalkTransform(projRev, 'seam_1', 0);
        const pA0Rev = core.transformPiecePoints(projRev.pieces[0].points, projRev.pieces[0])[0];
        assertNear(dist2DIndependent(walkRev.transformedPointsB[1], pA0Rev), 0, 0.05, 'reversed=true aligns pB[1] to pA[0]');
      },
    },

    // ========================================================================
    // F14: Live Millimeter Dimensions & Units
    // ========================================================================
    {
      id: 'T2-F14-1',
      tier: 2,
      feature: 'F14',
      name: '0.001mm micro-edge piece yields finite positive measurements without NaN',
      fn: async () => {
        const core = await loadCore();
        const micro = {
          id: 'micro_edge',
          name: 'Micro',
          position: { x: 0, y: 0 },
          rotation: 0,
          seamAllowance: 0,
          points: [
            { x: 0, y: 0 },
            { x: 0.001, y: 0 },
            { x: 0.001, y: 0.001 },
            { x: 0, y: 0.001 },
          ],
          edges: [{ seamAllowance: 0 }, { seamAllowance: 0 }, { seamAllowance: 0 }, { seamAllowance: 0 }],
        };
        const m = core.computePieceMeasurements(micro);
        const area = m.netAreaMm2 ?? m.areaMm2;
        const perim = m.netPerimeterMm ?? m.perimeterMm;
        assert(Number.isFinite(area) && Number.isFinite(perim), `Non-finite micro measurements: ${JSON.stringify(m)}`);
        assertNear(perim, 0.004, 1e-6, 'Micro perimeter');
      },
    },
    {
      id: 'T2-F14-2',
      tier: 2,
      feature: 'F14',
      name: '10000mm giant piece computes exact 1e8 mm² area and 40000mm perimeter',
      fn: async () => {
        const core = await loadCore();
        const giant = core.createRectanglePiece('Giant', 10000, 10000, { seamAllowance: 0 });
        const m = core.computePieceMeasurements(giant);
        const width = m.netWidthMm ?? m.netBoundsMm?.width ?? m.widthMm;
        const height = m.netHeightMm ?? m.netBoundsMm?.height ?? m.heightMm;
        const area = m.netAreaMm2 ?? m.areaMm2;
        const perim = m.netPerimeterMm ?? m.perimeterMm;
        assertNear(width, 10000, 1e-3, 'Giant width');
        assertNear(height, 10000, 1e-3, 'Giant height');
        assertNear(area, 1e8, 1.0, 'Giant area');
        assertNear(perim, 40000, 1e-2, 'Giant perimeter');
      },
    },
    {
      id: 'T2-F14-3',
      tier: 2,
      feature: 'F14',
      name: 'mm <-> in roundtrip conversion accurate within < 1e-6 mm across boundary values',
      fn: async () => {
        const core = await loadCore();
        for (const val of [0, 0.01, 25.4, 152.4, 1234.5678]) {
          const back = core.unitToMm(core.mmToUnit(val, 'in'), 'in');
          assertNear(back, val, 1e-6, `mm->in->mm roundtrip for ${val}`);
        }
      },
    },
    {
      id: 'T2-F14-4',
      tier: 2,
      feature: 'F14',
      name: 'mm <-> cm roundtrip accurate and unsupported unit throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        for (const val of [0, 0.5, 10, 987.654]) {
          const back = core.unitToMm(core.mmToUnit(val, 'cm'), 'cm');
          assertNear(back, val, 1e-6, `mm->cm->mm roundtrip for ${val}`);
        }
        await assertThrows(
          () => core.mmToUnit(100, 'furlongs'),
          (err) => assert(err?.name === 'ValidationError', `Expected ValidationError, got ${err?.name}: ${err?.message}`),
          'Unsupported unit must throw ValidationError'
        );
      },
    },
    {
      id: 'T2-F14-5',
      tier: 2,
      feature: 'F14',
      name: 'Degenerate zero-area collinear points in computePieceMeasurements return finite 0 area',
      fn: async () => {
        const core = await loadCore();
        const deg = {
          id: 'deg_meas',
          name: 'DegMeas',
          position: { x: 0, y: 0 },
          rotation: 0,
          seamAllowance: 0,
          points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }],
          edges: [{}, {}, {}],
        };
        const m = core.computePieceMeasurements(deg);
        const area = m.netAreaMm2 ?? m.areaMm2;
        const perim = m.netPerimeterMm ?? m.perimeterMm;
        assert(Number.isFinite(area) && area >= 0 && area < 1e-6, `Expected finite 0 area, got ${area}`);
        assertNear(perim, 200, 1e-3, 'Collinear back-and-forth perimeter = 200');
      },
    },

    // ========================================================================
    // F15: Binary & ASCII STL Parser
    // ========================================================================
    {
      id: 'T2-F15-1',
      tier: 2,
      feature: 'F15',
      name: 'Binary STL with "solid " 80-byte header disambiguates correctly as binary (E01)',
      fn: async () => {
        const core = await loadCore();
        const buf = createSyntheticBinarySTLWithSolidHeader(undefined, 'solid tricker header');
        const info = parseBinarySTLHeaderInfo(buf);
        assert(info.startsWithSolid && info.matchesLength && info.triangleCount === 12, 'Synthetic STL helper check');
        const mesh = core.parseSTL(buf, 'solid_header_binary.stl');
        assert(mesh.format === 'binary', `Expected format 'binary', got '${mesh.format}'`);
        assert(mesh.triangleCount === 12, `Expected 12 triangles, got ${mesh.triangleCount}`);
        assertNear(mesh.surfaceAreaMm2, 2400, 0.5, '20mm cube surface area = 2400 mm²');
      },
    },
    {
      id: 'T2-F15-2',
      tier: 2,
      feature: 'F15',
      name: 'Empty string passed to parseSTL throws an Error',
      fn: async () => {
        const core = await loadCore();
        assert(typeof core.parseSTL === 'function', 'parseSTL missing');
        const checkParseStlErr = (err) =>
          assert(
            err instanceof Error &&
              err.name !== 'ReferenceError' &&
              !(err instanceof TypeError && /is not a function/i.test(err.message)),
            `Expected domain error from parseSTL, got ${err?.name}: ${err?.message}`
          );
        await assertThrows(() => core.parseSTL('', 'empty.stl'), checkParseStlErr, 'parseSTL("") must throw');
        await assertThrows(() => core.parseSTL('   \n  ', 'ws.stl'), checkParseStlErr, 'parseSTL(whitespace) must throw');
      },
    },
    {
      id: 'T2-F15-3',
      tier: 2,
      feature: 'F15',
      name: 'Truncated <84-byte binary buffer throws an Error',
      fn: async () => {
        const core = await loadCore();
        assert(typeof core.parseSTL === 'function', 'parseSTL missing');
        const shortBuf = Buffer.alloc(50, 0);
        await assertThrows(
          () => core.parseSTL(shortBuf, 'truncated.stl'),
          (err) =>
            assert(
              err instanceof Error &&
                err.name !== 'ReferenceError' &&
                !(err instanceof TypeError && /is not a function/i.test(err.message)),
              `Expected domain error from parseSTL, got ${err?.name}: ${err?.message}`
            ),
          'parseSTL(<84 bytes) must throw'
        );
      },
    },
    {
      id: 'T2-F15-4',
      tier: 2,
      feature: 'F15',
      name: 'Zero-triangle ASCII STL ("solid x\\nendsolid x") throws an Error',
      fn: async () => {
        const core = await loadCore();
        assert(typeof core.parseSTL === 'function', 'parseSTL missing');
        await assertThrows(
          () => core.parseSTL('solid empty_mesh\nendsolid empty_mesh\n', 'zero_tris.stl'),
          (err) =>
            assert(
              err instanceof Error &&
                err.name !== 'ReferenceError' &&
                !(err instanceof TypeError && /is not a function/i.test(err.message)),
              `Expected domain error from parseSTL, got ${err?.name}: ${err?.message}`
            ),
          '0-triangle ASCII STL must throw'
        );
      },
    },
    {
      id: 'T2-F15-5',
      tier: 2,
      feature: 'F15',
      name: 'CRLF line endings and scientific notation ASCII STL parses matching independent oracle',
      fn: async () => {
        const core = await loadCore();
        const ascii = [
          'solid crlf_sci',
          '  facet normal 0 0 1',
          '    outer loop',
          '      vertex 0.0e0 0.0e0 0.0e0',
          '      vertex 1.5e+2 0.0E+0 0.0e0',
          '      vertex 0.0e0 2.0e+2 -2.5e-1',
          '    endloop',
          '  endfacet',
          '  facet normal 0 0 1',
          '    outer loop',
          '      vertex 1.5e+2 0.0e0 0.0e0',
          '      vertex 1.5e+2 2.0e+2 -2.5e-1',
          '      vertex 0.0e0 2.0e+2 -2.5e-1',
          '    endloop',
          '  endfacet',
          'endsolid crlf_sci',
        ].join('\r\n');
        const oracle = parseAsciiSTLIndependent(ascii);
        const mesh = core.parseSTL(ascii, 'crlf_sci.stl');
        assert(mesh.triangleCount === oracle.triangleCount, `Expected ${oracle.triangleCount} tris, got ${mesh.triangleCount}`);
        assertNear(mesh.bounds.size.x, oracle.bounds.size.x, 1e-3, 'CRLF scientific X span');
        assertNear(mesh.bounds.size.y, oracle.bounds.size.y, 1e-3, 'CRLF scientific Y span');
        assertNear(mesh.surfaceAreaMm2, oracle.surfaceAreaMm2, 0.5, 'CRLF scientific area');
      },
    },

    // ========================================================================
    // F16: Orientation-Invariant STL Unwrapping
    // ========================================================================
    {
      id: 'T2-F16-1',
      tier: 2,
      feature: 'F16',
      name: 'assembled_view vs print_ready span axis invariance (Y vs Z -> matching panel dims <= 1.0mm)',
      fn: async () => {
        const core = await loadCore();
        const assembledText = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const printReadyText = await fsp.readFile(WEDGE_PRINT_READY_STL, 'utf8');
        const meshA = core.parseSTL(assembledText, 'assembled.stl');
        const meshP = core.parseSTL(printReadyText, 'print_ready.stl');
        const patA = core.unwrapSTLToPattern(meshA, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, seamAllowance: 0 });
        const patP = core.unwrapSTLToPattern(meshP, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, seamAllowance: 0 });

        assertPatternPiecesValid(core, patA, 'wedge_assembled');
        assertPatternPiecesValid(core, patP, 'wedge_print_ready');

        const areasA = patA.pieces.map((pc) => shoelaceArea(pc.points)).sort((a, b) => b - a);
        const areasP = patP.pieces.map((pc) => shoelaceArea(pc.points)).sort((a, b) => b - a);
        assertNear(areasA[0], areasP[0], areasA[0] * 0.015, 'Largest panel area invariant across Y/Z orientation');

        // Compare largest panel sorted bounding dimensions [min(W,H), max(W,H)] within <= 1.0mm
        const largestA = patA.pieces.slice().sort((a, b) => shoelaceArea(b.points) - shoelaceArea(a.points))[0];
        const largestP = patP.pieces.slice().sort((a, b) => shoelaceArea(b.points) - shoelaceArea(a.points))[0];
        const bA = calcBounds(largestA.points);
        const bP = calcBounds(largestP.points);
        const dimsA = [Math.min(bA.width, bA.height), Math.max(bA.width, bA.height)];
        const dimsP = [Math.min(bP.width, bP.height), Math.max(bP.width, bP.height)];
        assertNear(dimsA[0], dimsP[0], 1.0, 'Oriented panel minor dim match <= 1.0mm');
        assertNear(dimsA[1], dimsP[1], 1.0, 'Oriented panel major dim match <= 1.0mm');
      },
    },
    {
      id: 'T2-F16-2',
      tier: 2,
      feature: 'F16',
      name: 'Thin flat 100x100x2mm plate unwraps into valid closed CCW panels',
      fn: async () => {
        const core = await loadCore();
        const plateStl = core.createBoxSTL(100, 100, 2, false);
        const mesh = core.parseSTL(plateStl, 'plate_100x100x2.stl');
        const pat = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 2, seamAllowance: 8 });
        assertPatternPiecesValid(core, pat, 'thin_plate');
        for (const pc of pat.pieces) {
          assert(pc.distortionPct === undefined || Number.isFinite(pc.distortionPct), 'distortionPct must be finite');
        }
      },
    },
    {
      id: 'T2-F16-3',
      tier: 2,
      feature: 'F16',
      name: '45°-rotated 120x80x60 box mesh unwraps cleanly with valid CCW panels',
      fn: async () => {
        const core = await loadCore();
        const boxStl = core.createBoxSTL(120, 80, 60, false);
        const oracle = parseAsciiSTLIndependent(boxStl);
        const rotTris = rotateSTLTrianglesZ(oracle.triangles, 45);
        const rotBuf = createSyntheticBinarySTLWithSolidHeader(rotTris, 'rotated 45 deg box');
        const mesh = core.parseSTL(rotBuf, 'rot45_box.stl');
        const pat = core.unwrapSTLToPattern(mesh, { mode: 'surface_panels', seamAllowance: 8 });
        assertPatternPiecesValid(core, pat, 'rot45_box');
        assert(pat.pieces.length >= 6, `Expected 6 box panels in surface_panels mode, got ${pat.pieces.length}`);
      },
    },
    {
      id: 'T2-F16-4',
      tier: 2,
      feature: 'F16',
      name: 'High dihedral threshold 89° in surface_panels emits valid merged charts',
      fn: async () => {
        const core = await loadCore();
        const wedgeStl = core.createWedgeSTL(150, 150, 50, 15, false);
        const mesh = core.parseSTL(wedgeStl, 'wedge_89.stl');
        const pat89 = core.unwrapSTLToPattern(mesh, {
          mode: 'surface_panels',
          dihedralThresholdDeg: 89,
          angleThresholdDeg: 89,
          angleThreshold: 89,
          seamAllowance: 6,
        });
        assertPatternPiecesValid(core, pat89, 'surface_panels_89deg');
        for (const pc of pat89.pieces) {
          assert(pc.distortionPct === undefined || Number.isFinite(pc.distortionPct), 'distortionPct must be finite');
        }
      },
    },
    {
      id: 'T2-F16-5',
      tier: 2,
      feature: 'F16',
      name: 'Low dihedral threshold 5° in surface_panels splits charts along creases cleanly',
      fn: async () => {
        const core = await loadCore();
        const wedgeText = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const mesh = core.parseSTL(wedgeText, 'wedge_5deg.stl');
        const pat5 = core.unwrapSTLToPattern(mesh, {
          mode: 'surface_panels',
          dihedralThresholdDeg: 5,
          angleThresholdDeg: 5,
          angleThreshold: 5,
          seamAllowance: 6,
        });
        assertPatternPiecesValid(core, pat5, 'surface_panels_5deg');
        assert(pat5.pieces.length >= 2, `Expected >=2 charts at 5° dihedral threshold, got ${pat5.pieces.length}`);
      },
    },

    // ========================================================================
    // F17: Conforming 2D->3D Cloth Triangulation
    // ========================================================================
    {
      id: 'T2-F17-1',
      tier: 2,
      feature: 'F17',
      name: 'Acute thin triangle (200x5mm) triangulates with exact area and Euler V-E+F=1',
      fn: async () => {
        const core = await loadCore();
        const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 5 }];
        const triMesh = core.triangulatePolygon(pts);
        const { totalArea } = assertEulerDiskMesh(triMesh, 'acute_tri');
        assertNear(totalArea, 500, 0.1, 'Acute triangle area = 500 mm²');
      },
    },
    {
      id: 'T2-F17-2',
      tier: 2,
      feature: 'F17',
      name: 'Concave C-shape polygon triangulates inside boundary with V-E+F=1 and 0 T-junctions',
      fn: async () => {
        const core = await loadCore();
        const cShape = [
          { x: 0, y: 0 },
          { x: 120, y: 0 },
          { x: 120, y: 30 },
          { x: 30, y: 30 },
          { x: 30, y: 90 },
          { x: 120, y: 90 },
          { x: 120, y: 120 },
          { x: 0, y: 120 },
        ];
        const expectedArea = shoelaceArea(cShape); // 120*120 - 90*60 = 14400 - 5400 = 9000
        const mesh = core.generateClothMesh2D(cShape, 35);
        const { totalArea } = assertEulerDiskMesh(mesh, 'concave_c_cloth');
        assertNear(totalArea, expectedArea, 1.0, 'C-shape cloth mesh area = 9000');
        assert(countTJunctions(mesh) === 0, 'C-shape cloth mesh must have 0 T-junctions');
      },
    },
    {
      id: 'T2-F17-3',
      tier: 2,
      feature: 'F17',
      name: 'Polygon with collinear boundary vertices triangulates with V-E+F=1 and no zero-area tris',
      fn: async () => {
        const core = await loadCore();
        const poly = [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 50 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ];
        const mesh = core.triangulatePolygon(poly);
        const { totalArea } = assertEulerDiskMesh(mesh, 'collinear_boundary_tri');
        assertNear(totalArea, 10000, 0.5, 'Collinear boundary square area = 10000');
      },
    },
    {
      id: 'T2-F17-4',
      tier: 2,
      feature: 'F17',
      name: 'Dense maxEdgeLengthMm=10 produces fine conforming mesh with V-E+F=1 and 0 T-junctions',
      fn: async () => {
        const core = await loadCore();
        const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
        const dense = core.generateClothMesh2D(sq, 10);
        const { F, totalArea } = assertEulerDiskMesh(dense, 'dense_10mm');
        assert(F >= 100, `Expected >=100 triangles for 100x100 at maxEdgeLengthMm=10, got ${F}`);
        assertNear(totalArea, 10000, 1.0, 'Dense mesh area = 10000');
        assert(countTJunctions(dense) === 0, 'Dense cloth mesh must have 0 T-junctions');
      },
    },
    {
      id: 'T2-F17-5',
      tier: 2,
      feature: 'F17',
      name: 'Coarse maxEdgeLengthMm=500 produces minimal conforming mesh with V-E+F=1',
      fn: async () => {
        const core = await loadCore();
        const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
        const coarse = core.generateClothMesh2D(sq, 500);
        const { F, totalArea } = assertEulerDiskMesh(coarse, 'coarse_500mm');
        assert(F >= 2 && F <= 16, `Expected minimal triangle count for coarse 500mm, got ${F}`);
        assertNear(totalArea, 10000, 0.5, 'Coarse mesh area = 10000');
      },
    },

    // ========================================================================
    // F18: XPBD / Verlet 3D Cloth & Sewing Solver
    // ========================================================================
    {
      id: 'T2-F18-1',
      tier: 2,
      feature: 'F18',
      name: '0 simulation steps returns initial finite state with stepCount=0',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt');
        const res = core.runSimulationSteps(pat, { steps: 0 });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0, 'Expected non-empty particles at step 0');
        for (let i = 0; i < pts.length; i++) {
          assert(Number.isFinite(pts[i].x) && Number.isFinite(pts[i].y) && Number.isFinite(pts[i].z), `Particle ${i} non-finite at step 0`);
        }
        const sc = res.stepCount ?? res.strainReport?.stepCount ?? 0;
        assert(sc === 0, `Expected stepCount=0, got ${sc}`);
      },
    },
    {
      id: 'T2-F18-2',
      tier: 2,
      feature: 'F18',
      name: '200-step eva_foam_4mm (bendStiffness=0.94) simulation remains finite and bounded',
      fn: async () => {
        const core = await loadCore();
        const pat = makeTwoPieceSeamPattern(core, 120, 100, 120, 100);
        pat.materialId = 'eva_foam_4mm';
        const res = core.runSimulationSteps(pat, {
          steps: 200,
          materialId: 'eva_foam_4mm',
          materialOverrides: { bendStiffness: 0.94 },
        });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0, 'Expected particles for eva_foam_4mm sim');
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          assert(
            Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
              Math.abs(p.x) < 1e5 && Math.abs(p.y) < 1e5 && Math.abs(p.z) < 1e5,
            `EVA foam particle ${i} diverged or non-finite: ${JSON.stringify(p)}`
          );
        }
      },
    },
    {
      id: 'T2-F18-3',
      tier: 2,
      feature: 'F18',
      name: '200-step ripstop_nylon (75 GSM) lightweight simulation remains finite and bounded',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tote_bag', { widthMm: 220, heightMm: 240, gussetDepthMm: 80 });
        pat.materialId = 'ripstop_nylon';
        const res = core.runSimulationSteps(pat, {
          steps: 200,
          materialId: 'ripstop_nylon',
          materialOverrides: { gsm: 75 },
        });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0, 'Expected particles for ripstop_nylon sim');
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          assert(
            Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
              Math.abs(p.x) < 1e5 && Math.abs(p.y) < 1e5 && Math.abs(p.z) < 1e5,
            `Ripstop nylon particle ${i} diverged or non-finite: ${JSON.stringify(p)}`
          );
        }
      },
    },
    {
      id: 'T2-F18-4',
      tier: 2,
      feature: 'F18',
      name: 'Extreme stiffness 1.0 (stretch/shear/bend=1.0) remains numerically stable over 100 steps',
      fn: async () => {
        const core = await loadCore();
        const pat = makeTwoPieceSeamPattern(core, 100, 100, 100, 100);
        const res = core.runSimulationSteps(pat, {
          steps: 100,
          materialOverrides: { stretchStiffness: 1.0, warpStiffness: 1.0, weftStiffness: 1.0, shearStiffness: 1.0, bendStiffness: 1.0 },
        });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0, 'Expected particles');
        assert(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Extreme stiffness produced non-finite particles');
        assert(Number.isFinite(res.strainReport.maxStrainPct), 'maxStrainPct must be finite');
      },
    },
    {
      id: 'T2-F18-5',
      tier: 2,
      feature: 'F18',
      name: 'Pattern with empty seams:[] runs 50 simulation steps cleanly',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 140, 140, 10);
        const res = core.runSimulationSteps(pat, { steps: 50 });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0, 'Expected particles for seamless pattern');
        assert(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Empty seams sim produced non-finite coords');
        const gap = res.avgSewGapMm ?? res.strainReport?.avgSewGapMm ?? 0;
        assert(Number.isFinite(gap) && gap >= 0, `Expected finite avgSewGapMm >= 0, got ${gap}`);
      },
    },

    // ========================================================================
    // F19: Triangle-Mesh STL & Avatar Collision
    // ========================================================================
    {
      id: 'T2-F19-1',
      tier: 2,
      feature: 'F19',
      name: 'Small avatar (heightMm=1200) generates valid colliders and finite draped cloth',
      fn: async () => {
        const core = await loadCore();
        const avatar = core.createParametricAvatar({ heightMm: 1200, chestMm: 650, waistMm: 550, hipMm: 680, shoulderWidthMm: 300 });
        assert(Array.isArray(avatar.colliders) && avatar.colliders.length > 0, 'Expected non-empty avatar colliders');
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 680, lengthMm: 450 });
        const res = core.runSimulationSteps(pat, { steps: 40, avatar });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Small avatar drape produced non-finite coords');
      },
    },
    {
      id: 'T2-F19-2',
      tier: 2,
      feature: 'F19',
      name: 'Large avatar (chestMm=1400) generates valid colliders and finite draped cloth',
      fn: async () => {
        const core = await loadCore();
        const avatar = core.createParametricAvatar({ chestMm: 1400, waistMm: 1250, hipMm: 1450, shoulderWidthMm: 540, heightMm: 1900 });
        assert(Array.isArray(avatar.colliders) && avatar.colliders.length > 0, 'Expected non-empty avatar colliders');
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 1400, lengthMm: 800 });
        const res = core.runSimulationSteps(pat, { steps: 40, avatar });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Large avatar drape produced non-finite coords');
      },
    },
    {
      id: 'T2-F19-3',
      tier: 2,
      feature: 'F19',
      name: 'Zero thicknessMm=0 STL collision runs cleanly with zero non-finite particles',
      fn: async () => {
        const core = await loadCore();
        const boxStl = core.createBoxSTL(100, 100, 40, false);
        const mesh = core.parseSTL(boxStl, 'box_t0.stl');
        const pat = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover', easeMm: 2 });
        const res = core.runSimulationSteps(pat, {
          steps: 40,
          stlMesh: mesh,
          materialOverrides: { thicknessMm: 0 },
        });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Zero thicknessMm STL collision produced non-finite particles');
      },
    },
    {
      id: 'T2-F19-4',
      tier: 2,
      feature: 'F19',
      name: 'Thick thicknessMm=10 foam enforces >= thickness clearance from STL triangles',
      fn: async () => {
        const core = await loadCore();
        const boxStl = core.createBoxSTL(100, 100, 40, false);
        const oracle = parseAsciiSTLIndependent(boxStl);
        const mesh = core.parseSTL(boxStl, 'box_t10.stl');
        // Place a flat cloth sheet above the box and let it settle under gravity
        const sheet = core.createRectanglePiece('DrapeSheet', 120, 120, { seamAllowance: 0 });
        sheet.placement3D = {
          offset: { x: 0, y: oracle.bounds.max.y + 20, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          up: { x: 0, y: 0, z: 1 },
        };
        const pat = {
          id: 'thick_stl_proj',
          unit: 'mm',
          materialId: 'eva_foam_4mm',
          pieces: [sheet],
          seams: [],
        };
        const res = core.runSimulationSteps(pat, {
          steps: 60,
          stlMesh: mesh,
          materialOverrides: { thicknessMm: 10 },
        });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0, 'Expected particles');
        for (const p of pts) {
          assert(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), 'Non-finite particle');
          let minD = Infinity;
          for (const tri of oracle.triangles) {
            const d = pointToTriangleDist3D(p, tri[0], tri[1], tri[2]);
            if (d < minD) minD = d;
          }
          // Particles resting above/near box must respect thicknessMm=10 clearance and not deeply penetrate
          assert(
            minD >= 10 - 0.5,
            `Particle penetrated thicknessMm=10 clearance from STL box: minD=${minD.toFixed(3)}mm < 9.5mm at ${JSON.stringify(p)}`
          );
          const insideBox =
            p.x > oracle.bounds.min.x + 10 && p.x < oracle.bounds.max.x - 10 &&
            p.y > oracle.bounds.min.y + 10 && p.y < oracle.bounds.max.y - 10 &&
            p.z > oracle.bounds.min.z + 5 && p.z < oracle.bounds.max.z - 5;
          assert(!insideBox, `Particle penetrated deep inside STL box at ${JSON.stringify(p)}`);
        }
      },
    },
    {
      id: 'T2-F19-5',
      tier: 2,
      feature: 'F19',
      name: 'Degenerate zero-area triangle in STL mesh is safely guarded during ClothSimulation',
      fn: async () => {
        const core = await loadCore();
        const boxStl = core.createBoxSTL(80, 80, 40, false);
        const oracle = parseAsciiSTLIndependent(boxStl);
        // Inject degenerate zero-area triangle
        const trisWithDeg = [
          ...oracle.triangles,
          [{ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 20 }, { x: 10, y: 0, z: 20 }],
        ];
        const buf = createSyntheticBinarySTLWithSolidHeader(trisWithDeg, 'deg_tri_stl');
        const mesh = core.parseSTL(buf, 'deg_tri.stl');
        const pat = core.unwrapSTLToPattern(mesh, { mode: 'form_shell_cover' });
        const res = core.runSimulationSteps(pat, { steps: 30, stlMesh: mesh });
        const pts = extractParticlesXYZ(res);
        assert(pts.length > 0 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Degenerate STL triangle caused NaN in physics');
      },
    },

    // ========================================================================
    // F20: Strain / Fit Tension Heatmap
    // ========================================================================
    {
      id: 'T2-F20-1',
      tier: 2,
      feature: 'F20',
      name: 'Degenerate zero rest-length edge is guarded so strainReport has no NaN',
      fn: async () => {
        const core = await loadCore();
        const deg = {
          id: 'deg_strain',
          name: 'DegStrain',
          role: 'custom',
          position: { x: 0, y: 0 },
          rotation: 0,
          seamAllowance: 0,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
          edges: [{}, {}, {}, {}, {}],
          notches: [],
          darts: [],
          internalLines: [],
          grainline: { angleDeg: 90 },
          placement3D: { offset: { x: 0, y: 120, z: 140 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
        };
        const res = core.runSimulationSteps({ id: 'p', unit: 'mm', pieces: [deg], seams: [] }, { steps: 20 });
        assert(Number.isFinite(res.strainReport.meanStrainPct), 'meanStrainPct must be finite');
        assert(Number.isFinite(res.strainReport.maxStrainPct), 'maxStrainPct must be finite');
      },
    },
    {
      id: 'T2-F20-2',
      tier: 2,
      feature: 'F20',
      name: 'Relaxed loose cloth with generous maxSafeStrainPct reports good_fit',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 1100, easeMm: 140 });
        const res = core.runSimulationSteps(pat, {
          steps: 25,
          materialOverrides: { maxSafeStrainPct: 50, gsm: 100 },
        });
        assert(res.strainReport.fitStatus === 'good_fit', `Expected good_fit on loose garment, got ${res.strainReport.fitStatus}`);
        assert(res.strainReport.meanStrainPct >= 0, 'meanStrainPct must be >= 0');
      },
    },
    {
      id: 'T2-F20-3',
      tier: 2,
      feature: 'F20',
      name: 'Lower maxSafeStrainPct shifts fitStatus toward tighter status monotonically',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 820, easeMm: 0 });
        const looseThreshold = core.runSimulationSteps(pat, {
          steps: 40,
          avatar: core.createParametricAvatar({ chestMm: 1150, waistMm: 1000, hipMm: 1180, shoulderWidthMm: 480, heightMm: 1750 }),
          materialOverrides: { maxSafeStrainPct: 200 },
        });
        const tightThreshold = core.runSimulationSteps(pat, {
          steps: 40,
          avatar: core.createParametricAvatar({ chestMm: 1150, waistMm: 1000, hipMm: 1180, shoulderWidthMm: 480, heightMm: 1750 }),
          materialOverrides: { maxSafeStrainPct: 0.5 },
        });
        const rank = { good_fit: 0, snug: 1, too_tight: 2 };
        assert(
          rank[tightThreshold.strainReport.fitStatus] >= rank[looseThreshold.strainReport.fitStatus],
          `Expected tighter status for lower maxSafeStrainPct (${tightThreshold.strainReport.fitStatus} vs ${looseThreshold.strainReport.fitStatus})`
        );
      },
    },
    {
      id: 'T2-F20-4',
      tier: 2,
      feature: 'F20',
      name: 'Heavily over-stretched garment on oversized avatar reports too_tight',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 600, easeMm: 0, lengthMm: 500 });
        const res = core.runSimulationSteps(pat, {
          steps: 80,
          avatar: core.createParametricAvatar({ chestMm: 1350, waistMm: 1200, hipMm: 1400, shoulderWidthMm: 520, heightMm: 1800 }),
          materialOverrides: { maxSafeStrainPct: 3 },
        });
        assert(res.strainReport.fitStatus === 'too_tight', `Expected too_tight on severely undersized shirt, got ${res.strainReport.fitStatus} (max=${res.strainReport.maxStrainPct}%)`);
        assert(res.strainReport.maxStrainPct > 3, `Expected maxStrainPct > 3%, got ${res.strainReport.maxStrainPct}`);
      },
    },
    {
      id: 'T2-F20-5',
      tier: 2,
      feature: 'F20',
      name: 'Compressed bunched cloth clamps engineering strain >= 0% across all particles',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 160, 160, 0);
        const sim = new core.ClothSimulation(pat);
        // Compress all particles toward centroid by 50%
        for (const p of sim.particles) {
          if (p.pos) {
            p.pos.x *= 0.5;
            p.pos.y *= 0.5;
            p.pos.z *= 0.5;
          }
        }
        const rep = sim.step(1);
        assert(rep.meanStrainPct >= 0 && rep.maxStrainPct >= 0, `Negative strain not clamped: ${JSON.stringify(rep)}`);
        for (const p of sim.particles) {
          if (p.strainPct !== undefined) {
            assert(p.strainPct >= 0 && Number.isFinite(p.strainPct), `Particle strainPct invalid: ${p.strainPct}`);
          }
        }
      },
    },

    // ========================================================================
    // F21: Substance 3D PBR Material Studio
    // ========================================================================
    {
      id: 'T2-F21-1',
      tier: 2,
      feature: 'F21',
      name: 'Unknown materialId falls back safely to a valid material config',
      fn: async () => {
        const core = await loadCore();
        const cfg = core.getMaterialConfig('nonexistent_material_999');
        assert(cfg && typeof cfg.id === 'string' && cfg.gsm > 0 && cfg.thicknessMm > 0, `Invalid fallback material config: ${JSON.stringify(cfg)}`);
        assert(Number.isFinite(cfg.roughness) && Number.isFinite(cfg.sheen), 'Fallback config roughness/sheen must be finite');
      },
    },
    {
      id: 'T2-F21-2',
      tier: 2,
      feature: 'F21',
      name: 'roughness overrides -1 and 2 clamp cleanly into [0, 1]',
      fn: async () => {
        const core = await loadCore();
        const low = core.getMaterialConfig('cotton_jersey', { roughness: -1 });
        const high = core.getMaterialConfig('cotton_jersey', { roughness: 2 });
        assert(low.roughness >= 0 && low.roughness <= 1, `Expected roughness clamped >= 0, got ${low.roughness}`);
        assert(high.roughness >= 0 && high.roughness <= 1, `Expected roughness clamped <= 1, got ${high.roughness}`);
      },
    },
    {
      id: 'T2-F21-3',
      tier: 2,
      feature: 'F21',
      name: 'sheen overrides -0.5 and 5.0 clamp cleanly into [0, 1]',
      fn: async () => {
        const core = await loadCore();
        const low = core.getMaterialConfig('heavy_fleece', { sheen: -0.5 });
        const high = core.getMaterialConfig('heavy_fleece', { sheen: 5.0 });
        assert(low.sheen >= 0 && low.sheen <= 1, `Expected sheen clamped >= 0, got ${low.sheen}`);
        assert(high.sheen >= 0 && high.sheen <= 1, `Expected sheen clamped <= 1, got ${high.sheen}`);
      },
    },
    {
      id: 'T2-F21-4',
      tier: 2,
      feature: 'F21',
      name: 'Tiny sizePx=16 generateProceduralPBRMaps returns 4 valid non-empty texture maps',
      fn: async () => {
        const core = await loadCore();
        const cfg = core.getMaterialConfig('heavy_denim');
        const maps = core.generateProceduralPBRMaps(cfg, 16);
        assert(maps && typeof maps === 'object', 'Expected PBR maps object');
        const albedo = maps.albedo || maps.albedoMap;
        const normal = maps.normal || maps.normalMap;
        const roughness = maps.roughness || maps.roughnessMap;
        const ao = maps.ao || maps.aoMap;
        for (const [name, buf] of [['albedo', albedo], ['normal', normal], ['roughness', roughness], ['ao', ao]]) {
          assert(buf && (buf.length === 16 * 16 * 4 || buf.length === 16 * 16 || buf.data?.length === 16 * 16 * 4), `Invalid ${name} buffer at sizePx=16`);
        }
      },
    },
    {
      id: 'T2-F21-5',
      tier: 2,
      feature: 'F21',
      name: 'Extreme thick material gsm=1200, thicknessMm=8 generates valid PBR maps and SVG swatch',
      fn: async () => {
        const core = await loadCore();
        const cfg = core.getMaterialConfig('veg_leather', { gsm: 1200, thicknessMm: 8 });
        assertNear(cfg.gsm, 1200, 1e-6, 'Overridden GSM');
        assertNear(cfg.thicknessMm, 8, 1e-6, 'Overridden thicknessMm');
        const maps = core.generateProceduralPBRMaps(cfg, 32);
        assert(maps && (maps.albedo || maps.albedoMap), 'Expected PBR maps for thick material');
        const svg = core.generateProceduralWeaveSVG(cfg, 120);
        assert(typeof svg === 'string' && svg.includes('<svg') && svg.includes('</svg>'), 'Expected valid SVG swatch');
      },
    },

    // ========================================================================
    // F22: True-Scale 1:1 SVG Exporter
    // ========================================================================
    {
      id: 'T2-F22-1',
      tier: 2,
      feature: 'F22',
      name: 'Empty pieces:[] exports valid 1:1 SVG with mm units and calibration square',
      fn: async () => {
        const core = await loadCore();
        const emptyPat = { id: 'empty_svg', name: 'Empty SVG', unit: 'mm', pieces: [], seams: [] };
        const svg = core.exportSVG(emptyPat);
        const rep = await verifyExportWithPython('svg', svg, { requireCalibrationSquare: true });
        assert(rep.ok, `Empty SVG failed verification: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F22-2',
      tier: 2,
      feature: 'F22',
      name: 'XML special characters (<>&"\') in piece/project names are properly XML-escaped in SVG',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 100, 80, 10);
        pat.name = 'Test <Proj> & "Quotes" \'Single\'';
        pat.pieces[0].name = 'Front <Panel> & "A&B"';
        const svg = core.exportSVG(pat);
        const rep = await verifyExportWithPython('svg', svg, {
          expectedPieces: [{ widthMm: 120, heightMm: 100, areaMm2: 12000, tolMm: 0.1 }],
        });
        assert(rep.ok, `XML special chars broke SVG parsing: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F22-3',
      tier: 2,
      feature: 'F22',
      name: 'High-curvature >250mm cubic Bezier SVG curve deviation <= 0.1mm (catches 16-seg bug)',
      fn: async () => {
        const core = await loadCore();
        // 300mm wide piece with deep inward cubic curve on bottom edge (cp1/cp2 y=160 inside 220mm height)
        const piece = core.createRectanglePiece('BigCurve', 300, 220, { seamAllowance: 0 });
        piece.edges[0].curve = { cp1: { x: 50, y: 160 }, cp2: { x: 250, y: 160 } };
        const pat = { id: 'big_curve', name: 'BigCurve', unit: 'mm', pieces: [piece], seams: [] };
        const svg = core.exportSVG(pat);

        // Locate the exported piece's bounding box in SVG coordinates so we align p0=(0,0) accurately
        const parsedShapes = parseSvgCutPathsAndPolygons(svg);
        const target = parsedShapes.find(
          (sh) => Math.abs(sh.bounds.width - 300) < 1.0 && Math.abs(sh.bounds.height - 220) < 1.0
        );
        assert(target, `Could not locate 300x220 curved shape in exported SVG (found ${parsedShapes.length} shapes)`);

        const ox = target.bounds.minX;
        const oy = target.bounds.minY;
        const rep = await verifyExportWithPython('svg', svg, {
          curveTolMm: 0.1,
          bezierSegments: [
            {
              p0: [ox, oy],
              cp1: [ox + 50, oy + 160],
              cp2: [ox + 250, oy + 160],
              p1: [ox + 300, oy],
            },
          ],
        });
        assert(rep.ok, `High-curvature >250mm Bezier SVG exceeded 0.1mm tolerance: ${JSON.stringify(rep)}`);
      },
    },
    {
      id: 'T2-F22-4',
      tier: 2,
      feature: 'F22',
      name: 'piece.rotation=37° exports SVG with exact rotated bounding box <= 0.1mm',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('Rot37', 120, 60, { seamAllowance: 0, rotation: 37 });
        const pat = { id: 'rot37', name: 'Rot37', unit: 'mm', pieces: [piece], seams: [] };
        const svg = core.exportSVG(pat);
        const rad = (37 * Math.PI) / 180;
        const expW = 120 * Math.abs(Math.cos(rad)) + 60 * Math.abs(Math.sin(rad));
        const expH = 120 * Math.abs(Math.sin(rad)) + 60 * Math.abs(Math.cos(rad));
        const rep = await verifyExportWithPython('svg', svg, {
          expectedPieces: [{ widthMm: expW, heightMm: expH, areaMm2: 7200, tolMm: 0.1 }],
        });
        assert(rep.ok, `Rotated 37° SVG bounds mismatch: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F22-5',
      tier: 2,
      feature: 'F22',
      name: 'Negative piece coordinates shift cleanly into positive SVG viewBox preserving 100x100mm',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('NegCoords', 100, 100, {
          seamAllowance: 0,
          position: { x: -180, y: -150 },
        });
        const pat = { id: 'neg_svg', name: 'NegSVG', unit: 'mm', pieces: [piece], seams: [] };
        const svg = core.exportSVG(pat);
        const rep = await verifyExportWithPython('svg', svg, {
          expectedPieces: [{ widthMm: 100, heightMm: 100, areaMm2: 10000, tolMm: 0.1 }],
        });
        assert(rep.ok, `Negative coordinate SVG failed: ${JSON.stringify(rep.errors)}`);
        assert(rep.metrics.viewBox[0] >= 0 && rep.metrics.viewBox[1] >= 0, 'SVG viewBox minX/minY should be non-negative');
      },
    },

    // ========================================================================
    // F23: Multi-Page Tiled PDF 1.4 Exporter
    // ========================================================================
    {
      id: 'T2-F23-1',
      tier: 2,
      feature: 'F23',
      name: 'Single-page tiny 60x40mm piece fits in 1x1 LETTER PDF with calibration square',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 60, 40, 5);
        const pdf = core.exportTiledPDF(pat, { pageFormat: 'LETTER' });
        assert(pdf.pageCount === 1, `Expected 1 page for tiny 70x50mm cut piece on LETTER, got ${pdf.pageCount}`);
        const rep = await verifyExportWithPython('pdf', pdf.pdfBytes || pdf.pdfString, {
          pageFormat: 'LETTER',
          exactPages: 1,
          requireCalibrationSquare: true,
          expectedPieces: [{ widthMm: 70, heightMm: 50, areaMm2: 3500, tolMm: 0.1 }],
        });
        assert(rep.ok, `Tiny single-page PDF failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F23-2',
      tier: 2,
      feature: 'F23',
      name: 'Oversized 900x900mm LETTER PDF tiles cleanly (overlap=15mm, registration marks & Page 1 calib)',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 900, 900, 0);
        const pdf = core.exportTiledPDF(pat, { pageFormat: 'LETTER', overlapMm: 15 });
        assert(pdf.rows >= 3 && pdf.cols >= 3, `Expected >=3x3 tiles for 900x900mm on LETTER, got ${pdf.cols}x${pdf.rows}`);
        assert(pdf.pageCount === pdf.rows * pdf.cols, `pageCount (${pdf.pageCount}) must equal rows*cols (${pdf.rows}*${pdf.cols})`);
        const rep = await verifyExportWithPython('pdf', pdf.pdfBytes || pdf.pdfString, {
          pageFormat: 'LETTER',
          overlapMm: 15,
          minPages: 9,
          requireCalibrationSquare: true,
          requireRegistrationMarks: true,
        });
        assert(rep.ok, `900x900mm tiled LETTER PDF failed: ${JSON.stringify(rep.errors)}`);
        assert(rep.metrics.regMarksFound >= 2, `Expected >=2 corner registration marks, got ${rep.metrics.regMarksFound}`);
      },
    },
    {
      id: 'T2-F23-3',
      tier: 2,
      feature: 'F23',
      name: 'Large 700x500mm piece fits on single-page A0 PDF',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 700, 500, 10);
        const pdf = core.exportTiledPDF(pat, { pageFormat: 'A0' });
        assert(pdf.pageCount === 1, `Expected 1 page on A0 (841x1189mm), got ${pdf.pageCount}`);
        const rep = await verifyExportWithPython('pdf', pdf.pdfBytes || pdf.pdfString, {
          pageFormat: 'A0',
          exactPages: 1,
          requireCalibrationSquare: true,
          expectedPieces: [{ widthMm: 720, heightMm: 520, tolMm: 0.1 }],
        });
        assert(rep.ok, `A0 single-sheet PDF failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F23-4',
      tier: 2,
      feature: 'F23',
      name: 'Zero seamAllowance=0 piece exports valid PDF matching net dimensions',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 100, 80, 0);
        const pdf = core.exportTiledPDF(pat, { pageFormat: 'A4' });
        const rep = await verifyExportWithPython('pdf', pdf.pdfBytes || pdf.pdfString, {
          pageFormat: 'A4',
          exactPages: 1,
          expectedPieces: [{ widthMm: 100, heightMm: 80, areaMm2: 8000, tolMm: 0.1 }],
        });
        assert(rep.ok, `SA=0 PDF failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F23-5',
      tier: 2,
      feature: 'F23',
      name: 'Empty pieces:[] exports valid %PDF-1.4 document with calibration square',
      fn: async () => {
        const core = await loadCore();
        const emptyPat = { id: 'empty_pdf', name: 'EmptyPDF', unit: 'mm', pieces: [], seams: [] };
        const pdf = core.exportTiledPDF(emptyPat, { pageFormat: 'LETTER' });
        assert(pdf.pageCount >= 1, 'Empty PDF should still produce at least 1 page');
        const rep = await verifyExportWithPython('pdf', pdf.pdfBytes || pdf.pdfString, {
          pageFormat: 'LETTER',
          requireCalibrationSquare: true,
        });
        assert(rep.ok, `Empty pieces PDF failed: ${JSON.stringify(rep.errors)}`);
      },
    },

    // ========================================================================
    // F24: True-Scale 1:1 CAD DXF Exporter
    // ========================================================================
    {
      id: 'T2-F24-1',
      tier: 2,
      feature: 'F24',
      name: 'Empty pieces:[] exports valid DXF with $INSUNITS=4, TABLES/LAYER, and EOF',
      fn: async () => {
        const core = await loadCore();
        const emptyPat = { id: 'empty_dxf', name: 'EmptyDXF', unit: 'mm', pieces: [], seams: [] };
        const dxf = core.exportDXF(emptyPat);
        const rep = await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireTablesLayer: true,
          requireCalibrationSquare: true,
        });
        assert(rep.ok, `Empty DXF failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F24-2',
      tier: 2,
      feature: 'F24',
      name: 'Special characters and newlines in piece name do not corrupt DXF group pairs',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 110, 70, 0);
        pat.pieces[0].name = 'Back\nPanel & "Layer/1" <Test>';
        const dxf = core.exportDXF(pat);
        const rep = await verifyExportWithPython('dxf', dxf, {
          expectedPieces: [{ widthMm: 110, heightMm: 70, areaMm2: 7700, tolMm: 0.1 }],
        });
        assert(rep.ok, `DXF with special chars/newline failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F24-3',
      tier: 2,
      feature: 'F24',
      name: 'piece.rotation=90 swaps DXF LWPOLYLINE W/H within <= 0.1mm',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 160, 70, 0, { rotation: 90 });
        const dxf = core.exportDXF(pat);
        // allowRotate90 is false so width MUST be 70 and height MUST be 160
        const rep = await verifyExportWithPython('dxf', dxf, {
          expectedPieces: [{ widthMm: 70, heightMm: 160, areaMm2: 11200, tolMm: 0.1 }],
        });
        assert(rep.ok, `DXF rotation=90 W/H swap failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F24-4',
      tier: 2,
      feature: 'F24',
      name: 'Curved cubic Bezier contour exports closed LWPOLYLINE in DXF within <= 0.1mm',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('DxfCurve', 260, 180, { seamAllowance: 0, position: { x: 0, y: 0 } });
        piece.edges[0].curve = { cp1: { x: 60, y: 120 }, cp2: { x: 200, y: 120 } };
        const pat = { id: 'dxf_curve', name: 'DXFCurve', unit: 'mm', pieces: [piece], seams: [] };
        const dxf = core.exportDXF(pat);
        const rep = await verifyExportWithPython('dxf', dxf, {
          requireClosedLwpolyline: true,
          expectedPieces: [{ widthMm: 260, heightMm: 180, tolMm: 0.1 }],
        });
        assert(rep.ok, `Curved DXF LWPOLYLINE failed: ${JSON.stringify(rep.errors)}`);
      },
    },
    {
      id: 'T2-F24-5',
      tier: 2,
      feature: 'F24',
      name: 'Negative piece coordinates export valid DXF preserving exact dimensions <= 0.1mm',
      fn: async () => {
        const core = await loadCore();
        const pat = makeSimpleRectPattern(core, 95, 65, 0, { position: { x: -200, y: -150 } });
        const dxf = core.exportDXF(pat);
        const rep = await verifyExportWithPython('dxf', dxf, {
          expectedPieces: [{ widthMm: 95, heightMm: 65, areaMm2: 95 * 65, tolMm: 0.1 }],
        });
        assert(rep.ok, `Negative coordinates DXF failed: ${JSON.stringify(rep.errors)}`);
      },
    },

    // ========================================================================
    // F25: Fabric Roll Nesting & Yield BOM
    // ========================================================================
    {
      id: 'T2-F25-1',
      tier: 2,
      feature: 'F25',
      name: 'Piece wider than roll fits via allowRotate90:true inside roll width',
      fn: async () => {
        const core = await loadCore();
        // 1050 x 200mm piece on 914mm mat: cannot fit unrotated (1050 > 914), fits rotated 90° (200 <= 914)
        const pat = makeSimpleRectPattern(core, 1050, 200, 0);
        const res = core.nestPatternPieces(pat, { fabricWidthMm: 914, marginMm: 10, spacingMm: 10, allowRotate90: true });
        assert(res.placements.length === 1, 'Expected 1 placement');
        const pl = res.placements[0];
        const px = Number(pl.x ?? pl.minX ?? 0);
        const pw = Number(pl.width ?? pl.widthMm ?? pl.w ?? (pl.maxX !== undefined ? pl.maxX - px : NaN));
        assert(Number.isFinite(px) && Number.isFinite(pw) && pw > 0, `Invalid placement bbox: ${JSON.stringify(pl)}`);
        assert(pw <= 914 + 1e-3 && px >= -0.1 && px + pw <= 914 + 1e-3, `Rotated placement should fit inside 914mm width: ${JSON.stringify(pl)}`);
      },
    },
    {
      id: 'T2-F25-2',
      tier: 2,
      feature: 'F25',
      name: 'allowRotate90:true achieves tighter or equal linear yield than allowRotate90:false',
      fn: async () => {
        const core = await loadCore();
        // Two 600x300 pieces on a 1000mm roll:
        // Without rotate90: 600+600=1200 > 1000 -> stacked in 2 rows -> requiredLength >= 600mm
        // With rotate90: rotated to 300x600 -> 300+300=600 <= 1000 -> side-by-side or rotated cleanly
        const p1 = core.createRectanglePiece('R1', 600, 250, { id: 'r1', seamAllowance: 0 });
        const p2 = core.createRectanglePiece('R2', 600, 250, { id: 'r2', seamAllowance: 0 });
        const p3 = core.createRectanglePiece('R3', 600, 250, { id: 'r3', seamAllowance: 0 });
        const pat = { id: 'rot_yield', unit: 'mm', pieces: [p1, p2, p3], seams: [] };
        const noRot = core.nestPatternPieces(pat, { fabricWidthMm: 1000, marginMm: 0, spacingMm: 0, allowRotate90: false });
        const withRot = core.nestPatternPieces(pat, { fabricWidthMm: 1000, marginMm: 0, spacingMm: 0, allowRotate90: true });
        // noRot requires 3 rows * 250 = 750mm; withRot can put 3 rotated 250x600 side-by-side = 600mm!
        assert(
          withRot.requiredLengthMm <= noRot.requiredLengthMm,
          `allowRotate90=true (${withRot.requiredLengthMm}mm) must be <= allowRotate90=false (${noRot.requiredLengthMm}mm)`
        );
        assert(withRot.requiredLengthMm <= 600.1, `Expected rotated 3x(250x600) to pack into <=600mm length, got ${withRot.requiredLengthMm}`);
      },
    },
    {
      id: 'T2-F25-3',
      tier: 2,
      feature: 'F25',
      name: 'onFold:true piece nests cleanly with valid positive yield and utilization',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('FoldFront', 200, 400, { seamAllowance: 10, onFold: true });
        const pat = { id: 'fold_nest', unit: 'mm', pieces: [piece], seams: [] };
        const res = core.nestPatternPieces(pat, { fabricWidthMm: 1143, marginMm: 10, spacingMm: 10 });
        assert(res.placements.length >= 1, 'Expected >=1 placement for onFold piece');
        assert(res.requiredLengthMm > 0 && res.utilizationPct > 0 && res.utilizationPct <= 100, `Invalid utilization: ${JSON.stringify(res)}`);
      },
    },
    {
      id: 'T2-F25-4',
      tier: 2,
      feature: 'F25',
      name: 'Zero marginMm=0 and spacingMm=0 packs flush rectangles with exact requiredLengthMm',
      fn: async () => {
        const core = await loadCore();
        const p1 = core.createRectanglePiece('F1', 400, 300, { id: 'f1', seamAllowance: 0 });
        const p2 = core.createRectanglePiece('F2', 400, 300, { id: 'f2', seamAllowance: 0 });
        const pat = { id: 'flush_nest', unit: 'mm', pieces: [p1, p2], seams: [] };
        const res = core.nestPatternPieces(pat, { fabricWidthMm: 800, marginMm: 0, spacingMm: 0, allowRotate90: false });
        assertNear(res.requiredLengthMm, 300, 0.1, 'Two 400x300 pieces on 800mm flush = 300mm');
        assertNear(res.utilizationPct, 100, 0.5, 'Flush 100% utilization');
      },
    },
    {
      id: 'T2-F25-5',
      tier: 2,
      feature: 'F25',
      name: 'Empty pieces:[] returns requiredLengthMm=0, utilizationPct=0, placements=[]',
      fn: async () => {
        const core = await loadCore();
        const res = core.nestPatternPieces({ id: 'empty_nest', unit: 'mm', pieces: [], seams: [] }, { fabricWidthMm: 1143 });
        assert(res.requiredLengthMm === 0, `Expected requiredLengthMm=0, got ${res.requiredLengthMm}`);
        assert(res.utilizationPct === 0, `Expected utilizationPct=0, got ${res.utilizationPct}`);
        assert(Array.isArray(res.placements) && res.placements.length === 0, 'Expected empty placements[]');
      },
    },

    // ========================================================================
    // F26: Responsive Web Studio & WebGL2 3D (HTTP / API Error Boundaries)
    // ========================================================================
    {
      id: 'T2-F26-1',
      tier: 2,
      feature: 'F26',
      name: 'HTTP path traversal (/../etc/passwd & encoded) blocked with 403 or 404',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const r1 = await srv.fetchText('/../etc/passwd');
          assert(r1.status === 403 || r1.status === 404, `Expected 403/404 for /../etc/passwd, got ${r1.status}`);
          assert(!r1.text.includes('root:'), 'Path traversal leaked /etc/passwd!');

          const r2 = await srv.fetchText('/..%2F..%2Fetc%2Fpasswd');
          assert(r2.status === 403 || r2.status === 404, `Expected 403/404 for encoded traversal, got ${r2.status}`);
          assert(!r2.text.includes('root:'), 'Encoded path traversal leaked /etc/passwd!');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T2-F26-2',
      tier: 2,
      feature: 'F26',
      name: 'Unknown API route GET /api/nonexistent returns 404 JSON error',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const r = await srv.fetchJson('/api/nonexistent_route_xyz');
          assert(r.status === 404, `Expected 404 for unknown API route, got ${r.status}`);
          assert(r.data && typeof r.data.error === 'string', `Expected JSON {error}, got ${r.text}`);
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T2-F26-3',
      tier: 2,
      feature: 'F26',
      name: 'Malformed JSON body to POST /api/generate-template returns 400 JSON error',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const r = await srv.fetchJson('/api/generate-template', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{bad json:::',
          });
          assert(r.status === 400, `Expected 400 for malformed JSON, got ${r.status}`);
          assert(r.data && typeof r.data.error === 'string', `Expected JSON {error}, got ${r.text}`);
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T2-F26-4',
      tier: 2,
      feature: 'F26',
      name: 'POST /api/export with invalid format returns 400 JSON error',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tote_bag');
        const srv = await startTestServer({ port: 0 });
        try {
          const r = await srv.fetchJson('/api/export', {
            method: 'POST',
            body: { pattern: pat, format: 'bmp' },
          });
          assert(r.status === 400, `Expected 400 for unsupported export format 'bmp', got ${r.status}`);
          assert(r.data && typeof r.data.error === 'string', `Expected JSON {error}, got ${r.text}`);
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T2-F26-5',
      tier: 2,
      feature: 'F26',
      name: 'POST /api/unwrap-stl with empty STL payload returns 400 JSON error',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const r = await srv.fetchJson('/api/unwrap-stl', {
            method: 'POST',
            body: { stlText: '', name: 'empty.stl' },
          });
          assert(r.status === 400, `Expected 400 for empty STL upload, got ${r.status}`);
          assert(r.data && typeof r.data.error === 'string', `Expected JSON {error}, got ${r.text}`);
        } finally {
          await srv.stop();
        }
      },
    },

    // ========================================================================
    // F27: Server, CLI & Isolation
    // ========================================================================
    {
      id: 'T2-F27-1',
      tier: 2,
      feature: 'F27',
      name: '--port=0 ephemeral port binds cleanly and prints Remote & SSH tunnel banner',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          assert(Number.isInteger(srv.port) && srv.port > 0, `Expected ephemeral port > 0, got ${srv.port}`);
          const out = srv.getStdout();
          const expectedHost = os.hostname() || 'localhost';
          const escHost = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          assert(out.includes(`127.0.0.1:${srv.port}`), `Missing Local URL in stdout:\n${out}`);
          assert(out.includes(`${expectedHost}:${srv.port}`), `Missing Remote URL in stdout:\n${out}`);
          assert(
            new RegExp(`ssh\\s+-L\\s+${srv.port}:localhost:${srv.port}\\s+${escHost}`).test(out),
            `Missing SSH tunnel command in stdout:\n${out}`
          );
          const h = await srv.fetchJson('/api/health');
          assert(h.status === 200 && h.data?.ok === true && h.data?.port === srv.port, `Health check failed: ${JSON.stringify(h)}`);
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T2-F27-2',
      tier: 2,
      feature: 'F27',
      name: 'HOST and PORT environment variables override default binding when CLI flags omitted',
      fn: async () => {
        const serverPath = path.join(V2_ROOT, 'src', 'server.mjs');
        assert(fs.existsSync(serverPath), `Missing server at ${serverPath}`);
        const freePort = await getFreePort();
        const child = spawn(process.execPath, [serverPath], {
          cwd: V2_ROOT,
          env: { ...process.env, HOST: '127.0.0.1', PORT: String(freePort) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Server failed to bind PORT=${freePort}.\nstdout:${stdout}\nstderr:${stderr}`)), 8000);
            const check = () => {
              if (stdout.includes(`:${freePort}`)) {
                clearTimeout(timer);
                resolve();
              }
            };
            child.stdout.on('data', (d) => { stdout += d.toString('utf8'); check(); });
            child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
            child.once('close', (code) => {
              clearTimeout(timer);
              reject(new Error(`Server exited early (${code}).\nstdout:${stdout}\nstderr:${stderr}`));
            });
          });
          const res = await fetch(`http://127.0.0.1:${freePort}/api/health`);
          const data = await res.json();
          assert(res.status === 200 && data.ok === true, `Expected 200 ok from PORT=${freePort}`);
          assert(data.port === freePort, `Expected port=${freePort}, got ${data.port}`);
          assert(data.host === '127.0.0.1', `Expected host=127.0.0.1, got ${data.host}`);
        } finally {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          await new Promise((r) => {
            const kt = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 1500);
            child.once('close', () => { clearTimeout(kt); r(); });
          });
        }
      },
    },
    {
      id: 'T2-F27-3',
      tier: 2,
      feature: 'F27',
      name: 'GET /api/stl-content?file=../../etc/passwd strips traversal and returns 404 JSON',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const r = await srv.fetchJson('/api/stl-content?file=../../etc/passwd');
          assert(r.status === 404, `Expected 404 for traversal stl-content, got ${r.status}`);
          assert(r.data && typeof r.data.error === 'string', `Expected JSON {error}, got ${r.text}`);
          assert(!r.text.includes('root:'), 'Traversal leaked /etc/passwd!');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T2-F27-4',
      tier: 2,
      feature: 'F27',
      name: 'CLI unknown command exits with non-zero exit code',
      fn: async () => {
        const res = await runCli(['unknown-command-xyz']);
        assert(res.code !== 0, `Expected non-zero exit code for unknown CLI command, got ${res.code}`);
      },
    },
    {
      id: 'T2-F27-5',
      tier: 2,
      feature: 'F27',
      name: 'CLI unwrap without --stl exits with non-zero exit code',
      fn: async () => {
        await withTempDir(async (outDir) => {
          const res = await runCli(['unwrap', '--out', outDir]);
          assert(res.code !== 0, `Expected non-zero exit code for unwrap missing --stl, got ${res.code}`);
        });
      },
    },
  ];
}
