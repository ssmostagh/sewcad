import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  V2_ROOT,
  WEDGE_ASSEMBLED_STL,
  WEDGE_PRINT_READY_STL,
  assert,
  assertNear,
  buildSeamConnectivity,
  calcBounds,
  convexHull2DIndependent,
  countSelfIntersections,
  loadCore,
  parseAsciiSTLIndependent,
  pointToTriangleDist3D,
  runChromeCDPCheck,
  runCli,
  sampleCubicArcLengthIndependent,
  samplePieceOutlineIndependent,
  shoelaceArea,
  shoelaceSignedArea,
  startTestServer,
  verifyExportWithPython,
  verifyPatternStudioIsolation,
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
    assert(Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0, `Invalid placement: ${JSON.stringify(pl)}`);
    assert(x >= -0.1 && x + w <= rollWidthMm + 0.1, `Placement out of roll width ${rollWidthMm}mm: x=${x}, w=${w}`);
    return { x, y, w, h };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert(!(ox > 0.05 && oy > 0.05), `Overlapping placements: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
}

function minParticleDistToSTLTriangles(particles, indTriangles, stlBounds) {
  let sx = 0, sy = 0, sz = 0;
  for (const p of particles) {
    const pos = getParticlePos(p);
    sx += pos.x;
    sy += pos.y;
    sz += pos.z;
  }
  const pMean = {
    x: sx / Math.max(1, particles.length),
    y: sy / Math.max(1, particles.length),
    z: sz / Math.max(1, particles.length),
  };
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

  let minDist = Infinity;
  for (const p of particles) {
    const pos = getParticlePos(p);
    let best = Infinity;
    for (let i = 0; i < shiftedTris.length; i++) {
      const tri = shiftedTris[i];
      const d = pointToTriangleDist3D(pos, tri[0], tri[1], tri[2]);
      if (d < best) best = d;
    }
    if (best < minDist) minDist = best;
  }
  return minDist;
}

async function getUnusedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function nodeCheckFile(filePath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', filePath], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Syntax check failed for ${filePath}: ${stderr || err.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export function getTests() {
  return [
    {
      id: 'T4-01',
      tier: 4,
      feature: 'S01:F01,F02,F08,F09,F11,F13,F18,F21,F22,F23,F24',
      features: ['S01', 'F01', 'F02', 'F08', 'F09', 'F11', 'F13', 'F18', 'F21', 'F22', 'F23', 'F24'],
      name: 'S01: Custom T-shirt cut-and-sew pack (cotton_jersey, notch/SA edit, seam walk, 3D drape, SVG/PDF/DXF <= 0.1 mm)',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern(
          'tshirt',
          { chestMm: 1000, easeMm: 50, seamAllowance: 10 },
          { materialId: 'cotton_jersey' }
        );
        assert(pattern.unit === 'mm' && pattern.pieces.length >= 5, 'T-shirt schema invalid');
        assert(buildSeamConnectivity(pattern).isFullyConnected, 'T-shirt neckband/sleeves must be wired into seam graph');

        const frontIdx = pattern.pieces.findIndex((p) => /front/i.test(p.name) || /front/i.test(p.role));
        assert(frontIdx >= 0, 'Missing front bodice piece on tshirt');
        const front = pattern.pieces[frontIdx];
        const edgeLen = (piece, idx) => {
          const p0 = piece.points[idx];
          const p1 = piece.points[(idx + 1) % piece.points.length];
          const curve = piece.edges?.[idx]?.curve;
          return curve
            ? sampleCubicArcLengthIndependent(p0, curve.cp1 || curve.cp, curve.cp2, p1, 128)
            : core.edgeArcLength(p0, p1, null);
        };
        const frontCopy = structuredClone(front);
        const origEdgeLen = edgeLen(frontCopy, 0);
        const splitFront = core.splitPieceEdge(frontCopy, 0, 0.5) || frontCopy;
        const splitLen = edgeLen(splitFront, 0) + edgeLen(splitFront, 1);
        assertNear(splitLen, origEdgeLen, 0.05, 'Split edge arc length');

        const notched = core.addNotchToPiece(front, { edgeIndex: 1, t: 0.4, type: 'double', depthMm: 5 }) || front;
        notched.edges[0].seamAllowance = 12;
        if (frontIdx >= 0) pattern.pieces[frontIdx] = notched;

        const seamReport = core.validatePatternSeams(pattern);
        assert(seamReport.every((s) => s.valid !== false && s.status !== 'mismatch'), 'T-shirt seam validation failed');

        assert(pattern.seams.length > 0, 'Expected seams on tshirt');
        const walk =
          core.computeSeamWalkTransform(pattern, pattern.seams[0]) ||
          core.computeSeamWalkTransform(front, 0, pattern.pieces[1], 0);
        assert(walk && typeof walk === 'object', 'computeSeamWalkTransform failed');

        const sim = new core.ClothSimulation(pattern, {
          avatar: core.createParametricAvatar(),
          materialId: 'cotton_jersey',
        });
        const r0 = sim.step(1);
        const r60 = sim.step(59);
        assert(r60.avgSewGapMm <= r0.avgSewGapMm + 1.0, 'Sew gap did not remain bounded/converge');
        for (const p of sim.particles) {
          const pos = getParticlePos(p);
          assert(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z), 'T-shirt 3D drape NaN');
        }

        const cutFront = extractPts(core.computePieceCutBoundary(notched));
        assert(countSelfIntersections(cutFront) === 0, 'Edited front bodice cut boundary self-intersects');
        const cutB = calcBounds(cutFront);

        const svg = core.exportSVG(pattern);
        const dxf = core.exportDXF(pattern);
        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'LETTER' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');

        const pieceExp = { expectedPieces: [{ widthMm: cutB.width, heightMm: cutB.height, tolMm: 0.1 }] };
        assert((await verifyExportWithPython('svg', svg, { ...pieceExp, checkScale1to1: true })).ok, 'S01 SVG failed');
        assert((await verifyExportWithPython('dxf', dxf, pieceExp)).ok, 'S01 DXF failed');
        assert((await verifyExportWithPython('pdf', pdfBytes, { pageFormat: 'LETTER', requireCalibrationSquare: true })).ok, 'S01 PDF failed');
      },
    },
    {
      id: 'T4-02',
      tier: 4,
      feature: 'S02:F03,F13,F17,F18,F19,F21,F23',
      features: ['S02', 'F03', 'F13', 'F17', 'F18', 'F19', 'F21', 'F23'],
      name: 'S02: Fleece hoodie with kangaroo pocket & contoured hood (heavy_fleece, internalLines in PDF, 3D drape)',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern('hoodie', {}, { materialId: 'heavy_fleece' });
        assert(pattern.pieces.length >= 8, `Expected >=8 hoodie pieces, got ${pattern.pieces.length}`);
        assert(buildSeamConnectivity(pattern).isFullyConnected, 'Hoodie hood/pocket/waistband seams must be connected');
        assert(
          pattern.pieces.some((p) => Array.isArray(p.internalLines) && p.internalLines.length > 0),
          'Hoodie must contain kangaroo pocket / fold internalLines'
        );

        const seams = core.validatePatternSeams(pattern);
        assert(seams.length >= 5 && seams.every((s) => s.status !== 'mismatch'), 'Hoodie seams invalid');

        const hood = pattern.pieces.find((p) => /hood/i.test(p.name) || /hood/i.test(p.role));
        assert(hood, 'Missing hood piece on hoodie');
        const mesh = core.generateClothMesh2D(samplePieceOutlineIndependent(hood, 16), 30);
        assert(mesh.vertices.length >= 3 && mesh.triangles.length >= 1, 'Hood cloth triangulation failed');

        const sim = core.runSimulationSteps(pattern, {
          steps: 50,
          avatar: core.DEFAULT_AVATAR,
          materialId: 'heavy_fleece',
        });
        assert(sim.finiteOk !== false && sim.particles.length > 0, 'Hoodie simulation failed');
        for (const p of sim.particles) {
          const pos = getParticlePos(p);
          assert(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z), 'Hoodie drape non-finite');
        }

        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'LETTER' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
        const report = await verifyExportWithPython('pdf', pdfBytes, {
          pageFormat: 'LETTER',
          requireCalibrationSquare: true,
          requireRegistrationMarks: true,
          requireInternalLines: true,
        });
        assert(report.ok, 'S02 Hoodie tiled PDF verification failed');
      },
    },
    {
      id: 'T4-03',
      tier: 4,
      feature: 'S03:F04,F10,F13,F18,F20,F21,F24,F25',
      features: ['S03', 'F04', 'F10', 'F13', 'F18', 'F20', 'F21', 'F24', 'F25'],
      name: 'S03: Tailored denim pants with waist darts & waistband (dart fold/truing, 3D strain heatmap, DXF + roll yield)',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern(
          'pants',
          { waistMm: 820, hipMm: 1000, inseamMm: 780 },
          { materialId: 'heavy_denim' }
        );
        assert(pattern.pieces.length >= 5, `Expected >=5 pants pieces, got ${pattern.pieces.length}`);
        assert(buildSeamConnectivity(pattern).isFullyConnected, 'Pants waistband/legs seam graph disconnected');

        const darted = pattern.pieces.find((p) => Array.isArray(p.darts) && p.darts.length > 0);
        assert(darted, 'Expected at least one pants piece with waist darts');
        const folded = core.toggleDartFold(darted, darted.darts[0].id ?? 0) || darted;
        assert(countSelfIntersections(extractPts(core.computePieceCutBoundary(folded))) === 0, 'Folded pants dart self-intersects');

        const sim = core.runSimulationSteps(pattern, {
          steps: 55,
          avatar: core.createParametricAvatar({ waistMm: 860, hipMm: 1040 }),
          materialId: 'heavy_denim',
        });
        assert(sim.finiteOk !== false, 'Pants simulation non-finite');
        assert(sim.strainReport.meanStrainPct >= 0 && sim.strainReport.maxStrainPct >= sim.strainReport.meanStrainPct, 'Invalid strainReport');
        assert(['good_fit', 'snug', 'too_tight'].includes(sim.strainReport.fitStatus), 'Invalid fitStatus');

        const rolls = getRollList(core.FABRIC_ROLL_PRESETS);
        const roll54 = rolls.find((r) => Math.abs(getRollWidthMm(r) - 1372) < 20) || rolls[0];
        const w54 = getRollWidthMm(roll54);
        const nest = core.nestPatternPieces(pattern, { fabricWidthMm: w54, allowRotate90: true });
        assert(nest.requiredLengthMm > 0 && nest.utilizationPct > 0 && nest.utilizationPct <= 100, 'Invalid pants roll yield');
        assertNoOverlappingPlacements(nest.placements, w54);

        const dxf = core.exportDXF(pattern);
        const rDxf = await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireTablesLayer: true,
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
        });
        assert(rDxf.ok, 'S03 DXF verification failed');
      },
    },
    {
      id: 'T4-04',
      tier: 4,
      feature: 'S04:F06,F15,F16,F18,F19,F21,F23',
      features: ['S04', 'F06', 'F15', 'F16', 'F18', 'F19', 'F21', 'F23'],
      name: 'S04: 4mm EVA foam cover for cutting_mat_wedge_assembled_view.stl (concavity <= 0.94, STL collision, tiled PDF)',
      fn: async () => {
        const core = await loadCore();
        const stlText = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const indMesh = parseAsciiSTLIndependent(stlText);
        const stlMesh = core.parseSTL(stlText, 'cutting_mat_wedge_assembled_view.stl');
        assert(stlMesh.triangleCount === 984, `Expected 984 triangles, got ${stlMesh.triangleCount}`);

        const foam = core.getMaterialConfig('eva_foam_4mm');
        assert(foam.thicknessMm >= 3.5, `Expected 4mm EVA foam thickness, got ${foam.thicknessMm}`);

        const pattern = core.unwrapSTLToPattern(stlMesh, {
          mode: 'form_shell_cover',
          easeMm: 2,
          thicknessMm: foam.thicknessMm,
          seamAllowance: 8,
          materialId: 'eva_foam_4mm',
        });
        assert(pattern.pieces.length >= 3, `Expected >=3 cover pieces, got ${pattern.pieces.length}`);

        const ratios = pattern.pieces.map((p) => {
          const pts = samplePieceOutlineIndependent(p, 16);
          assert(countSelfIntersections(pts) === 0, `Cover piece ${p.name} self-intersects`);
          return shoelaceArea(pts) / Math.max(1e-6, shoelaceArea(convexHull2DIndependent(pts)));
        });
        assert(Math.min(...ratios) <= 0.94, `Concave hook recess lost in EVA cover (min ratio=${Math.min(...ratios).toFixed(4)})`);

        const sim = new core.ClothSimulation(pattern, { stlMesh, materialId: 'eva_foam_4mm' });
        sim.step(50);
        for (const p of sim.particles) {
          const pos = getParticlePos(p);
          assert(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z), 'EVA foam STL sim non-finite');
        }
        const minDist = minParticleDistToSTLTriangles(sim.particles, indMesh.triangles, indMesh.bounds);
        assert(
          minDist >= foam.thicknessMm - 0.5,
          `EVA foam penetrated STL collision offset: minDist=${minDist.toFixed(3)}mm < ${foam.thicknessMm - 0.5}mm`
        );

        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'LETTER' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
        const rPdf = await verifyExportWithPython('pdf', pdfBytes, {
          pageFormat: 'LETTER',
          requireCalibrationSquare: true,
        });
        assert(rPdf.ok, 'S04 Tiled PDF failed');
      },
    },
    {
      id: 'T4-05',
      tier: 4,
      feature: 'S05:F06,F15,F16,F18,F19,F21,F22,F24',
      features: ['S05', 'F06', 'F15', 'F16', 'F18', 'F19', 'F21', 'F22', 'F24'],
      name: 'S05: Veg-tan leather cover for cutting_mat_wedge_print_ready.stl (orientation invariance, surface_panels, STL collision, SVG/DXF)',
      fn: async () => {
        const core = await loadCore();
        const txtAsm = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
        const txtPrt = await fsp.readFile(WEDGE_PRINT_READY_STL, 'utf8');
        const indPrt = parseAsciiSTLIndependent(txtPrt);
        const meshAsm = core.parseSTL(txtAsm, 'assembled.stl');
        const meshPrt = core.parseSTL(txtPrt, 'print_ready.stl');
        const leather = core.getMaterialConfig('veg_leather');

        // Orientation invariance check against assembled_view
        const shellAsm = core.unwrapSTLToPattern(meshAsm, { mode: 'form_shell_cover', easeMm: 2, thicknessMm: leather.thicknessMm });
        const shellPrt = core.unwrapSTLToPattern(meshPrt, { mode: 'form_shell_cover', easeMm: 2, thicknessMm: leather.thicknessMm });
        const areaFn = (pat) => pat.pieces.reduce((s, p) => s + shoelaceArea(samplePieceOutlineIndependent(p, 16)), 0);
        assert(
          Math.abs(areaFn(shellAsm) - areaFn(shellPrt)) / Math.max(1, areaFn(shellAsm)) < 0.03,
          'Orientation invariance failed between assembled_view and print_ready'
        );

        // surface_panels unwrap + collision
        const panelsPat = core.unwrapSTLToPattern(meshPrt, {
          mode: 'surface_panels',
          easeMm: 2,
          thicknessMm: leather.thicknessMm,
          seamAllowance: 8,
          materialId: 'veg_leather',
        });
        assert(panelsPat.pieces.length >= 2, 'Expected >=2 surface_panels pieces');
        for (const p of panelsPat.pieces) {
          assert(p.distortionPct === undefined || Number.isFinite(p.distortionPct), 'Non-finite distortionPct');
          assert(countSelfIntersections(samplePieceOutlineIndependent(p, 16)) === 0, `Surface panel ${p.name} self-intersects`);
        }

        const sim = new core.ClothSimulation(panelsPat, { stlMesh: meshPrt, materialId: 'veg_leather' });
        sim.step(50);
        const minDist = minParticleDistToSTLTriangles(sim.particles, indPrt.triangles, indPrt.bounds);
        assert(
          minDist >= leather.thicknessMm - 0.5,
          `Leather cover penetrated STL collision offset: minDist=${minDist.toFixed(3)}mm < ${leather.thicknessMm - 0.5}mm`
        );

        const svg = core.exportSVG(panelsPat);
        const dxf = core.exportDXF(panelsPat);
        assert((await verifyExportWithPython('svg', svg, { checkScale1to1: true })).ok, 'S05 SVG failed');
        assert((await verifyExportWithPython('dxf', dxf, { requireInsUnits4: true, requireClosedLwpolyline: true })).ok, 'S05 DXF failed');
      },
    },
    {
      id: 'T4-06',
      tier: 4,
      feature: 'S06:F05,F13,F21,F22,F23,F24,F25',
      features: ['S06', 'F05', 'F13', 'F21', 'F22', 'F23', 'F24', 'F25'],
      name: 'S06: Duck canvas tote bag roll yield & production pack (45"/54"/60" rolls, Cut-2 qty, 0.0mm gussets, SVG/PDF/DXF)',
      fn: async () => {
        const core = await loadCore();
        const pattern = core.generateTemplatePattern(
          'tote_bag',
          { widthMm: 400, heightMm: 420, gussetDepthMm: 120 },
          { materialId: 'duck_canvas' }
        );
        assert(pattern.pieces.length >= 5, `Expected >=5 tote pieces, got ${pattern.pieces.length}`);
        assert(buildSeamConnectivity(pattern).isFullyConnected, 'Tote bag straps/gussets must be wired into seam graph');

        const seams = core.validatePatternSeams(pattern);
        const gussetSeams = seams.filter((s) => /gusset|base|side/i.test(String(s.name || '')));
        assert(gussetSeams.length >= 1, 'Expected gusset seams on tote_bag');
        for (const gs of gussetSeams) {
          assert(gs.deltaMm <= 0.1, `Gusset seam ${gs.name} delta ${gs.deltaMm} > 0.1mm`);
        }

        const totalQty = pattern.pieces.reduce((s, p) => s + (Number(p.quantity) || 1), 0);
        const rolls = getRollList(core.FABRIC_ROLL_PRESETS);
        for (const r of rolls.slice(0, 3)) {
          const rw = getRollWidthMm(r);
          const nest = core.nestPatternPieces(pattern, { fabricWidthMm: rw, allowRotate90: true });
          assert(nest.placements.length >= totalQty, `Roll ${rw}mm missed Cut-2 quantity (${nest.placements.length} < ${totalQty})`);
          assertNoOverlappingPlacements(nest.placements, rw);
        }

        const svg = core.exportSVG(pattern);
        const dxf = core.exportDXF(pattern);
        const pdfRes = core.exportTiledPDF(pattern, { pageFormat: 'LETTER' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
        assert((await verifyExportWithPython('svg', svg, { checkScale1to1: true })).ok, 'S06 SVG failed');
        assert((await verifyExportWithPython('dxf', dxf, { requireInsUnits4: true })).ok, 'S06 DXF failed');
        assert((await verifyExportWithPython('pdf', pdfBytes, { pageFormat: 'LETTER' })).ok, 'S06 PDF failed');
      },
    },
    {
      id: 'T4-07',
      tier: 4,
      feature: 'S07:F07,F08,F11,F12,F18,F21,F25',
      features: ['S07', 'F07', 'F08', 'F11', 'F12', 'F18', 'F21', 'F25'],
      name: 'S07: Freeform ultralight ripstop pouch (pen draw, Bezier split, mirror/unfold, notches, ripstop 3D drape, 36x24 mat)',
      fn: async () => {
        const core = await loadCore();
        let half = core.createFreeformPiece(
          'PouchFront',
          [
            { x: 0, y: 0 },
            { x: 90, y: 0 },
            { x: 110, y: 80 },
            { x: 80, y: 150 },
            { x: 0, y: 150 },
          ],
          { seamAllowance: 8 }
        );
        half.edges[1].curve = { cp1: { x: 115, y: 20 }, cp2: { x: 120, y: 55 } };
        const origArc = sampleCubicArcLengthIndependent(
          half.points[1],
          half.edges[1].curve.cp1,
          half.edges[1].curve.cp2,
          half.points[2],
          128
        );
        half = core.splitPieceEdge(half, 1, 0.5) || half;
        const splitArc =
          sampleCubicArcLengthIndependent(
            half.points[1],
            half.edges[1]?.curve?.cp1 || half.edges[1]?.curve?.cp,
            half.edges[1]?.curve?.cp2,
            half.points[2],
            128
          ) +
          sampleCubicArcLengthIndependent(
            half.points[2],
            half.edges[2]?.curve?.cp1 || half.edges[2]?.curve?.cp,
            half.edges[2]?.curve?.cp2,
            half.points[3],
            128
          );
        assertNear(splitArc, origArc, 0.05, 'Ripstop pouch Bezier split arc length');

        half = core.addNotchToPiece(half, { edgeIndex: 0, t: 0.5, type: 'v', depthMm: 5 }) || half;
        const origHalfPoints = half.points.map((p) => ({ ...p }));
        const front = core.mirrorPieceAcrossEdge(half, half.points.length - 1);
        const frontOutline = samplePieceOutlineIndependent(front, 24);
        assert(shoelaceSignedArea(frontOutline) > 0, 'Mirrored pouch must preserve CCW');
        assert(countSelfIntersections(frontOutline) === 0, 'Mirrored pouch self-intersects');
        assert(front.notches.length >= 2, 'Mirrored pouch lost notches');

        const back = core.mirrorPieceAcrossEdge(
          core.createFreeformPiece('PouchBack', origHalfPoints, { seamAllowance: 8 }),
          origHalfPoints.length - 1
        );
        back.id = `${front.id}_back`;
        back.name = 'PouchBack';
        back.placement3D = { offset: { x: 0, y: 0, z: -30 }, normal: { x: 0, y: 0, z: -1 } };
        front.placement3D = { offset: { x: 0, y: 0, z: 30 }, normal: { x: 0, y: 0, z: 1 } };

        const pattern = {
          id: 'p-s07',
          name: 'RipstopPouch',
          unit: 'mm',
          materialId: 'ripstop_nylon',
          pieces: [front, back],
          seams: [{ id: 's-top', name: 'TopEdge', pieceA: front.id, edgeA: 0, pieceB: back.id, edgeB: 0 }],
        };

        const sim = new core.ClothSimulation(pattern, { materialId: 'ripstop_nylon' });
        const r1 = sim.step(1);
        const r50 = sim.step(49);
        assert(r50.avgSewGapMm <= r1.avgSewGapMm + 0.5, 'Ripstop pouch seam failed to converge');
        for (const p of sim.particles) {
          const pos = getParticlePos(p);
          assert(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z), 'Ripstop sim NaN');
        }

        const rolls = getRollList(core.FABRIC_ROLL_PRESETS);
        const mat = rolls.find((r) => /36|mat/i.test(String(r.id || r.name)) || Math.abs(getRollWidthMm(r) - 914) < 5) || rolls[0];
        const matW = getRollWidthMm(mat);
        const nest = core.nestPatternPieces(pattern, { fabricWidthMm: matW });
        assert(nest.placements.length >= 2, 'Expected >=2 pouch placements');
        assertNoOverlappingPlacements(nest.placements, matW);
      },
    },
    {
      id: 'T4-08',
      tier: 4,
      feature: 'S08:F07,F09,F14,F21,F24',
      features: ['S08', 'F07', 'F09', 'F14', 'F21', 'F24'],
      name: 'S08: Custom leather case with per-edge SA [0,12], stepped corners & miter bevel -> DXF LWPOLYLINE',
      fn: async () => {
        const core = await loadCore();
        let body = core.createRectanglePiece('LeatherBody', 160, 110, { seamAllowance: 12 });
        body = core.splitPieceEdge(body, 0, 0.5) || body; // top edge split into two collinear 80mm halves
        body.edges[0].seamAllowance = 0;  // left half 0mm fold
        body.edges[1].seamAllowance = 12; // right half 12mm seam

        const bodyCut = extractPts(core.computePieceCutBoundary(body));
        assert(countSelfIntersections(bodyCut) === 0, 'Stepped leather cut boundary self-intersects');
        const stepPts = bodyCut.filter((p) => Math.abs(p.x - 80) < 1.0 && p.y <= 0.5 && p.y >= -12.5);
        assert(stepPts.length >= 2, `Expected perpendicular stepped corner at x=80, got ${stepPts.length} pts`);

        // Acute spike flap to verify miter beveling prevents spike explosion
        const flap = core.createFreeformPiece(
          'AcuteFlap',
          [
            { x: 0, y: 0 },
            { x: 200, y: 0 },
            { x: 100, y: 12 },
          ],
          { seamAllowance: 10 }
        );
        const flapCut = extractPts(core.computePieceCutBoundary(flap));
        assert(countSelfIntersections(flapCut) === 0, 'Miter-beveled acute flap cut boundary self-intersects');
        const flapCutB = calcBounds(flapCut);
        assert(flapCutB.width < 320, `Miter spike exploded without beveling: width=${flapCutB.width}`);

        const meas = core.computePieceMeasurements(body);
        assert(meas && Number.isFinite(meas.area ?? meas.areaMm2 ?? shoelaceArea(body.points)), 'Invalid piece measurements');
        const leather = core.getMaterialConfig('veg_leather');
        const pattern = {
          id: 'p-s08',
          name: 'LeatherCase',
          unit: 'mm',
          materialId: 'veg_leather',
          material: leather,
          pieces: [body, flap],
          seams: [],
        };

        const dxf = core.exportDXF(pattern);
        const rDxf = await verifyExportWithPython('dxf', dxf, {
          requireInsUnits4: true,
          requireTablesLayer: true,
          requireClosedLwpolyline: true,
          requireCalibrationSquare: true,
          expectedPieces: [{ widthMm: 160, heightMm: 110, tolMm: 0.1 }],
        });
        assert(rDxf.ok, 'S08 DXF verification failed');
      },
    },
    {
      id: 'T4-09',
      tier: 4,
      feature: 'S09:F02,F06,F15,F18,F22,F23,F24,F27',
      features: ['S09', 'F02', 'F06', 'F15', 'F18', 'F22', 'F23', 'F24', 'F27'],
      name: 'S09: CLI full maker production pipeline (template, unwrap, verify-sim -> verified disk artifacts)',
      fn: async () => {
        await withTempDir(async (tmpDir) => {
          const tplDir = path.join(tmpDir, 'tpl_out');
          const stlDir = path.join(tmpDir, 'stl_out');
          await fsp.mkdir(tplDir, { recursive: true });
          await fsp.mkdir(stlDir, { recursive: true });

          const tplRes = await runCli([
            'template',
            '--type',
            'tote_bag',
            '--out',
            tplDir,
            '--format',
            'svg,pdf,dxf,json',
            '--page',
            'A4',
          ]);
          assert(tplRes.code === 0, `CLI template failed: ${tplRes.stderr}\n${tplRes.stdout}`);

          const tplFiles = await fsp.readdir(tplDir);
          const tplSvg = tplFiles.find((f) => f.endsWith('.svg'));
          const tplPdf = tplFiles.find((f) => f.endsWith('.pdf'));
          const tplDxf = tplFiles.find((f) => f.endsWith('.dxf'));
          const tplJson = tplFiles.find((f) => f.endsWith('.json'));
          assert(tplSvg && tplPdf && tplDxf && tplJson, `Missing template CLI outputs in [${tplFiles.join(', ')}]`);

          assert((await verifyExportWithPython('svg', await fsp.readFile(path.join(tplDir, tplSvg), 'utf8'))).ok, 'CLI tpl SVG failed');
          assert((await verifyExportWithPython('pdf', await fsp.readFile(path.join(tplDir, tplPdf)), { pageFormat: 'A4' })).ok, 'CLI tpl PDF failed');
          assert((await verifyExportWithPython('dxf', await fsp.readFile(path.join(tplDir, tplDxf), 'utf8'))).ok, 'CLI tpl DXF failed');

          const core = await loadCore();
          const imported = core.importPatternJSON(await fsp.readFile(path.join(tplDir, tplJson), 'utf8'));
          assert(imported.unit === 'mm' && imported.pieces.length >= 5, 'CLI JSON output invalid');

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
            stlDir,
            '--format',
            'svg,pdf,dxf,json',
          ]);
          assert(unwrapRes.code === 0, `CLI unwrap failed: ${unwrapRes.stderr}`);
          const stlFiles = await fsp.readdir(stlDir);
          assert(
            stlFiles.some((f) => f.endsWith('.svg')) &&
              stlFiles.some((f) => f.endsWith('.pdf')) &&
              stlFiles.some((f) => f.endsWith('.dxf')),
            `Missing unwrap CLI outputs in [${stlFiles.join(', ')}]`
          );

          const simTpl = await runCli(['verify-sim', '--template', 'tshirt', '--material', 'cotton_jersey', '--steps', '60']);
          assert(simTpl.code === 0, `CLI verify-sim --template failed: ${simTpl.stderr}`);
          const simStl = await runCli(['verify-sim', '--stl', WEDGE_PRINT_READY_STL, '--material', 'eva_foam_4mm', '--steps', '60']);
          assert(simStl.code === 0, `CLI verify-sim --stl failed: ${simStl.stderr}`);
        });
      },
    },
    {
      id: 'T4-10',
      tier: 4,
      feature: 'S10:F01,F06,F15,F16,F18,F22,F27',
      features: ['S10', 'F01', 'F06', 'F15', 'F16', 'F18', 'F22', 'F27'],
      name: 'S10: HTTP REST API full session lifecycle (/api/health -> catalog -> workspace-stls -> stl-content -> unwrap -> simulate -> export)',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const health = await srv.fetchJson('/api/health');
          assert(health.status === 200 && health.data?.ok === true, `/api/health invalid: ${health.text}`);
          assert(Number(health.data.port) === srv.port, `Health port ${health.data.port} != ${srv.port}`);

          const cat = await srv.fetchJson('/api/catalog');
          assert(cat.status === 200, `/api/catalog failed: ${cat.status}`);
          assert(cat.data.templates?.length === 5, 'Expected 5 templates in catalog');
          assert(cat.data.materials?.length >= 7, 'Expected >=7 materials in catalog');
          const rolls = cat.data.rolls || cat.data.fabricRolls;
          assert(Array.isArray(rolls) && rolls.length >= 4, 'Expected >=4 fabric rolls in catalog');
          assert(cat.data.pageFormats || cat.data.pdfFormats, 'Expected pageFormats in catalog');
          assert(cat.data.defaultAvatar, 'Expected defaultAvatar in catalog');

          const stls = await srv.fetchJson('/api/workspace-stls');
          assert(stls.status === 200 && Array.isArray(stls.data?.files), '/api/workspace-stls invalid');
          const fileNames = stls.data.files.map((f) => (typeof f === 'string' ? f : f.name || f.file));
          assert(fileNames.some((n) => n.includes('cutting_mat_wedge_assembled_view.stl')), 'Missing assembled_view STL');

          const rawStl = await srv.fetchText('/api/stl-content?file=cutting_mat_wedge_assembled_view.stl');
          assert(rawStl.status === 200, `/api/stl-content failed: ${rawStl.status}`);
          const indStl = parseAsciiSTLIndependent(rawStl.text);
          assert(indStl.triangleCount === 984, `Expected 984 tris from /api/stl-content, got ${indStl.triangleCount}`);

          const unwrapped = await srv.fetchJson('/api/unwrap-stl', {
            method: 'POST',
            body: {
              workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
              mode: 'form_shell_cover',
              easeMm: 3,
              thicknessMm: 4,
              seamAllowance: 8,
              materialId: 'eva_foam_4mm',
            },
          });
          assert(unwrapped.status === 200 && unwrapped.data?.pattern?.pieces?.length >= 1, `/api/unwrap-stl failed: ${unwrapped.text}`);
          const summary = unwrapped.data.stlSummary || unwrapped.data.mesh;
          assert(summary?.triangleCount === 984, 'STL summary triangle count mismatch');

          const sim = await srv.fetchJson('/api/simulate', {
            method: 'POST',
            body: { pattern: unwrapped.data.pattern, steps: 30 },
          });
          assert(sim.status === 200 && sim.data?.finiteOk !== false, `/api/simulate failed: ${sim.text}`);
          assert(Array.isArray(sim.data.particles) && sim.data.particles.length > 0, 'Empty particles from /api/simulate');

          for (const [fmt, mime, verifierFmt] of [
            ['svg', 'image/svg+xml', 'svg'],
            ['pdf', 'application/pdf', 'pdf'],
            ['dxf', 'application/dxf', 'dxf'],
          ]) {
            const exp = await srv.fetchBuffer('/api/export', {
              method: 'POST',
              body: { pattern: unwrapped.data.pattern, format: fmt, options: { pageFormat: 'LETTER' } },
            });
            assert(exp.status === 200, `/api/export ${fmt} failed: ${exp.status}`);
            const ct = exp.headers.get('content-type') || '';
            assert(ct.toLowerCase().includes(mime), `Expected ${mime}, got ${ct}`);
            assert(exp.headers.get('content-disposition'), `Missing Content-Disposition for ${fmt}`);
            const content = verifierFmt === 'pdf' ? exp.buffer : exp.buffer.toString('utf8');
            assert((await verifyExportWithPython(verifierFmt, content)).ok, `API exported ${fmt} failed verify_exports.py`);
          }
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T4-11',
      tier: 4,
      feature: 'S11:F27',
      features: ['S11', 'F27'],
      name: 'S11: Remote SSH startup banner, HOST/PORT env override & path traversal guard',
      fn: async () => {
        // 1. Default 0.0.0.0 startup banner & security guards
        const srv = await startTestServer({ port: 0 });
        try {
          const out = srv.getStdout() + '\n' + srv.getStderr();
          const expectedHost = os.hostname() || 'localhost';
          const escHost = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          assert(out.includes(`127.0.0.1:${srv.port}`), `Missing 127.0.0.1:<port> in startup output:\n${out}`);
          assert(out.includes(`${expectedHost}:${srv.port}`), `Missing Remote URL in startup output:\n${out}`);
          assert(
            new RegExp(`ssh\\s+-L\\s+${srv.port}:localhost:${srv.port}\\s+${escHost}`).test(out),
            `Missing SSH tunnel command in startup output:\n${out}`
          );

          const travStl = await srv.fetchJson('/api/stl-content?file=../../etc/passwd');
          assert(travStl.status === 404, `Expected 404 on STL traversal, got ${travStl.status}`);

          const travStatic = await srv.fetchText('/../../etc/passwd');
          assert(travStatic.status === 403 || travStatic.status === 404, `Expected 403/404 on static traversal, got ${travStatic.status}`);

          const badStl = await srv.fetchJson('/api/unwrap-stl', { method: 'POST', body: { stlText: '' } });
          assert(badStl.status === 400, `Expected 400 on empty STL, got ${badStl.status}`);
        } finally {
          await srv.stop();
        }

        // 2. HOST / PORT environment override without CLI flags
        const freePort = await getUnusedPort();
        const serverPath = path.join(V2_ROOT, 'src', 'server.mjs');
        const child = spawn(process.execPath, [serverPath], {
          cwd: V2_ROOT,
          env: { ...process.env, HOST: '127.0.0.1', PORT: String(freePort) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let buf = '';
        try {
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`HOST/PORT env server startup timeout:\n${buf}`)), 8000);
            const check = (chunk) => {
              buf += chunk.toString('utf8');
              if (buf.includes(`:${freePort}`)) {
                clearTimeout(t);
                setTimeout(resolve, 60);
              }
            };
            child.stdout.on('data', check);
            child.stderr.on('data', check);
            child.once('close', (c) => {
              clearTimeout(t);
              reject(new Error(`Server exited early (${c}):\n${buf}`));
            });
          });
          const res = await fetch(`http://127.0.0.1:${freePort}/api/health`);
          assert(res.status === 200, `Env override health failed: ${res.status}`);
          const data = await res.json();
          assert(Number(data.port) === freePort, `Expected port ${freePort}, got ${data.port}`);
        } finally {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          await new Promise((resolve) => {
            const kt = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
              resolve();
            }, 1500);
            child.once('close', () => {
              clearTimeout(kt);
              resolve();
            });
          });
        }
      },
    },
    {
      id: 'T4-12',
      tier: 4,
      feature: 'S12:F26,F27',
      features: ['S12', 'F26', 'F27'],
      name: 'S12: Headless Chrome CDP full studio UI workflow (explicitly fails BROWSER_UNAVAILABLE if Chrome unmounted)',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const result = await runChromeCDPCheck(srv.baseUrl);
          assert(
            result.ok === true &&
              result.docStatus === 200 &&
              result.stlChecked === true &&
              result.exportTriggered === true &&
              result.templateSwitched === true,
            `Chrome CDP check did not verify all required UI workflows: ${JSON.stringify(result)}`
          );
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T4-13',
      tier: 4,
      feature: 'S13:F26,F27',
      features: ['S13', 'F26', 'F27'],
      name: 'S13: Static frontend asset, ESM module graph & WebGL2 shader integrity check (Node v24 DOM-free)',
      fn: async () => {
        const srv = await startTestServer({ port: 0 });
        try {
          const htmlRes = await srv.fetchText('/');
          assert(htmlRes.status === 200, `GET / failed: ${htmlRes.status}`);
          assert((htmlRes.headers.get('content-type') || '').includes('text/html'), 'GET / must return text/html');
          assert(/<canvas\b/i.test(htmlRes.text), 'index.html missing <canvas>');
          assert(/<script[^>]+type=["']module["'][^>]+app\.mjs/i.test(htmlRes.text), 'index.html missing module script app.mjs');

          const cssRes = await srv.fetchText('/styles.css');
          assert(cssRes.status === 200, `GET /styles.css failed: ${cssRes.status}`);
          assert(/@media\s*\(/i.test(cssRes.text), 'styles.css missing responsive @media breakpoints');

          const jsAssets = ['/app.mjs', '/cad2d.mjs', '/webgl3d.mjs', '/src/core/index.mjs'];
          const fetched = new Map();
          for (const assetPath of jsAssets) {
            const res = await srv.fetchText(assetPath);
            assert(res.status === 200, `GET ${assetPath} failed: ${res.status}`);
            const ct = res.headers.get('content-type') || '';
            assert(/javascript/i.test(ct), `Expected JS MIME for ${assetPath}, got ${ct}`);
            fetched.set(assetPath, res.text);
          }

          // Verify WebGL2 shader keywords in webgl3d.mjs
          const glSrc = fetched.get('/webgl3d.mjs');
          assert(/webgl2/i.test(glSrc), 'webgl3d.mjs missing webgl2 context initialization');
          assert(/gl_Position/.test(glSrc) && /createShader/.test(glSrc) && /createProgram/.test(glSrc), 'webgl3d.mjs missing WebGL2 shader pipeline');

          // Discover and check syntax of all fetched ESM files and their local relative imports
          await withTempDir(async (tmpDir) => {
            const queue = [...jsAssets];
            const visited = new Set();
            while (queue.length > 0) {
              const urlPath = queue.shift();
              if (visited.has(urlPath)) continue;
              visited.add(urlPath);

              let code = fetched.get(urlPath);
              if (code === undefined) {
                const r = await srv.fetchText(urlPath);
                assert(r.status === 200, `Broken ESM import ${urlPath}: HTTP ${r.status}`);
                code = r.text;
              }

              const localPath = path.join(tmpDir, urlPath.replace(/^\/+/, ''));
              await fsp.mkdir(path.dirname(localPath), { recursive: true });
              await fsp.writeFile(localPath, code, 'utf8');
              await nodeCheckFile(localPath);

              const importRe = /(?:import|export)\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
              let m;
              while ((m = importRe.exec(code)) !== null) {
                const spec = m[1] || m[2];
                if (spec && (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/'))) {
                  const resolved = path.posix.resolve(path.posix.dirname(urlPath), spec);
                  if (!visited.has(resolved)) queue.push(resolved);
                }
              }
            }
          });
        } finally {
          await srv.stop();
        }
      },
    },
    {
      id: 'T4-14',
      tier: 4,
      feature: 'S14:F01,F14,F22,F23,F24',
      features: ['S14', 'F01', 'F14', 'F22', 'F23', 'F24'],
      name: 'S14: Multi-format roundtrip & unit consistency (mm/cm/in + JSON roundtrip + SVG/DXF/PDF <= 0.1 mm)',
      fn: async () => {
        const core = await loadCore();
        const wMm = core.unitToMm(6, 'in'); // 152.4 mm
        const hMm = core.unitToMm(4, 'in'); // 101.6 mm
        assertNear(core.mmToUnit(wMm, 'cm'), 15.24, 1e-6, 'mm->cm');
        assertNear(core.mmToUnit(hMm, 'in'), 4.0, 1e-6, 'mm->in');

        const rect = core.createRectanglePiece('UnitPlate', wMm, hMm, { seamAllowance: 0 });
        const rawProject = {
          id: 'p-s14',
          name: 'UnitRoundtrip',
          unit: 'mm',
          pieces: [rect],
          seams: [],
        };
        const restored = core.importPatternJSON(core.exportPatternJSON(rawProject));
        assert(restored.unit === 'mm', 'Restored project unit must be mm');

        const exp = {
          expectedPieces: [{ widthMm: 152.4, heightMm: 101.6, areaMm2: 152.4 * 101.6, perimeterMm: 508.0, tolMm: 0.1 }],
        };
        const svg = core.exportSVG(restored);
        const dxf = core.exportDXF(restored);
        const pdfRes = core.exportTiledPDF(restored, { pageFormat: 'A4' });
        const pdfBytes = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');

        assert((await verifyExportWithPython('svg', svg, { ...exp, checkScale1to1: true })).ok, 'S14 SVG failed');
        assert((await verifyExportWithPython('dxf', dxf, exp)).ok, 'S14 DXF failed');
        assert((await verifyExportWithPython('pdf', pdfBytes, { ...exp, pageFormat: 'A4', checkPage1PieceBounds: true })).ok, 'S14 PDF failed');
      },
    },
    {
      id: 'T4-15',
      tier: 4,
      feature: 'S15:F27',
      features: ['S15', 'F27'],
      name: 'S15: pattern_studio/ baseline SHA-256 non-modification isolation check (16 files intact)',
      fn: async () => {
        const res = await verifyPatternStudioIsolation();
        assert(res.ok === true, 'pattern_studio/ baseline isolation failed');
        assert(res.checkedCount === 16, `Expected 16 baseline files verified, got ${res.checkedCount}`);
      },
    },
  ];
}
