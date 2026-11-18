import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from '../src/core/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V2_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(V2_ROOT, '..');
const WEDGE_ASSEMBLED_STL = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge_assembled_view.stl');
const WEDGE_PRINT_READY_STL = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge_print_ready.stl');

function polygonArea2D(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

function convexHullArea2D(pts) {
  const sorted = [...pts].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return Math.abs(polygonArea2D([...lower, ...upper]));
}

function makeBinarySTLWithSolidHeader(triangles, headerText = 'solid fake binary header') {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.write(headerText.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(triangles.length, 80);
  let off = 84;
  for (const [a, b, c] of triangles) {
    buf.writeFloatLE(0, off);
    buf.writeFloatLE(0, off + 4);
    buf.writeFloatLE(1, off + 8);
    buf.writeFloatLE(a.x, off + 12);
    buf.writeFloatLE(a.y, off + 16);
    buf.writeFloatLE(a.z, off + 20);
    buf.writeFloatLE(b.x, off + 24);
    buf.writeFloatLE(b.y, off + 28);
    buf.writeFloatLE(b.z, off + 32);
    buf.writeFloatLE(c.x, off + 36);
    buf.writeFloatLE(c.y, off + 40);
    buf.writeFloatLE(c.z, off + 44);
    buf.writeUInt16LE(0, off + 48);
    off += 50;
  }
  return buf;
}

// ----------------------------------------------------------------------------
// 1. Barrel, M1 Hook Preservation & Conditional stl_cover Integration
// ----------------------------------------------------------------------------
test('M2/M3 barrel exports all M1/M2/M3 symbols and wires conditional stl_cover', () => {
  const indexSrc = fs.readFileSync(path.join(V2_ROOT, 'src/core/index.mjs'), 'utf8');
  assert.match(indexSrc, /^export\s+\*\s+from\s+'\.\/nesting\.mjs';/m);
  assert.match(indexSrc, /^export\s+\*\s+from\s+'\.\/exporters\.mjs';/m);

  const templatesSrc = fs.readFileSync(path.join(V2_ROOT, 'src/core/templates.mjs'), 'utf8');
  assert.equal(/\.\/stl\.mjs/.test(templatesSrc), false);

  for (const fn of [
    'parseSTL',
    'analyzeSTLTopology',
    'unwrapSTLToPattern',
    'createBoxSTL',
    'createWedgeSTL',
    'serializeTrianglesToSTL',
    'WEAVE_TYPES',
    'MATERIAL_PRESETS',
    'getMaterialConfig',
    'getMaterialPreset',
    'generateProceduralPBRMaps',
    'generateProceduralWeaveSVG',
    'DEFAULT_AVATAR',
    'createParametricAvatar',
    'ClothSimulation',
    'runSimulationSteps',
  ]) {
    assert.ok(core[fn] !== undefined, `Expected core.${fn} to be exported`);
  }

  // M1 stub still works when no STL input is provided
  const stubPat = core.generateTemplatePattern('stl_cover');
  assert.equal(stubPat.isStub, true);
  assert.throws(() => core.generateTemplatePattern('stl_cover', {}, { requireStl: true }), /requires M2 stl\.mjs/i);

  // With STL input, real unwrapped pattern is produced and validates cleanly
  const stlText = fs.readFileSync(WEDGE_ASSEMBLED_STL, 'utf8');
  const realPat = core.generateTemplatePattern('stl_cover', {
    stlText,
    easeMm: 2,
    materialId: 'eva_foam_4mm',
    seamAllowance: 8,
  });
  assert.equal(Boolean(realPat.isStub), false);
  assert.ok(realPat.pieces.length >= 10);
  assert.ok(realPat.seams.length >= 10);
  assert.equal(realPat.stlMetadata.triangleCount, 984);
  const val = core.validatePatternProject(realPat);
  assert.equal(val.valid, true, `Validation errors: ${JSON.stringify(val.errors)}`);
});

// ----------------------------------------------------------------------------
// 2. F21: Materials & Isomorphic Procedural PBR Maps + Weave SVG
// ----------------------------------------------------------------------------
test('F21: MATERIAL_PRESETS, WEAVE_TYPES, getMaterialConfig clamping/zero preservation, and PBR/SVG generation', () => {
  assert.ok(Object.keys(core.WEAVE_TYPES).length >= 6);
  const expectedIds = [
    'cotton_jersey',
    'heavy_fleece',
    'heavy_denim',
    'duck_canvas',
    'ripstop_nylon',
    'veg_leather',
    'eva_foam_4mm',
    'cotton_poplin',
  ];
  for (const id of expectedIds) {
    assert.ok(core.MATERIAL_PRESETS[id], `Missing material preset ${id}`);
  }
  assert.equal(core.getMaterialPreset('heavy_denim').id, 'heavy_denim');

  // Non-mutating clone + unknown fallback + clamping + thicknessMm: 0 preservation
  const baseRough = core.MATERIAL_PRESETS.veg_leather.roughness;
  const custom = core.getMaterialConfig('veg_leather', {
    roughness: 5.2,
    sheen: -0.7,
    damping: 2.0,
    friction: -1.0,
    thicknessMm: 0,
  });
  assert.equal(core.MATERIAL_PRESETS.veg_leather.roughness, baseRough);
  assert.equal(custom.roughness, 1);
  assert.equal(custom.sheen, 0);
  assert.equal(custom.damping, 1);
  assert.equal(custom.friction, 0);
  assert.equal(custom.thicknessMm, 0);

  const fallback = core.getMaterialConfig('totally_unknown_fabric_id');
  assert.ok(fallback && typeof fallback.id === 'string' && fallback.gsm > 0);

  for (const sizePx of [16, 64]) {
    const maps = core.generateProceduralPBRMaps(core.getMaterialConfig('heavy_denim'), sizePx);
    for (const key of ['albedo', 'normal', 'roughness', 'ao', 'height']) {
      const m = maps[key];
      assert.equal(m.width, sizePx);
      assert.equal(m.height, sizePx);
      assert.ok(m.data instanceof Uint8Array);
      assert.equal(m.data.length, sizePx * sizePx * 4);
      let minR = 255;
      let maxR = 0;
      for (let i = 0; i < m.data.length; i += 4) {
        if (m.data[i] < minR) minR = m.data[i];
        if (m.data[i] > maxR) maxR = m.data[i];
      }
      assert.ok(maxR > minR, `Expected non-constant R channel in ${key} map at ${sizePx}px`);
    }
    // Check tangent-space normal Z stays positive
    for (let i = 2; i < maps.normal.data.length; i += 4) {
      assert.ok(maps.normal.data[i] >= 128);
    }
  }

  const svg = core.generateProceduralWeaveSVG(core.getMaterialConfig('ripstop_nylon'), 96);
  assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'));
});

// ----------------------------------------------------------------------------
// 3. F15: STL Parsing (ASCII/Binary/"solid " header) & Topology Analysis
// ----------------------------------------------------------------------------
test('F15: parseSTL handles ASCII, binary, "solid " binary disambiguation, errors, and genus-3 topology', () => {
  // Error handling on invalid inputs
  assert.throws(() => core.parseSTL(''), core.ValidationError);
  assert.throws(() => core.parseSTL(null), core.ValidationError);
  assert.throws(() => core.parseSTL(new Uint8Array(40)), core.ValidationError);
  assert.throws(() => core.parseSTL('solid empty\nendsolid empty\n'), core.ValidationError);

  // Synthetic binary STL starting with "solid " header
  const tri = [
    [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 0, y: 100, z: 0 },
    ],
  ];
  const solidBin = makeBinarySTLWithSolidHeader(tri, 'solid deceptive binary STL');
  const parsedSolidBin = core.parseSTL(solidBin, 'deceptive.stl');
  assert.equal(parsedSolidBin.format, 'binary');
  assert.equal(parsedSolidBin.faceCount, 1);
  assert.ok(Math.abs(parsedSolidBin.surfaceAreaMm2 - 5000) < 1e-2);

  // Scientific notation + CRLF ASCII STL
  const crlfAscii = [
    'solid sci',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0.0e0 0.0e0 0',
    '      vertex 1.0e2 0 0',
    '      vertex 0 5.0e1 0',
    '    endloop',
    '  endfacet',
    'endsolid sci',
  ].join('\r\n');
  const parsedSci = core.parseSTL(crlfAscii, 'sci.stl');
  assert.equal(parsedSci.format, 'ascii');
  assert.ok(Math.abs(parsedSci.surfaceAreaMm2 - 2500) < 1e-2);

  // Box & Wedge binary roundtrip
  const boxBin = core.createBoxSTL(80, 60, 40, true);
  const boxMesh = core.parseSTL(boxBin, 'box.stl');
  assert.equal(boxMesh.format, 'binary');
  assert.equal(boxMesh.faceCount, 12);
  assert.equal(boxMesh.shellCount, 1);
  assert.equal(boxMesh.euler, 2);
  assert.ok(Math.abs(boxMesh.surfaceAreaMm2 - 2 * (80 * 60 + 80 * 40 + 60 * 40)) < 1e-1);
  assert.ok(Math.abs(boxMesh.volumeMm3 - 80 * 60 * 40) < 1);

  const wedgeAscii = core.createWedgeSTL(150, 100, 50, 10, false);
  const wedgeMesh = core.parseSTL(wedgeAscii, 'wedge.stl');
  assert.equal(wedgeMesh.faceCount, 12);
  assert.equal(wedgeMesh.shellCount, 1);

  // Multi-shell check via serializeTrianglesToSTL
  const shiftedBox = boxMesh.triangles.map((t) => t.map((v) => ({ x: v.x + 300, y: v.y, z: v.z })));
  const twoShells = core.analyzeSTLTopology(core.serializeTrianglesToSTL([...boxMesh.triangles, ...shiftedBox], 'two', false));
  assert.equal(twoShells.shellCount, 2);

  // Real verification STLs: watertight genus-3 shell (V=488, E=1476, F=984, euler=-4)
  const assembled = core.parseSTL(fs.readFileSync(WEDGE_ASSEMBLED_STL, 'utf8'), 'assembled.stl');
  const printReady = core.parseSTL(fs.readFileSync(WEDGE_PRINT_READY_STL, 'utf8'), 'print_ready.stl');
  for (const m of [assembled, printReady]) {
    assert.equal(m.faceCount, 984);
    assert.equal(m.weldedVertexCount, 488);
    assert.equal(m.edgeCount, 1476);
    assert.equal(m.boundaryEdges, 0);
    assert.equal(m.nonManifoldEdges, 0);
    assert.equal(m.shellCount, 1);
    assert.equal(m.euler, -4);
    assert.ok(Math.abs(m.surfaceAreaMm2 - 123931.51) < 1.0);
  }
  assert.equal(assembled.bounds.size.y.toFixed(2), '164.36');
  assert.equal(printReady.bounds.size.z.toFixed(2), '164.36');
});

// ----------------------------------------------------------------------------
// 4. F16: Orientation-Invariant Concave Cover & Surface Panels Unwrapping
// ----------------------------------------------------------------------------
test('F16: unwrapSTLToPattern preserves concavity, orientation invariance, linear scaling & surface_panels seams', () => {
  const assembled = core.parseSTL(fs.readFileSync(WEDGE_ASSEMBLED_STL, 'utf8'), 'assembled.stl');
  const printReady = core.parseSTL(fs.readFileSync(WEDGE_PRINT_READY_STL, 'utf8'), 'print_ready.stl');

  const patA = core.unwrapSTLToPattern(assembled, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 1 });
  const patP = core.unwrapSTLToPattern(printReady, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 1 });

  assert.equal(patA.pieces.length, patP.pieces.length);
  assert.equal(patA.pieces.length, 13);

  const areaA = Math.abs(polygonArea2D(patA.pieces[0].points));
  const areaP = Math.abs(polygonArea2D(patP.pieces[0].points));
  assert.ok(Math.abs(areaA - areaP) < 50, `Expected orientation-invariant area parity (${areaA} vs ${areaP})`);

  const hullA = convexHullArea2D(patA.pieces[0].points);
  assert.ok(areaA / hullA <= 0.94, `Concave hook recess lost: ratio=${(areaA / hullA).toFixed(3)}`);

  for (const p of patA.pieces) {
    assert.ok(polygonArea2D(p.points) > 0, `${p.id} must be CCW`);
    assert.equal(core.polygonSelfIntersects(p.points), false, `${p.id} self-intersects`);
    assert.ok(Number.isFinite(p.distortionPct) && p.distortionPct >= 0);
  }
  assert.equal(core.validatePatternProject(patA).valid, true);

  // Scale invariance (0.5x -> 0.25x area, 2x -> 4x area) and thickness expansion
  const patHalf = core.unwrapSTLToPattern(assembled, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 0.5 });
  const patDouble = core.unwrapSTLToPattern(assembled, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 0, scale: 2.0 });
  const areaHalf = Math.abs(polygonArea2D(patHalf.pieces[0].points));
  const areaDouble = Math.abs(polygonArea2D(patDouble.pieces[0].points));
  assert.ok(Math.abs(areaHalf / areaA - 0.25) < 0.03);
  assert.ok(Math.abs(areaDouble / areaA - 4.0) < 0.05);

  const patThick = core.unwrapSTLToPattern(assembled, { mode: 'form_shell_cover', easeMm: 0, thicknessMm: 6.0, scale: 1 });
  assert.ok(Math.abs(polygonArea2D(patThick.pieces[0].points)) > areaA + 500);

  // Surface panels (dihedral BFS + chart_unfold alias) on box gives 6 panels & all 12 seams
  const boxMesh = core.parseSTL(core.createBoxSTL(100, 100, 100, false), 'box.stl');
  const boxPanels = core.unwrapSTLToPattern(boxMesh, { mode: 'chart_unfold', dihedralThresholdDeg: 28, easeMm: 0 });
  assert.equal(boxPanels.pieces.length, 6);
  assert.equal(boxPanels.seams.length, 12);
  assert.equal(core.validatePatternProject(boxPanels).valid, true);

  // Dihedral threshold sweep on wedge STL
  const coarseCharts = core.unwrapSTLToPattern(assembled, { mode: 'surface_panels', dihedralThresholdDeg: 89 });
  const fineCharts = core.unwrapSTLToPattern(assembled, { mode: 'surface_panels', dihedralThresholdDeg: 5 });
  assert.ok(fineCharts.pieces.length > coarseCharts.pieces.length);
  assert.equal(core.validatePatternProject(coarseCharts).valid, true);
});

// ----------------------------------------------------------------------------
// 5. F18/F19/F20: XPBD Cloth Simulation, Parametric Avatar, BVH STL & Strain
// ----------------------------------------------------------------------------
test('F18-F20: XPBD sewing/darts, anisotropic drape, parametric avatar, BVH STL collision & strain heatmap', () => {
  // Avatar scaling & cm support
  assert.ok(core.DEFAULT_AVATAR && core.DEFAULT_AVATAR.colliders.length >= 7);
  const smallAv = core.createParametricAvatar({ chestCm: 82, waistCm: 64, hipCm: 86, heightCm: 158 });
  const largeAv = core.createParametricAvatar({ chestCm: 120, waistCm: 102, hipCm: 124, heightCm: 188 });
  const widthOf = (av) => {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const v of av.vertices) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
    }
    return maxX - minX;
  };
  assert.ok(widthOf(largeAv) > widthOf(smallAv) + 80);

  // steps: 0 preserves initial state and explicit thicknessMm: 0 + avatar: null
  const tshirt = core.generateTemplatePattern('tshirt', { chestMm: 1200, easeMm: 140 });
  const zeroRes = core.runSimulationSteps(tshirt, {
    steps: 0,
    avatar: null,
    materialOverrides: { thicknessMm: 0 },
  });
  assert.equal(zeroRes.strainReport.stepCount, 0);
  assert.equal(zeroRes.finiteOk, true);

  // Progressive sewing reduces avgSewGapMm
  const simSew = new core.ClothSimulation(tshirt, { avatar: smallAv, materialId: 'cotton_jersey' });
  const g0 = simSew.computeStrainAnalysis().avgSewGapMm;
  const g40 = simSew.step(40).avgSewGapMm;
  assert.ok(g40 < g0 * 0.5, `Expected sewing gap to drop substantially (${g0} -> ${g40})`);

  // Dart closing springs deform cloth vs dartless control
  const dRect = core.createRectanglePiece('Darted', 180, 180, { seamAllowance: 8 });
  const plainRect = core.createRectanglePiece('Plain', 180, 180, { seamAllowance: 8 });
  dRect.darts = [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 34, depthMm: 75, folded: false }];
  const dProj = core.createPatternProject({ name: 'DartTest', pieces: [dRect], seams: [] });
  const pProj = core.createPatternProject({ name: 'PlainTest', pieces: [plainRect], seams: [] });
  const dRes = core.runSimulationSteps(dProj, { steps: 30, avatar: null });
  const pRes = core.runSimulationSteps(pProj, { steps: 30, avatar: null });
  let maxDartDelta = 0;
  for (let i = 0; i < Math.min(dRes.particles.length, pRes.particles.length); i++) {
    const a = dRes.particles[i].pos;
    const b = pRes.particles[i].pos;
    const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (dist > maxDartDelta) maxDartDelta = dist;
  }
  assert.ok(maxDartDelta > 3.0);

  // Degenerate zero-area triangle in STL mesh safely guarded
  const wedgeMesh = core.parseSTL(core.createWedgeSTL(150, 150, 70, 12, false), 'w.stl');
  const degenSTL = core.analyzeSTLTopology({
    triangles: [
      ...wedgeMesh.triangles,
      [
        { x: 10, y: 10, z: 10 },
        { x: 10, y: 10, z: 10 },
        { x: 10, y: 10, z: 10 },
      ],
    ],
  });
  const coverPat = core.unwrapSTLToPattern(wedgeMesh, { mode: 'surface_panels', easeMm: 1 });
  const degenRes = core.runSimulationSteps(coverPat, { steps: 30, stlMesh: degenSTL, avatar: null });
  assert.equal(degenRes.finiteOk, true);

  // Strain heatmap fitStatus & non-negative clamping
  const tightPat = core.generateTemplatePattern('tshirt', { chestMm: 700, easeMm: 0 });
  const tightRes = core.runSimulationSteps(tightPat, {
    steps: 50,
    avatar: largeAv,
    materialId: 'heavy_denim',
    materialOverrides: { maxSafeStrainPct: 3 },
  });
  assert.equal(tightRes.strainReport.fitStatus, 'too_tight');
  assert.equal(tightRes.strainReport.vertexColors.length, tightRes.particles.length * 3);

  const compSim = new core.ClothSimulation(pProj, { avatar: null });
  for (const pt of compSim.particles) {
    pt.pos.x *= 0.4;
    pt.pos.y *= 0.4;
  }
  const compReport = compSim.step(1);
  assert.ok(compReport.meanStrainPct >= 0 && compReport.maxStrainPct >= 0);
});

// ============================================================================
// M2 Iteration 2 Regression Tests (Fixes 1–13)
// ============================================================================

function rotateTris(triangles, rxDeg, ryDeg, rzDeg) {
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const rz = (rzDeg * Math.PI) / 180;
  const rotPt = (p) => {
    let { x, y, z } = p;
    // Rx
    {
      const y1 = y * Math.cos(rx) - z * Math.sin(rx);
      const z1 = y * Math.sin(rx) + z * Math.cos(rx);
      y = y1;
      z = z1;
    }
    // Ry
    {
      const x1 = x * Math.cos(ry) + z * Math.sin(ry);
      const z1 = -x * Math.sin(ry) + z * Math.cos(ry);
      x = x1;
      z = z1;
    }
    // Rz
    {
      const x1 = x * Math.cos(rz) - y * Math.sin(rz);
      const y1 = x * Math.sin(rz) + y * Math.cos(rz);
      x = x1;
      y = y1;
    }
    return { x, y, z };
  };
  return core.parseSTL(
    toAsciiSTL(
      triangles.map((t) => {
        const v0 = Array.isArray(t) ? t[0] : (t.v0 ?? t.a);
        const v1 = Array.isArray(t) ? t[1] : (t.v1 ?? t.b);
        const v2 = Array.isArray(t) ? t[2] : (t.v2 ?? t.c);
        return [rotPt(v0), rotPt(v1), rotPt(v2)];
      }),
      'rot'
    ),
    'rot.stl'
  );
}

function toAsciiSTL(tris, name = 'mesh') {
  const lines = [`solid ${name}`];
  for (const [a, b, c] of tris) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    lines.push(`      vertex ${a.x} ${a.y} ${a.z}`);
    lines.push(`      vertex ${b.x} ${b.y} ${b.z}`);
    lines.push(`      vertex ${c.x} ${c.y} ${c.z}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

function toBinarySTLBuffer(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    const v0 = Array.isArray(t) ? t[0] : (t.v0 ?? t.a);
    const v1 = Array.isArray(t) ? t[1] : (t.v1 ?? t.b);
    const v2 = Array.isArray(t) ? t[2] : (t.v2 ?? t.c);
    off += 12; // normal zeros
    for (const v of [v0, v1, v2]) {
      dv.setFloat32(off, v.x, true);
      dv.setFloat32(off + 4, v.y, true);
      dv.setFloat32(off + 8, v.z, true);
      off += 12;
    }
    off += 2; // attr
  }
  return buf;
}

function buildPrismaticSTL(poly2D, height) {
  const tris = [];
  const { vertices, triangles } = core.triangulatePolygon(poly2D);
  const n = vertices.length;
  for (const [ia, ib, ic] of triangles) {
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    tris.push([
      { x: a.x, y: 0, z: a.y },
      { x: b.x, y: 0, z: b.y },
      { x: c.x, y: 0, z: c.y },
    ]);
    tris.push([
      { x: a.x, y: height, z: a.y },
      { x: c.x, y: height, z: c.y },
      { x: b.x, y: height, z: b.y },
    ]);
  }
  for (let i = 0; i < n; i++) {
    const p0 = vertices[i];
    const p1 = vertices[(i + 1) % n];
    const a0 = { x: p0.x, y: 0, z: p0.y };
    const a1 = { x: p1.x, y: 0, z: p1.y };
    const b0 = { x: p0.x, y: height, z: p0.y };
    const b1 = { x: p1.x, y: height, z: p1.y };
    tris.push([a0, b0, b1], [a0, b1, a1]);
  }
  return core.parseSTL(toAsciiSTL(tris, 'prism'), 'prism.stl');
}

function closestTriDistExact(p, a, b, c) {
  const sub = (u, v) => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const dot = (u, v) => u.x * v.x + u.y * v.y + u.z * v.z;
  const add = (u, v) => ({ x: u.x + v.x, y: u.y + v.y, z: u.z + v.z });
  const sc = (u, s) => ({ x: u.x * s, y: u.y * s, z: u.z * s });
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const dq = sub(p, add(a, sc(ab, d1 / (d1 - d3))));
    return dot(dq, dq);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const dq = sub(p, add(a, sc(ac, d2 / (d2 - d6))));
    return dot(dq, dq);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const dq = sub(p, add(b, sc(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))));
    return dot(dq, dq);
  }
  const denom = 1 / (va + vb + vc);
  const q = add(a, add(sc(ab, vb * denom), sc(ac, vc * denom)));
  const dq = sub(p, q);
  return dot(dq, dq);
}

test('M2 r2 regression: form_shell_cover right-cap seam twist, off-axis 3D orientation & planar triangle fallback', () => {
  const wedgeMesh = core.parseSTL(fs.readFileSync(WEDGE_ASSEMBLED_STL), 'wedgeA.stl');
  const pat = core.unwrapSTLToPattern(wedgeMesh, { mode: 'form_shell_cover' });
  const rightSeams = pat.seams.filter((s) => /_right$/.test(s.id));
  assert.ok(rightSeams.length > 0);
  for (const s of rightSeams) {
    assert.equal(s.reversed, true, `expected ${s.id} to have reversed: true`);
  }

  const sim = new core.ClothSimulation(pat, { stlMesh: wedgeMesh, materialId: 'veg_leather' });
  const r0 = sim.step(0);
  assert.ok(r0.avgSewGapMm < 8, `expected form_shell_cover s0 avgSewGapMm < 8, got ${r0.avgSewGapMm}`);
  const r60 = sim.step(60);
  assert.ok(r60.maxStrainPct < 10, `expected form_shell_cover s60 maxStrainPct < 10, got ${r60.maxStrainPct}`);

  // Off-axis 3D orientation invariance
  const baseCaps = pat.pieces.filter((p) => p.role === 'stl_profile');
  assert.equal(baseCaps.length, 2);
  const baseCapArea = baseCaps.reduce((s, p) => s + Math.abs(polygonArea2D(p.points)), 0);
  for (const [rx, ry, rz] of [
    [45, 0, 0],
    [0, 0, 45],
    [37, 53, 19],
    [120, -45, 78],
  ]) {
    const rotMesh = rotateTris(wedgeMesh.triangles, rx, ry, rz);
    const rotPat = core.unwrapSTLToPattern(rotMesh, { mode: 'form_shell_cover' });
    assert.equal(rotPat.pieces.length, 13, `rotated (${rx},${ry},${rz}) pieces`);
    const rotCaps = rotPat.pieces.filter((p) => p.role === 'stl_profile');
    assert.equal(rotCaps.length, 2);
    const rotCapArea = rotCaps.reduce((s, p) => s + Math.abs(polygonArea2D(p.points)), 0);
    const driftPct = (Math.abs(rotCapArea - baseCapArea) / baseCapArea) * 100;
    assert.ok(driftPct < 3.0, `rotated (${rx},${ry},${rz}) cap area drift ${driftPct.toFixed(2)}% >= 3%`);
    for (const c of rotCaps) {
      const hr = Math.abs(polygonArea2D(c.points)) / convexHullArea2D(c.points);
      assert.ok(hr <= 0.94, `rotated (${rx},${ry},${rz}) hullRatio ${hr.toFixed(4)} > 0.94`);
    }
  }

  // Single planar XY triangle fallback
  const singleTri = core.parseSTL(
    toAsciiSTL([[{ x: 0, y: 0, z: 0 }, { x: 80, y: 0, z: 0 }, { x: 40, y: 70, z: 0 }]], 'tri'),
    'tri.stl'
  );
  const triPat = core.unwrapSTLToPattern(singleTri, { mode: 'form_shell_cover' });
  assert.equal(core.validatePatternProject(triPat).valid, true);
  assert.ok(triPat.pieces.length >= 1);
});

test('M2 r2 regression: surface_panels Y-frame alignment, 0 invalid seams across wedge/U-shapes & non-convex offset', () => {
  const boxMesh = core.parseSTL(core.createBoxSTL(100, 80, 60), 'box.stl');
  const boxPat = core.unwrapSTLToPattern(boxMesh, { mode: 'surface_panels', easeMm: 0, thicknessMm: 0 });
  const boxSeams = core.validatePatternSeams(boxPat);
  assert.equal(boxSeams.filter((r) => !r.valid).length, 0);
  const boxSim = new core.ClothSimulation(boxPat, { stlMesh: boxMesh });
  assert.ok(boxSim.step(0).avgSewGapMm < 8);
  for (const pm of boxSim.pieceMeshes) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const cnt = pm.endIdx - pm.startIdx;
    for (let i = pm.startIdx; i < pm.endIdx; i++) {
      cx += boxSim.particles[i].pos.x;
      cy += boxSim.particles[i].pos.y;
      cz += boxSim.particles[i].pos.z;
    }
    const c = { x: cx / cnt, y: cy / cnt, z: cz / cnt };
    let bestD = Infinity;
    let bestN = null;
    for (const tri of boxSim.stlCollider.tris) {
      const d = (tri.cx - c.x) ** 2 + (tri.cy - c.y) ** 2 + (tri.cz - c.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestN = tri.normal;
      }
    }
    const dot = bestN.x * pm.normal.x + bestN.y * pm.normal.y + bestN.z * pm.normal.z;
    assert.ok(dot > 0, `expected box panel ${pm.piece.id} normal dot > 0, got ${dot}`);
  }

  const wedgeA = core.parseSTL(fs.readFileSync(WEDGE_ASSEMBLED_STL), 'wedgeA.stl');
  const wedgeP = core.parseSTL(fs.readFileSync(WEDGE_PRINT_READY_STL), 'wedgeP.stl');
  for (const [label, opts] of [
    ['default', { mode: 'surface_panels' }],
    ['ease0', { mode: 'surface_panels', easeMm: 0, thicknessMm: 0 }],
    ['ease1', { mode: 'surface_panels', easeMm: 1 }],
    ['scale0.5', { mode: 'surface_panels', scale: 0.5 }],
    ['coarse89', { mode: 'surface_panels', dihedralThresholdDeg: 89 }],
  ]) {
    const pat = core.unwrapSTLToPattern(wedgeA, opts);
    assert.equal(core.validatePatternProject(pat).valid, true, `wedgeA ${label} valid project`);
    const invalid = core.validatePatternSeams(pat).filter((r) => !r.valid);
    assert.equal(invalid.length, 0, `wedgeA ${label} expected 0 invalid seams, got ${invalid.length}`);
  }
  const simWedgeSP = new core.ClothSimulation(core.unwrapSTLToPattern(wedgeA, { mode: 'surface_panels' }), {
    stlMesh: wedgeA,
  });
  assert.ok(simWedgeSP.step(0).avgSewGapMm < 8);
  assert.equal(
    core.validatePatternSeams(core.unwrapSTLToPattern(wedgeP, { mode: 'surface_panels' })).filter((r) => !r.valid).length,
    0
  );

  // Non-convex U-shape & deepNarrowU with positive easeMm + thicknessMm
  const uShape = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 70, y: 80 },
    { x: 70, y: 20 },
    { x: 30, y: 20 },
    { x: 30, y: 80 },
    { x: 0, y: 80 },
  ];
  const deepNarrowU = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 80, y: 120 },
    { x: 46, y: 120 },
    { x: 46, y: 15 },
    { x: 34, y: 15 },
    { x: 34, y: 120 },
    { x: 0, y: 120 },
  ];
  for (const [name, poly, thick] of [
    ['U_shape', uShape, 2],
    ['deepNarrowU', deepNarrowU, 3],
  ]) {
    const mesh = buildPrismaticSTL(poly, 30);
    assert.equal(mesh.boundaryEdges, 0, `${name} expected closed watertight prism (boundaryEdges === 0)`);
    const pat = core.unwrapSTLToPattern(mesh, { mode: 'surface_panels', easeMm: 3, thicknessMm: thick });
    assert.equal(core.validatePatternProject(pat).valid, true, `${name} valid project`);
    const inv = core.validatePatternSeams(pat).filter((r) => !r.valid);
    assert.equal(inv.length, 0, `${name} expected 0 invalid seams, got ${inv.length}`);
  }
});

test('M2 r2 regression: binary STL NaN/Infinity guard, solid-prefixed binary header, PBR tile periodicity & finiteOr guards', () => {
  // Binary STL with NaN vertex
  const badBuf = new ArrayBuffer(84 + 50);
  const dv = new DataView(badBuf);
  dv.setUint32(80, 1, true);
  dv.setFloat32(84 + 12, Number.NaN, true);
  assert.throws(() => core.parseSTL(badBuf, 'nan.stl'), (err) => err?.code === 'INVALID_STL');

  // Binary STL whose 80-byte header contains "solid ... facet ... vertex"
  const parsedBox = core.parseSTL(core.createBoxSTL(40, 40, 40), 'box40.stl');
  const boxRaw = new Uint8Array(toBinarySTLBuffer(parsedBox.triangles));
  const trickyHeader = Buffer.from('solid sneaky_binary facet normal 0 0 1 outer loop vertex 0 0 0', 'ascii');
  boxRaw.set(trickyHeader.subarray(0, Math.min(79, trickyHeader.length)), 0);
  const parsedTricky = core.parseSTL(boxRaw.buffer, 'tricky.stl');
  assert.equal(parsedTricky.triangleCount, 12);

  // PBR tile periodicity on duck_canvas (sizePx: 64, plain_weave), heavy_denim (twill_3x1) & ripstop_nylon
  for (const matId of ['duck_canvas', 'heavy_denim', 'ripstop_nylon', 'cotton_jersey']) {
    const cfg = core.getMaterialConfig(matId);
    const maps = core.generateProceduralPBRMaps(cfg, 64);
    assert.ok(maps && maps.albedo?.data && maps.normal?.data && maps.roughness?.data);
    const sz = maps.size;
    const hData = maps.height.data;
    let maxIntY = 0;
    let maxWrapY = 0;
    let maxIntX = 0;
    let maxWrapX = 0;
    for (let x = 0; x < sz; x++) {
      maxWrapY = Math.max(maxWrapY, Math.abs(hData[x * 4] - hData[((sz - 1) * sz + x) * 4]));
      for (let y = 0; y < sz - 1; y++) {
        maxIntY = Math.max(maxIntY, Math.abs(hData[((y + 1) * sz + x) * 4] - hData[(y * sz + x) * 4]));
      }
    }
    for (let y = 0; y < sz; y++) {
      maxWrapX = Math.max(maxWrapX, Math.abs(hData[y * sz * 4] - hData[(y * sz + sz - 1) * 4]));
      for (let x = 0; x < sz - 1; x++) {
        maxIntX = Math.max(maxIntX, Math.abs(hData[(y * sz + x + 1) * 4] - hData[(y * sz + x) * 4]));
      }
    }
    assert.ok(maxWrapY <= maxIntY, `${matId} wrapY=${maxWrapY} > intY=${maxIntY}`);
    assert.ok(maxWrapX <= maxIntX, `${matId} wrapX=${maxWrapX} > intX=${maxIntX}`);
  }
  // Verify duck_canvas (sizePx: 64, periods=8) alternates cleanly across y=63 -> y=0 border
  const duckMaps = core.generateProceduralPBRMaps(core.getMaterialConfig('duck_canvas'), 64);
  const aDuck = duckMaps.albedo.data;
  const pxAt = (x, y) => aDuck[(y * 64 + x) * 4];
  assert.ok(
    Math.abs(pxAt(4, 4) - pxAt(4, 60)) > 10,
    'duck_canvas border cells y=4 and y=60 must have alternating warp/weft polarity'
  );

  // finiteOr null / '' / boolean / Symbol guards
  const matNull = core.getMaterialConfig('duck_canvas', { roughness: null, thicknessMm: '' });
  assert.equal(matNull.roughness, core.getMaterialConfig('duck_canvas').roughness);
  assert.equal(matNull.thicknessMm, core.getMaterialConfig('duck_canvas').thicknessMm);
  assert.doesNotThrow(() => core.getMaterialConfig('duck_canvas', { roughness: Symbol('r') }));
  assert.doesNotThrow(() => core.createParametricAvatar({ waistCm: Symbol('w'), chestMm: null, hipMm: '' }));

  // runSimulationSteps Symbol('s') steps guard
  const symStepsRes = core.runSimulationSteps(core.generateTemplatePattern('tshirt'), { steps: Symbol('s') });
  assert.equal(symStepsRes.stepCount, 120);
  assert.equal(symStepsRes.finiteOk, true);
});

test('M2 r2 regression: BVH concave clearance, 70mm deep box pushout, hoodie/pants Step-1 strain, avatar norm & invMass pinning', () => {
  // 1. 70mm deep inside 140mm box pushout
  const bigBox = core.parseSTL(core.createBoxSTL(140, 140, 140), 'bigbox.stl');
  const boxPat = core.unwrapSTLToPattern(bigBox, { mode: 'form_shell_cover', maxEdgeLengthMm: 22 });
  const simDeep = new core.ClothSimulation(boxPat, { stlMesh: bigBox, materialId: 'veg_leather', gravityMmS2: 0 });
  const deepCoords = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 10, y: -5, z: 3 },
    { x: 10, y: -5, z: 3 },
  ];
  for (let i = 0; i < deepCoords.length; i++) {
    simDeep.particles[i].pos = { ...deepCoords[i] };
    simDeep.particles[i].prevPos = { ...deepCoords[i] };
  }
  simDeep.step(1);
  for (let i = 0; i < deepCoords.length; i++) {
    const p = simDeep.particles[i].pos;
    const stillInside = Math.abs(p.x) < 70 && Math.abs(p.y) < 70 && Math.abs(p.z) < 70;
    assert.equal(stillInside, false, `deep particle ${i} should be pushed out of [-70, 70]^3 140mm box`);
  }

  // 2. cutting_mat_wedge_assembled_view.stl 120-step 0 violations < thicknessOffset - 0.05
  const wedgeA = core.parseSTL(fs.readFileSync(WEDGE_ASSEMBLED_STL), 'wedgeA.stl');
  const wedgePat = core.unwrapSTLToPattern(wedgeA, { mode: 'form_shell_cover' });
  const simWedge = new core.ClothSimulation(wedgePat, { stlMesh: wedgeA, materialId: 'veg_leather' });
  simWedge.step(120);
  const thOff = simWedge.material.thicknessMm + 0.5;
  for (let i = 0; i < simWedge.particles.length; i++) {
    const p = simWedge.particles[i].pos;
    let bestSq = Infinity;
    for (const tri of simWedge.stlCollider.tris) {
      const dx = Math.max(tri.minX - p.x, 0, p.x - tri.maxX);
      const dy = Math.max(tri.minY - p.y, 0, p.y - tri.maxY);
      const dz = Math.max(tri.minZ - p.z, 0, p.z - tri.maxZ);
      if (dx * dx + dy * dy + dz * dz >= bestSq) continue;
      const d2 = closestTriDistExact(p, tri.a, tri.b, tri.c);
      if (d2 < bestSq) bestSq = d2;
    }
    const dist = Math.sqrt(bestSq);
    assert.ok(dist >= thOff - 0.05, `wedge particle ${i} dist=${dist.toFixed(3)} < ${thOff - 0.05}`);
  }

  // 3. hoodie & pants Step 1..60 strain realistic (<< 100%)
  for (const tpl of ['hoodie', 'pants']) {
    const pat = core.generateTemplatePattern(tpl);
    const sim = new core.ClothSimulation(pat, { materialId: 'duck_canvas', maxEdgeLengthMm: 35 });
    const r1 = sim.step(1);
    assert.ok(r1.maxStrainPct < 50, `${tpl} Step-1 maxStrainPct=${r1.maxStrainPct} expected < 50`);
    const r60 = sim.step(59);
    assert.ok(r60.maxStrainPct < 50, `${tpl} Step-60 maxStrainPct=${r60.maxStrainPct} expected < 50`);
  }

  // 4. Raw options.avatar normalization
  const rectPat = {
    schemaVersion: 2,
    id: 'raw_av_test',
    name: 'RawAvatarTest',
    units: 'mm',
    pieces: [core.createRectanglePiece({ id: 'r', name: 'Rect', widthMm: 100, heightMm: 100 })],
    seams: [],
  };
  const simRawAv = new core.ClothSimulation(rectPat, { avatar: { waistCm: 95 } });
  assert.ok(simRawAv.avatar && Array.isArray(simRawAv.avatar.colliders) && simRawAv.avatar.colliders.length > 0);
  assert.equal(simRawAv.avatar.measurements.waistMm, 950);

  // 5. invMass === 0 Verlet pinning under gravity & flat bending guard
  const simPin = new core.ClothSimulation(rectPat, { avatar: null, gravityMmS2: -9810 });
  const pinnedPos = { ...simPin.particles[0].pos };
  simPin.particles[0].invMass = 0;
  const rPin = simPin.step(20);
  assert.ok(Number.isFinite(rPin.maxStrainPct) && Number.isFinite(simPin.particles[1].pos.y));
  assert.deepEqual(simPin.particles[0].pos, pinnedPos);
});

test('M2 r4 regression: Symbol/BigInt/null guards in physics.mjs & stl.mjs (placement3D, BVH, colliders, <=9-tri header, Symbol names)', () => {
  const sym = Symbol('x');

  // 1. Multi-piece tshirt with Symbol() / BigInt in piece.placement3D
  for (const offsetVal of [
    { x: sym, y: 120, z: 140 },
    { x: 0, y: sym, z: 140 },
    { x: 1n, y: 120, z: 140 },
  ]) {
    const tshirt = core.generateTemplatePattern('tshirt');
    tshirt.pieces[0].placement3D = { offset: offsetVal, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: sym, z: 0 } };
    const res = core.runSimulationSteps(tshirt, { steps: 2 });
    assert.equal(res.finiteOk, true);
  }
  const tshirtNormSym = core.generateTemplatePattern('tshirt');
  tshirtNormSym.pieces[0].placement3D = { offset: { x: 0, y: 120, z: 140 }, normal: { x: sym, y: 0, z: 1 } };
  assert.equal(core.runSimulationSteps(tshirtNormSym, { steps: 2 }).finiteOk, true);

  // 2. buildSTLBvhCollider with null / non-object entries in triangles & faces
  const smallRect = core.createPatternProject({
    name: 'Rect',
    pieces: [core.createRectanglePiece('R', 80, 80)],
    seams: [],
  });
  const resBadTris = core.runSimulationSteps(smallRect, {
    steps: 2,
    stlMesh: { triangles: [null, sym] },
  });
  assert.equal(resBadTris.finiteOk, true);

  const resBadFaces = core.runSimulationSteps(smallRect, {
    steps: 2,
    stlMesh: { faces: [null, sym, { indices: sym }], vertices: [] },
  });
  assert.equal(resBadFaces.finiteOk, true);

  // 3. Custom avatar.colliders with null & Symbol() center/radii
  const resBadColliders = core.runSimulationSteps(smallRect, {
    steps: 2,
    avatar: {
      colliders: [
        null,
        sym,
        { center: { x: 0, y: 0, z: 0 }, radii: { x: sym, y: 50, z: 50 } },
      ],
    },
  });
  assert.equal(resBadColliders.finiteOk, true);

  // 4. 1-triangle binary STL with "solid ... facet ... vertex ... endsolid ..." 80-byte header
  const oneTri = [
    [
      { x: 0, y: 0, z: 0 },
      { x: 50, y: 0, z: 0 },
      { x: 0, y: 50, z: 0 },
    ],
  ];
  const binEndsolid = makeBinarySTLWithSolidHeader(oneTri, 'solid foo facet vertex endsolid foo');
  const parsedEndsolid = core.parseSTL(binEndsolid, 'one_tri_endsolid.stl');
  assert.equal(parsedEndsolid.format, 'binary');
  assert.equal(parsedEndsolid.triangleCount, 1);

  // 5. Symbol('name') in parseSTL & serializeTrianglesToSTL
  const asciiSym = core.serializeTrianglesToSTL(oneTri, Symbol('name'), false);
  assert.ok(asciiSym.startsWith('solid model\n') && asciiSym.endsWith('endsolid model'));
  const binSym = core.serializeTrianglesToSTL(oneTri, Symbol('name'), true);
  assert.equal(core.parseSTL(binSym, Symbol('name')).name, 'model.stl');
  assert.throws(() => core.parseSTL(new Uint8Array(40), Symbol('name')), (err) => err?.code === 'TRUNCATED_STL');
  assert.throws(() => core.parseSTL('solid empty\nendsolid empty\n', Symbol('name')), (err) => err?.code === 'EMPTY_STL');
});
