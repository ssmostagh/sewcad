import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
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
  samplePieceOutlineIndependent,
  buildSeamConnectivity,
  parseAsciiSTLIndependent,
  parseBinarySTLHeaderInfo,
  createSyntheticBinarySTLWithSolidHeader,
  pointToTriangleDist3D,
  verifyExportWithPython,
  verifyPatternStudioIsolation,
} from './helpers.mjs';

// ============================================================================
// Local Pure-JS Geometry & Physics Oracles (Zero src/core Imports)
// ============================================================================

function pt3(p) {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]) };
  if (p?.pos) return pt3(p.pos);
  return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
}

function dist3(aRaw, bRaw) {
  const a = pt3(aRaw);
  const b = pt3(bRaw);
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function triArea3D(aRaw, bRaw, cRaw) {
  const a = pt3(aRaw);
  const b = pt3(bRaw);
  const c = pt3(cRaw);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

function triSignedArea2D(a, b, c) {
  const ax = Array.isArray(a) ? a[0] : a.x;
  const ay = Array.isArray(a) ? a[1] : a.y;
  const bx = Array.isArray(b) ? b[0] : b.x;
  const by = Array.isArray(b) ? b[1] : b.y;
  const cx = Array.isArray(c) ? c[0] : c.x;
  const cy = Array.isArray(c) ? c[1] : c.y;
  return 0.5 * ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
}

function pointToSegDist2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { dist: Math.hypot(px - ax, py - ay), t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return {
    dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)),
    t,
  };
}

function computeMeshTopology2D(vertices, triangles) {
  const edgeMap = new Map();
  let totalArea = 0;
  let maxEdgeLen = 0;

  for (const tri of triangles) {
    const [i0, i1, i2] = Array.isArray(tri) ? tri : [tri.a, tri.b, tri.c];
    const v0 = vertices[i0];
    const v1 = vertices[i1];
    const v2 = vertices[i2];
    totalArea += Math.abs(triSignedArea2D(v0, v1, v2));

    const pairs = [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ];
    for (const [u, v] of pairs) {
      const len = dist2DIndependent(vertices[u], vertices[v]);
      if (len > maxEdgeLen) maxEdgeLen = len;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
  }

  let boundaryEdges = 0;
  let interiorEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeMap.values()) {
    if (count === 1) boundaryEdges++;
    else if (count === 2) interiorEdges++;
    else nonManifoldEdges++;
  }

  // Count T-junctions: any vertex lying strictly inside any edge (not an endpoint of that edge)
  let tJunctions = 0;
  for (const key of edgeMap.keys()) {
    const [uStr, vStr] = key.split(':');
    const u = Number(uStr);
    const v = Number(vStr);
    const a = Array.isArray(vertices[u]) ? { x: vertices[u][0], y: vertices[u][1] } : vertices[u];
    const b = Array.isArray(vertices[v]) ? { x: vertices[v][0], y: vertices[v][1] } : vertices[v];
    for (let k = 0; k < vertices.length; k++) {
      if (k === u || k === v) continue;
      const p = Array.isArray(vertices[k]) ? { x: vertices[k][0], y: vertices[k][1] } : vertices[k];
      const { dist, t } = pointToSegDist2D(p.x, p.y, a.x, a.y, b.x, b.y);
      if (t > 1e-3 && t < 1 - 1e-3 && dist < 1e-3) {
        tJunctions++;
      }
    }
  }

  return {
    V: vertices.length,
    E: edgeMap.size,
    F: triangles.length,
    euler: vertices.length - edgeMap.size + triangles.length,
    boundaryEdges,
    interiorEdges,
    nonManifoldEdges,
    tJunctions,
    totalArea,
    maxEdgeLen,
  };
}

function extractTrianglesFromParsedSTL(mesh) {
  if (Array.isArray(mesh?.triangles) && mesh.triangles.length > 0) {
    return mesh.triangles.map((t) =>
      Array.isArray(t) ? t.map(pt3) : [pt3(t.a ?? t.v0), pt3(t.b ?? t.v1), pt3(t.c ?? t.v2)]
    );
  }
  const verts = mesh?.vertices || [];
  const faces = mesh?.faces || [];
  if (faces.length > 0 && verts.length > 0) {
    return faces.map((f) => {
      const idx = Array.isArray(f) ? f : f.indices || [f.a, f.b, f.c];
      return [pt3(verts[idx[0]]), pt3(verts[idx[1]]), pt3(verts[idx[2]])];
    });
  }
  if (verts.length >= 3) {
    const tris = [];
    for (let i = 0; i + 2 < verts.length; i += 3) {
      tris.push([pt3(verts[i]), pt3(verts[i + 1]), pt3(verts[i + 2])]);
    }
    return tris;
  }
  return [];
}

function minDistToSTLTtris(pRaw, tris) {
  let minD = Infinity;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const d = pointToTriangleDist3D(pRaw, t[0], t[1], t[2]);
    if (d < minD) minD = d;
  }
  return minD;
}

function makeSimpleProject(core, pieces, seams = [], materialId = 'cotton_jersey', extra = {}) {
  if (typeof core.createPatternProject === 'function') {
    return core.createPatternProject({
      name: extra.name || 'Test Project',
      templateId: extra.templateId || 'freeform',
      materialId,
      pieces,
      seams,
      ...extra,
    });
  }
  const material = core.getMaterialConfig(materialId, extra.materialOverrides);
  return {
    id: 'test_proj',
    name: extra.name || 'Test Project',
    templateId: extra.templateId || 'freeform',
    version: '2.0.0',
    unit: 'mm',
    params: {},
    materialId,
    material,
    avatar: core.DEFAULT_AVATAR,
    stlMetadata: null,
    pieces,
    seams,
    ...extra,
  };
}

async function runNodeCheck(filePath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', filePath], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`node --check failed for ${filePath}: ${stderr || error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function getPBRMapEntry(maps, keys) {
  for (const k of keys) {
    if (maps && maps[k] !== undefined && maps[k] !== null) return maps[k];
  }
  return null;
}

function extractPixelBuffer(mapObj) {
  if (!mapObj) return null;
  if (ArrayBuffer.isView(mapObj)) return mapObj;
  if (ArrayBuffer.isView(mapObj.data)) return mapObj.data;
  if (Array.isArray(mapObj.data)) return mapObj.data;
  if (Array.isArray(mapObj)) return mapObj;
  return null;
}

function assertNonConstantBuffer(buf, label) {
  assert(buf && buf.length > 0, `${label} buffer must be non-empty`);
  let min = Infinity;
  let max = -Infinity;
  const stride = buf.length >= 16384 ? 4 : 1;
  for (let i = 0; i < buf.length; i += stride) {
    const v = Number(buf[i]);
    assert(Number.isFinite(v), `${label} contains non-finite value at index ${i}`);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert(max > min, `${label} must have non-constant pixel variance (min=${min}, max=${max})`);
}

// ============================================================================
// Tier 1 Tests: F15 - F27 (65 Cases)
// ============================================================================

export function getTests() {
  return [
    // ------------------------------------------------------------------------
    // F15: Binary & ASCII STL Parser (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F15-1',
      tier: 1,
      feature: 'F15',
      name: 'parseSTL parses ASCII cutting_mat_wedge_assembled_view.stl (984 tris, 123931.5 mm2)',
      fn: async () => {
        const core = await loadCore();
        const text = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const oracle = parseAsciiSTLIndependent(text);
        const mesh = core.parseSTL(text, 'cutting_mat_wedge_assembled_view.stl');

        assert(mesh.triangleCount === 984, `Expected 984 triangles, got ${mesh.triangleCount}`);
        assert(oracle.triangleCount === 984, `Oracle mismatch: ${oracle.triangleCount}`);
        assertNear(mesh.surfaceAreaMm2, oracle.surfaceAreaMm2, 5.0, 'surfaceAreaMm2');
        assertNear(mesh.surfaceAreaMm2, 123931.51, 5.0, 'ground-truth area');
        assertNear(mesh.bounds.size.x, 180.6, 0.1, 'bounds size.x');
        assertNear(mesh.bounds.size.y, 164.36, 0.1, 'bounds size.y');
        assertNear(mesh.bounds.size.z, 60.7, 0.1, 'bounds size.z');
      },
    },
    {
      id: 'T1-F15-2',
      tier: 1,
      feature: 'F15',
      name: 'parseSTL parses ASCII cutting_mat_wedge_print_ready.stl (984 tris, 180.6x60.7x164.36 mm)',
      fn: async () => {
        const core = await loadCore();
        const text = await fsp.readFile(WEDGE_PRINT_READY_STL, 'utf8');
        const oracle = parseAsciiSTLIndependent(text);
        const mesh = core.parseSTL(text, 'cutting_mat_wedge_print_ready.stl');

        assert(mesh.triangleCount === 984, `Expected 984 triangles, got ${mesh.triangleCount}`);
        assertNear(mesh.surfaceAreaMm2, oracle.surfaceAreaMm2, 5.0, 'surfaceAreaMm2');
        assertNear(mesh.surfaceAreaMm2, 123931.52, 5.0, 'ground-truth area');
        assertNear(mesh.bounds.size.x, 180.6, 0.1, 'bounds size.x');
        assertNear(mesh.bounds.size.y, 60.7, 0.1, 'bounds size.y');
        assertNear(mesh.bounds.size.z, 164.36, 0.1, 'bounds size.z');
      },
    },
    {
      id: 'T1-F15-3',
      tier: 1,
      feature: 'F15',
      name: 'createBoxSTL binary STL & "solid " binary header disambiguation parse cleanly',
      fn: async () => {
        const core = await loadCore();
        const binBox = core.createBoxSTL(120, 80, 60, true);
        const info = parseBinarySTLHeaderInfo(binBox);
        assert(info.validHeader && info.matchesLength, 'createBoxSTL binary byteLength must match 84 + 50*N');
        assert(info.triangleCount === 12, `Box must have 12 triangles, got ${info.triangleCount}`);

        const parsed = core.parseSTL(binBox, 'box_120x80x60.stl');
        assert(parsed.triangleCount === 12, `parseSTL expected 12 tris, got ${parsed.triangleCount}`);
        assertNear(parsed.surfaceAreaMm2, 2 * (120 * 80 + 120 * 60 + 80 * 60), 1.0, 'box surface area');
        assertNear(Math.abs(parsed.volumeMm3), 120 * 80 * 60, 10.0, 'box volume');
        const dims = [parsed.bounds.size.x, parsed.bounds.size.y, parsed.bounds.size.z].sort((a, b) => a - b);
        assertNear(dims[0], 60, 0.1, 'box min dim');
        assertNear(dims[1], 80, 0.1, 'box mid dim');
        assertNear(dims[2], 120, 0.1, 'box max dim');

        // Also test binary STL starting with "solid " in 80-byte header
        const solidBin = createSyntheticBinarySTLWithSolidHeader();
        const parsedSolidBin = core.parseSTL(solidBin, 'solid_header_bin.stl');
        assert(parsedSolidBin.triangleCount === 12, `Expected 12 tris for solid-header binary STL, got ${parsedSolidBin.triangleCount}`);
        assertNear(parsedSolidBin.surfaceAreaMm2, 2400, 1.0, '20mm cube area');
      },
    },
    {
      id: 'T1-F15-4',
      tier: 1,
      feature: 'F15',
      name: 'analyzeSTLTopology reports watertight genus-3 shell (488 welded verts, 1476 edges, 984 faces)',
      fn: async () => {
        const core = await loadCore();
        const text = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const mesh = core.parseSTL(text, 'cutting_mat_wedge_assembled_view.stl');
        const topo = core.analyzeSTLTopology(mesh);

        assert(topo && typeof topo === 'object', 'analyzeSTLTopology must return an object');
        const shells = topo.shellCount ?? topo.shells ?? topo.componentCount ?? (Array.isArray(topo.components) ? topo.components.length : undefined);
        assert(shells === 1, `Expected 1 connected shell, got ${shells}`);

        const boundaryEdges = topo.boundaryEdges ?? topo.openEdges ?? topo.boundaryEdgeCount;
        assert(boundaryEdges === 0, `Expected 0 boundary edges on watertight STL, got ${boundaryEdges}`);

        const nonManifold = topo.nonManifoldEdges ?? topo.nonManifoldEdgeCount;
        assert(nonManifold === 0, `Expected 0 non-manifold edges, got ${nonManifold}`);

        const vCount = topo.weldedVertexCount ?? topo.vertexCount ?? topo.vertices;
        assert(typeof vCount === 'number', `Expected numeric welded vertex count, got ${vCount}`);
        assertNear(vCount, 488, 2, 'welded vertex count');

        const eCount = topo.edgeCount ?? topo.edges;
        assert(typeof eCount === 'number', `Expected numeric edge count, got ${eCount}`);
        assertNear(eCount, 1476, 4, 'welded edge count');

        const fCount = topo.faceCount ?? topo.triangleCount ?? topo.faces;
        assert(fCount === 984, `Expected 984 faces, got ${fCount}`);

        const euler = topo.euler ?? topo.eulerCharacteristic ?? (vCount - eCount + fCount);
        assert(euler === -4, `Expected genus-3 Euler characteristic -4, got ${euler}`);
      },
    },
    {
      id: 'T1-F15-5',
      tier: 1,
      feature: 'F15',
      name: 'createWedgeSTL generates valid sloped wedge STL matching independent triangle metrics',
      fn: async () => {
        const core = await loadCore();
        const wedgeText = core.createWedgeSTL(152.4, 152.4, 51.2, 13.5, false);
        assert(typeof wedgeText === 'string' && wedgeText.includes('facet normal'), 'Expected ASCII STL output');

        const oracle = parseAsciiSTLIndependent(wedgeText);
        const mesh = core.parseSTL(wedgeText, 'wedge.stl');
        assert(mesh.triangleCount === oracle.triangleCount && mesh.triangleCount >= 12, 'Wedge tri count mismatch');
        assertNear(mesh.surfaceAreaMm2, oracle.surfaceAreaMm2, 0.5, 'wedge surface area');
        assert(mesh.surfaceAreaMm2 > 0, 'Wedge surface area must be positive');

        const sortedMesh = [mesh.bounds.size.x, mesh.bounds.size.y, mesh.bounds.size.z].sort((a, b) => a - b);
        const sortedExpected = [51.2, 152.4, 152.4];
        assertNear(sortedMesh[0], sortedExpected[0], 0.1, 'wedge height');
        assertNear(sortedMesh[1], sortedExpected[1], 0.1, 'wedge width');
        assertNear(sortedMesh[2], sortedExpected[2], 0.1, 'wedge length');
      },
    },

    // ------------------------------------------------------------------------
    // F16: Orientation-Invariant STL Unwrapping (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F16-1',
      tier: 1,
      feature: 'F16',
      name: 'unwrapSTLToPattern form_shell_cover on assembled_view yields valid CCW non-self-intersecting cover pieces',
      fn: async () => {
        const core = await loadCore();
        const text = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const mesh = core.parseSTL(text, 'cutting_mat_wedge_assembled_view.stl');
        const pat = core.unwrapSTLToPattern(mesh, {
          name: 'Wedge Cover',
          mode: 'form_shell_cover',
          easeMm: 4,
          seamAllowance: 10,
        });

        assert(pat && Array.isArray(pat.pieces) && pat.pieces.length >= 2, 'Expected >= 2 form_shell_cover pieces');
        assert(pat.stlMetadata && pat.stlMetadata.triangleCount === 984, 'stlMetadata must record 984 triangles');

        for (const piece of pat.pieces) {
          const outline = samplePieceOutlineIndependent(piece, 24);
          assert(outline.length >= 3, `Piece ${piece.name} has < 3 sampled vertices`);
          assert(shoelaceSignedArea(outline) > 0, `Piece ${piece.name} must have CCW positive area`);
          assert(countSelfIntersections(outline) === 0, `Piece ${piece.name} self-intersects`);
        }
      },
    },
    {
      id: 'T1-F16-2',
      tier: 1,
      feature: 'F16',
      name: 'form_shell_cover preserves concave hook recess (shoelace/convexHull <= 0.94)',
      fn: async () => {
        const core = await loadCore();
        const text = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const mesh = core.parseSTL(text, 'cutting_mat_wedge_assembled_view.stl');
        const pat = core.unwrapSTLToPattern(mesh, {
          mode: 'form_shell_cover',
          easeMm: 4,
          thicknessMm: 0,
          seamAllowance: 10,
        });

        // Ground truth: true wedge outer profile has 763.96 mm2 hook recess -> ratio <= 0.9154 at 4mm offset (<= 0.94).
        // Convex hull collapse gives 1.000.
        let minRatio = Infinity;
        let foundSideProfile = false;
        for (const piece of pat.pieces) {
          const outline = samplePieceOutlineIndependent(piece, 24);
          const area = shoelaceArea(outline);
          const hullArea = shoelaceArea(convexHull2DIndependent(outline));
          if (area >= 2500 && hullArea > 0) {
            const ratio = area / hullArea;
            if (ratio < minRatio) minRatio = ratio;
            if (ratio <= 0.94) foundSideProfile = true;
          }
        }
        assert(
          foundSideProfile && minRatio <= 0.94,
          `Expected concave side-profile panel with area/hull <= 0.94 (hook recess preserved), got minRatio=${minRatio.toFixed(4)}`
        );
      },
    },
    {
      id: 'T1-F16-3',
      tier: 1,
      feature: 'F16',
      name: 'form_shell_cover is orientation-invariant between assembled_view and print_ready STLs',
      fn: async () => {
        const core = await loadCore();
        const asmMesh = core.parseSTL(
          await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8'),
          'cutting_mat_wedge_assembled_view.stl'
        );
        const prtMesh = core.parseSTL(
          await fsp.readFile(WEDGE_PRINT_READY_STL, 'utf8'),
          'cutting_mat_wedge_print_ready.stl'
        );

        const opts = { mode: 'form_shell_cover', easeMm: 4, seamAllowance: 10 };
        const patAsm = core.unwrapSTLToPattern(asmMesh, opts);
        const patPrt = core.unwrapSTLToPattern(prtMesh, opts);

        assert(
          patAsm.pieces.length === patPrt.pieces.length,
          `Piece count mismatch: assembled=${patAsm.pieces.length} vs print_ready=${patPrt.pieces.length}`
        );

        const summarize = (pat) =>
          pat.pieces
            .map((p) => {
              const pts = samplePieceOutlineIndependent(p, 16);
              const b = calcBounds(pts);
              const major = Math.max(b.width, b.height);
              const minor = Math.min(b.width, b.height);
              return { area: shoelaceArea(pts), major, minor };
            })
            .sort((a, b) => a.area - b.area);

        const sAsm = summarize(patAsm);
        const sPrt = summarize(patPrt);

        const totalAreaAsm = sAsm.reduce((s, p) => s + p.area, 0);
        const totalAreaPrt = sPrt.reduce((s, p) => s + p.area, 0);
        const areaDiffPct = (Math.abs(totalAreaAsm - totalAreaPrt) / Math.max(1, totalAreaAsm)) * 100;
        assert(areaDiffPct <= 2.0, `Total cover area differs by ${areaDiffPct.toFixed(2)}% across orientations`);

        for (let i = 0; i < sAsm.length; i++) {
          assertNear(sAsm[i].major, sPrt[i].major, Math.max(2.0, sAsm[i].major * 0.02), `piece[${i}] major dim`);
          assertNear(sAsm[i].minor, sPrt[i].minor, Math.max(2.0, sAsm[i].minor * 0.02), `piece[${i}] minor dim`);
        }
      },
    },
    {
      id: 'T1-F16-4',
      tier: 1,
      feature: 'F16',
      name: 'unwrapSTLToPattern surface_panels generates dihedral charts with valid shared-edge seams',
      fn: async () => {
        const core = await loadCore();
        const mesh = core.parseSTL(
          await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8'),
          'cutting_mat_wedge_assembled_view.stl'
        );
        const pat = core.unwrapSTLToPattern(mesh, {
          mode: 'surface_panels',
          easeMm: 2,
          seamAllowance: 10,
        });

        assert(pat.pieces.length >= 2, `surface_panels must emit >= 2 chart pieces, got ${pat.pieces.length}`);
        assert(Array.isArray(pat.seams) && pat.seams.length >= 1, 'surface_panels must emit shared-edge sewing seams');

        for (const piece of pat.pieces) {
          const outline = samplePieceOutlineIndependent(piece, 16);
          assert(shoelaceSignedArea(outline) > 0, `Panel ${piece.name} must be CCW`);
          assert(countSelfIntersections(outline) === 0, `Panel ${piece.name} self-intersects`);
        }

        const seamReport = core.validatePatternSeams(pat);
        assert(seamReport.length === pat.seams.length, 'validatePatternSeams count mismatch');
        for (const r of seamReport) {
          assert(r.status !== 'missing_piece', `Invalid seam reference in ${r.seamId}`);
        }
      },
    },
    {
      id: 'T1-F16-5',
      tier: 1,
      feature: 'F16',
      name: 'Unwrapped STL cover pieces report finite non-negative distortionPct',
      fn: async () => {
        const core = await loadCore();
        const boxMesh = core.parseSTL(core.createBoxSTL(100, 80, 60, false), 'box.stl');
        const patPanels = core.unwrapSTLToPattern(boxMesh, { mode: 'surface_panels', easeMm: 2, seamAllowance: 10 });
        const patShell = core.unwrapSTLToPattern(boxMesh, { mode: 'form_shell_cover', easeMm: 2, seamAllowance: 10 });

        for (const pat of [patPanels, patShell]) {
          assert(pat.pieces.length >= 1, 'Expected unwrapped pieces');
          for (const piece of pat.pieces) {
            assert(
              typeof piece.distortionPct === 'number' && Number.isFinite(piece.distortionPct) && piece.distortionPct >= 0,
              `Piece ${piece.name} distortionPct must be finite >= 0, got ${piece.distortionPct}`
            );
          }
        }
      },
    },

    // ------------------------------------------------------------------------
    // F17: Conforming 2D->3D Cloth Triangulation (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F17-1',
      tier: 1,
      feature: 'F17',
      name: 'triangulatePolygon ear-clipping matches exact Shoelace area on concave L-shape',
      fn: async () => {
        const core = await loadCore();
        const lShape = [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 50 },
          { x: 50, y: 50 },
          { x: 50, y: 100 },
          { x: 0, y: 100 },
        ];
        const expectedArea = shoelaceArea(lShape); // 7500 mm2
        assertNear(expectedArea, 7500, 1e-6, 'L-shape oracle area');

        const mesh = core.triangulatePolygon(lShape);
        assert(mesh && Array.isArray(mesh.vertices) && Array.isArray(mesh.triangles), 'Expected {vertices, triangles}');
        assert(mesh.triangles.length === 4, `6-vertex simple polygon should yield 4 ear triangles, got ${mesh.triangles.length}`);

        const topo = computeMeshTopology2D(mesh.vertices, mesh.triangles);
        assertNear(topo.totalArea, expectedArea, 0.05, 'triangulated L-shape area');
        assert(topo.euler === 1, `Expected Euler V-E+F=1, got ${topo.euler}`);
      },
    },
    {
      id: 'T1-F17-2',
      tier: 1,
      feature: 'F17',
      name: 'generateClothMesh2D satisfies Euler characteristic V - E + F === 1 and exact area',
      fn: async () => {
        const core = await loadCore();
        const rect = [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 150 },
          { x: 0, y: 150 },
        ];
        const mesh = core.generateClothMesh2D(rect, 35);
        const topo = computeMeshTopology2D(mesh.vertices, mesh.triangles);

        assert(topo.F >= 16, `Expected refined cloth mesh on 200x150 with maxEdge=35, got ${topo.F} tris`);
        assert(topo.euler === 1, `Cloth mesh must be topological disk (V-E+F=1), got ${topo.euler} (V=${topo.V}, E=${topo.E}, F=${topo.F})`);
        assert(topo.nonManifoldEdges === 0, `Expected 0 non-manifold edges, got ${topo.nonManifoldEdges}`);
        assertNear(topo.totalArea, 30000, 0.5, 'cloth mesh total area');
      },
    },
    {
      id: 'T1-F17-3',
      tier: 1,
      feature: 'F17',
      name: 'generateClothMesh2D produces zero T-junctions on conforming mesh',
      fn: async () => {
        const core = await loadCore();
        const poly = [
          { x: 0, y: 0 },
          { x: 180, y: 0 },
          { x: 180, y: 90 },
          { x: 90, y: 90 },
          { x: 90, y: 160 },
          { x: 0, y: 160 },
        ];
        const mesh = core.generateClothMesh2D(poly, 28);
        const topo = computeMeshTopology2D(mesh.vertices, mesh.triangles);

        assert(topo.tJunctions === 0, `Conforming cloth mesh must have 0 T-junctions, found ${topo.tJunctions}`);
        assert(topo.euler === 1, `Expected Euler V-E+F=1, got ${topo.euler}`);
        assert(topo.nonManifoldEdges === 0, `Expected 0 non-manifold edges, got ${topo.nonManifoldEdges}`);
      },
    },
    {
      id: 'T1-F17-4',
      tier: 1,
      feature: 'F17',
      name: 'generateClothMesh2D respects maxEdgeLengthMm refinement bound',
      fn: async () => {
        const core = await loadCore();
        const rect = [
          { x: 0, y: 0 },
          { x: 240, y: 0 },
          { x: 240, y: 180 },
          { x: 0, y: 180 },
        ];
        const fine = core.generateClothMesh2D(rect, 25);
        const coarse = core.generateClothMesh2D(rect, 80);

        const topoFine = computeMeshTopology2D(fine.vertices, fine.triangles);
        const topoCoarse = computeMeshTopology2D(coarse.vertices, coarse.triangles);

        assert(topoFine.maxEdgeLen <= 25.5, `Fine mesh max edge ${topoFine.maxEdgeLen.toFixed(2)} exceeds maxEdgeLengthMm=25`);
        assert(topoFine.F > topoCoarse.F * 2, `Fine mesh (${topoFine.F} tris) should be significantly denser than coarse (${topoCoarse.F} tris)`);
        assert(topoFine.tJunctions === 0, `Fine mesh has ${topoFine.tJunctions} T-junctions`);
      },
    },
    {
      id: 'T1-F17-5',
      tier: 1,
      feature: 'F17',
      name: 'generateClothMesh2D meshes curved + concave pattern outline cleanly',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createFreeformPiece('CurvedConcave', [
          { x: 0, y: 0 },
          { x: 160, y: 0 },
          { x: 160, y: 80 },
          { x: 90, y: 80 },
          { x: 90, y: 150 },
          { x: 0, y: 150 },
        ]);
        // Curve the outer vertical edge (index 5: (0,150)->(0,0))
        piece.edges[5].curve = { cp1: { x: -35, y: 110 }, cp2: { x: -35, y: 40 } };

        const outline = samplePieceOutlineIndependent(piece, 16);
        const expectedArea = shoelaceArea(outline);
        const mesh = core.generateClothMesh2D(outline, 30);
        const topo = computeMeshTopology2D(mesh.vertices, mesh.triangles);

        assert(topo.euler === 1, `Curved concave mesh Euler must be 1, got ${topo.euler}`);
        assert(topo.tJunctions === 0, `Curved concave mesh must have 0 T-junctions, got ${topo.tJunctions}`);
        assertNear(topo.totalArea, expectedArea, expectedArea * 0.01, 'curved concave mesh area');
      },
    },

    // ------------------------------------------------------------------------
    // F18: XPBD / Verlet 3D Cloth & Sewing Solver (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F18-1',
      tier: 1,
      feature: 'F18',
      name: 'ClothSimulation steps produce finite 3D particle coordinates and motion',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt');
        const sim = new core.ClothSimulation(pat, { materialId: 'cotton_jersey' });
        const initialPos = sim.particles.map((p) => pt3(p));

        const report = sim.step(30);
        assert(sim.particles.length > 0, 'ClothSimulation must create particles');
        assert(report.stepCount === 30, `Expected stepCount=30, got ${report.stepCount}`);

        let maxDisp = 0;
        for (let i = 0; i < sim.particles.length; i++) {
          const p = pt3(sim.particles[i]);
          assert(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `Non-finite particle at ${i}`);
          const d = dist3(initialPos[i], p);
          if (d > maxDisp) maxDisp = d;
        }
        assert(maxDisp > 0.5, `Expected particles to move during simulation, maxDisp=${maxDisp}`);
      },
    },
    {
      id: 'T1-F18-2',
      tier: 1,
      feature: 'F18',
      name: 'runSimulationSteps executes automated steps and returns finite state + strainReport',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tote_bag');
        const res = core.runSimulationSteps(pat, { steps: 25, materialId: 'duck_canvas' });

        assert(res && Array.isArray(res.particles) && res.particles.length > 0, 'runSimulationSteps must return particles');
        assert(res.finiteOk !== false, 'finiteOk must not be false');
        assert(res.strainReport && typeof res.strainReport === 'object', 'strainReport missing');
        assert((res.stepCount ?? res.strainReport.stepCount) === 25, 'Expected 25 steps');
        for (const p of res.particles) {
          const c = pt3(p);
          assert(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z), 'Non-finite particle returned');
        }
      },
    },
    {
      id: 'T1-F18-3',
      tier: 1,
      feature: 'F18',
      name: 'Progressive sewing springs reduce avgSewGapMm across simulation steps',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('PanelA', 140, 140, {
          placement3D: { offset: { x: -90, y: 1100, z: 40 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
        });
        const pB = core.createRectanglePiece('PanelB', 140, 140, {
          placement3D: { offset: { x: -90, y: 1100, z: -40 }, normal: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
        });
        const seam = {
          id: 'seam_ab',
          name: 'Side Seam',
          pieceA: pA.id,
          edgeA: 1,
          pieceB: pB.id,
          edgeB: 1,
          reversed: true,
        };
        const pat = makeSimpleProject(core, [pA, pB], [seam], 'cotton_jersey');

        const sim = new core.ClothSimulation(pat, { avatar: null });
        const r1 = sim.step(1);
        const gapStart = r1.avgSewGapMm;
        const r80 = sim.step(80);
        const gapEnd = r80.avgSewGapMm;

        assert(Number.isFinite(gapStart) && Number.isFinite(gapEnd), 'avgSewGapMm must be finite');
        assert(
          gapEnd < gapStart * 0.75,
          `Expected sewing springs to pull seams together: gapStart=${gapStart.toFixed(2)}mm -> gapEnd=${gapEnd.toFixed(2)}mm`
        );
      },
    },
    {
      id: 'T1-F18-4',
      tier: 1,
      feature: 'F18',
      name: 'Dart-closing springs pull dart legs and deform cloth geometry vs dartless control',
      fn: async () => {
        const core = await loadCore();
        const placement = { offset: { x: -100, y: 1100, z: 120 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
        const plainPiece = core.createRectanglePiece('Plain', 200, 200, { placement3D: placement });
        const dartedPiece = core.addDartToPiece(
          core.createRectanglePiece('Darted', 200, 200, { placement3D: placement }),
          { edgeIndex: 0, t: 0.5, widthMm: 35, depthMm: 85 }
        );

        const resPlain = core.runSimulationSteps(makeSimpleProject(core, [plainPiece]), { steps: 50, avatar: null });
        const resDart = core.runSimulationSteps(makeSimpleProject(core, [dartedPiece]), { steps: 50, avatar: null });

        assert(resDart.particles.length > 0 && resPlain.particles.length > 0, 'Missing particles');
        for (const p of resDart.particles) {
          const c = pt3(p);
          assert(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z), 'Dart sim produced non-finite coords');
        }

        // Compare final bounding shape / Z-span or strain between darted and plain piece
        const zSpan = (parts) => {
          let minZ = Infinity;
          let maxZ = -Infinity;
          for (const p of parts) {
            const z = pt3(p).z;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
          return maxZ - minZ;
        };
        const zDart = zSpan(resDart.particles);
        const zPlain = zSpan(resPlain.particles);
        const strainDiff = Math.abs((resDart.strainReport?.maxStrainPct ?? 0) - (resPlain.strainReport?.maxStrainPct ?? 0));
        assert(
          Math.abs(zDart - zPlain) > 0.2 || strainDiff > 0.05 || resDart.particles.length !== resPlain.particles.length,
          `Darted simulation showed no measurable physical difference vs dartless control (zDart=${zDart.toFixed(2)}, zPlain=${zPlain.toFixed(2)}, strainDiff=${strainDiff.toFixed(3)})`
        );
      },
    },
    {
      id: 'T1-F18-5',
      tier: 1,
      feature: 'F18',
      name: 'Anisotropic warp/weft stiffness and shearStiffness alter draping physics response',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt');

        const resLow = core.runSimulationSteps(pat, {
          steps: 45,
          materialId: 'cotton_jersey',
          materialOverrides: { warpStiffness: 0.98, weftStiffness: 0.15, shearStiffness: 0.02, bendStiffness: 0.05 },
        });
        const resHigh = core.runSimulationSteps(pat, {
          steps: 45,
          materialId: 'cotton_jersey',
          materialOverrides: { warpStiffness: 0.2, weftStiffness: 0.98, shearStiffness: 0.98, bendStiffness: 0.8 },
        });

        assert(resLow.particles.length === resHigh.particles.length, 'Particle counts should match on identical pattern');
        let maxDiff = 0;
        for (let i = 0; i < resLow.particles.length; i++) {
          const d = dist3(resLow.particles[i], resHigh.particles[i]);
          if (d > maxDiff) maxDiff = d;
        }
        assert(maxDiff > 0.2, `Expected anisotropic + shear stiffness changes to affect drape, maxDiff=${maxDiff.toFixed(4)}mm`);
      },
    },

    // ------------------------------------------------------------------------
    // F19: Triangle-Mesh STL & Avatar Collision (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F19-1',
      tier: 1,
      feature: 'F19',
      name: 'DEFAULT_AVATAR and createParametricAvatar generate scaled dress-form colliders',
      fn: async () => {
        const core = await loadCore();
        assert(core.DEFAULT_AVATAR && typeof core.DEFAULT_AVATAR === 'object', 'DEFAULT_AVATAR must be exported');

        const small = core.createParametricAvatar({ chestMm: 840, waistMm: 660, hipMm: 880, heightMm: 1600 });
        const large = core.createParametricAvatar({ chestMm: 1180, waistMm: 1020, hipMm: 1220, heightMm: 1880 });

        for (const av of [small, large]) {
          assert(Array.isArray(av.vertices) && av.vertices.length > 20, 'Avatar must have mesh vertices');
          assert(Array.isArray(av.triangles) && av.triangles.length > 20, 'Avatar must have mesh triangles');
          assert(Array.isArray(av.colliders) && av.colliders.length >= 1, 'Avatar must have ellipsoid colliders');
        }

        const xWidth = (av) => {
          let minX = Infinity;
          let maxX = -Infinity;
          for (const v of av.vertices) {
            const x = pt3(v).x;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
          return maxX - minX;
        };
        assert(xWidth(large) > xWidth(small) + 30, 'Larger avatar chest/hip params must produce wider avatar geometry');
      },
    },
    {
      id: 'T1-F19-2',
      tier: 1,
      feature: 'F19',
      name: 'Cloth drapes cleanly around parametric avatar colliders without collapsing',
      fn: async () => {
        const core = await loadCore();
        const avatar = core.createParametricAvatar({ chestMm: 980, waistMm: 820, hipMm: 1000, heightMm: 1750 });
        const pat = core.generateTemplatePattern('tshirt');
        const res = core.runSimulationSteps(pat, { steps: 60, avatar, materialId: 'cotton_jersey' });

        assert(res.particles.length > 0, 'Expected simulation particles');
        let minX = Infinity;
        let maxX = -Infinity;
        for (const p of res.particles) {
          const c = pt3(p);
          assert(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z), 'Non-finite particle on avatar');
          if (c.x < minX) minX = c.x;
          if (c.x > maxX) maxX = c.x;
        }
        // T-shirt draped over chest (~300+ mm wide) must not collapse inward through torso
        assert(maxX - minX > 250, `Garment collapsed on avatar: width=${(maxX - minX).toFixed(1)}mm`);
      },
    },
    {
      id: 'T1-F19-3',
      tier: 1,
      feature: 'F19',
      name: 'Triangle-mesh STL collision settles cloth onto angled wedge slope inside AABB (anti-AABB check)',
      fn: async () => {
        const core = await loadCore();
        const wedgeText = core.createWedgeSTL(160, 160, 70, 10, false);
        const wedgeMesh = core.parseSTL(wedgeText, 'sloped_wedge.stl');
        const tris = extractTrianglesFromParsedSTL(wedgeMesh);
        assert(tris.length >= 12, 'Expected wedge triangles');

        const pat = core.unwrapSTLToPattern(wedgeMesh, {
          mode: 'surface_panels',
          easeMm: 2,
          thicknessMm: 1.5,
          seamAllowance: 10,
        });
        const sim = new core.ClothSimulation(pat, {
          stlMesh: wedgeMesh,
          avatar: null,
          materialOverrides: { thicknessMm: 1.5 },
        });
        sim.step(60);

        const b = wedgeMesh.bounds;
        let insideAabbCount = 0;
        let penetratedCount = 0;
        for (const p of sim.particles) {
          const c = pt3(p);
          assert(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z), 'Non-finite particle on wedge');
          const d = minDistToSTLTtris(c, tris);
          if (d < 0.8) penetratedCount++;
          if (
            c.x > b.min.x + 3 && c.x < b.max.x - 3 &&
            c.y > b.min.y + 3 && c.y < b.max.y - 3 &&
            c.z > b.min.z + 3 && c.z < b.max.z - 3
          ) {
            insideAabbCount++;
          }
        }
        assert(
          penetratedCount <= Math.ceil(sim.particles.length * 0.05),
          `Too many particles penetrated wedge STL triangles: ${penetratedCount}/${sim.particles.length}`
        );
        assert(
          insideAabbCount > 0,
          'Expected cloth particles on sloped wedge face to settle inside overall AABB rather than floating on AABB shell'
        );
      },
    },
    {
      id: 'T1-F19-4',
      tier: 1,
      feature: 'F19',
      name: 'STL collision honors material thicknessMm surface clearance',
      fn: async () => {
        const core = await loadCore();
        const boxMesh = core.parseSTL(core.createBoxSTL(100, 100, 100, false), 'box.stl');
        const tris = extractTrianglesFromParsedSTL(boxMesh);
        const pat = core.unwrapSTLToPattern(boxMesh, { mode: 'surface_panels', easeMm: 0, seamAllowance: 8 });

        const simThin = new core.ClothSimulation(pat, {
          stlMesh: boxMesh,
          avatar: null,
          materialOverrides: { thicknessMm: 0.5 },
        });
        simThin.step(50);

        const simThick = new core.ClothSimulation(pat, {
          stlMesh: boxMesh,
          avatar: null,
          materialOverrides: { thicknessMm: 6.0 },
        });
        simThick.step(50);

        const meanDist = (parts) =>
          parts.reduce((acc, p) => acc + minDistToSTLTtris(pt3(p), tris), 0) / parts.length;

        const dThin = meanDist(simThin.particles);
        const dThick = meanDist(simThick.particles);
        assert(
          dThick > dThin + 2.0,
          `Expected 6mm thicknessMm clearance (${dThick.toFixed(2)}mm) > 0.5mm (${dThin.toFixed(2)}mm) + 2mm`
        );
      },
    },
    {
      id: 'T1-F19-5',
      tier: 1,
      feature: 'F19',
      name: 'Material friction slows sliding across sloped STL surface',
      fn: async () => {
        const core = await loadCore();
        const wedgeMesh = core.parseSTL(core.createWedgeSTL(160, 160, 80, 10, false), 'slope.stl');
        const pat = core.unwrapSTLToPattern(wedgeMesh, { mode: 'form_shell_cover', easeMm: 4, seamAllowance: 10 });

        const resLow = core.runSimulationSteps(pat, {
          steps: 55,
          stlMesh: wedgeMesh,
          avatar: null,
          materialOverrides: { friction: 0.01, gsm: 300 },
        });
        const resHigh = core.runSimulationSteps(pat, {
          steps: 55,
          stlMesh: wedgeMesh,
          avatar: null,
          materialOverrides: { friction: 0.95, gsm: 300 },
        });

        let maxDiff = 0;
        const n = Math.min(resLow.particles.length, resHigh.particles.length);
        for (let i = 0; i < n; i++) {
          const d = dist3(resLow.particles[i], resHigh.particles[i]);
          if (d > maxDiff) maxDiff = d;
        }
        assert(maxDiff > 0.15, `Expected friction 0.01 vs 0.95 to produce different slide/settle positions, maxDiff=${maxDiff.toFixed(4)}mm`);
      },
    },

    // ------------------------------------------------------------------------
    // F20: Strain / Fit Tension Heatmap (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F20-1',
      tier: 1,
      feature: 'F20',
      name: 'ClothSimulation returns complete strainReport with valid fitStatus enum',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt');
        const res = core.runSimulationSteps(pat, { steps: 30 });
        const sr = res.strainReport;

        assert(sr && typeof sr === 'object', 'strainReport must be an object');
        assert(typeof sr.meanStrainPct === 'number' && Number.isFinite(sr.meanStrainPct) && sr.meanStrainPct >= 0, 'Invalid meanStrainPct');
        assert(typeof sr.maxStrainPct === 'number' && Number.isFinite(sr.maxStrainPct) && sr.maxStrainPct >= sr.meanStrainPct, 'maxStrainPct must be >= meanStrainPct');
        assert(typeof sr.maxSafeStrainPct === 'number' && sr.maxSafeStrainPct > 0, 'maxSafeStrainPct must be > 0');
        assert(['good_fit', 'snug', 'too_tight'].includes(sr.fitStatus), `Unexpected fitStatus: ${sr.fitStatus}`);
      },
    },
    {
      id: 'T1-F20-2',
      tier: 1,
      feature: 'F20',
      name: 'Generous ease garment produces good_fit strain status',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 1200, easeMm: 140 });
        const avatar = core.createParametricAvatar({ chestMm: 900, waistMm: 760, hipMm: 920 });
        const res = core.runSimulationSteps(pat, {
          steps: 40,
          avatar,
          materialId: 'cotton_jersey',
          materialOverrides: { maxSafeStrainPct: 25 },
        });
        assert(
          res.strainReport.fitStatus === 'good_fit',
          `Expected good_fit for loose garment, got ${res.strainReport.fitStatus} (maxStrain=${res.strainReport.maxStrainPct}%)`
        );
      },
    },
    {
      id: 'T1-F20-3',
      tier: 1,
      feature: 'F20',
      name: 'Undersized garment on large avatar produces too_tight strain status',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt', { chestMm: 700, easeMm: 0 });
        const largeAvatar = core.createParametricAvatar({ chestMm: 1300, waistMm: 1120, hipMm: 1320, shoulderWidthMm: 520 });
        const res = core.runSimulationSteps(pat, {
          steps: 60,
          avatar: largeAvatar,
          materialId: 'heavy_denim',
          materialOverrides: { maxSafeStrainPct: 3 },
        });
        assert(
          res.strainReport.fitStatus === 'too_tight',
          `Expected too_tight for undersized rigid denim on 1300mm chest, got ${res.strainReport.fitStatus} (maxStrain=${res.strainReport.maxStrainPct}%)`
        );
        assert(res.strainReport.maxStrainPct > res.strainReport.maxSafeStrainPct, 'maxStrainPct should exceed maxSafeStrainPct');
      },
    },
    {
      id: 'T1-F20-4',
      tier: 1,
      feature: 'F20',
      name: 'Compressed cloth clamps engineering strain >= 0 (no negative strain)',
      fn: async () => {
        const core = await loadCore();
        const p = core.createRectanglePiece('Compressed', 120, 120);
        const pat = makeSimpleProject(core, [p]);
        const sim = new core.ClothSimulation(pat, { avatar: null });
        // Compress all particles toward center to create compressive strain
        for (const pt of sim.particles) {
          if (pt.pos) {
            pt.pos.x *= 0.5;
            pt.pos.y *= 0.5;
          }
        }
        const sr = sim.step(1);
        assert(sr.meanStrainPct >= 0 && sr.maxStrainPct >= 0, `Strain must clamp >= 0, got mean=${sr.meanStrainPct}, max=${sr.maxStrainPct}`);
        for (const pt of sim.particles) {
          assert(pt.strainPct >= 0 && Number.isFinite(pt.strainPct), `Particle strainPct must be >= 0, got ${pt.strainPct}`);
        }
      },
    },
    {
      id: 'T1-F20-5',
      tier: 1,
      feature: 'F20',
      name: 'Per-particle strainPct values are finite and drive tightParticleCount',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt');
        const res = core.runSimulationSteps(pat, { steps: 35 });

        assert(res.particles.length > 0, 'Expected particles');
        for (let i = 0; i < res.particles.length; i++) {
          const s = res.particles[i].strainPct;
          assert(typeof s === 'number' && Number.isFinite(s) && s >= 0, `Particle ${i} invalid strainPct: ${s}`);
        }
        assert(
          typeof res.strainReport.tightParticleCount === 'number' &&
          res.strainReport.tightParticleCount >= 0 &&
          res.strainReport.tightParticleCount <= res.particles.length,
          `Invalid tightParticleCount: ${res.strainReport.tightParticleCount}`
        );
      },
    },

    // ------------------------------------------------------------------------
    // F21: Substance 3D PBR Material Studio (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F21-1',
      tier: 1,
      feature: 'F21',
      name: 'MATERIAL_PRESETS exposes >= 7 presets spanning fabric, leather, and EVA foam',
      fn: async () => {
        const core = await loadCore();
        const presets = Array.isArray(core.MATERIAL_PRESETS)
          ? core.MATERIAL_PRESETS
          : Object.values(core.MATERIAL_PRESETS);
        assert(presets.length >= 7, `Expected >= 7 material presets, got ${presets.length}`);

        const text = presets.map((m) => `${m.id} ${m.name} ${m.category}`.toLowerCase()).join(' | ');
        assert(/jersey|fleece|denim|canvas|nylon/.test(text), 'Expected fabric presets');
        assert(/leather/.test(text), 'Expected leather preset');
        assert(/eva|foam/.test(text), 'Expected EVA foam preset');

        for (const m of presets) {
          assert(typeof m.gsm === 'number' && m.gsm > 0, `Preset ${m.id} invalid gsm`);
          assert(typeof m.thicknessMm === 'number' && m.thicknessMm > 0, `Preset ${m.id} invalid thicknessMm`);
        }
      },
    },
    {
      id: 'T1-F21-2',
      tier: 1,
      feature: 'F21',
      name: 'WEAVE_TYPES is exported and covers preset weave types',
      fn: async () => {
        const core = await loadCore();
        const weaves = Array.isArray(core.WEAVE_TYPES)
          ? core.WEAVE_TYPES
          : Object.keys(core.WEAVE_TYPES || {});
        assert(weaves.length >= 4, `Expected >= 4 WEAVE_TYPES, got ${weaves.length}`);
      },
    },
    {
      id: 'T1-F21-3',
      tier: 1,
      feature: 'F21',
      name: 'getMaterialConfig merges mutable overrides without mutating base preset',
      fn: async () => {
        const core = await loadCore();
        const base = core.getMaterialConfig('heavy_denim');
        const origGsm = base.gsm;
        const custom = core.getMaterialConfig('heavy_denim', {
          gsm: 520,
          thicknessMm: 2.2,
          roughness: 0.91,
          friction: 0.65,
        });

        assertNear(custom.gsm, 520, 1e-6, 'override gsm');
        assertNear(custom.thicknessMm, 2.2, 1e-6, 'override thicknessMm');
        assertNear(custom.roughness, 0.91, 1e-6, 'override roughness');
        assertNear(custom.friction, 0.65, 1e-6, 'override friction');

        const baseAfter = core.getMaterialConfig('heavy_denim');
        assertNear(baseAfter.gsm, origGsm, 1e-6, 'base preset must not be mutated');
      },
    },
    {
      id: 'T1-F21-4',
      tier: 1,
      feature: 'F21',
      name: 'generateProceduralPBRMaps generates 4 non-constant tileable maps (albedo, normal, roughness, ao)',
      fn: async () => {
        const core = await loadCore();
        const cfg = core.getMaterialConfig('heavy_denim');
        const maps = core.generateProceduralPBRMaps(cfg, 64);

        assert(maps && typeof maps === 'object', 'generateProceduralPBRMaps must return an object');
        const albedo = extractPixelBuffer(getPBRMapEntry(maps, ['albedo', 'albedoMap', 'baseColor', 'color']));
        const normal = extractPixelBuffer(getPBRMapEntry(maps, ['normal', 'normalMap', 'height', 'heightMap']));
        const roughness = extractPixelBuffer(getPBRMapEntry(maps, ['roughness', 'roughnessMap']));
        const ao = extractPixelBuffer(getPBRMapEntry(maps, ['ao', 'aoMap', 'ambientOcclusion']));

        assert(albedo, 'Missing albedo map');
        assert(normal, 'Missing normal/height map');
        assert(roughness, 'Missing roughness map');
        assert(ao, 'Missing ao map');

        for (const [label, buf] of [['albedo', albedo], ['normal', normal], ['roughness', roughness], ['ao', ao]]) {
          assert(buf.length === 64 * 64 * 4 || buf.length === 64 * 64, `${label} unexpected length ${buf.length}`);
          assertNonConstantBuffer(buf, label);
        }
      },
    },
    {
      id: 'T1-F21-5',
      tier: 1,
      feature: 'F21',
      name: 'generateProceduralWeaveSVG produces valid SVG swatch reflecting material colors',
      fn: async () => {
        const core = await loadCore();
        const cfg = core.getMaterialConfig('heavy_denim', { warpColor: '#123456', weftColor: '#abcdef' });
        const svg = core.generateProceduralWeaveSVG(cfg, 120);

        assert(typeof svg === 'string' && svg.includes('<svg') && svg.includes('</svg>'), 'Expected valid <svg> string');
        assert(/<(?:rect|path|line|polygon)\b/i.test(svg), 'Weave SVG must contain vector primitives');
        assert(svg.toLowerCase().includes('#123456') || svg.toLowerCase().includes('#abcdef'), 'Weave SVG should use material colors');
      },
    },

    // ------------------------------------------------------------------------
    // F22: True-Scale 1:1 SVG Exporter (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F22-1',
      tier: 1,
      feature: 'F22',
      name: 'exportSVG emits 1:1 millimeter root <svg width="...mm"> matching viewBox',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Panel', 200, 100, { seamAllowance: 0 });
        const pat = makeSimpleProject(core, [rect]);
        const svg = core.exportSVG(pat);

        assert(typeof svg === 'string' && svg.includes('<svg'), 'exportSVG must return SVG string');
        const report = await verifyExportWithPython('svg', svg, {
          checkScale1to1: true,
          requireCalibrationSquare: false,
        });
        assert(report.ok, 'Python SVG 1:1 scale check failed');
      },
    },
    {
      id: 'T1-F22-2',
      tier: 1,
      feature: 'F22',
      name: 'exportSVG includes measurable 50.0 +/- 0.1 mm calibration square',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Panel', 180, 120, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const svg = core.exportSVG(pat);

        const report = await verifyExportWithPython('svg', svg, {
          checkScale1to1: true,
          requireCalibrationSquare: true,
          calibSizeMm: 50.0,
          calibTolMm: 0.1,
        });
        assert(report.metrics.calib50Count >= 1, 'Expected >= 1 50mm calibration square in SVG');
      },
    },
    {
      id: 'T1-F22-3',
      tier: 1,
      feature: 'F22',
      name: 'exportSVG organizes contours into semantic <g> layers',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Panel', 160, 100, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const svg = core.exportSVG(pat);

        const report = await verifyExportWithPython('svg', svg, {
          requireCalibrationSquare: true,
          expectedLayers: ['cut', 'seam'],
        });
        assert(report.metrics.layerCount >= 2, `Expected >= 2 semantic SVG layers, got ${report.metrics.layerCount}`);
      },
    },
    {
      id: 'T1-F22-4',
      tier: 1,
      feature: 'F22',
      name: 'exportSVG preserves high-curvature > 250 mm cubic Bezier within <= 0.1 mm',
      fn: async () => {
        const core = await loadCore();
        const p0 = { x: 0, y: 0 };
        const p1 = { x: 300, y: 0 };
        const cp1 = { x: 80, y: -120 };
        const cp2 = { x: 220, y: 120 };
        const piece = core.createFreeformPiece('CurvedPanel', [
          p0,
          p1,
          { x: 300, y: 200 },
          { x: 0, y: 200 },
        ], { seamAllowance: 0 });
        piece.edges[0].curve = { cp1, cp2 };
        // Ensure piece stays cleanly positive in SVG page space
        const pat = makeSimpleProject(core, [piece]);
        const svg = core.exportSVG(pat);

        // Compute expected offset by finding the curved shape bbox in SVG or anchoring curve relative to top-left
        // verify_exports.py check_curve_fidelity checks distance from true curve points to extracted edges;
        // find SVG piece offset via bounding box match first or check via SVG <path> C command presence + relative sample
        const report = await verifyExportWithPython('svg', svg, {
          checkScale1to1: true,
          requireCalibrationSquare: true,
        });
        assert(report.ok, 'SVG failed basic validation');
        // Extract actual bounding box of curved piece by verifying width 300mm and height/perimeter match
        const outline = samplePieceOutlineIndependent(piece, 64);
        const ob = calcBounds(outline);
        const expPerim = polylinePerimeter(outline, true);
        const expArea = shoelaceArea(outline);
        const detailReport = await verifyExportWithPython('svg', svg, {
          expectedPieces: [{ widthMm: ob.width, heightMm: ob.height, areaMm2: expArea, perimeterMm: expPerim, tolMm: 0.1 }],
        });
        assert(detailReport.ok, 'Curved SVG piece dimensions failed 1:1 verification');
      },
    },
    {
      id: 'T1-F22-5',
      tier: 1,
      feature: 'F22',
      name: 'exportSVG preserves exact physical mm dimensions (<= 0.1 mm) including piece.rotation=90',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('RotatedPanel', 220, 140, { seamAllowance: 10, rotation: 90 });
        const pat = makeSimpleProject(core, [rect]);
        const svg = core.exportSVG(pat);

        // Net: 220x140 rotated 90 -> 140x220; Cut (SA=10): 160x240
        await verifyExportWithPython('svg', svg, {
          checkScale1to1: true,
          requireCalibrationSquare: true,
          expectedPieces: [
            { widthMm: 140, heightMm: 220, areaMm2: 220 * 140, perimeterMm: 720, tolMm: 0.1 },
            { widthMm: 160, heightMm: 240, areaMm2: 160 * 240, perimeterMm: 800, tolMm: 0.1 },
          ],
        });
      },
    },

    // ------------------------------------------------------------------------
    // F23: Multi-Page Tiled PDF 1.4 Exporter (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F23-1',
      tier: 1,
      feature: 'F23',
      name: 'exportTiledPDF emits valid %PDF-1.4 document passing Ghostscript and pdfinfo',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Panel', 150, 110, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const out = core.exportTiledPDF(pat, { pageFormat: 'LETTER' });
        const bytes = out.pdfBytes ?? Buffer.from(out.pdfString, 'latin1');

        const report = await verifyExportWithPython('pdf', bytes, {
          requirePdf14: true,
          pageFormat: 'LETTER',
          requireCalibrationSquare: true,
        });
        assert(report.metrics.pageCount >= 1, 'Expected >= 1 PDF page');
      },
    },
    {
      id: 'T1-F23-2',
      tier: 1,
      feature: 'F23',
      name: 'exportTiledPDF honors LETTER, A4, and A0 physical page sizes (+/- 0.5 pt)',
      fn: async () => {
        const core = await loadCore();
        assert(core.PAGE_FORMATS && core.PAGE_FORMATS.LETTER && core.PAGE_FORMATS.A4 && core.PAGE_FORMATS.A0, 'PAGE_FORMATS missing LETTER/A4/A0');
        const rect = core.createRectanglePiece('Panel', 140, 100, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);

        for (const fmt of ['LETTER', 'A4', 'A0']) {
          const out = core.exportTiledPDF(pat, { pageFormat: fmt });
          const bytes = out.pdfBytes ?? Buffer.from(out.pdfString, 'latin1');
          const report = await verifyExportWithPython('pdf', bytes, {
            pageFormat: fmt,
            requireCalibrationSquare: true,
          });
          assert(report.ok, `PDF check failed for ${fmt}`);
        }
      },
    },
    {
      id: 'T1-F23-3',
      tier: 1,
      feature: 'F23',
      name: 'exportTiledPDF includes measurable 50.0 +/- 0.1 mm calibration square on Page 1',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Panel', 130, 90, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const out = core.exportTiledPDF(pat, { pageFormat: 'A4' });
        const bytes = out.pdfBytes ?? Buffer.from(out.pdfString, 'latin1');

        const report = await verifyExportWithPython('pdf', bytes, {
          pageFormat: 'A4',
          requireCalibrationSquare: true,
          calibSizeMm: 50.0,
          calibTolMm: 0.1,
          checkPage1PieceBounds: true,
          expectedPieces: [{ widthMm: 130, heightMm: 90, tolMm: 0.1 }],
        });
        assert(report.metrics.page1Calib50Count >= 1, 'Page 1 missing 50mm calibration square');
      },
    },
    {
      id: 'T1-F23-4',
      tier: 1,
      feature: 'F23',
      name: 'Multi-page tiled PDF emits corner registration marks and tile grid labels',
      fn: async () => {
        const core = await loadCore();
        const bigPiece = core.createRectanglePiece('LargePanel', 500, 500, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [bigPiece]);
        const out = core.exportTiledPDF(pat, { pageFormat: 'LETTER', overlapMm: 12 });
        const bytes = out.pdfBytes ?? Buffer.from(out.pdfString, 'latin1');

        assert(out.pageCount >= 4, `Expected >= 4 tiles for 520x520mm on LETTER, got ${out.pageCount}`);
        const report = await verifyExportWithPython('pdf', bytes, {
          pageFormat: 'LETTER',
          minPages: 4,
          overlapMm: 12,
          requireCalibrationSquare: true,
          requireRegistrationMarks: true,
        });
        assert(report.metrics.regMarksFound >= 2, `Expected corner registration marks, found ${report.metrics.regMarksFound}`);
      },
    },
    {
      id: 'T1-F23-5',
      tier: 1,
      feature: 'F23',
      name: 'exportTiledPDF renders dashed seam lines, grainlines, and piece.internalLines',
      fn: async () => {
        const core = await loadCore();
        const basePiece = core.createRectanglePiece('PocketBody', 160, 180, { seamAllowance: 10 });
        const basePat = makeSimpleProject(core, [basePiece]);
        const baseOut = core.exportTiledPDF(basePat, { pageFormat: 'LETTER' });
        const baseBytes = baseOut.pdfBytes ?? Buffer.from(baseOut.pdfString, 'latin1');
        const baseReport = await verifyExportWithPython('pdf', baseBytes, {
          pageFormat: 'LETTER',
          requireCalibrationSquare: true,
        });

        const piece = core.createRectanglePiece('PocketBody', 160, 180, {
          seamAllowance: 10,
          internalLines: [
            { id: 'fold_1', type: 'fold', points: [{ x: 10, y: 90 }, { x: 150, y: 90 }], label: 'Fold' },
            { id: 'pocket_1', type: 'pocket', points: [{ x: 30, y: 40 }, { x: 130, y: 40 }], label: 'Pocket' },
          ],
        });
        const pat = makeSimpleProject(core, [piece]);
        const out = core.exportTiledPDF(pat, { pageFormat: 'LETTER' });
        const bytes = out.pdfBytes ?? Buffer.from(out.pdfString, 'latin1');

        const report = await verifyExportWithPython('pdf', bytes, {
          pageFormat: 'LETTER',
          requireCalibrationSquare: true,
          requireDashedLines: true,
          requireInternalLines: true,
        });
        assert(report.metrics.dashedFound, 'Expected dashed seam/internal lines in PDF');
        assert(
          report.metrics.internalLineCandidates >= baseReport.metrics.internalLineCandidates + 2,
          `Expected >= 2 additional vectors from piece.internalLines (base=${baseReport.metrics.internalLineCandidates}, withLines=${report.metrics.internalLineCandidates})`
        );
      },
    },

    // ------------------------------------------------------------------------
    // F24: True-Scale 1:1 CAD DXF Exporter (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F24-1',
      tier: 1,
      feature: 'F24',
      name: 'exportDXF sets $INSUNITS=4 (millimeters) and ends cleanly with EOF',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('DxfPanel', 180, 100, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const dxf = core.exportDXF(pat);

        assert(typeof dxf === 'string' && dxf.includes('SECTION') && dxf.includes('EOF'), 'Expected valid ASCII DXF');
        const report = await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireTablesLayer: true,
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
        });
        assert(report.metrics.insunits === 4, `Expected $INSUNITS=4, got ${report.metrics.insunits}`);
      },
    },
    {
      id: 'T1-F24-2',
      tier: 1,
      feature: 'F24',
      name: 'exportDXF includes TABLES / LAYER definitions for cut and seam layers',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('DxfLayers', 150, 120, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const dxf = core.exportDXF(pat);

        const report = await verifyExportWithPython('dxf', dxf, {
          requireTablesLayer: true,
          expectedLayers: ['CUT', 'SEAM'],
        });
        assert(Array.isArray(report.metrics.layers) && report.metrics.layers.length >= 2, `Expected >= 2 DXF layers, got ${JSON.stringify(report.metrics.layers)}`);
      },
    },
    {
      id: 'T1-F24-3',
      tier: 1,
      feature: 'F24',
      name: 'exportDXF emits closed LWPOLYLINE (flag 70 & 1) contours',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('LwPoly', 160, 100, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const dxf = core.exportDXF(pat);

        const report = await verifyExportWithPython('dxf', dxf, {
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
        });
        assert(report.metrics.closedLwpolylineCount >= 3, `Expected >= 3 closed LWPOLYLINEs (cut+seam+calib), got ${report.metrics.closedLwpolylineCount}`);
      },
    },
    {
      id: 'T1-F24-4',
      tier: 1,
      feature: 'F24',
      name: 'exportDXF includes measurable 50.0 +/- 0.1 mm calibration square',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('CalibDxf', 140, 90, { seamAllowance: 0 });
        const pat = makeSimpleProject(core, [rect]);
        const dxf = core.exportDXF(pat);

        const report = await verifyExportWithPython('dxf', dxf, {
          requireCalibrationSquare: true,
          calibSizeMm: 50.0,
          calibTolMm: 0.1,
        });
        assert(report.metrics.calib50Count >= 1, 'Missing 50mm calibration square in DXF');
      },
    },
    {
      id: 'T1-F24-5',
      tier: 1,
      feature: 'F24',
      name: 'exportDXF preserves exact piece net and cut millimeter dimensions (<= 0.1 mm)',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('ExactDxf', 200, 120, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [rect]);
        const dxf = core.exportDXF(pat);

        await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
          expectedPieces: [
            { widthMm: 200, heightMm: 120, areaMm2: 24000, perimeterMm: 640, tolMm: 0.1 },
            { widthMm: 220, heightMm: 140, areaMm2: 30800, perimeterMm: 720, tolMm: 0.1 },
          ],
        });
      },
    },

    // ------------------------------------------------------------------------
    // F25: Fabric Roll Nesting & Yield BOM (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F25-1',
      tier: 1,
      feature: 'F25',
      name: 'FABRIC_ROLL_PRESETS provides >= 4 roll/mat presets in millimeters',
      fn: async () => {
        const core = await loadCore();
        const rolls = Array.isArray(core.FABRIC_ROLL_PRESETS)
          ? core.FABRIC_ROLL_PRESETS
          : Object.values(core.FABRIC_ROLL_PRESETS || {});
        assert(rolls.length >= 4, `Expected >= 4 FABRIC_ROLL_PRESETS, got ${rolls.length}`);
        for (const r of rolls) {
          const w = r.widthMm ?? r.fabricWidthMm;
          assert(typeof w === 'number' && w >= 500 && w <= 3000, `Invalid roll widthMm: ${w}`);
        }
      },
    },
    {
      id: 'T1-F25-2',
      tier: 1,
      feature: 'F25',
      name: 'nestPatternPieces packs all pieces inside roll width with positive yield metrics',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('tshirt');
        const rollWidth = 1143; // 45 in
        const nest = core.nestPatternPieces(pat, { fabricWidthMm: rollWidth, marginMm: 10, spacingMm: 10 });

        assert(nest.fabricWidthMm === rollWidth, `Expected fabricWidthMm=${rollWidth}, got ${nest.fabricWidthMm}`);
        assert(nest.requiredLengthMm > 0 && nest.requiredMeters > 0 && nest.requiredYards > 0, 'Yield lengths must be > 0');
        assert(Array.isArray(nest.placements) && nest.placements.length >= pat.pieces.length, 'Missing placements');

        for (const pl of nest.placements) {
          const x = pl.x ?? pl.minX ?? 0;
          const y = pl.y ?? pl.minY ?? 0;
          const w = pl.width ?? pl.widthMm ?? pl.w;
          const h = pl.height ?? pl.heightMm ?? pl.h;
          assert(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0, `Placement missing finite positive dimensions: ${JSON.stringify(pl)}`);
          assert(x >= -1e-6 && x + w <= rollWidth + 1e-6, `Placement ${pl.pieceName || pl.pieceId} exceeds roll width: [${x}, ${x + w}]`);
          assert(y >= -1e-6 && y + h <= nest.requiredLengthMm + 1e-3, `Placement exceeds requiredLengthMm`);
        }
      },
    },
    {
      id: 'T1-F25-3',
      tier: 1,
      feature: 'F25',
      name: 'nestPatternPieces emits zero overlapping placement bounding boxes',
      fn: async () => {
        const core = await loadCore();
        const pat = core.generateTemplatePattern('hoodie');
        const nest = core.nestPatternPieces(pat, { fabricWidthMm: 1372, marginMm: 10, spacingMm: 8 });

        const boxes = nest.placements.map((pl) => {
          const x = pl.x ?? pl.minX ?? 0;
          const y = pl.y ?? pl.minY ?? 0;
          const w = pl.width ?? pl.widthMm ?? pl.w;
          const h = pl.height ?? pl.heightMm ?? pl.h;
          assert(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0, `Placement missing finite positive dimensions: ${JSON.stringify(pl)}`);
          return { id: pl.pieceName || pl.pieceId, x0: x, y0: y, x1: x + w, y1: y + h };
        });
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
            const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
            assert(
              overlapX <= 1e-4 || overlapY <= 1e-4,
              `Placements ${a.id} and ${b.id} overlap by ${overlapX.toFixed(2)}x${overlapY.toFixed(2)}mm`
            );
          }
        }
      },
    },
    {
      id: 'T1-F25-4',
      tier: 1,
      feature: 'F25',
      name: 'nestPatternPieces reports valid utilizationPct (0..100) and BOM area/perimeter totals',
      fn: async () => {
        const core = await loadCore();
        const p1 = core.createRectanglePiece('P1', 300, 200, { seamAllowance: 10 });
        const p2 = core.createRectanglePiece('P2', 300, 200, { seamAllowance: 10 });
        const pat = makeSimpleProject(core, [p1, p2]);
        const nest = core.nestPatternPieces(pat, { fabricWidthMm: 914, marginMm: 10, spacingMm: 10 });

        assert(nest.utilizationPct > 0 && nest.utilizationPct <= 100, `Invalid utilizationPct: ${nest.utilizationPct}`);
        if (typeof nest.wastePct === 'number') {
          assertNear(nest.utilizationPct + nest.wastePct, 100, 0.5, 'utilization + waste = 100%');
        }
        assertNear(nest.totalNetAreaMm2, 2 * 300 * 200, 5, 'totalNetAreaMm2');
        assertNear(nest.totalCutAreaMm2, 2 * 320 * 220, 5, 'totalCutAreaMm2');
        assert(nest.totalCutPerimeterMm > nest.totalSewPerimeterMm, 'Cut perimeter must exceed sew perimeter');
      },
    },
    {
      id: 'T1-F25-5',
      tier: 1,
      feature: 'F25',
      name: 'nestPatternPieces honors piece.quantity=2 and allowRotate90 packing',
      fn: async () => {
        const core = await loadCore();
        const pPair = core.createRectanglePiece('CutTwo', 200, 300, { seamAllowance: 10, quantity: 2 });
        const pat = makeSimpleProject(core, [pPair]);
        const nest = core.nestPatternPieces(pat, { fabricWidthMm: 1000, marginMm: 10, spacingMm: 10, allowRotate90: true });

        assert(nest.placements.length === 2, `Expected 2 placements for quantity=2, got ${nest.placements.length}`);
        assertNear(nest.totalNetAreaMm2, 2 * 200 * 300, 5, 'quantity=2 net area');

        const pWide = core.createRectanglePiece('CutTwoWide', 700, 200, { seamAllowance: 10, quantity: 2 });
        const widePat = makeSimpleProject(core, [pWide]);
        const rotNest = core.nestPatternPieces(widePat, { fabricWidthMm: 600, marginMm: 10, spacingMm: 10, allowRotate90: true });
        assert(rotNest.placements.length === 2, `Expected 2 rotated placements, got ${rotNest.placements.length}`);
        for (const pl of rotNest.placements) {
          const x = pl.x ?? pl.minX ?? 0;
          const w = pl.width ?? pl.widthMm ?? pl.w;
          const h = pl.height ?? pl.heightMm ?? pl.h;
          assert(Math.abs(w - 220) <= 0.1 && Math.abs(h - 720) <= 0.1, `Expected 90° rotated 220x720 cut box, got ${w}x${h}`);
          assert(x >= -1e-6 && x + w <= 600 + 1e-3, `Rotated placement exceeds 600mm width: [${x}, ${x + w}]`);
        }
      },
    },

    // ------------------------------------------------------------------------
    // F26: Responsive Web Studio & WebGL2 3D (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F26-1',
      tier: 1,
      feature: 'F26',
      name: 'GET / serves 200 text/html studio shell with canvases and module entrypoint',
      fn: async () => {
        const srv = await startTestServer();
        try {
          const res = await srv.fetchText('/');
          assert(res.status === 200, `Expected 200, got ${res.status}`);
          const ct = res.headers.get('content-type') || '';
          assert(/text\/html/i.test(ct), `Expected text/html, got ${ct}`);
          assert(/<canvas\b/i.test(res.text), 'HTML missing <canvas> element');
          assert(/app\.mjs/i.test(res.text), 'HTML missing app.mjs module script');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T1-F26-2',
      tier: 1,
      feature: 'F26',
      name: 'Static frontend assets (cad2d.mjs, webgl3d.mjs, app.mjs, styles.css) return 200 with proper MIME',
      fn: async () => {
        const srv = await startTestServer();
        try {
          for (const asset of ['cad2d.mjs', 'webgl3d.mjs', 'app.mjs']) {
            const res = await srv.fetchText(`/${asset}`);
            assert(res.status === 200, `GET /${asset} returned ${res.status}`);
            const ct = res.headers.get('content-type') || '';
            assert(/javascript/i.test(ct), `/${asset} expected JS MIME, got ${ct}`);
            assert(res.text.trim().length > 100, `/${asset} body unexpectedly small`);
          }
          const css = await srv.fetchText('/styles.css');
          assert(css.status === 200, `GET /styles.css returned ${css.status}`);
          assert(/text\/css/i.test(css.headers.get('content-type') || ''), 'Expected text/css');
          assert(css.text.trim().length > 100, 'styles.css unexpectedly small');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T1-F26-3',
      tier: 1,
      feature: 'F26',
      name: 'Server serves isomorphic /src/core/index.mjs and core modules with 200 JS MIME',
      fn: async () => {
        const srv = await startTestServer();
        try {
          for (const modPath of ['/src/core/index.mjs', '/src/core/types.mjs', '/src/core/geometry.mjs', '/src/core/stl.mjs']) {
            const res = await srv.fetchText(modPath);
            assert(res.status === 200, `GET ${modPath} returned ${res.status}`);
            assert(/javascript/i.test(res.headers.get('content-type') || ''), `${modPath} expected JS MIME`);
            assert(res.text.includes('export '), `${modPath} missing ESM exports`);
          }
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T1-F26-4',
      tier: 1,
      feature: 'F26',
      name: 'Frontend ESM modules pass node --check and webgl3d.mjs defines valid WebGL2 GLSL 300 es shaders',
      fn: async () => {
        const publicDir = path.join(V2_ROOT, 'public');
        for (const f of ['cad2d.mjs', 'webgl3d.mjs', 'app.mjs']) {
          const full = path.join(publicDir, f);
          assert(fs.existsSync(full), `Missing frontend file: ${full}`);
          await runNodeCheck(full);
        }
        const glSrc = await fsp.readFile(path.join(publicDir, 'webgl3d.mjs'), 'utf8');
        assert(/webgl2/i.test(glSrc), 'webgl3d.mjs must target WebGL2');
        assert(/#version\s+300\s+es/.test(glSrc), 'webgl3d.mjs must contain GLSL #version 300 es shaders');
        assert(/gl_Position\s*=/.test(glSrc) && /void\s+main\s*\(/.test(glSrc), 'webgl3d.mjs missing vertex/fragment main/gl_Position');
      },
    },
    {
      id: 'T1-F26-5',
      tier: 1,
      feature: 'F26',
      name: 'styles.css includes responsive @media breakpoints for tablet/mobile viewports',
      fn: async () => {
        const cssPath = path.join(V2_ROOT, 'public', 'styles.css');
        assert(fs.existsSync(cssPath), `Missing ${cssPath}`);
        const css = await fsp.readFile(cssPath, 'utf8');
        const mediaMatches = css.match(/@media\s*\([^)]*(?:max-width|min-width)[^)]*\)/gi) || [];
        assert(mediaMatches.length >= 1, 'styles.css must define responsive @media width breakpoints');
        assert(/display\s*:\s*(?:grid|flex)/i.test(css), 'styles.css must use CSS Grid or Flexbox layout');
      },
    },

    // ------------------------------------------------------------------------
    // F27: Server, CLI & Isolation (5 cases)
    // ------------------------------------------------------------------------
    {
      id: 'T1-F27-1',
      tier: 1,
      feature: 'F27',
      name: 'Server startup prints local 127.0.0.1, remote hostname, and ssh -L tunnel command',
      fn: async () => {
        const srv = await startTestServer({ host: '0.0.0.0', port: 0 });
        try {
          const out = srv.getStdout();
          const p = srv.port;
          const expectedHost = os.hostname() || 'localhost';
          const escHost = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          assert(out.includes(`http://127.0.0.1:${p}`), `Startup stdout missing Local URL 127.0.0.1:${p}:\n${out}`);
          assert(
            out.includes(`${expectedHost}:${p}`),
            `Startup stdout missing Remote URL ${expectedHost}:${p}:\n${out}`
          );
          assert(
            new RegExp(`ssh\\s+-L\\s+${p}:(?:localhost|127\\.0\\.0\\.1):${p}\\s+${escHost}`).test(out),
            `Startup stdout missing ssh -L tunnel command:\n${out}`
          );
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T1-F27-2',
      tier: 1,
      feature: 'F27',
      name: 'GET /api/health and GET /api/catalog return complete v2 metadata',
      fn: async () => {
        const srv = await startTestServer();
        try {
          const health = await srv.fetchJson('/api/health');
          assert(health.status === 200 && health.data?.ok === true, `Unexpected /api/health: ${health.status} ${health.text}`);
          assert(health.data.port === srv.port, `Health port ${health.data.port} != ${srv.port}`);

          const cat = await srv.fetchJson('/api/catalog');
          assert(cat.status === 200, `/api/catalog returned ${cat.status}`);
          const d = cat.data;
          assert(Array.isArray(d.templates) && d.templates.length === 5, `Expected 5 catalog templates, got ${d.templates?.length}`);
          const mats = Array.isArray(d.materials) ? d.materials : Object.values(d.materials || {});
          assert(mats.length >= 7, `Expected >= 7 catalog materials, got ${mats.length}`);
          const rolls = d.rolls || d.fabricRolls || [];
          assert(rolls.length >= 4, `Expected >= 4 catalog rolls, got ${rolls.length}`);
          assert(d.pageFormats || d.pdfFormats, 'Catalog missing pageFormats');
          assert(d.defaultAvatar, 'Catalog missing defaultAvatar');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T1-F27-3',
      tier: 1,
      feature: 'F27',
      name: 'GET /api/workspace-stls and /api/stl-content serve wedge STLs and block traversal',
      fn: async () => {
        const srv = await startTestServer();
        try {
          const listRes = await srv.fetchJson('/api/workspace-stls');
          assert(listRes.status === 200, `/api/workspace-stls returned ${listRes.status}`);
          const files = (listRes.data?.files || []).map((f) => (typeof f === 'string' ? f : f.name || f.file || ''));
          assert(
            files.some((f) => f.includes('cutting_mat_wedge_assembled_view.stl')),
            `Expected cutting_mat_wedge_assembled_view.stl in workspace-stls, got ${JSON.stringify(files)}`
          );

          const stlRes = await srv.fetchText('/api/stl-content?file=cutting_mat_wedge_assembled_view.stl');
          assert(stlRes.status === 200, `/api/stl-content returned ${stlRes.status}`);
          const parsed = parseAsciiSTLIndependent(stlRes.text);
          assert(parsed.triangleCount === 984, `Expected 984 tris from /api/stl-content, got ${parsed.triangleCount}`);

          const travRes = await srv.fetchJson('/api/stl-content?file=../../etc/passwd');
          assert(travRes.status === 404 || travRes.status === 400 || travRes.status === 403, `Path traversal must fail, got ${travRes.status}`);
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T1-F27-4',
      tier: 1,
      feature: 'F27',
      name: 'CLI template, unwrap, and verify-sim subcommands succeed and emit verified exports',
      fn: async () => {
        await withTempDir(async (tmpDir) => {
          const tplOut = path.join(tmpDir, 'tpl_out');
          const r1 = await runCli([
            'template',
            '--type', 'tote_bag',
            '--out', tplOut,
            '--format', 'svg,pdf,dxf,json',
            '--page', 'LETTER',
          ]);
          assert(r1.code === 0, `CLI template failed (${r1.code}):\n${r1.stderr}\n${r1.stdout}`);

          const tplFiles = await fsp.readdir(tplOut);
          const svgFile = tplFiles.find((f) => f.endsWith('.svg'));
          const pdfFile = tplFiles.find((f) => f.endsWith('.pdf'));
          const dxfFile = tplFiles.find((f) => f.endsWith('.dxf'));
          const jsonFile = tplFiles.find((f) => f.endsWith('.json'));
          assert(svgFile && pdfFile && dxfFile && jsonFile, `CLI template missing expected exports in ${JSON.stringify(tplFiles)}`);

          await verifyExportWithPython('svg', await fsp.readFile(path.join(tplOut, svgFile), 'utf8'), { requireCalibrationSquare: true });
          await verifyExportWithPython('pdf', await fsp.readFile(path.join(tplOut, pdfFile)), { pageFormat: 'LETTER', requireCalibrationSquare: true });
          await verifyExportWithPython('dxf', await fsp.readFile(path.join(tplOut, dxfFile), 'utf8'), { requireCalibrationSquare: true });

          const unwrapOut = path.join(tmpDir, 'unwrap_out');
          const r2 = await runCli([
            'unwrap',
            '--stl', WEDGE_ASSEMBLED_STL,
            '--mode', 'form_shell_cover',
            '--ease', '4',
            '--sa', '10',
            '--out', unwrapOut,
            '--format', 'svg,dxf',
          ]);
          assert(r2.code === 0, `CLI unwrap failed (${r2.code}):\n${r2.stderr}\n${r2.stdout}`);
          const unwrapFiles = await fsp.readdir(unwrapOut);
          const unwrapSvg = unwrapFiles.find((f) => f.endsWith('.svg'));
          const unwrapDxf = unwrapFiles.find((f) => f.endsWith('.dxf'));
          assert(unwrapSvg && unwrapDxf, 'CLI unwrap missing SVG/DXF');
          await verifyExportWithPython('svg', await fsp.readFile(path.join(unwrapOut, unwrapSvg), 'utf8'), { requireCalibrationSquare: true });
          await verifyExportWithPython('dxf', await fsp.readFile(path.join(unwrapOut, unwrapDxf), 'utf8'), { requireInsUnits4: true, requireCalibrationSquare: true });

          const r3 = await runCli(['verify-sim', '--template', 'tshirt', '--material', 'cotton_jersey', '--steps', '40']);
          assert(r3.code === 0, `CLI verify-sim failed (${r3.code}):\n${r3.stderr}\n${r3.stdout}`);
        });
      },
    },
    {
      id: 'T1-F27-5',
      tier: 1,
      feature: 'F27',
      name: 'pattern_studio/ baseline isolation verified (16 files match exact SHA-256 manifest)',
      fn: async () => {
        const res = await verifyPatternStudioIsolation();
        assert(res.ok && res.checkedCount === 16, `Expected 16 verified v1 files, got ${res.checkedCount}`);
      },
    },
  ];
}
