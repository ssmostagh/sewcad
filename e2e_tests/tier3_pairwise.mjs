import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  WEDGE_ASSEMBLED_STL,
  WEDGE_PRINT_READY_STL,
  assert,
  assertNear,
  buildSeamConnectivity,
  calcBounds,
  convexHull2DIndependent,
  countSelfIntersections,
  dist2DIndependent,
  loadCore,
  parseAsciiSTLIndependent,
  pointToTriangleDist3D,
  polylinePerimeter,
  runCli,
  sampleCubicArcLengthIndependent,
  samplePieceOutlineIndependent,
  shoelaceArea,
  shoelaceSignedArea,
  startTestServer,
  verifyExportWithPython,
  withTempDir,
} from './helpers.mjs';

function extractPts(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.points)) return res.points;
  return [];
}

function getParticlePos(p) {
  if (p?.pos) return { x: Number(p.pos.x), y: Number(p.pos.y), z: Number(p.pos.z) };
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]) };
  return { x: Number(p?.x), y: Number(p?.y), z: Number(p?.z) };
}

function getRollList(presets) {
  return Array.isArray(presets) ? presets : Object.values(presets || {});
}

function getRollWidthMm(roll) {
  return Number(roll?.widthMm ?? roll?.fabricWidthMm ?? roll?.width ?? 0);
}

function assertNoOverlappingPlacements(placements, rollWidthMm) {
  const boxes = placements.map((pl) => {
    const x = Number(pl.x ?? pl.minX ?? 0);
    const y = Number(pl.y ?? pl.minY ?? 0);
    const w = Number(pl.width ?? pl.widthMm ?? pl.w ?? (pl.maxX !== undefined ? pl.maxX - x : 0));
    const h = Number(pl.height ?? pl.heightMm ?? pl.h ?? (pl.maxY !== undefined ? pl.maxY - y : 0));
    assert(Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0, `Invalid placement bbox: ${JSON.stringify(pl)}`);
    assert(x >= -0.1 && x + w <= rollWidthMm + 0.1, `Placement exceeds roll width ${rollWidthMm}mm: x=${x}, w=${w}`);
    return { x, y, w, h };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert(!(overlapX > 0.05 && overlapY > 0.05), `Overlapping placements: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
}

function checkEulerAndTJunctions(mesh, expectedAreaMm2) {
  const verts = mesh.vertices || [];
  const tris = mesh.triangles || [];
  assert(verts.length >= 3 && tris.length >= 1, 'Mesh must have >=3 vertices and >=1 triangle');

  const usedVerts = new Set();
  const edgeSet = new Set();
  let triAreaSum = 0;

  for (const tri of tris) {
    const i0 = tri[0], i1 = tri[1], i2 = tri[2];
    usedVerts.add(i0);
    usedVerts.add(i1);
    usedVerts.add(i2);
    const pairs = [[i0, i1], [i1, i2], [i2, i0]];
    for (const [u, v] of pairs) {
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      edgeSet.add(`${a}:${b}`);
    }
    const p0 = verts[i0], p1 = verts[i1], p2 = verts[i2];
    const area = 0.5 * Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y));
    assert(area > 1e-6, 'Degenerate zero-area triangle in cloth mesh');
    triAreaSum += area;
  }

  const V = usedVerts.size;
  const E = edgeSet.size;
  const F = tris.length;
  assert(V - E + F === 1, `Expected Euler characteristic V-E+F=1, got V=${V}, E=${E}, F=${F} (chi=${V - E + F})`);

  if (expectedAreaMm2 !== undefined) {
    const relErr = Math.abs(triAreaSum - expectedAreaMm2) / Math.max(1, expectedAreaMm2);
    assert(relErr <= 0.02, `Triangulated area ${triAreaSum.toFixed(2)} differs from outline area ${expectedAreaMm2.toFixed(2)}`);
  }

  // Zero T-junction check: no mesh vertex may lie strictly on the interior of any edge it is not an endpoint of
  for (const key of edgeSet) {
    const [aStr, bStr] = key.split(':');
    const aIdx = Number(aStr), bIdx = Number(bStr);
    const a = verts[aIdx], b = verts[bIdx];
    const abLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (abLen < 1e-6) continue;
    for (const vIdx of usedVerts) {
      if (vIdx === aIdx || vIdx === bIdx) continue;
      const p = verts[vIdx];
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (abLen * abLen);
      if (t > 1e-4 && t < 1 - 1e-4) {
        const projX = a.x + t * (b.x - a.x);
        const projY = a.y + t * (b.y - a.y);
        const perp = Math.hypot(p.x - projX, p.y - projY);
        assert(perp > 1e-3, `T-junction detected: vertex ${vIdx} lies on edge (${aIdx},${bIdx})`);
      }
    }
  }
}

function minParticleDistToTriangles(particles, indTriangles, stlBounds) {
  if (!particles.length || !indTriangles.length) return 0;
  let sumX = 0, sumY = 0, sumZ = 0;
  for (const p of particles) {
    const pos = getParticlePos(p);
    sumX += pos.x;
    sumY += pos.y;
    sumZ += pos.z;
  }
  const pMean = { x: sumX / particles.length, y: sumY / particles.length, z: sumZ / particles.length };
  const c = {
    x: 0.5 * (stlBounds.min.x + stlBounds.max.x),
    y: 0.5 * (stlBounds.min.y + stlBounds.max.y),
    z: 0.5 * (stlBounds.min.z + stlBounds.max.z),
  };
  const dOrigin = Math.hypot(pMean.x, pMean.y, pMean.z);
  const dCenter = Math.hypot(pMean.x - c.x, pMean.y - c.y, pMean.z - c.z);
  const shift = dOrigin < dCenter ? c : { x: 0, y: 0, z: 0 };

  const shiftedTris = indTriangles.map(([a, b, tC]) => [
    { x: a.x - shift.x, y: a.y - shift.y, z: a.z - shift.z },
    { x: b.x - shift.x, y: b.y - shift.y, z: b.z - shift.z },
    { x: tC.x - shift.x, y: tC.y - shift.y, z: tC.z - shift.z },
  ]);

  let globalMin = Infinity;
  for (const p of particles) {
    const pos = getParticlePos(p);
    let best = Infinity;
    for (let i = 0; i < shiftedTris.length; i++) {
      const tri = shiftedTris[i];
      const d = pointToTriangleDist3D(pos, tri[0], tri[1], tri[2]);
      if (d < best) best = d;
    }
    if (best < globalMin) globalMin = best;
  }
  return globalMin;
}

export function getTests() {
  return [
    {
      id: 'T3-01',
      tier: 3,
      feature: 'F01+F02+F22',
      features: ['F01', 'F02', 'F22'],
      name: 'Pairwise: T-shirt block schema -> 1:1 SVG export <= 0.1 mm',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern('tshirt', { chestMm: 1020, seamAllowance: 10 });
        assert(pattern.unit === 'mm', `Expected unit='mm', got ${pattern.unit}`);
        assert(pattern.pieces.length >= 5, `Expected >=5 tshirt pieces, got ${pattern.pieces.length}`);
        assert(buildSeamConnectivity(pattern).isFullyConnected, 'T-shirt seam graph must be connected');

        const front = pattern.pieces.find((p) => /front/i.test(p.name) || /front/i.test(p.role));
        assert(front, 'Missing front bodice piece on tshirt');
        const cutPts = extractPts(core.computePieceCutBoundary(front));
        assert(countSelfIntersections(cutPts) === 0, 'Front bodice cut boundary self-intersects');
        const cutB = calcBounds(cutPts);

        const svg = core.exportSVG(pattern);
        const report = await verifyExportWithPython('svg', svg, {
          checkScale1to1: true,
          requireCalibrationSquare: true,
          require2InCalibrationSquare: true,
          expectedPieces: [{ widthMm: cutB.width, heightMm: cutB.height, tolMm: 0.1 }],
        });
        assert(report.ok, 'T3-01 SVG verification failed');
      },
    },
    {
      id: 'T3-02',
      tier: 3,
      feature: 'F03+F23',
      features: ['F03', 'F23'],
      name: 'Pairwise: Hoodie block -> LETTER tiled PDF with internalLines & registration marks',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern('hoodie', {}, { materialId: 'heavy_fleece' });
        assert(pattern.pieces.length >= 8, `Expected >=8 hoodie pieces, got ${pattern.pieces.length}`);
        assert(
          pattern.pieces.some((p) => Array.isArray(p.internalLines) && p.internalLines.length > 0),
          'Hoodie must include internalLines (pocket placement / fold guides)'
        );

        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'LETTER' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
        const report = await verifyExportWithPython('pdf', pdfBytes, {
          pageFormat: 'LETTER',
          minPages: 2,
          requireCalibrationSquare: true,
          requireRegistrationMarks: true,
          requireInternalLines: true,
        });
        assert(report.ok, 'T3-02 PDF verification failed');
      },
    },
    {
      id: 'T3-03',
      tier: 3,
      feature: 'F04+F10+F24',
      features: ['F04', 'F10', 'F24'],
      name: 'Pairwise: Pants waist dart fold/truing -> CAD DXF closed LWPOLYLINE',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern('pants', { waistMm: 820, hipMm: 1000 });
        const leg = pattern.pieces.find((p) => Array.isArray(p.darts) && p.darts.length > 0);
        assert(leg, 'Expected at least one pants piece with waist darts');
        const dartRef = leg.darts[0].id ?? 0;
        const folded = core.toggleDartFold(leg, dartRef) || leg;
        if (folded !== leg) {
          const idx = pattern.pieces.indexOf(leg);
          pattern.pieces[idx] = folded;
        }
        const cutPts = extractPts(core.computePieceCutBoundary(folded));
        assert(countSelfIntersections(cutPts) === 0, 'Folded pants piece cut boundary self-intersects');
        const cutB = calcBounds(cutPts);
        const cutArea = shoelaceArea(cutPts);

        const dxf = core.exportDXF(pattern);
        const report = await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireTablesLayer: true,
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
          expectedPieces: [{ widthMm: cutB.width, heightMm: cutB.height, areaMm2: cutArea, tolMm: 0.1 }],
        });
        assert(report.ok, 'T3-03 DXF verification failed');
      },
    },
    {
      id: 'T3-04',
      tier: 3,
      feature: 'F05+F25',
      features: ['F05', 'F25'],
      name: 'Pairwise: Tote bag (Cut-2 straps/gussets) -> 45" & 54" fabric roll nesting yield',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern('tote_bag', { widthMm: 380, heightMm: 400, gussetDepthMm: 100 });
        const totalQty = pattern.pieces.reduce((s, p) => s + (Number(p.quantity) || 1), 0);
        assert(totalQty >= 6, `Expected >=6 total cut pieces for tote bag, got ${totalQty}`);

        const rolls = getRollList(core.FABRIC_ROLL_PRESETS);
        const r45 = rolls.find((r) => /45/.test(String(r.id || r.name)) || Math.abs(getRollWidthMm(r) - 1143) < 10) || rolls[0];
        const r54 = rolls.find((r) => /54/.test(String(r.id || r.name)) || Math.abs(getRollWidthMm(r) - 1372) < 10) || rolls[1];

        const nest45 = core.nestPatternPieces(pattern, { fabricWidthMm: getRollWidthMm(r45), allowRotate90: true });
        const nest54 = core.nestPatternPieces(pattern, { fabricWidthMm: getRollWidthMm(r54), allowRotate90: true });

        assert(nest45.placements.length >= totalQty, `45" placements ${nest45.placements.length} < ${totalQty}`);
        assert(nest54.placements.length >= totalQty, `54" placements ${nest54.placements.length} < ${totalQty}`);
        assertNoOverlappingPlacements(nest45.placements, getRollWidthMm(r45));
        assertNoOverlappingPlacements(nest54.placements, getRollWidthMm(r54));
        assert(nest45.utilizationPct > 0 && nest45.utilizationPct <= 100, 'Invalid 45" utilizationPct');
        assert(nest54.utilizationPct > 0 && nest54.utilizationPct <= 100, 'Invalid 54" utilizationPct');
        assert(nest54.requiredLengthMm <= nest45.requiredLengthMm + 1e-3, 'Wider 54" roll should require <= linear length than 45"');
      },
    },
    {
      id: 'T3-05',
      tier: 3,
      feature: 'F07+F08+F09',
      features: ['F07', 'F08', 'F09'],
      name: 'Pairwise: Freeform rect -> De Casteljau Bezier split -> per-edge stepped collinear SA [0,12]',
      fn: async () => {
        const core = await loadCore();
        let piece = core.createRectanglePiece('Panel', 200, 160, { seamAllowance: 10 });
        piece.edges[0].curve = { cp1: { x: 60, y: -45 }, cp2: { x: 140, y: -45 } };

        const origLen = sampleCubicArcLengthIndependent(
          piece.points[0],
          piece.edges[0].curve.cp1,
          piece.edges[0].curve.cp2,
          piece.points[1],
          128
        );
        piece = core.splitPieceEdge(piece, 0, 0.5) || piece;
        assert(piece.points.length === 5, `Expected 5 points after edge split, got ${piece.points.length}`);

        const lenA = sampleCubicArcLengthIndependent(
          piece.points[0],
          piece.edges[0]?.curve?.cp1 || piece.edges[0]?.curve?.cp,
          piece.edges[0]?.curve?.cp2,
          piece.points[1],
          128
        );
        const lenB = sampleCubicArcLengthIndependent(
          piece.points[1],
          piece.edges[1]?.curve?.cp1 || piece.edges[1]?.curve?.cp,
          piece.edges[1]?.curve?.cp2,
          piece.points[2],
          128
        );
        assertNear(lenA + lenB, origLen, 0.05, 'Split Bezier arc length drift');

        // Split bottom straight edge (now edge 3: [200,160]->[0,160]) with stepped collinear SA [0, 12]
        piece = core.splitPieceEdge(piece, 3, 0.5) || piece;
        piece.edges[3].seamAllowance = 0;
        piece.edges[4].seamAllowance = 12;

        const netPts = samplePieceOutlineIndependent(piece, 24);
        const cutPts = extractPts(core.computePieceCutBoundary(piece));
        assert(countSelfIntersections(cutPts) === 0, 'Stepped collinear SA cut boundary self-intersects');
        assert(shoelaceArea(cutPts) > shoelaceArea(netPts), 'Cut area must exceed net area');

        // Check perpendicular step near x=100, y in [160, 172]
        const stepVertices = cutPts.filter((p) => Math.abs(p.x - 100) < 1.0 && p.y >= 159.5 && p.y <= 172.5);
        assert(stepVertices.length >= 2, `Expected perpendicular step vertices near (100,160..172), found ${stepVertices.length}`);
      },
    },
    {
      id: 'T3-06',
      tier: 3,
      feature: 'F08+F11+F12',
      features: ['F08', 'F11', 'F12'],
      name: 'Pairwise: Curved edge + alignment notches -> mirror across edge preserves CCW & notches',
      fn: async () => {
        const core = await loadCore();
        let piece = core.createFreeformPiece(
          'HalfBodice',
          [
            { x: 0, y: 0 },
            { x: 120, y: 0 },
            { x: 100, y: 150 },
            { x: 0, y: 150 },
          ],
          { seamAllowance: 10 }
        );
        piece.edges[1].curve = { cp1: { x: 135, y: 45 }, cp2: { x: 125, y: 110 } };
        piece = core.addNotchToPiece(piece, { edgeIndex: 1, t: 0.5, type: 'double', depthMm: 5 }) || piece;
        piece = core.addNotchToPiece(piece, { edgeIndex: 2, t: 0.4, type: 'v', depthMm: 6 }) || piece;

        const origArea = shoelaceArea(samplePieceOutlineIndependent(piece, 32));
        const mirrored = core.mirrorPieceAcrossEdge(piece, 3); // left vertical edge x=0
        const mirroredOutline = samplePieceOutlineIndependent(mirrored, 32);

        assert(shoelaceSignedArea(mirroredOutline) > 0, 'Mirrored outline must preserve CCW winding');
        assert(countSelfIntersections(mirroredOutline) === 0, 'Mirrored outline self-intersects');
        assertNear(shoelaceArea(mirroredOutline), origArea * 2, origArea * 0.02, 'Mirrored area');
        assert(mirrored.notches.length >= 4, `Expected >=4 notches after mirroring, got ${mirrored.notches.length}`);
        assert(
          (mirrored.internalLines || []).some((l) => /fold|center/i.test(String(l.type || l.name || ''))),
          'Mirrored piece must include fold center internalLine'
        );
      },
    },
    {
      id: 'T3-07',
      tier: 3,
      feature: 'F09+F13',
      features: ['F09', 'F13'],
      name: 'Pairwise: Per-edge SA + piece.rotation=90 -> seam validation & walk transform',
      fn: async () => {
        const core = await loadCore();
        const a = core.createRectanglePiece('PartA', 120, 180, { seamAllowance: 10 });
        a.edges[1].seamAllowance = 15; // 180mm right edge
        const b = core.createRectanglePiece('PartB', 180, 100, { seamAllowance: 8 });
        b.rotation = 90; // top edge is 180mm long in local space, rotated 90deg in layout

        const project = {
          id: 'proj-t3-07',
          name: 'T3-07',
          unit: 'mm',
          pieces: [a, b],
          seams: [{ id: 's1', name: 'SideJoin', pieceA: a.id, edgeA: 1, pieceB: b.id, edgeB: 0, reversed: true }],
        };
        const report = core.validatePatternSeams(project);
        assert(report.length === 1 && report[0].status === 'ok', `Expected seam status 'ok', got ${JSON.stringify(report)}`);
        assert(report[0].deltaMm <= 0.1, `Expected deltaMm <= 0.1, got ${report[0].deltaMm}`);

        const rawRot = extractPts(core.transformPiecePoints(b));
        const rotatedPts = rawRot.length >= 3 ? rawRot : extractPts(core.transformPiecePoints(b.points, b));
        const rotBounds = calcBounds(rotatedPts);
        assertNear(rotBounds.width, 100, 0.1, 'Rotated piece width');
        assertNear(rotBounds.height, 180, 0.1, 'Rotated piece height');

        assert(typeof core.computeSeamWalkTransform === 'function', 'computeSeamWalkTransform missing');
        const walk = core.computeSeamWalkTransform(project, project.seams[0]) || core.computeSeamWalkTransform(a, 1, b, 0);
        assert(walk && typeof walk === 'object', 'computeSeamWalkTransform must return transform object');
      },
    },
    {
      id: 'T3-08',
      tier: 3,
      feature: 'F10+F13',
      features: ['F10', 'F13'],
      name: 'Pairwise: Dart intake (24mm) aligns mismatched 200mm seam to 176mm mate',
      fn: async () => {
        const core = await loadCore();
        const a = core.createRectanglePiece('Darted', 200, 150, { seamAllowance: 10 });
        const b = core.createRectanglePiece('Mate', 176, 150, { seamAllowance: 10 });
        const project = {
          id: 'proj-t3-08',
          name: 'T3-08',
          unit: 'mm',
          pieces: [a, b],
          seams: [{ id: 's1', name: 'Waist', pieceA: a.id, edgeA: 0, pieceB: b.id, edgeB: 2 }],
        };

        const before = core.validatePatternSeams(project);
        assert(before[0].status === 'mismatch', `Expected mismatch before dart, got ${before[0].status}`);

        core.addDartToPiece(a, { edgeIndex: 0, t: 0.5, widthMm: 24, depthMm: 70 });
        const after = core.validatePatternSeams(project);
        assert(after[0].status === 'ok', `Expected 'ok' after 24mm dart intake, got ${JSON.stringify(after[0])}`);
        assert(after[0].deltaMm <= 0.1, `Expected deltaMm <= 0.1 after dart, got ${after[0].deltaMm}`);
      },
    },
    {
      id: 'T3-09',
      tier: 3,
      feature: 'F12+F14',
      features: ['F12', 'F14'],
      name: 'Pairwise: Mirrored piece -> mm/cm/in measurements without internal drift',
      fn: async () => {
        const core = await loadCore();
        const half = core.createRectanglePiece('Half', 100, 200, { seamAllowance: 0 });
        const full = core.mirrorPieceAcrossEdge(half, 3); // x=0 edge
        const meas = core.computePieceMeasurements(full);

        const bboxW = meas.width ?? meas.bounds?.width ?? calcBounds(full.points).width;
        const bboxH = meas.height ?? meas.bounds?.height ?? calcBounds(full.points).height;
        const area = meas.netAreaMm2 ?? meas.area ?? meas.areaMm2 ?? shoelaceArea(full.points);
        assertNear(bboxW, 200, 0.1, 'Mirrored width');
        assertNear(bboxH, 200, 0.1, 'Mirrored height');
        assertNear(area, 40000, 1.0, 'Mirrored area');

        const wIn = core.mmToUnit(bboxW, 'in');
        const wCm = core.mmToUnit(bboxW, 'cm');
        assertNear(wIn, 200 / 25.4, 1e-6, 'mmToUnit in');
        assertNear(wCm, 20.0, 1e-6, 'mmToUnit cm');
        assertNear(core.unitToMm(wIn, 'in'), 200, 1e-6, 'unitToMm roundtrip in');
      },
    },
    {
      id: 'T3-10',
      tier: 3,
      feature: 'F15+F16',
      features: ['F15', 'F16'],
      name: 'Pairwise: cutting_mat_wedge assembled_view vs print_ready STL -> orientation-invariant unwrap',
      fn: async () => {
        const core = await loadCore();
        const txtAsm = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const txtPrt = await fsp.readFile(WEDGE_PRINT_READY_STL, 'utf8');

        const indAsm = parseAsciiSTLIndependent(txtAsm);
        const indPrt = parseAsciiSTLIndependent(txtPrt);
        assert(indAsm.triangleCount === 984 && indPrt.triangleCount === 984, 'Expected 984 triangles in both STLs');
        assertNear(indAsm.surfaceAreaMm2, 123931.5, 5.0, 'Assembled STL area');

        const meshAsm = core.parseSTL(txtAsm, 'assembled.stl');
        const meshPrt = core.parseSTL(txtPrt, 'print_ready.stl');
        assert(meshAsm.triangleCount === 984 && meshPrt.triangleCount === 984, 'Core parseSTL triangle count');

        const topoAsm = core.analyzeSTLTopology(meshAsm);
        assert(topoAsm && typeof topoAsm === 'object', 'analyzeSTLTopology must return object');

        const patAsm = core.unwrapSTLToPattern(meshAsm, { mode: 'form_shell_cover', easeMm: 2, thicknessMm: 2, seamAllowance: 8 });
        const patPrt = core.unwrapSTLToPattern(meshPrt, { mode: 'form_shell_cover', easeMm: 2, thicknessMm: 2, seamAllowance: 8 });

        assert(patAsm.pieces.length === patPrt.pieces.length, `Piece count mismatch: ${patAsm.pieces.length} vs ${patPrt.pieces.length}`);

        const totalArea = (pat) =>
          pat.pieces.reduce((s, p) => s + shoelaceArea(samplePieceOutlineIndependent(p, 16)), 0);
        const a1 = totalArea(patAsm);
        const a2 = totalArea(patPrt);
        assert(Math.abs(a1 - a2) / Math.max(1, a1) < 0.03, `Orientation-dependent area divergence: ${a1.toFixed(1)} vs ${a2.toFixed(1)}`);

        const sideConcavity = patAsm.pieces.map((p) => {
          const pts = samplePieceOutlineIndependent(p, 16);
          return shoelaceArea(pts) / Math.max(1e-6, shoelaceArea(convexHull2DIndependent(pts)));
        });
        assert(Math.min(...sideConcavity) <= 0.94, `Concave hook recess lost (min ratio=${Math.min(...sideConcavity).toFixed(4)})`);
      },
    },
    {
      id: 'T3-11',
      tier: 3,
      feature: 'F06+F21',
      features: ['F06', 'F21'],
      name: 'Pairwise: stl_cover + eva_foam_4mm thickness compensation expands cover panels',
      fn: async () => {
        const core = await loadCore();
        const wedge = core.createWedgeSTL();
        const jersey = core.getMaterialConfig('cotton_jersey');
        const foam = core.getMaterialConfig('eva_foam_4mm');
        assert(foam.thicknessMm >= 3.5, `Expected eva_foam_4mm thicknessMm >= 3.5, got ${foam.thicknessMm}`);

        const patThin = core.unwrapSTLToPattern(wedge, {
          mode: 'form_shell_cover',
          easeMm: 1,
          thicknessMm: jersey.thicknessMm,
          seamAllowance: 8,
        });
        const patFoam = core.unwrapSTLToPattern(wedge, {
          mode: 'form_shell_cover',
          easeMm: 1,
          thicknessMm: foam.thicknessMm,
          seamAllowance: 8,
        });

        const areaSum = (pat) => pat.pieces.reduce((s, p) => s + shoelaceArea(samplePieceOutlineIndependent(p, 16)), 0);
        assert(areaSum(patFoam) > areaSum(patThin), `4mm foam area (${areaSum(patFoam)}) must exceed thin jersey (${areaSum(patThin)})`);

        for (const p of patFoam.pieces) {
          assert(countSelfIntersections(samplePieceOutlineIndependent(p, 16)) === 0, `Foam cover piece ${p.name} self-intersects`);
        }
      },
    },
    {
      id: 'T3-12',
      tier: 3,
      feature: 'F16+F17',
      features: ['F16', 'F17'],
      name: 'Pairwise: Unwrapped concave wedge profile panel -> conforming V-E+F=1 cloth mesh',
      fn: async () => {
        const core = await loadCore();
        const stlText = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const pat = core.unwrapSTLToPattern(core.parseSTL(stlText, 'wedge.stl'), {
          mode: 'form_shell_cover',
          easeMm: 2,
          seamAllowance: 8,
        });
        const sidePiece = pat.pieces.reduce((best, p) => {
          const pts = samplePieceOutlineIndependent(p, 16);
          const ratio = shoelaceArea(pts) / Math.max(1e-6, shoelaceArea(convexHull2DIndependent(pts)));
          return !best || ratio < best.ratio ? { piece: p, pts, ratio } : best;
        }, null);
        assert(sidePiece && sidePiece.ratio <= 0.94, 'Could not locate concave side profile panel');

        const mesh = core.generateClothMesh2D(sidePiece.pts, 25);
        checkEulerAndTJunctions(mesh, shoelaceArea(sidePiece.pts));
      },
    },
    {
      id: 'T3-13',
      tier: 3,
      feature: 'F17+F18',
      features: ['F17', 'F18'],
      name: 'Pairwise: Dense (18mm) vs coarse (60mm) mesh -> XPBD cloth simulation stability',
      fn: async () => {
        const core = await loadCore();
        const panel = core.createRectanglePiece('Cloth', 240, 240, { seamAllowance: 0 });
        const pat = { id: 'p-t3-13', name: 'Sheet', unit: 'mm', pieces: [panel], seams: [] };

        const simDense = new core.ClothSimulation(pat, { maxEdgeLengthMm: 18, materialId: 'cotton_jersey' });
        const simCoarse = new core.ClothSimulation(pat, { maxEdgeLengthMm: 60, materialId: 'cotton_jersey' });
        assert(simDense.particles.length > simCoarse.particles.length, 'Dense mesh must have more particles than coarse');

        const repD = simDense.step(80);
        const repC = simCoarse.step(80);
        assert(repD.stepCount >= 80 && repC.stepCount >= 80, 'Expected >=80 simulation steps');

        for (const p of [...simDense.particles, ...simCoarse.particles]) {
          const pos = getParticlePos(p);
          assert(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z), 'Non-finite particle pos');
          assert(Math.hypot(pos.x, pos.y, pos.z) < 5000, 'Particle diverged > 5000mm');
        }
      },
    },
    {
      id: 'T3-14',
      tier: 3,
      feature: 'F18+F19',
      features: ['F18', 'F19'],
      name: 'Pairwise: XPBD sewing solver with parametric avatar vs STL triangle-mesh collider',
      fn: async () => {
        const core = await loadCore();
        // 1. Avatar sewing convergence
        const shirt = core.generateTemplatePattern('tshirt', {}, { materialId: 'cotton_jersey' });
        const simAvatar = new core.ClothSimulation(shirt, { avatar: core.DEFAULT_AVATAR, materialId: 'cotton_jersey' });
        const r1 = simAvatar.step(1);
        const r80 = simAvatar.step(79);
        assert(r80.avgSewGapMm <= r1.avgSewGapMm + 1.0, `Expected sew gap to stay bounded/decrease: ${r1.avgSewGapMm} -> ${r80.avgSewGapMm}`);
        for (const p of simAvatar.particles) {
          const pos = getParticlePos(p);
          assert(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z), 'Avatar sim non-finite pos');
        }

        // 2. STL triangle-mesh collision
        const wedgeTxt = core.createWedgeSTL();
        const indWedge = parseAsciiSTLIndependent(wedgeTxt);
        const stlMesh = core.parseSTL(wedgeTxt, 'wedge.stl');
        const foam = core.getMaterialConfig('eva_foam_4mm');
        const cover = core.unwrapSTLToPattern(stlMesh, { mode: 'form_shell_cover', easeMm: 2, thicknessMm: foam.thicknessMm });
        const simStl = new core.ClothSimulation(cover, { stlMesh, materialId: 'eva_foam_4mm' });
        simStl.step(50);

        const minDist = minParticleDistToTriangles(simStl.particles, indWedge.triangles, indWedge.bounds);
        assert(
          minDist >= foam.thicknessMm - 0.5,
          `STL triangle collision violated: minDist=${minDist.toFixed(3)}mm < thicknessMm-0.5 (${foam.thicknessMm - 0.5})`
        );
      },
    },
    {
      id: 'T3-15',
      tier: 3,
      feature: 'F18+F21',
      features: ['F18', 'F21'],
      name: 'Pairwise: Material physical properties (cotton_jersey vs stiff veg_leather) drive drape delta',
      fn: async () => {
        const core = await loadCore();
        const shirt = core.generateTemplatePattern('tshirt');
        const simSoft = new core.ClothSimulation(shirt, {
          materialId: 'cotton_jersey',
          materialOverrides: { gsm: 140, bendStiffness: 0.05, shearStiffness: 0.1 },
        });
        const simStiff = new core.ClothSimulation(shirt, {
          materialId: 'veg_leather',
          materialOverrides: { gsm: 850, bendStiffness: 0.95, shearStiffness: 0.95 },
        });
        const repSoft = simSoft.step(60);
        const repStiff = simStiff.step(60);

        let maxPosDelta = 0;
        const n = Math.min(simSoft.particles.length, simStiff.particles.length);
        for (let i = 0; i < n; i++) {
          const a = getParticlePos(simSoft.particles[i]);
          const b = getParticlePos(simStiff.particles[i]);
          const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          if (d > maxPosDelta) maxPosDelta = d;
        }
        const strainDelta = Math.abs(repSoft.meanStrainPct - repStiff.meanStrainPct);
        assert(
          maxPosDelta > 0.1 || strainDelta > 0.05,
          `Expected measurable drape difference between jersey & stiff leather (posDelta=${maxPosDelta}, strainDelta=${strainDelta})`
        );
      },
    },
    {
      id: 'T3-16',
      tier: 3,
      feature: 'F19+F20',
      features: ['F19', 'F20'],
      name: 'Pairwise: Oversized avatar vs small T-shirt triggers strain heatmap too_tight',
      fn: async () => {
        const core = await loadCore();
        const smallShirt = core.generateTemplatePattern('tshirt', { chestMm: 860, easeMm: 0 });
        const fitRes = core.runSimulationSteps(smallShirt, {
          steps: 50,
          avatar: core.createParametricAvatar({ chestMm: 840, waistMm: 700, hipMm: 880 }),
          materialId: 'duck_canvas',
        });
        const tightRes = core.runSimulationSteps(smallShirt, {
          steps: 50,
          avatar: core.createParametricAvatar({ chestMm: 1350, waistMm: 1200, hipMm: 1380 }),
          materialId: 'duck_canvas',
        });

        assert(tightRes.strainReport.maxStrainPct > fitRes.strainReport.maxStrainPct, 'Larger avatar must induce higher maxStrainPct');
        assert(
          tightRes.strainReport.fitStatus === 'too_tight' || tightRes.strainReport.tightParticleCount > 0,
          `Expected 'too_tight' or tight particles on 1350mm avatar, got ${JSON.stringify(tightRes.strainReport)}`
        );
      },
    },
    {
      id: 'T3-17',
      tier: 3,
      feature: 'F20+F21',
      features: ['F20', 'F21'],
      name: 'Pairwise: Material maxSafeStrainPct threshold shifts strain fitStatus',
      fn: async () => {
        const core = await loadCore();
        const shirt = core.generateTemplatePattern('tshirt', { chestMm: 940, easeMm: 10 });
        const avatar = core.createParametricAvatar({ chestMm: 1040, waistMm: 880, hipMm: 1060 });

        const strictRes = core.runSimulationSteps(shirt, {
          steps: 50,
          avatar,
          materialId: 'cotton_jersey',
          materialOverrides: { maxSafeStrainPct: 1.0 },
        });
        const tolerantRes = core.runSimulationSteps(shirt, {
          steps: 50,
          avatar,
          materialId: 'cotton_jersey',
          materialOverrides: { maxSafeStrainPct: 80.0 },
        });

        assert(strictRes.strainReport.maxStrainPct > 1.0, 'Expected measurable strain > 1% for stretched fit test');
        assert(
          strictRes.strainReport.fitStatus !== 'good_fit',
          `Expected snug/too_tight when maxSafeStrainPct=1%, got ${strictRes.strainReport.fitStatus}`
        );
        assert(
          tolerantRes.strainReport.fitStatus === 'good_fit',
          `Expected good_fit when maxSafeStrainPct=80%, got ${tolerantRes.strainReport.fitStatus}`
        );
      },
    },
    {
      id: 'T3-18',
      tier: 3,
      feature: 'F21+F26',
      features: ['F21', 'F26'],
      name: 'Pairwise: Procedural PBR maps + HTTP POST /api/simulate material roundtrip',
      fn: async () => {
        const core = await loadCore();
        const matCfg = core.getMaterialConfig('heavy_denim', { roughness: 0.85, sheen: 0.25 });
        const maps = core.generateProceduralPBRMaps(matCfg, 32);
        assert(maps && typeof maps === 'object', 'generateProceduralPBRMaps must return map object');
        const keys = Object.keys(maps);
        for (const ch of ['albedo', 'normal', 'roughness', 'ao']) {
          const k = keys.find((x) => x.toLowerCase().includes(ch));
          assert(k, `Missing PBR channel '${ch}' in keys [${keys.join(', ')}]`);
          const buf = maps[k]?.data || maps[k];
          assert(buf && buf.length >= 32 * 32, `PBR channel ${k} buffer too small`);
          const first = buf[0];
          assert(buf.some((v) => v !== first), `PBR channel ${k} is uniform/constant`);
        }

        const srv = await startTestServer({ port: 0 });
        try {
          const tplRes = await srv.fetchJson('/api/generate-template', {
            method: 'POST',
            body: { templateId: 'tshirt', materialId: 'heavy_denim' },
          });
          assert(tplRes.status === 200 && tplRes.data?.pattern, 'POST /api/generate-template failed');

          const simRes = await srv.fetchJson('/api/simulate', {
            method: 'POST',
            body: { pattern: tplRes.data.pattern, material: matCfg, steps: 30 },
          });
          assert(simRes.status === 200, `POST /api/simulate failed: ${simRes.status}`);
          assert(simRes.data.finiteOk !== false, 'Expected finiteOk !== false');
          assert(Array.isArray(simRes.data.particles) && simRes.data.particles.length > 0, 'Missing simulated particles');
          assert(simRes.data.strainReport && Number.isFinite(simRes.data.strainReport.meanStrainPct), 'Missing strainReport');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T3-19',
      tier: 3,
      feature: 'F09+F22+F24',
      features: ['F09', 'F22', 'F24'],
      name: 'Pairwise: piece.rotation=90 + SA=10 -> SVG & DXF exact swapped dimensions <= 0.1 mm',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('RotTest', 100, 200, { seamAllowance: 10 });
        rect.rotation = 90;
        const pattern = { id: 'p-t3-19', name: 'Rot90', unit: 'mm', pieces: [rect], seams: [] };

        const svg = core.exportSVG(pattern);
        const dxf = core.exportDXF(pattern);

        const exp = {
          expectedPieces: [
            { widthMm: 220, heightMm: 120, allowRotate90: false, tolMm: 0.1 },
            { widthMm: 200, heightMm: 100, allowRotate90: false, tolMm: 0.1 },
          ],
        };
        const rSvg = await verifyExportWithPython('svg', svg, exp);
        const rDxf = await verifyExportWithPython('dxf', dxf, exp);
        assert(rSvg.ok && rDxf.ok, 'T3-19 rotation=90 SVG/DXF parity failed');
      },
    },
    {
      id: 'T3-20',
      tier: 3,
      feature: 'F10+F22+F23',
      features: ['F10', 'F22', 'F23'],
      name: 'Pairwise: Darted piece cutout -> SVG & Tiled PDF cut area parity',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('DartPiece', 240, 180, { seamAllowance: 10 });
        core.addDartToPiece(rect, { edgeIndex: 0, t: 0.5, widthMm: 30, depthMm: 80 });
        const cutPts = extractPts(core.computePieceCutBoundary(rect));
        assert(countSelfIntersections(cutPts) === 0, 'Darted cut boundary self-intersects');
        const cutArea = shoelaceArea(cutPts);
        assert(cutArea < 260 * 200 - 400, `Dart cutout did not reduce cut area (${cutArea})`);
        const cutB = calcBounds(cutPts);

        const pattern = { id: 'p-t3-20', name: 'DartExport', unit: 'mm', pieces: [rect], seams: [] };
        const svg = core.exportSVG(pattern);
        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'A4' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');

        const rSvg = await verifyExportWithPython('svg', svg, {
          expectedPieces: [{ widthMm: cutB.width, heightMm: cutB.height, areaMm2: cutArea, areaTolPct: 1.0, tolMm: 0.1 }],
        });
        const rPdf = await verifyExportWithPython('pdf', pdfBytes, {
          pageFormat: 'A4',
          requireCalibrationSquare: true,
        });
        assert(rSvg.ok && rPdf.ok, 'T3-20 SVG/PDF failed');
      },
    },
    {
      id: 'T3-21',
      tier: 3,
      feature: 'F14+F25',
      features: ['F14', 'F25'],
      name: 'Pairwise: Imperial inch inputs -> cutting_mat_36x24 (914mm) nesting BOM',
      fn: async () => {
        const core = await loadCore();
        const wMm = core.unitToMm(10, 'in'); // 254mm
        const hMm = core.unitToMm(8, 'in');  // 203.2mm
        const piece = core.createRectanglePiece('InchBlock', wMm, hMm, { seamAllowance: 0, quantity: 3 });
        const pattern = { id: 'p-t3-21', name: 'InchNest', unit: 'mm', pieces: [piece], seams: [] };

        const rolls = getRollList(core.FABRIC_ROLL_PRESETS);
        const mat = rolls.find((r) => /36|mat/i.test(String(r.id || r.name)) || Math.abs(getRollWidthMm(r) - 914) < 5) || rolls[0];
        const matW = getRollWidthMm(mat);
        const nest = core.nestPatternPieces(pattern, { fabricWidthMm: matW, marginMm: 10, spacingMm: 10 });

        assert(nest.placements.length === 3, `Expected 3 placements for quantity=3, got ${nest.placements.length}`);
        assertNoOverlappingPlacements(nest.placements, matW);
        const lenIn = core.mmToUnit(nest.requiredLengthMm, 'in');
        assert(Number.isFinite(lenIn) && lenIn > 7.5 && lenIn < 30, `Unexpected nested length in inches: ${lenIn}`);
      },
    },
    {
      id: 'T3-22',
      tier: 3,
      feature: 'F22+F23+F24',
      features: ['F22', 'F23', 'F24'],
      name: 'Pairwise: 3-way SVG / Tiled PDF / CAD DXF parity on exact 175x115mm piece <= 0.1 mm',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('CalibBlock', 175, 115, { seamAllowance: 0 });
        const pattern = { id: 'p-t3-22', name: 'Parity3Way', unit: 'mm', pieces: [piece], seams: [] };

        const exp = {
          expectedPieces: [{ widthMm: 175, heightMm: 115, areaMm2: 175 * 115, perimeterMm: 580, tolMm: 0.1 }],
        };
        const svg = core.exportSVG(pattern);
        const dxf = core.exportDXF(pattern);
        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'A4' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');

        const rSvg = await verifyExportWithPython('svg', svg, exp);
        const rDxf = await verifyExportWithPython('dxf', dxf, exp);
        const rPdf = await verifyExportWithPython('pdf', pdfBytes, { ...exp, pageFormat: 'A4', checkPage1PieceBounds: true });
        assert(rSvg.ok && rDxf.ok && rPdf.ok, '3-way SVG/DXF/PDF parity check failed');
      },
    },
    {
      id: 'T3-23',
      tier: 3,
      feature: 'F01+F22',
      features: ['F01', 'F22'],
      name: 'Pairwise: exportPatternJSON -> importPatternJSON roundtrip produces matching SVG',
      fn: async () => {
        const core = await loadCore();
        const original = core.generateTemplatePattern('tote_bag');
        const jsonStr = core.exportPatternJSON(original);
        const restored = core.importPatternJSON(jsonStr);

        assert(restored.unit === 'mm', 'Restored unit must be mm');
        assert(restored.pieces.length === original.pieces.length, 'Piece count mismatch after JSON roundtrip');
        assert(restored.seams.length === original.seams.length, 'Seam count mismatch after JSON roundtrip');

        const r1 = await verifyExportWithPython('svg', core.exportSVG(original), { checkScale1to1: true });
        const r2 = await verifyExportWithPython('svg', core.exportSVG(restored), { checkScale1to1: true });
        assert(r1.metrics.closedShapeCount === r2.metrics.closedShapeCount, 'Closed SVG shape count changed after JSON roundtrip');
        assertNear(r1.metrics.widthMm, r2.metrics.widthMm, 0.1, 'SVG widthMm after JSON roundtrip');
        assertNear(r1.metrics.heightMm, r2.metrics.heightMm, 0.1, 'SVG heightMm after JSON roundtrip');
      },
    },
    {
      id: 'T3-24',
      tier: 3,
      feature: 'F06+F23',
      features: ['F06', 'F23'],
      name: 'Pairwise: stl_cover (cutting_mat_wedge_assembled_view.stl) -> A4 multi-page tiled PDF',
      fn: async () => {
        const core = await loadCore();
        const stlText = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const pat = core.unwrapSTLToPattern(core.parseSTL(stlText, 'wedge_asm.stl'), {
          mode: 'form_shell_cover',
          easeMm: 3,
          seamAllowance: 10,
        });
        const pdfRes = core.exportTiledPDF(pat, { pageFormat: 'A4' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
        const report = await verifyExportWithPython('pdf', pdfBytes, {
          pageFormat: 'A4',
          requireCalibrationSquare: true,
          requireRegistrationMarks: true,
        });
        assert(report.ok, 'T3-24 A4 tiled PDF verification failed');
      },
    },
    {
      id: 'T3-25',
      tier: 3,
      feature: 'F06+F24+F25',
      features: ['F06', 'F24', 'F25'],
      name: 'Pairwise: stl_cover surface_panels -> CAD DXF + 60" roll nesting BOM',
      fn: async () => {
        const core = await loadCore();
        const stlText = await fsp.readFile(WEDGE_PRINT_READY_STL, 'utf8');
        const pat = core.unwrapSTLToPattern(core.parseSTL(stlText, 'wedge_prt.stl'), {
          mode: 'surface_panels',
          easeMm: 2,
          seamAllowance: 8,
        });
        assert(pat.pieces.length >= 2, `Expected >=2 surface_panels, got ${pat.pieces.length}`);

        const dxf = core.exportDXF(pat);
        const rDxf = await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireTablesLayer: true,
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
        });
        assert(rDxf.ok, 'T3-25 DXF verification failed');

        const rolls = getRollList(core.FABRIC_ROLL_PRESETS);
        const r60 = rolls.find((r) => /60/.test(String(r.id || r.name)) || Math.abs(getRollWidthMm(r) - 1524) < 10) || rolls[rolls.length - 1];
        const w60 = getRollWidthMm(r60);
        const nest = core.nestPatternPieces(pat, { fabricWidthMm: w60, allowRotate90: true });
        assert(nest.requiredLengthMm > 0 && nest.utilizationPct > 0 && nest.utilizationPct <= 100, 'Invalid 60" roll nesting metrics');
        assertNoOverlappingPlacements(nest.placements, w60);
      },
    },
    {
      id: 'T3-26',
      tier: 3,
      feature: 'F26+F27',
      features: ['F26', 'F27'],
      name: 'Pairwise: HTTP POST /api/generate-template -> POST /api/export raw PDF binary',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const gen = await srv.fetchJson('/api/generate-template', {
            method: 'POST',
            body: { templateId: 'tshirt', params: { chestMm: 980 }, materialId: 'cotton_jersey' },
          });
          assert(gen.status === 200 && gen.data?.pattern?.pieces?.length >= 5, 'POST /api/generate-template failed');

          const exp = await srv.fetchBuffer('/api/export', {
            method: 'POST',
            body: { pattern: gen.data.pattern, format: 'pdf', options: { pageFormat: 'LETTER' } },
          });
          assert(exp.status === 200, `POST /api/export PDF failed: ${exp.status}`);
          const ct = exp.headers.get('content-type') || '';
          const cd = exp.headers.get('content-disposition') || '';
          assert(ct.includes('application/pdf'), `Expected application/pdf Content-Type, got ${ct}`);
          assert(cd.length > 0, 'Missing Content-Disposition header on /api/export');

          const report = await verifyExportWithPython('pdf', exp.buffer, {
            pageFormat: 'LETTER',
            requireCalibrationSquare: true,
          });
          assert(report.ok, 'HTTP exported PDF failed independent verification');
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T3-27',
      tier: 3,
      feature: 'F15+F27',
      features: ['F15', 'F27'],
      name: 'Pairwise: CLI unwrap + verify-sim on cutting_mat_wedge_assembled_view.stl',
      fn: async () => {
        await withTempDir(async (tmpDir) => {
          const unwrapRes = await runCli([
            'unwrap',
            '--stl',
            WEDGE_ASSEMBLED_STL,
            '--mode',
            'form_shell_cover',
            '--ease',
            '4',
            '--sa',
            '10',
            '--out',
            tmpDir,
            '--format',
            'svg,dxf,pdf',
          ]);
          assert(unwrapRes.code === 0, `CLI unwrap exited ${unwrapRes.code}: ${unwrapRes.stderr}\n${unwrapRes.stdout}`);

          const files = await fsp.readdir(tmpDir);
          const svgFile = files.find((f) => f.endsWith('.svg'));
          const dxfFile = files.find((f) => f.endsWith('.dxf'));
          const pdfFile = files.find((f) => f.endsWith('.pdf'));
          assert(svgFile && dxfFile && pdfFile, `Expected svg/dxf/pdf in ${tmpDir}, got [${files.join(', ')}]`);

          const rSvg = await verifyExportWithPython('svg', await fsp.readFile(path.join(tmpDir, svgFile), 'utf8'));
          const rDxf = await verifyExportWithPython('dxf', await fsp.readFile(path.join(tmpDir, dxfFile), 'utf8'));
          const rPdf = await verifyExportWithPython('pdf', await fsp.readFile(path.join(tmpDir, pdfFile)));
          assert(rSvg.ok && rDxf.ok && rPdf.ok, 'CLI unwrap exported artifacts failed verification');

          const simRes = await runCli([
            'verify-sim',
            '--stl',
            WEDGE_ASSEMBLED_STL,
            '--material',
            'eva_foam_4mm',
            '--steps',
            '60',
          ]);
          assert(simRes.code === 0, `CLI verify-sim exited ${simRes.code}: ${simRes.stderr}\n${simRes.stdout}`);
          assert(!/NaN|Infinity/i.test(simRes.stdout), `CLI verify-sim printed non-finite output: ${simRes.stdout}`);
        });
      },
    },
  ];
}
