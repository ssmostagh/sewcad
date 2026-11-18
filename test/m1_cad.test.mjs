import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Core from '../src/core/index.mjs';
import {
  SCHEMA_VERSION,
  CANONICAL_UNIT,
  SUPPORTED_UNITS,
  UNIT_FACTORS,
  ValidationError,
  mmToUnit,
  unitToMm,
  formatUnitValue,
  createPatternProject,
  createPatternPiece,
  createSeam,
  validatePatternPiece,
  validateSeam,
  validatePatternProject,
  normalizePatternProject,
  dist2D,
  polygonArea,
  signedPolygonArea,
  ensureCCW,
  polygonCentroid,
  polygonBounds,
  pointInPolygon,
  segmentIntersection2D,
  polygonSelfIntersects,
  evalQuadBezier,
  evalCubicBezier,
  evalEdgeAt,
  evalEdgeTangentAt,
  splitEdgeCurve,
  edgeArcLength,
  samplePieceOutline,
  offsetPolygonOutward,
  computePieceCutBoundary,
  transformPiecePoints,
  computePieceNotches,
  computePieceGrainline,
  computePieceMeasurements,
  triangulatePolygon,
  generateClothMesh2D,
  TEMPLATE_CATALOG,
  generateTemplatePattern,
  registerStlCoverGenerator,
  createFreeformPiece,
  createRectanglePiece,
  addDartToPiece,
  toggleDartFold,
  addNotchToPiece,
  splitPieceEdge,
  deletePieceVertex,
  mirrorPieceAcrossEdge,
  validatePatternSeams,
  computeSeamWalkTransform,
} from '../src/core/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function computeEulerCharacteristic(vertices, triangles) {
  const usedVerts = new Set();
  const edges = new Set();
  for (const [a, b, c] of triangles) {
    usedVerts.add(a);
    usedVerts.add(b);
    usedVerts.add(c);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edges.add(key);
    }
  }
  const V = usedVerts.size;
  const E = edges.size;
  const F = triangles.length;
  return { V, E, F, euler: V - E + F, allVerticesUsed: V === vertices.length };
}

// ============================================================================
// 1. Barrel Export & Leaf Module Architecture Contract
// ============================================================================

test('M1 Contract: barrel exports all PROJECT.md M1 symbols and types.mjs is a pure leaf module', () => {
  const requiredFunctions = [
    'mmToUnit',
    'unitToMm',
    'dist2D',
    'polygonArea',
    'signedPolygonArea',
    'ensureCCW',
    'polygonCentroid',
    'polygonBounds',
    'segmentIntersection2D',
    'polygonSelfIntersects',
    'evalQuadBezier',
    'evalCubicBezier',
    'edgeArcLength',
    'samplePieceOutline',
    'computePieceCutBoundary',
    'transformPiecePoints',
    'computePieceNotches',
    'computePieceGrainline',
    'computePieceMeasurements',
    'triangulatePolygon',
    'generateClothMesh2D',
    'generateTemplatePattern',
    'createFreeformPiece',
    'createRectanglePiece',
    'addDartToPiece',
    'toggleDartFold',
    'addNotchToPiece',
    'splitPieceEdge',
    'deletePieceVertex',
    'mirrorPieceAcrossEdge',
    'validatePatternSeams',
    'computeSeamWalkTransform',
    'createPatternProject',
    'createPatternPiece',
    'createSeam',
    'validatePatternProject',
    'normalizePatternProject',
  ];
  for (const name of requiredFunctions) {
    assert.equal(typeof Core[name], 'function', `Expected Core.${name} to be a function`);
  }
  assert.equal(typeof Core.UNIT_FACTORS, 'object');
  assert.ok(Array.isArray(Core.TEMPLATE_CATALOG));

  const typesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/core/types.mjs'), 'utf8');
  assert.equal(/\bfrom\s+['"]\.\//.test(typesSrc), false, 'types.mjs must not import sibling src/core modules');

  const templatesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/core/templates.mjs'), 'utf8');
  assert.equal(/\.\/stl\.mjs/.test(templatesSrc), false, 'templates.mjs must not statically import M2 stl.mjs');
});

// ============================================================================
// 2. Schema Validation, Normalization & Unit Conversion (F01, F14)
// ============================================================================

test('Units (F14): mmToUnit and unitToMm convert accurately and throw ValidationError on invalid inputs', () => {
  assert.deepEqual(SUPPORTED_UNITS, ['mm', 'cm', 'in']);
  assert.equal(CANONICAL_UNIT, 'mm');
  assert.equal(UNIT_FACTORS.in, 25.4);
  assert.equal(mmToUnit(25.4, 'in'), 1);
  assert.equal(unitToMm(1, 'in'), 25.4);
  assert.equal(mmToUnit(100, 'cm'), 10);
  assert.equal(unitToMm(10, 'cm'), 100);
  assert.equal(formatUnitValue(25.4, 'in', 1), '1.0 in');

  for (const badUnit of ['yd', 'px', 'm', '']) {
    assert.throws(
      () => mmToUnit(10, badUnit),
      (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
    );
    assert.throws(
      () => unitToMm(10, badUnit),
      (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
    );
  }
  for (const badVal of [NaN, Infinity, -Infinity, '10', null, undefined]) {
    assert.throws(
      () => mmToUnit(badVal, 'mm'),
      (err) => err instanceof ValidationError && err.code === 'NON_FINITE_NUMBER'
    );
    assert.throws(
      () => unitToMm(badVal, 'mm'),
      (err) => err instanceof ValidationError && err.code === 'NON_FINITE_NUMBER'
    );
  }
});

test('Schema (F01): factories, validatePatternProject, and normalizePatternProject', () => {
  const p1 = createPatternPiece({ id: 'p1', name: 'Panel 1' });
  const p2 = createPatternPiece({ id: 'p2', name: 'Panel 2' });
  const seam = createSeam({ id: 's1', pieceA: 'p1', edgeA: 0, pieceB: 'p2', edgeB: 0 });
  const proj = createPatternProject({ name: 'Test Proj', pieces: [p1, p2], seams: [seam] });

  assert.equal(proj.version, SCHEMA_VERSION);
  assert.equal(proj.unit, 'mm');
  assert.equal(proj.pieces[0].quantity, 1);
  assert.equal(proj.pieces[0].onFold, false);
  assert.deepEqual(proj.pieces[0].placement3D.up, { x: 0, y: 1, z: 0 });
  assert.equal(proj.seams[0].tStartA, 0);
  assert.equal(proj.seams[0].tEndA, 1);
  assert.equal(validatePatternProject(proj, { requireNonEmpty: true }).valid, true);

  // Rejection cases
  assert.throws(
    () => validatePatternProject({ unit: 'mm' }),
    (err) => err instanceof ValidationError && err.code === 'MISSING_PIECES'
  );
  assert.throws(
    () => validatePatternProject({ unit: 'in', pieces: [] }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
  );
  assert.throws(
    () => validatePatternProject({ unit: 'mm', pieces: [] }, { requireNonEmpty: true }),
    (err) => err instanceof ValidationError && err.code === 'EMPTY_PIECES'
  );
  assert.throws(
    () =>
      validatePatternPiece({
        id: 'bad',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        edges: [{}, {}],
      }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.throws(
    () =>
      validatePatternPiece({
        id: 'nan_pt',
        points: [
          { x: 0, y: 0 },
          { x: Number.NaN, y: 0 },
          { x: 10, y: 10 },
        ],
        edges: [{}, {}, {}],
      }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.throws(
    () =>
      validatePatternPiece({
        id: 'mismatch_edges',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        edges: [{}, {}],
      }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_EDGES'
  );
  assert.throws(
    () =>
      validatePatternPiece({
        id: 'bad_notch',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        edges: [{}, {}, {}],
        notches: [{ id: 'n1', edgeIndex: 5, t: 0.5, type: 'single' }],
      }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_NOTCH'
  );
  assert.throws(
    () =>
      validatePatternProject({
        unit: 'mm',
        pieces: [p1, { ...p2, id: 'p1' }],
        seams: [],
      }),
    (err) => err instanceof ValidationError && err.code === 'DUPLICATE_PIECE_ID'
  );
  assert.throws(
    () =>
      validateSeam(
        { id: 's_miss', pieceA: 'p1', edgeA: 0, pieceB: 'missing', edgeB: 0 },
        new Map([['p1', p1]])
      ),
    (err) => err instanceof ValidationError && err.code === 'SEAM_MISSING_PIECE'
  );
  assert.throws(
    () =>
      validateSeam(
        { id: 's_range', pieceA: 'p1', edgeA: 0, pieceB: 'p2', edgeB: 0, tStartA: 0.8, tEndA: 0.4 },
        new Map([
          ['p1', p1],
          ['p2', p2],
        ])
      ),
    (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM_RANGE'
  );
  assert.throws(
    () =>
      validateSeam(
        { id: 's_self', pieceA: 'p1', edgeA: 0, pieceB: 'p1', edgeB: 0, tStartA: 0, tEndA: 0.6, tStartB: 0.4, tEndB: 1 },
        new Map([['p1', p1]])
      ),
    (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
  );

  // Normalization from inches + legacy `parameters`
  const inchProject = normalizePatternProject({
    name: 'Inch Project',
    unit: 'in',
    parameters: { widthIn: 10 },
    pieces: [
      {
        id: 'sq_in',
        name: '10x10 Square',
        seamAllowance: 0.5,
        position: { x: 1, y: 2 },
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        edges: [
          { name: 'Top', curve: { cp: { x: 5, y: 1 } } },
          { name: 'Right' },
          { name: 'Bottom', seamAllowance: 1 },
          { name: 'Left' },
        ],
        darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 1, depthMm: 3 }],
      },
    ],
    seams: [],
  });
  assert.equal(inchProject.unit, 'mm');
  assert.equal(inchProject.displayUnit, 'in');
  assert.deepEqual(inchProject.params, { widthIn: 10 });
  assert.ok(Math.abs(inchProject.pieces[0].points[1].x - 254) < 1e-6);
  assert.ok(Math.abs(inchProject.pieces[0].seamAllowance - 12.7) < 1e-6);
  assert.ok(Math.abs(inchProject.pieces[0].edges[2].seamAllowance - 25.4) < 1e-6);
  assert.ok(Math.abs(inchProject.pieces[0].edges[0].curve.cp.y - 25.4) < 1e-6);
  assert.ok(Math.abs(inchProject.pieces[0].darts[0].widthMm - 25.4) < 1e-6);
});

// ============================================================================
// 3. 2D Geometry, Seam Allowance Offsetting & Rotation (F08, F09, F14)
// ============================================================================

test('Geometry (F09): offsetPolygonOutward handles winding invariance, acute miter-clip, U-slots, stars, duplicates & collinear steps', () => {
  const ccwSquare = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const cwSquare = [...ccwSquare].reverse();
  assert.ok(signedPolygonArea(ccwSquare) > 0);
  assert.ok(signedPolygonArea(cwSquare) < 0);

  const offCCW = offsetPolygonOutward(ccwSquare, 10);
  const offCW = offsetPolygonOutward(cwSquare, 10);
  assert.ok(Math.abs(polygonArea(offCCW) - 14400) < 1e-2);
  assert.ok(Math.abs(polygonArea(offCW) - 14400) < 1e-2);
  assert.ok(Math.abs(polygonArea(offsetPolygonOutward(ccwSquare, 0)) - 10000) < 1e-2);

  // Acute spike miter-clip bevel keeps tip strictly inside cut boundary
  const spike = [
    { x: 0, y: 0 },
    { x: 200, y: 5 },
    { x: 0, y: 10 },
  ];
  const spikeOut = offsetPolygonOutward(spike, 10, null, 2.5);
  assert.ok(spikeOut.length >= 4);
  assert.equal(polygonSelfIntersects(spikeOut), false);
  assert.equal(pointInPolygon({ x: 200, y: 5 }, spikeOut), true, 'Acute tip must remain inside beveled cut boundary');
  for (const pt of spikeOut) {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
    assert.ok(pt.x <= 226, `Beveled tip x=${pt.x} must stay within miter limit`);
  }

  // Narrow U-slot (30 mm slot, 20 mm SA) -> simple outer 240x240 square (57600 mm²)
  const narrowSlot = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 115, y: 200 },
    { x: 115, y: 120 },
    { x: 85, y: 120 },
    { x: 85, y: 200 },
    { x: 0, y: 200 },
  ];
  const narrowOut = offsetPolygonOutward(narrowSlot, 20);
  assert.equal(polygonSelfIntersects(narrowOut), false);
  assert.ok(Math.abs(polygonArea(narrowOut) - 57600) < 1e-1, `Expected 57600, got ${polygonArea(narrowOut)}`);

  // Touching U-slot (40 mm slot, 20 mm SA) -> zero backtracking spike, 57600 mm²
  const touchingSlot = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 120, y: 200 },
    { x: 120, y: 120 },
    { x: 80, y: 120 },
    { x: 80, y: 200 },
    { x: 0, y: 200 },
  ];
  const touchingOut = offsetPolygonOutward(touchingSlot, 20);
  assert.equal(polygonSelfIntersects(touchingOut), false);
  assert.ok(Math.abs(polygonArea(touchingOut) - 57600) < 1e-1, `Expected 57600, got ${polygonArea(touchingOut)}`);

  // 8-pointed concave star with large SA
  const star = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i * Math.PI) / 8;
    const r = i % 2 === 0 ? 120 : 45;
    star.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  for (const sa of [25, 40, 55]) {
    const starOut = offsetPolygonOutward(star, sa);
    assert.equal(polygonSelfIntersects(starOut), false, `Star offset SA=${sa} must not self-intersect`);
    assert.ok(polygonArea(starOut) > polygonArea(star));
  }

  // Lockstep duplicate vertex + per-edge allowance replacement
  const dupSq = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const dupOut = offsetPolygonOutward(dupSq, 10, [99, 0, 10, 20, 10]);
  assert.ok(Math.abs(polygonArea(dupOut) - 14400) < 1e-2);

  // Stepped collinear per-edge SA transitions (no diagonal slant)
  const steppedRect = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ];
  const steppedOut = offsetPolygonOutward(steppedRect, 10, [0, 20, 10, 10, 10]);
  assert.equal(polygonSelfIntersects(steppedOut), false);
  assert.ok(
    steppedOut.some((pt) => Math.abs(pt.x - 100) < 1e-4 && Math.abs(pt.y - 0) < 1e-4),
    'Stepped collinear transition must emit (100, 0)'
  );
  assert.ok(
    steppedOut.some((pt) => Math.abs(pt.x - 100) < 1e-4 && Math.abs(pt.y + 20) < 1e-4),
    'Stepped collinear transition must emit (100, -20)'
  );
  // Expected area: base 200x100 (20000) + bottom/left/right 10mm strips (220*10 + 100*10*2 = 4200) + top-right 110x20 (2200) = 26400
  assert.ok(Math.abs(polygonArea(steppedOut) - 26400) < 1e-1, `Expected 26400, got ${polygonArea(steppedOut)}`);
});

test('Geometry (F08, F09, F14): Bezier derivatives, De Casteljau split, self-intersection, rotation & measurements', () => {
  // Degenerate handle cp1 === p0 at t=0
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 100, y: 0 };
  const curve = { cp1: { x: 0, y: 0 }, cp2: { x: 70, y: 50 } };
  const tan0 = evalEdgeTangentAt(p0, p1, curve, 0);
  assert.ok(Number.isFinite(tan0.x) && Number.isFinite(tan0.y));
  assert.ok(Math.hypot(tan0.x, tan0.y) > 0.99);

  // De Casteljau split preserves arc length
  const fullLen = edgeArcLength(p0, p1, curve, 64);
  const split = splitEdgeCurve(p0, p1, curve, 0.4);
  const lenA = edgeArcLength(p0, split.mid, split.curveA, 64);
  const lenB = edgeArcLength(split.mid, p1, split.curveB, 64);
  assert.ok(Math.abs(lenA + lenB - fullLen) < 0.01);

  // Bowtie self-intersection check
  const bowtie = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
  ];
  assert.equal(polygonSelfIntersects(bowtie), true);
  assert.ok(segmentIntersection2D({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }));

  // Piece rotation + position invariance
  const piece = createRectanglePiece('Rotated Panel', 120, 80, {
    seamAllowance: 10,
    position: { x: 150, y: 80 },
    rotation: 90,
  });
  addNotchToPiece(piece, { edgeIndex: 0, t: 0.5, type: 'single' });

  const localOutline = samplePieceOutline(piece);
  const worldOutline = samplePieceOutline(piece, 16, { worldSpace: true });
  const worldCut = computePieceCutBoundary(piece, 16, { worldSpace: true });
  const worldNotches = computePieceNotches(piece, { worldSpace: true });
  const worldGrain = computePieceGrainline(piece, { worldSpace: true });

  assert.ok(Math.abs(polygonArea(worldOutline) - polygonArea(localOutline)) < 1e-4);
  assert.ok(Math.abs(polygonArea(worldCut) - 140 * 100) < 1e-1);
  assert.equal(worldNotches.length, 1);
  // Edge 0 goes from worldOutline[0] to worldOutline[1]; notch midpoint must lie on that edge
  const edgeMid = {
    x: (worldOutline[0].x + worldOutline[1].x) * 0.5,
    y: (worldOutline[0].y + worldOutline[1].y) * 0.5,
  };
  assert.ok(dist2D(worldNotches[0].position, edgeMid) < 1e-4);
  assert.ok(Number.isFinite(worldGrain.start.x) && Number.isFinite(worldGrain.end.y));

  // Measurements in mm & in
  const measMm = computePieceMeasurements(piece, 'mm');
  const measIn = computePieceMeasurements(piece, 'in');
  assert.ok(Math.abs(measMm.netAreaMm2 - 9600) < 1e-2);
  assert.ok(Math.abs(measMm.netPerimeterMm - 400) < 1e-2);
  assert.ok(Math.abs(measIn.netPerimeter - 400 / 25.4) < 1e-4);
  // Rotated 90 deg: width and height swap in world bounds!
  assert.ok(Math.abs(measMm.worldBoundsMm.width - 80) < 1e-4);
  assert.ok(Math.abs(measMm.worldBoundsMm.height - 120) < 1e-4);
});

// ============================================================================
// 4. V-Darts, Notches, Grainlines & Cloth Triangulation (F10, F11, F17-geom)
// ============================================================================

test('Darts, Notches, Grainlines & Triangulation (F10, F11): V-cutout, folded cap truing, 4 notch types & V-E+F=1', () => {
  const piece = createRectanglePiece('Darted Block', 200, 200, { seamAllowance: 10 });
  addDartToPiece(piece, { edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 70, folded: false });

  // Unfolded V-dart preserves V-cutout even though 2 * SA (20) === dart.widthMm (20)
  const cutUnfolded = computePieceCutBoundary(piece);
  assert.equal(polygonSelfIntersects(cutUnfolded), false);
  assert.ok(
    polygonArea(cutUnfolded) < 220 * 220 - 200,
    `Unfolded dart V-cutout should reduce cut area below 48400, got ${polygonArea(cutUnfolded)}`
  );
  assert.ok(
    cutUnfolded.some((pt) => Math.abs(pt.x - 100) < 1e-3 && Math.abs(pt.y - 70) < 1e-3),
    'Unfolded dart apex (100, 70) should appear in cut boundary'
  );

  // Toggle folded -> trued outward dart cap
  toggleDartFold(piece, 0, true);
  assert.equal(piece.darts[0].folded, true);
  const cutFolded = computePieceCutBoundary(piece);
  assert.equal(polygonSelfIntersects(cutFolded), false);
  assert.ok(
    polygonArea(cutFolded) > 220 * 220,
    `Folded dart cap should pop outward (> 48400), got ${polygonArea(cutFolded)}`
  );

  // All 4 notch types
  const nPiece = createRectanglePiece('Notch Panel', 160, 120);
  addNotchToPiece(nPiece, { edgeIndex: 0, t: 0.25, type: 'single' });
  addNotchToPiece(nPiece, { edgeIndex: 0, t: 0.75, type: 'double' });
  addNotchToPiece(nPiece, { edgeIndex: 1, t: 0.5, type: 'v' });
  addNotchToPiece(nPiece, { edgeIndex: 2, t: 0.5, type: 't' });
  const notches = computePieceNotches(nPiece);
  assert.deepEqual(
    notches.map((n) => n.lines.length),
    [1, 2, 2, 2]
  );

  // Concave L-shape grainline stays inside
  const lPiece = createFreeformPiece('L-Shape', [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 60 },
    { x: 60, y: 60 },
    { x: 60, y: 200 },
    { x: 0, y: 200 },
  ]);
  const lGrain = computePieceGrainline(lPiece);
  assert.ok(Number.isFinite(lGrain.start.x) && Number.isFinite(lGrain.end.y));

  // Large 800x800 bodice cloth mesh: edges <= 35 mm and Euler V - E + F === 1
  const bigBodice = createRectanglePiece('Big Bodice', 800, 800);
  addDartToPiece(bigBodice, { edgeIndex: 0, t: 0.5, widthMm: 30, depthMm: 100, folded: false });
  const outline = samplePieceOutline(bigBodice);
  const mesh = generateClothMesh2D(outline, 35);
  assert.ok(mesh.triangles.length > 200);
  for (const [a, b, c] of mesh.triangles) {
    assert.ok(dist2D(mesh.vertices[a], mesh.vertices[b]) <= 35 + 1e-6);
    assert.ok(dist2D(mesh.vertices[b], mesh.vertices[c]) <= 35 + 1e-6);
    assert.ok(dist2D(mesh.vertices[c], mesh.vertices[a]) <= 35 + 1e-6);
  }
  const topo = computeEulerCharacteristic(mesh.vertices, mesh.triangles);
  assert.equal(topo.allVerticesUsed, true);
  assert.equal(topo.euler, 1, `Expected Euler V-E+F=1, got ${topo.euler} (V=${topo.V}, E=${topo.E}, F=${topo.F})`);
});

// ============================================================================
// 5. All 5 Parametric Starter Templates & Complete Seam Wiring (F02-F06 stub)
// ============================================================================

test('Templates (F02-F06): all 5 catalog entries, non-self-intersecting net/cut boundaries, and 100% valid complete seams', () => {
  assert.deepEqual(
    TEMPLATE_CATALOG.map((t) => t.id),
    [
      'bodice_sloper',
      'princess_bodice',
      'fit_flare_dress',
      'aline_skirt',
      'pencil_skirt',
      'womens_trousers',
      'tshirt',
      'hoodie',
      'pants',
      'tote_bag',
      'stl_cover',
    ]
  );

  const expectedSeamCounts = {
    bodice_sloper: 10,
    princess_bodice: 10,
    fit_flare_dress: 8,
    aline_skirt: 5,
    pencil_skirt: 7,
    womens_trousers: 11,
    tshirt: 13,
    hoodie: 23,
    pants: 11,
    tote_bag: 14,
    stl_cover: 5,
  };

  for (const entry of TEMPLATE_CATALOG) {
    const pattern = generateTemplatePattern(entry.id);
    assert.equal(pattern.templateId, entry.id);
    assert.equal(pattern.unit, 'mm');
    assert.equal(validatePatternProject(pattern, { requireNonEmpty: true }).valid, true);
    assert.equal(
      pattern.seams.length,
      expectedSeamCounts[entry.id],
      `Expected ${expectedSeamCounts[entry.id]} seams for ${entry.id}, got ${pattern.seams.length}`
    );

    const wiredPieces = new Set();
    for (const s of pattern.seams) {
      wiredPieces.add(s.pieceA);
      wiredPieces.add(s.pieceB);
    }

    for (const piece of pattern.pieces) {
      assert.equal(
        wiredPieces.has(piece.id),
        true,
        `Piece "${piece.id}" in "${entry.id}" must participate in at least one seam`
      );
      const netOutline = samplePieceOutline(piece);
      const cutBoundary = computePieceCutBoundary(piece);
      const netArea = polygonArea(netOutline);
      const cutArea = polygonArea(cutBoundary);

      assert.equal(
        polygonSelfIntersects(netOutline),
        false,
        `Net outline of "${piece.id}" in "${entry.id}" must not self-intersect`
      );
      assert.equal(
        polygonSelfIntersects(cutBoundary),
        false,
        `Cut boundary of "${piece.id}" in "${entry.id}" must not self-intersect`
      );
      assert.ok(netArea > 100, `Piece "${piece.id}" net area must be > 100`);
      assert.ok(cutArea > netArea, `Piece "${piece.id}" cut area (${cutArea}) must exceed net area (${netArea})`);
    }

    const seamReports = validatePatternSeams(pattern);
    assert.equal(seamReports.length, pattern.seams.length);
    for (const r of seamReports) {
      assert.equal(
        r.valid,
        true,
        `Seam "${r.seamId}" in "${entry.id}" failed: status=${r.status}, A=${r.lengthAMm}, B=${r.lengthBMm}, delta=${r.deltaMm}`
      );
    }
  }

  // Stress extreme parameters on templates
  const extremeTee = generateTemplatePattern('tshirt', { chestMm: 900, waistMm: 1200, frontNeckDropMm: 180 });
  assert.equal(validatePatternSeams(extremeTee).every((r) => r.valid), true);

  const extremeHoodie = generateTemplatePattern('hoodie', { hoodDepthMm: 320, pocketWidthMm: 500 });
  assert.equal(validatePatternSeams(extremeHoodie).every((r) => r.valid), true);

  // stl_cover M1 hook: stub flag, strict error, and M2 delegation
  const stubCover = generateTemplatePattern('stl_cover');
  assert.equal(stubCover.isStub, true);
  assert.throws(
    () => generateTemplatePattern('stl_cover', {}, { requireStl: true }),
    /requires M2 stl\.mjs/i
  );

  const mockDelegated = generateTemplatePattern(
    'stl_cover',
    { materialId: 'eva_foam_4mm' },
    {
      unwrapFn: () => ({
        id: 'mock_stl',
        name: 'Mock Unwrapped STL',
        pieces: [createRectanglePiece('Mock Panel', 100, 80)],
        seams: [],
      }),
    }
  );
  assert.equal(mockDelegated.id, 'mock_stl');
  assert.equal(mockDelegated.materialId, 'eva_foam_4mm');

  registerStlCoverGenerator(() => ({
    id: 'registered_stl',
    name: 'Registered STL',
    pieces: [createRectanglePiece('Reg Panel', 120, 60)],
    seams: [],
  }));
  const regResult = generateTemplatePattern('stl_cover');
  assert.equal(regResult.id, 'registered_stl');
  registerStlCoverGenerator(null);
});

// ============================================================================
// 6. Freeform CAD Operations, Seam Matching & Walk Seam (F07-F13)
// ============================================================================

test('CAD Operations (F07, F08, F12): createRectanglePiece, splitPieceEdge, deletePieceVertex, and mirrorPieceAcrossEdge', () => {
  // Curved piece split preserves arc length and remaps pattern seams
  const pA = createFreeformPiece('Curved A', [
    { x: 0, y: 0 },
    { x: 160, y: 0 },
    { x: 160, y: 120 },
    { x: 0, y: 120 },
  ]);
  pA.edges[0].curve = { cp1: { x: 40, y: -35 }, cp2: { x: 120, y: -35 } };
  addNotchToPiece(pA, { edgeIndex: 0, t: 0.7, type: 'v' });
  addDartToPiece(pA, { edgeIndex: 2, t: 0.5, widthMm: 20, depthMm: 40 });

  const origCurveLen = edgeArcLength(pA.points[0], pA.points[1], pA.edges[0].curve, 64);
  const pB = createRectanglePiece('Mate B', origCurveLen, 100);
  const pattern = createPatternProject({
    pieces: [pA, pB],
    seams: [createSeam({ id: 's_top', pieceA: pA.id, edgeA: 0, pieceB: pB.id, edgeB: 0, reversed: true })],
  });
  const projA = pattern.pieces[0];

  splitPieceEdge(projA, 0, 0.4, pattern);
  assert.equal(projA.points.length, 5);
  assert.equal(projA.notches[0].edgeIndex, 1, 'Notch at t=0.7 should move to split edge 1');
  assert.equal(projA.darts[0].edgeIndex, 3, 'Dart on edge 2 should shift to edge 3');
  assert.equal(pattern.seams.length, 2, 'Straddling seam should split cleanly into 2 sub-seams');
  assert.equal(validatePatternSeams(pattern).every((r) => r.valid), true);

  const splitLenSum =
    edgeArcLength(projA.points[0], projA.points[1], projA.edges[0].curve, 64) +
    edgeArcLength(projA.points[1], projA.points[2], projA.edges[1].curve, 64);
  assert.ok(Math.abs(splitLenSum - origCurveLen) < 0.05);

  // deletePieceVertex updates counts & removes seams bound to deleted edges
  deletePieceVertex(projA, 1, pattern);
  assert.equal(projA.points.length, 4);
  assert.equal(pattern.seams.length, 0);
  const tri = createFreeformPiece('Triangle', [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 80 },
  ]);
  assert.throws(() => deletePieceVertex(tri, 0), /at least 3 vertices/i);

  // mirrorPieceAcrossEdge with curve, notch, dart, internalLine, and position shift
  const half = createFreeformPiece('Half Front', [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 200 },
    { x: 0, y: 200 },
  ], { onFold: true, position: { x: 100, y: 50 } });
  half.edges[0].curve = { cp: { x: 50, y: -25 } };
  addNotchToPiece(half, { edgeIndex: 0, t: 0.5, type: 'single' });
  addDartToPiece(half, { edgeIndex: 1, t: 0.5, widthMm: 16, depthMm: 40 });
  half.internalLines.push({
    id: 'pocket_mark',
    name: 'Pocket Guide',
    type: 'pocket',
    points: [
      { x: 30, y: 120 },
      { x: 70, y: 120 },
    ],
  });

  const beforeArea = polygonArea(samplePieceOutline(half));
  mirrorPieceAcrossEdge(half, 3);
  const afterArea = polygonArea(samplePieceOutline(half));
  assert.equal(half.onFold, false);
  assert.equal(half.position.x, 0, 'Mirroring across left x=0 shifts piece.position.x by -100');
  assert.ok(signedPolygonArea(half.points) > 0, 'Mirrored piece must maintain CCW winding');
  assert.ok(Math.abs(afterArea - beforeArea * 2) < 1, `Expected ${beforeArea * 2}, got ${afterArea}`);
  assert.equal(half.notches.length, 2);
  assert.equal(half.darts.length, 2);
  assert.ok(half.internalLines.some((il) => il.type === 'fold'));
  assert.ok(half.internalLines.some((il) => il.id === 'pocket_mark_mir'));

  // Degenerate zero-length edge rejection
  const degen = {
    id: 'degen',
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ],
    edges: [{}, {}, {}],
  };
  assert.throws(() => mirrorPieceAcrossEdge(degen, 0), /degenerate/i);
});

test('Seam Validation & Walk Seam (F13): dart intake subtraction, overlap duplicate_edge, and rigid walk alignment', () => {
  const darted = createRectanglePiece('Darted Waist', 220, 150);
  addDartToPiece(darted, { edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 80 });
  const mate = createRectanglePiece('Waistband', 200, 45);
  const mateLong = createRectanglePiece('Too Long', 235, 45);

  const okProj = createPatternProject({
    pieces: [darted, mate],
    seams: [createSeam({ id: 's_ok', pieceA: darted.id, edgeA: 0, pieceB: mate.id, edgeB: 0 })],
  });
  const okReport = validatePatternSeams(okProj);
  assert.equal(okReport[0].status, 'ok');
  assert.equal(okReport[0].lengthAMm, 200);
  assert.equal(okReport[0].deltaMm, 0);

  const dupProj = createPatternProject({
    pieces: [darted, mate, mateLong],
    seams: [
      createSeam({ id: 's_1', pieceA: darted.id, edgeA: 0, pieceB: mate.id, edgeB: 0, tStartA: 0, tEndA: 0.6 }),
      createSeam({ id: 's_2', pieceA: darted.id, edgeA: 0, pieceB: mateLong.id, edgeB: 0, tStartA: 0.4, tEndA: 1 }),
    ],
  });
  const dupReport = validatePatternSeams(dupProj);
  assert.equal(dupReport[0].status, 'duplicate_edge');
  assert.equal(dupReport[1].status, 'duplicate_edge');

  // Walk Seam rigid transform across straight, curved & reversed seams with pieceA rotation
  const aPiece = createRectanglePiece('Piece A', 160, 100, { position: { x: 200, y: 120 }, rotation: 35 });
  aPiece.edges[0].curve = { cp1: { x: 40, y: -30 }, cp2: { x: 120, y: -30 } };
  const curveLen = edgeArcLength(aPiece.points[0], aPiece.points[1], aPiece.edges[0].curve, 64);
  const bPiece = createRectanglePiece('Piece B', curveLen, 80, { position: { x: 500, y: 300 } });

  for (const reversed of [false, true]) {
    const walkProj = createPatternProject({
      pieces: [aPiece, bPiece],
      seams: [createSeam({ id: 'walk_seam', pieceA: aPiece.id, edgeA: 0, pieceB: bPiece.id, edgeB: 0, reversed })],
    });
    for (const s of [0, curveLen * 0.5, curveLen]) {
      const walk = computeSeamWalkTransform(walkProj, 'walk_seam', s);
      const pB_local = evalEdgeAt(bPiece.points[0], bPiece.points[1], null, walk.tB);
      const pB_transformed = walk.applyTransform(pB_local);
      assert.ok(
        dist2D(pB_transformed, walk.contactPointWorld) < 1e-6,
        `Walk contact mismatch at s=${s}, reversed=${reversed}`
      );
      const tanB_local = evalEdgeTangentAt(bPiece.points[0], bPiece.points[1], null, walk.tB);
      const tanB_walk = reversed ? { x: -tanB_local.x, y: -tanB_local.y } : tanB_local;
      const cos = Math.cos(walk.angleRad);
      const sin = Math.sin(walk.angleRad);
      const tanB_rot = {
        x: tanB_walk.x * cos - tanB_walk.y * sin,
        y: tanB_walk.x * sin + tanB_walk.y * cos,
      };
      const dotTan = tanB_rot.x * walk.tangentWorld.x + tanB_rot.y * walk.tangentWorld.y;
      assert.ok(dotTan > 0.9999, `Tangents must align (dot=${dotTan}) at s=${s}, reversed=${reversed}`);
    }
  }
});

test('10. M1 r2 regression — types.mjs validation & normalization', () => {
  // Mismatched edges.length in createPatternPiece pads/slices to points.length
  const pts4 = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const padded = createPatternPiece({ points: pts4, edges: [{ seamAllowance: 5 }] });
  assert.equal(padded.edges.length, 4);
  assert.equal(padded.edges[0].seamAllowance, 5);
  assert.equal(padded.edges[3].seamAllowance, 10);

  const sliced = createPatternPiece({ points: pts4.slice(0, 3), edges: [{}, {}, {}, {}, {}] });
  assert.equal(sliced.edges.length, 3);

  // Non-array nested collections in normalizePatternProject throw ValidationError
  const tri = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }];
  for (const field of ['edges', 'notches', 'darts', 'internalLines']) {
    assert.throws(
      () => normalizePatternProject({ pieces: [{ points: tri, [field]: 'not_an_array' }] }),
      ValidationError,
      `Expected ValidationError for non-array piece.${field}`
    );
  }
  assert.throws(
    () => normalizePatternProject({ pieces: [{ points: 'bad' }] }),
    ValidationError
  );
  assert.throws(
    () => normalizePatternProject({ pieces: [], seams: { bad: true } }),
    ValidationError
  );

  // Non-object edge.curve throws ValidationError instead of silent drop
  for (const badCurve of ['bezier', 123, ['a'], true]) {
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [{ points: tri, edges: [{ curve: badCurve }, {}, {}] }],
        }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_CURVE'
    );
  }

  // validatePatternPiece validates piece.rotationOrigin finiteness
  const badRotPiece = createRectanglePiece('RotOriginBad', 80, 60);
  badRotPiece.rotationOrigin = { x: Number.NaN, y: 10 };
  assert.throws(() => validatePatternPiece(badRotPiece), ValidationError);
  badRotPiece.rotationOrigin = 'invalid';
  assert.throws(() => validatePatternPiece(badRotPiece), ValidationError);

  // validatePatternProject rejects overlapping cross-seam intervals, ignoring internalLineIdB
  const pA = createRectanglePiece('A', 120, 60);
  const pB = createRectanglePiece('B', 120, 60);
  const projOverlap = createPatternProject({
    pieces: [pA, pB],
    seams: [
      createSeam({ id: 's1', pieceA: pA.id, edgeA: 0, tStartA: 0, tEndA: 0.6, pieceB: pB.id, edgeB: 0, tStartB: 0, tEndB: 0.6 }),
      createSeam({ id: 's2', pieceA: pA.id, edgeA: 0, tStartA: 0.4, tEndA: 1.0, pieceB: pB.id, edgeB: 2, tStartB: 0, tEndB: 0.6 }),
    ],
  });
  assert.throws(
    () => validatePatternProject(projOverlap),
    (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
  );

  const pInt = createRectanglePiece('Int', 120, 60, {
    internalLines: [{ id: 'il1', points: [{ x: 10, y: 10 }, { x: 110, y: 10 }], type: 'seam_line' }],
  });
  const projInternalOk = createPatternProject({
    pieces: [pA, pInt],
    seams: [
      createSeam({ id: 'si1', pieceA: pA.id, edgeA: 0, tStartA: 0, tEndA: 0.8, pieceB: pInt.id, internalLineIdB: 'il1', internalSegmentIndexB: 0 }),
      createSeam({ id: 'si2', pieceA: pA.id, edgeA: 2, tStartA: 0, tEndA: 0.5, pieceB: pInt.id, internalLineIdB: 'il1', internalSegmentIndexB: 0 }),
    ],
  });
  assert.equal(validatePatternProject(projInternalOk).valid, true);
});

test('11. M1 r2 regression — geometry.mjs SA miter/collinear, packed darts, mesh scaling & double notches', () => {
  // 1mm waist shaping, 0.1mm dimple, 0.5mm bulge, 2mm concave skirt hem (Challenger 1 #1)
  const cases = [
    {
      name: '1mm waist shaping',
      pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 199, y: 200 }, { x: 0, y: 200 }],
      allowances: [10, 10, 20, 10, 10],
    },
    {
      name: '0.1mm dimple',
      pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 0.1 }, { x: 200, y: 180 }, { x: 0, y: 180 }],
      allowances: [10, 5, 25, 10, 10],
    },
    {
      name: '0.5mm bulge',
      pts: [{ x: 0, y: 0 }, { x: 100, y: -0.5 }, { x: 200, y: 0 }, { x: 200, y: 160 }, { x: 0, y: 160 }],
      allowances: [25, 5, 10, 10, 10],
    },
    {
      name: '2mm concave skirt hem',
      pts: [{ x: 0, y: 0 }, { x: 220, y: 0 }, { x: 220, y: 400 }, { x: 110, y: 398 }, { x: 0, y: 400 }],
      allowances: [10, 10, 25, 10, 10],
    },
  ];
  for (const c of cases) {
    const n = c.pts.length;
    const areas = [];
    for (const poly of [c.pts, [...c.pts].reverse()]) {
      const allowances =
        poly === c.pts ? c.allowances : c.allowances.map((_, i) => c.allowances[(n - 2 - i + n) % n]);
      const origSign = Math.sign(signedPolygonArea(poly));
      const out = offsetPolygonOutward(poly, 10, allowances);
      assert.equal(polygonSelfIntersects(out), false, `${c.name} self-intersects`);
      assert.ok(
        signedPolygonArea(out) * origSign >= signedPolygonArea(poly) * origSign - 1e-6,
        `${c.name} collapsed or inverted winding`
      );
      areas.push(polygonArea(out));
    }
    assert.ok(Math.abs(areas[0] - areas[1]) < 1e-6, `${c.name} CW/CCW area mismatch: ${areas[0]} vs ${areas[1]}`);
  }

  // Challenger 1 Trial #189 & #234 repros (varying per-edge SA without tiny remnant or inversion)
  const trial234Pts = [
    { x: 0, y: 0 },
    { x: 160, y: 0 },
    { x: 160, y: 140 },
    { x: 80, y: 138 },
    { x: 0, y: 140 },
  ];
  const trial234SA = [15, 10, 25, 5, 10];
  const trial234Out = offsetPolygonOutward(trial234Pts, 10, trial234SA);
  assert.equal(polygonSelfIntersects(trial234Out), false);
  assert.ok(polygonArea(trial234Out) > polygonArea(trial234Pts));

  const trial189Pts = [
    { x: 0, y: 0 },
    { x: 140, y: 0 },
    { x: 141, y: 90 },
    { x: 140, y: 180 },
    { x: 0, y: 180 },
  ];
  const trial189Out = offsetPolygonOutward(trial189Pts, 10, [10, 25, 5, 10, 10]);
  assert.equal(polygonSelfIntersects(trial189Out), false);
  assert.ok(polygonArea(trial189Out) > polygonArea(trial189Pts));

  // 3 packed darts near t = 0.95..0.98 (Reviewer 2 Major #4)
  const dartPiece = createRectanglePiece('PackedDarts', 240, 120);
  dartPiece.darts = [
    { id: 'd1', edgeIndex: 0, t: 0.95, widthMm: 20, depthMm: 45 },
    { id: 'd2', edgeIndex: 0, t: 0.97, widthMm: 20, depthMm: 45 },
    { id: 'd3', edgeIndex: 0, t: 0.98, widthMm: 20, depthMm: 45 },
  ];
  const dartOutline = samplePieceOutline(dartPiece);
  assert.equal(polygonSelfIntersects(dartOutline), false);
  assert.equal(polygonSelfIntersects(computePieceCutBoundary(dartPiece)), false);
  for (const pt of dartOutline) {
    assert.ok(pt.x >= -1e-6 && pt.x <= 240 + 1e-6 && pt.y >= -1e-6 && pt.y <= 120 + 1e-6);
  }

  // generateClothMesh2D dynamic maxVertices scaling (Challenger 1 #2)
  const pants = generateTemplatePattern('pants');
  const backLeg = pants.pieces.find((p) => p.id === 'back_leg_left');
  const legMesh = generateClothMesh2D(samplePieceOutline(backLeg), 20);
  assert.ok(legMesh.triangles.length > 0);
  const worstLegEdge = legMesh.triangles.reduce((mx, [a, b, c]) => {
    const va = legMesh.vertices[a], vb = legMesh.vertices[b], vc = legMesh.vertices[c];
    return Math.max(mx, dist2D(va, vb), dist2D(vb, vc), dist2D(vc, va));
  }, 0);
  assert.ok(worstLegEdge <= 20 + 1e-4, `Pants mesh worstEdge=${worstLegEdge} > 20`);
  // Explicit Euler V - E + F = 1 check
  const legEdgeKeys = new Set();
  for (const [a, b, c] of legMesh.triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      legEdgeKeys.add(u < v ? `${u}:${v}` : `${v}:${u}`);
    }
  }
  assert.equal(legMesh.vertices.length - legEdgeKeys.size + legMesh.triangles.length, 1);

  const bigBodice = createRectanglePiece('BigBodice', 500, 950);
  const bigMesh = generateClothMesh2D(samplePieceOutline(bigBodice), 10);
  assert.ok(bigMesh.triangles.length > 0);
  const worstBigEdge = bigMesh.triangles.reduce((mx, [a, b, c]) => {
    const va = bigMesh.vertices[a], vb = bigMesh.vertices[b], vc = bigMesh.vertices[c];
    return Math.max(mx, dist2D(va, vb), dist2D(vb, vc), dist2D(vc, va));
  }, 0);
  assert.ok(worstBigEdge <= 10 + 1e-4, `Large bodice worstEdge=${worstBigEdge} > 10`);

  // Double notch spacing on non-uniform/degenerate cubic Bezier (Challenger 1 #3)
  const notchPiece = createRectanglePiece('NotchCurve', 160, 100);
  notchPiece.edges[0].curve = { cp1: { x: 0, y: 0 }, cp2: { x: 140, y: -40 } };
  notchPiece.notches = [{ id: 'dbl', edgeIndex: 0, t: 0.5, type: 'double' }];
  const notches = computePieceNotches(notchPiece);
  const doubleNotch = notches.find((n) => n.id === 'dbl');
  assert.ok(doubleNotch && doubleNotch.lines.length === 2);
  const gapMm = dist2D(doubleNotch.lines[0][0], doubleNotch.lines[1][0]);
  assert.ok(Math.abs(gapMm - 5.0) < 0.25, `Double notch gap expected ~5.0mm, got ${gapMm}`);
});

test('12. M1 r2 regression — CAD ops (deletePieceVertex, mirrorPieceAcrossEdge, splitPieceEdge, createFreeformPiece, self-seams)', () => {
  // deletePieceVertex triggering CCW->CW reversal (Reviewer 1 #1, Reviewer 2 #1, Challenger 2 #4)
  const arrowA = createFreeformPiece('ArrowA', [
    { x: 0, y: 0 },
    { x: 100, y: -100 },
    { x: 20, y: 0 },
    { x: 100, y: 100 },
  ]);
  // After bounds shift: points are [(0,100), (100,0), (20,100), (100,200)]
  // Edge 2 is (20,100)->(100,200), length sqrt(6400+10000)
  const edge2Len = edgeArcLength(arrowA.points[2], arrowA.points[3], null);
  const partner = createRectanglePiece('Partner', edge2Len, 50);
  addNotchToPiece(arrowA, { edgeIndex: 2, t: 0.25, type: 'single' });
  addDartToPiece(arrowA, { edgeIndex: 2, t: 0.7, widthMm: 10, depthMm: 20 });
  arrowA.edges[2].curve = { cp1: { x: 40, y: 140 }, cp2: { x: 70, y: 180 } };
  const seamProj = createPatternProject({
    pieces: [arrowA, partner],
    seams: [createSeam({ id: 's_arrow', pieceA: arrowA.id, edgeA: 2, tStartA: 0.1, tEndA: 0.8, pieceB: partner.id, edgeB: 0, tStartB: 0, tEndB: 0.7, reversed: false })],
  });
  // Delete vertex 0 -> remaining [v1, v2, v3] is CW, reversed to [v3, v2, v1]
  // Old edge 2 (v2->v3) becomes edge 0 (v3->v2) when m=3 -> (3-2-1+3)%3 = 0
  const arrowPiece = seamProj.pieces[0];
  deletePieceVertex(arrowPiece, 0, seamProj);
  assert.ok(signedPolygonArea(arrowPiece.points) > 0);
  assert.equal(arrowPiece.edges[0].curve.cp1.x, 70);
  assert.equal(arrowPiece.edges[0].curve.cp2.x, 40);
  assert.equal(arrowPiece.notches[0].edgeIndex, 0);
  assert.ok(Math.abs(arrowPiece.notches[0].t - 0.75) < 1e-6);
  assert.equal(arrowPiece.darts[0].edgeIndex, 0);
  assert.ok(Math.abs(arrowPiece.darts[0].t - 0.3) < 1e-6);
  assert.equal(seamProj.seams[0].edgeA, 0);
  assert.ok(Math.abs(seamProj.seams[0].tStartA - 0.2) < 1e-6);
  assert.ok(Math.abs(seamProj.seams[0].tEndA - 0.9) < 1e-6);
  assert.equal(seamProj.seams[0].reversed, true);

  // mirrorPieceAcrossEdge on rotated piece preserves world-space symmetry axis (< 1e-6 mm) & CW seam flip
  const rotPiece = createRectanglePiece('RotMirror', 120, 80, { position: { x: 150, y: 200 }, rotation: 37 });
  const beforeWorld = transformPiecePoints(rotPiece.points, rotPiece);
  const axisBefore0 = beforeWorld[1];
  const axisBefore1 = beforeWorld[2];
  mirrorPieceAcrossEdge(rotPiece, 1);
  const afterWorld = transformPiecePoints(rotPiece.points, rotPiece);
  // Across edge 1, original piece vertices (including the symmetry axis endpoints) remain invariant in world space
  const shift0 = Math.min(...afterWorld.map((p) => dist2D(p, axisBefore0)));
  const shift1 = Math.min(...afterWorld.map((p) => dist2D(p, axisBefore1)));
  assert.ok(shift0 < 1e-6 && shift1 < 1e-6, `Rotated mirror axis drifted: ${shift0}, ${shift1}`);

  // mirrorPieceAcrossEdge on CW raw piece flips surviving seams properly
  const cwRect = createPatternPiece({
    id: 'cw_rect',
    points: [{ x: 0, y: 0 }, { x: 0, y: 80 }, { x: 100, y: 80 }, { x: 100, y: 0 }],
  });
  const partnerM = createRectanglePiece('PM', 100, 50);
  const mirProj = createPatternProject({
    pieces: [cwRect, partnerM],
    seams: [createSeam({ id: 'sm1', pieceA: cwRect.id, edgeA: 1, tStartA: 0.1, tEndA: 0.9, pieceB: partnerM.id, edgeB: 0, tStartB: 0.1, tEndB: 0.9, reversed: false })],
  });
  const cwMirrored = mirProj.pieces[0];
  mirrorPieceAcrossEdge(cwMirrored, 0, mirProj);
  assert.ok(signedPolygonArea(cwMirrored.points) > 0);
  assert.equal(mirProj.seams[0].reversed, true);
  assert.ok(Math.abs(mirProj.seams[0].tStartA - 0.1) < 1e-6 && Math.abs(mirProj.seams[0].tEndA - 0.9) < 1e-6);

  // splitPieceEdge on self-seam (matchA && matchB) AND darted edge net-length split
  const selfSquare = createRectanglePiece('SelfSq', 200, 100);
  const selfProj = createPatternProject({
    pieces: [selfSquare],
    seams: [
      createSeam({
        id: 'self_seam',
        pieceA: selfSquare.id,
        edgeA: 0,
        tStartA: 0,
        tEndA: 0.4,
        pieceB: selfSquare.id,
        edgeB: 0,
        tStartB: 0.6,
        tEndB: 1.0,
      }),
    ],
  });
  // Before split: disjoint self-seam validates OK
  const preSelf = validatePatternSeams(selfProj);
  assert.equal(preSelf[0].valid, true, `Self-seam failed validation: ${JSON.stringify(preSelf[0])}`);
  splitPieceEdge(selfProj.pieces[0], 0, 0.5, selfProj);
  const postSelf = validatePatternSeams(selfProj);
  assert.equal(postSelf[0].valid, true, `Split self-seam failed: ${JSON.stringify(postSelf[0])}`);

  // True overlapping self-seam returns duplicate_edge
  const badSelfProj = createPatternProject({
    pieces: [createRectanglePiece('OverlapSq', 200, 100)],
  });
  badSelfProj.seams = [
    createSeam({
      id: 'bad_self',
      pieceA: badSelfProj.pieces[0].id,
      edgeA: 0,
      tStartA: 0.0,
      tEndA: 0.6,
      pieceB: badSelfProj.pieces[0].id,
      edgeB: 0,
      tStartB: 0.4,
      tEndB: 1.0,
    }),
  ];
  assert.equal(validatePatternSeams(badSelfProj)[0].status, 'duplicate_edge');

  // Out-of-range internalSegmentIndexB returns invalid_seam
  const pWithIL = createRectanglePiece('WithIL', 100, 100, {
    internalLines: [{ id: 'il1', points: [{ x: 10, y: 10 }, { x: 90, y: 90 }], type: 'seam_line' }],
  });
  const ilProj = createPatternProject({
    pieces: [createRectanglePiece('Opp', 100, 100), pWithIL],
  });
  ilProj.seams = [
    createSeam({
      id: 'bad_il_idx',
      pieceA: ilProj.pieces[0].id,
      edgeA: 0,
      pieceB: pWithIL.id,
      internalLineIdB: 'il1',
      internalSegmentIndexB: 3,
    }),
  ];
  const ilCheck = validatePatternSeams(ilProj);
  assert.equal(ilCheck[0].valid, false);
  assert.equal(ilCheck[0].status, 'invalid_seam');

  // Dart-intake-aware splitPieceEdge (net sewn length 100 - 20 = 80 split at t=0.4)
  const dartSplitA = createRectanglePiece('DartA', 100, 80);
  addDartToPiece(dartSplitA, { edgeIndex: 0, t: 0.3, widthMm: 20, depthMm: 30 });
  const plainSplitB = createRectanglePiece('PlainB', 80, 80);
  const dartSplitProj = createPatternProject({
    pieces: [dartSplitA, plainSplitB],
    seams: [createSeam({ id: 'sd', pieceA: dartSplitA.id, edgeA: 0, pieceB: plainSplitB.id, edgeB: 0 })],
  });
  splitPieceEdge(dartSplitProj.pieces[0], 0, 0.4, dartSplitProj);
  const splitRes = validatePatternSeams(dartSplitProj);
  for (const r of splitRes) {
    assert.equal(r.valid, true);
    assert.ok(Math.abs(r.deltaMm) < 1e-4, `Darted split deltaMm expected ~0, got ${r.deltaMm}`);
  }

  // createFreeformPiece CW with explicit edges/curves/notches/darts
  const ff = createFreeformPiece('CWFreeform', [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }], {
    edges: [
      { seamAllowance: 5 },
      { seamAllowance: 14, curve: { cp1: { x: 25, y: 120 }, cp2: { x: 75, y: 120 } } },
      { seamAllowance: 7 },
      { seamAllowance: 9 },
    ],
    notches: [{ edgeIndex: 1, t: 0.25, type: 'single' }],
    darts: [{ edgeIndex: 1, t: 0.8, widthMm: 15, depthMm: 30 }],
  });
  assert.equal(ff.edges[1].seamAllowance, 14);
  assert.ok(Math.abs(ff.edges[1].curve.cp1.x - 75) < 1e-6);
  assert.equal(ff.notches[0].edgeIndex, 1);
  assert.ok(Math.abs(ff.notches[0].t - 0.75) < 1e-6);
  assert.equal(ff.darts[0].edgeIndex, 1);
  assert.ok(Math.abs(ff.darts[0].t - 0.2) < 1e-6);
});

test('13. M1 r2 regression — garment template sweeps, NaN param guards & 3D back-seam parity', () => {
  // T-shirt sweep including child/small sizes + NaN fallback
  for (const cfg of [
    {},
    { chestMm: 400 },
    { chestMm: 500, bicepWidthMm: 180 },
    { chestMm: 540, bicepWidthMm: 200 },
    { chestMm: 1400, lengthMm: 820 },
    { chestMm: Number.NaN, lengthMm: Number.POSITIVE_INFINITY },
  ]) {
    const p = generateTemplatePattern('tshirt', cfg);
    const bad = validatePatternSeams(p).filter((r) => !r.valid);
    assert.equal(bad.length, 0, `tshirt ${JSON.stringify(cfg)} bad seams: ${JSON.stringify(bad)}`);
    for (const pc of p.pieces) {
      assert.equal(polygonSelfIntersects(samplePieceOutline(pc)), false);
      assert.equal(polygonSelfIntersects(computePieceCutBoundary(pc)), false);
    }
  }

  // Hoodie sweep including extreme shallow/deep hood + child chest
  for (const cfg of [
    {},
    { chestMm: 450, hoodDepthMm: 450 },
    { chestMm: 450, hoodDepthMm: 600 },
    { chestMm: 600, hoodDepthMm: 180 },
    { chestMm: 1300, hoodDepthMm: 180 },
    { chestMm: 1300, hoodDepthMm: 600 },
    { chestMm: Number.NaN, hoodDepthMm: Number.NaN },
  ]) {
    const p = generateTemplatePattern('hoodie', cfg);
    const bad = validatePatternSeams(p).filter((r) => !r.valid);
    assert.equal(bad.length, 0, `hoodie ${JSON.stringify(cfg)} bad seams: ${JSON.stringify(bad)}`);
    for (const pc of p.pieces) {
      assert.equal(polygonSelfIntersects(samplePieceOutline(pc)), false);
      assert.equal(polygonSelfIntersects(computePieceCutBoundary(pc)), false);
    }
  }

  // Pants sweep including child, oversized, palazzo, skinny, waist > hip
  for (const cfg of [
    {},
    { waistMm: 540, hipMm: 620, inseamMm: 520 },
    { waistMm: 1200, hipMm: 1550, inseamMm: 820 },
    { waistMm: 780, hipMm: 1020, ankleWidthMm: 900 },
    { waistMm: 780, hipMm: 1020, ankleWidthMm: 260 },
    { waistMm: 1100, hipMm: 950, inseamMm: 760 },
    { waistMm: Number.NaN, inseamMm: Number.POSITIVE_INFINITY },
  ]) {
    const p = generateTemplatePattern('pants', cfg);
    const results = validatePatternSeams(p);
    const bad = results.filter((r) => !r.valid);
    assert.equal(bad.length, 0, `pants ${JSON.stringify(cfg)} bad seams: ${JSON.stringify(bad)}`);
    const inseamR = results.find((r) => r.seamId && r.seamId.includes('inseam'));
    if (inseamR) {
      assert.ok(Math.abs(inseamR.deltaMm) <= 2.0, `pants inseam delta=${inseamR.deltaMm}`);
    }
  }

  // 3D back-seam reversed parity on tshirt (seam_neckband_back) and hoodie (seam_waistband_back)
  const cross3 = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const pieceWorldX = (piece, pt) => {
    const b = polygonBounds(piece.points);
    const localX = pt.x - (b.minX + b.maxX) * 0.5;
    const u = cross3(piece.placement3D.up, piece.placement3D.normal);
    return piece.placement3D.offset.x + localX * u.x;
  };
  const edgePtAt = (piece, edgeIdx, t) =>
    evalEdgeAt(
      piece.points[edgeIdx],
      piece.points[(edgeIdx + 1) % piece.points.length],
      piece.edges[edgeIdx]?.curve,
      t
    );

  const ts = generateTemplatePattern('tshirt');
  const tsFrontSeam = ts.seams.find((s) => s.id === 'seam_neckband_front');
  const tsBackSeam = ts.seams.find((s) => s.id === 'seam_neckband_back');
  assert.equal(tsFrontSeam.reversed, true);
  assert.equal(tsBackSeam.reversed, true);
  const tsFront = ts.pieces.find((p) => p.id === 'front_bodice');
  const tsBack = ts.pieces.find((p) => p.id === 'back_bodice');
  // At tA = frontRatio (junction of seam_neckband_front tEndA and seam_neckband_back tStartA):
  const tsFrontX = pieceWorldX(tsFront, edgePtAt(tsFront, tsFrontSeam.edgeB, tsFrontSeam.tStartB));
  const tsBackX = pieceWorldX(tsBack, edgePtAt(tsBack, tsBackSeam.edgeB, tsBackSeam.tEndB));
  assert.ok(Math.abs(tsFrontX - tsBackX) < 1e-6, `T-shirt neckband 3D X mismatch at frontRatio: ${tsFrontX} vs ${tsBackX}`);

  const hd = generateTemplatePattern('hoodie');
  const hdFrontSeam = hd.seams.find((s) => s.id === 'seam_waistband_front');
  const hdBackSeam = hd.seams.find((s) => s.id === 'seam_waistband_back');
  assert.equal(hdFrontSeam.reversed, true);
  assert.equal(hdBackSeam.reversed, true);
  const hdFront = hd.pieces.find((p) => p.id === 'front_bodice');
  const hdBack = hd.pieces.find((p) => p.id === 'back_bodice');
  // At tA = 0.5 (junction of seam_waistband_front tEndA and seam_waistband_back tStartA):
  const hdFrontX = pieceWorldX(hdFront, edgePtAt(hdFront, hdFrontSeam.edgeB, hdFrontSeam.tStartB));
  const hdBackX = pieceWorldX(hdBack, edgePtAt(hdBack, hdBackSeam.edgeB, hdBackSeam.tEndB));
  assert.ok(Math.abs(hdFrontX - hdBackX) < 1e-6, `Hoodie waistband 3D X mismatch at t=0.5: ${hdFrontX} vs ${hdBackX}`);
});

test('14. M1 r3 regression — coupled armhole-sleeve solver, finiteParam guards & freeform origin shift', () => {
  // (a) Wide 4D parameter sweep for tshirt + hoodie including extreme bicepWidthMm (120..500, 622)
  for (const chestMm of [400, 800, 1200, 1600]) {
    for (const lengthMm of [350, 650, 950]) {
      for (const bicepWidthMm of [120, 140, 320, 500]) {
        for (const easeMm of [0, 80, 150]) {
          const p = generateTemplatePattern('tshirt', { chestMm, lengthMm, bicepWidthMm, easeMm });
          const bad = validatePatternSeams(p).filter((r) => !r.valid);
          assert.equal(bad.length, 0, `tshirt(${chestMm},${lengthMm},${bicepWidthMm},${easeMm}): ${JSON.stringify(bad)}`);
          for (const pc of p.pieces) {
            assert.equal(polygonSelfIntersects(samplePieceOutline(pc)), false);
            assert.equal(polygonSelfIntersects(computePieceCutBoundary(pc)), false);
          }
        }
      }
    }
  }
  const narrowShoulder = generateTemplatePattern('tshirt', { chestMm: 1000, shoulderWidthMm: 150, bicepWidthMm: 120 });
  assert.equal(validatePatternSeams(narrowShoulder).filter((r) => !r.valid).length, 0);

  for (const chestMm of [450, 1080, 1600]) {
    for (const lengthMm of [350, 680, 950]) {
      for (const bicepWidthMm of [120, 140, 420, 622]) {
        const p = generateTemplatePattern('hoodie', { chestMm, lengthMm, bicepWidthMm });
        const bad = validatePatternSeams(p).filter((r) => !r.valid);
        assert.equal(bad.length, 0, `hoodie(${chestMm},${lengthMm},${bicepWidthMm}): ${JSON.stringify(bad)}`);
        for (const pc of p.pieces) {
          assert.equal(polygonSelfIntersects(samplePieceOutline(pc)), false);
          assert.equal(polygonSelfIntersects(computePieceCutBoundary(pc)), false);
        }
      }
    }
  }
  const hoodie1600Default = generateTemplatePattern('hoodie', { chestMm: 1600 });
  assert.equal(validatePatternSeams(hoodie1600Default).filter((r) => !r.valid).length, 0);

  // (b) finiteParam coercion/Symbol guard across all 5 templates + trimmed numeric strings
  const badParams = {
    chestMm: [],
    waistMm: false,
    hipMm: true,
    lengthMm: true,
    bicepWidthMm: '   ',
    easeMm: {},
    seamAllowance: Symbol('bad'),
    widthMm: [],
    heightMm: Symbol('h'),
    wedgeLengthMm: true,
    inseamMm: '\t\n',
  };
  for (const tpl of ['tshirt', 'hoodie', 'pants', 'tote_bag', 'stl_cover']) {
    const p = generateTemplatePattern(tpl, badParams);
    assert.equal(validatePatternSeams(p).filter((r) => !r.valid).length, 0, `${tpl} badParams seam failure`);
    for (const pc of p.pieces) {
      assert.equal(polygonSelfIntersects(samplePieceOutline(pc)), false);
      assert.equal(polygonSelfIntersects(computePieceCutBoundary(pc)), false);
    }
  }
  const trimmedTshirt = generateTemplatePattern('tshirt', { chestMm: ' 960 ' });
  assert.equal(trimmedTshirt.params.chestMm, 960);

  // (c) createFreeformPiece non-zero origin internalLines & grainline.start/end (CW & CCW)
  const cwBox = [{ x: -50, y: -30 }, { x: -50, y: 70 }, { x: 50, y: 70 }, { x: 50, y: -30 }];
  const ccwBox = [...cwBox].reverse();
  for (const pts of [cwBox, ccwBox]) {
    const pc = createFreeformPiece('NonZeroOrigin', pts, {
      internalLines: [{ id: 'il1', points: [{ x: 0, y: -10 }, { x: 0, y: 50 }] }],
      grainline: { start: { x: -10, y: 0 }, end: { x: -10, y: 40 } },
    });
    assert.deepEqual(pc.internalLines[0].points, [{ x: 50, y: 20 }, { x: 50, y: 80 }]);
    assert.deepEqual(pc.grainline.start, { x: 40, y: 30 });
    assert.deepEqual(pc.grainline.end, { x: 40, y: 70 });
    assert.ok(Number.isFinite(pc.grainline.angleDeg));
    assert.equal(validatePatternPiece(pc).valid, true);
  }
});

test('15. M1 r3 regression — normalizePatternProject strict falsy/null/type matrix & round-trip', () => {
  const tri = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }];
  const badValues = [null, '', 0, false, 'bad', 123, []];

  // Piece fields: position, rotationOrigin, grainline, placement3D
  for (const v of badValues) {
    assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, position: v }] }), ValidationError);
    assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, rotationOrigin: v }] }), ValidationError);
    assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, grainline: v }] }), ValidationError);
    assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, placement3D: v }] }), ValidationError);
    assert.throws(
      () => normalizePatternProject({ pieces: [{ points: tri, grainline: { angleDeg: 90, start: v } }] }),
      ValidationError
    );
    assert.throws(
      () => normalizePatternProject({ pieces: [{ points: tri, grainline: { angleDeg: 90, end: v } }] }),
      ValidationError
    );
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [{ points: tri, placement3D: { offset: v, normal: { x: 0, y: 0, z: 1 } } }],
        }),
      ValidationError
    );
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [{ points: tri, placement3D: { offset: { x: 0, y: 0, z: 0 }, normal: v } }],
        }),
      ValidationError
    );
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [{ points: tri, placement3D: { offset: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, up: v } }],
        }),
      ValidationError
    );
  }
  assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, grainline: {} }] }), ValidationError);
  assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, placement3D: {} }] }), ValidationError);

  // Null arrays & project-level fields
  for (const field of ['edges', 'notches', 'darts', 'internalLines']) {
    assert.throws(() => normalizePatternProject({ pieces: [{ points: tri, [field]: null }] }), ValidationError);
  }
  assert.throws(() => normalizePatternProject({ pieces: [], seams: null }), ValidationError);
  assert.throws(() => normalizePatternProject({ pieces: [], unit: null }), ValidationError);
  for (const badDisp of [null, '', 0, false, 'px', 123, []]) {
    assert.throws(() => normalizePatternProject({ pieces: [], displayUnit: badDisp }), ValidationError);
  }
  for (const badParams of [null, '', 0, false, 'bad', 123, []]) {
    assert.throws(() => normalizePatternProject({ pieces: [], params: badParams }), ValidationError);
    assert.throws(() => normalizePatternProject({ pieces: [], parameters: badParams }), ValidationError);
  }

  // Seam coercion guards
  const pA = createRectanglePiece('SA', 100, 50);
  const pB = createRectanglePiece('SB', 100, 50);
  for (const badIdx of [null, '', false, '0']) {
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [pA, pB],
          seams: [{ pieceA: pA.id, edgeA: badIdx, pieceB: pB.id, edgeB: 0 }],
        }),
      ValidationError
    );
  }
  for (const badT of [null, '', true, '1']) {
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [pA, pB],
          seams: [{ pieceA: pA.id, edgeA: 0, tEndA: badT, pieceB: pB.id, edgeB: 0 }],
        }),
      ValidationError
    );
  }
  for (const badIl of [null, '', 123]) {
    assert.throws(
      () =>
        normalizePatternProject({
          pieces: [pA, pB],
          seams: [{ pieceA: pA.id, edgeA: 0, pieceB: pB.id, internalLineIdB: badIl }],
        }),
      ValidationError
    );
  }

  // Valid defaults, nullable fields, numeric zeros, and round-trip
  const normMin = normalizePatternProject({
    pieces: [
      {
        points: tri,
        position: { x: 0, y: 0 },
        rotation: 0,
        seamAllowance: 0,
        edges: [{ seamAllowance: null, curve: null }, {}, {}],
        grainline: { angleDeg: 0 },
        placement3D: { offset: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      },
    ],
    material: null,
    avatar: null,
    stlMetadata: null,
  });
  assert.equal(normMin.pieces[0].edges[0].seamAllowance, 0);
  assert.deepEqual(normMin.pieces[0].placement3D.up, { x: 0, y: 1, z: 0 });
  const roundTrip = normalizePatternProject(createPatternProject({ pieces: [createRectanglePiece('RT', 100, 50)] }));
  assert.equal(roundTrip.pieces.length, 1);
  assert.equal(roundTrip.unit, 'mm');
});

test('16. M1 r3 regression — planar winding SA clipping (Trial #225, #824, 5-slot U-comb) & symmetric/clamped darts', () => {
  // (e) Trial #225 (5,745.9 mm² CW/CCW parity & spike preservation)
  const p225 = [
    { x: 120.56, y: -0.4 }, { x: 119.16, y: 41.96 }, { x: 106.96, y: 68.4 }, { x: 20.02, y: 24.22 },
    { x: 9.6, y: 25.35 }, { x: 0.68, y: 22.49 }, { x: -17.26, y: 100.11 }, { x: -32.99, y: 62.51 },
    { x: -23.89, y: 20.41 }, { x: -23.69, y: 10.1 }, { x: -26.7, y: 4.95 }, { x: -48.59, y: -6.06 },
    { x: -20.34, y: -10.32 }, { x: -28.18, y: -25.38 }, { x: -16.55, y: -28.26 }, { x: -25.38, y: -109.54 },
    { x: 12.46, y: -119.22 }, { x: 39.62, y: -98.11 }, { x: 44.94, y: -50.49 }, { x: 38.34, y: -24.29 },
    { x: 32.65, y: -10.36 },
  ];
  const sa225 = [25, 0, 25, 14.9, 25, 25, 25, 25, 19.5, 0, 25, 0, 0, 26.2, 0, 0, 26.3, 7.4, 25, 0, 0];
  const n225 = p225.length;
  const o225CCW = offsetPolygonOutward(p225, 10, sa225);
  const o225CW = offsetPolygonOutward([...p225].reverse(), 10, sa225.map((_, i) => sa225[(n225 - 2 - i + n225) % n225]));
  assert.equal(polygonSelfIntersects(o225CCW), false);
  assert.equal(polygonSelfIntersects(o225CW), false);
  assert.ok(Math.abs(polygonArea(o225CCW) - polygonArea(o225CW)) < 1e-3);
  assert.ok(polygonBounds(o225CCW).maxY >= 125 && polygonBounds(o225CW).maxY >= 125);

  // Trial #824 (2,302.4 mm² CW/CCW parity & v10 spike preservation)
  const p824 = [
    { x: 142.48, y: -5.98 }, { x: 82.93, y: 25.32 }, { x: 94.37, y: 74.51 }, { x: 68.77, y: 101.25 },
    { x: 17.37, y: 65.54 }, { x: -6.8, y: 70.97 }, { x: -42.26, y: 113.31 }, { x: -39.38, y: 39.8 },
    { x: -44.27, y: 24.07 }, { x: -76.83, y: 11.35 }, { x: -153.38, y: -21.88 }, { x: -48.14, y: -23.62 },
    { x: -104.78, y: -126.96 }, { x: -34.48, y: -77.7 }, { x: -21.97, y: -158.13 }, { x: 28.6, y: -95.1 },
    { x: 40.36, y: -67.32 }, { x: 94.98, y: -73.01 }, { x: 40.49, y: -13.66 },
  ];
  const sa824 = [0, 25, 25, 0, 0, 25, 25, 0, 25, 0, 0, 0, 25, 0, 25, 0, 0, 0, 25];
  const n824 = p824.length;
  const o824CCW = offsetPolygonOutward(p824, 10, sa824);
  const o824CW = offsetPolygonOutward([...p824].reverse(), 10, sa824.map((_, i) => sa824[(n824 - 2 - i + n824) % n824]));
  assert.equal(polygonSelfIntersects(o824CCW), false);
  assert.equal(polygonSelfIntersects(o824CW), false);
  assert.ok(Math.abs(polygonArea(o824CCW) - polygonArea(o824CW)) < 1e-3);
  assert.ok(polygonBounds(o824CCW).minX <= -153.38 && polygonBounds(o824CW).minX <= -153.38);

  // 5-slot U-comb (300x200 with 5 15mm slots) uniform SA=20 (340x240 = 81,600 mm²) & mixed 0/25/10 SA (335x210 = 70,350 mm²)
  const combPts = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }];
  for (let s = 0; s < 5; s++) {
    const rx = 275 - s * 55;
    combPts.push({ x: rx, y: 200 }, { x: rx, y: 120 }, { x: rx - 15, y: 120 }, { x: rx - 15, y: 200 });
  }
  combPts.push({ x: 0, y: 200 });
  const combUnif = offsetPolygonOutward(combPts, 20);
  const combUnifCW = offsetPolygonOutward([...combPts].reverse(), 20);
  assert.equal(polygonSelfIntersects(combUnif), false);
  assert.equal(polygonSelfIntersects(combUnifCW), false);
  assert.ok(Math.abs(polygonArea(combUnif) - 81600) < 1e-3);
  assert.ok(Math.abs(polygonArea(combUnif) - polygonArea(combUnifCW)) < 1e-3);
  const nComb = combPts.length;
  const combSA = combPts.map((_, i) => (i === 0 ? 0 : i === 1 ? 25 : 10));
  const combMixed = offsetPolygonOutward(combPts, 10, combSA);
  const combMixedCW = offsetPolygonOutward([...combPts].reverse(), 10, combSA.map((_, i) => combSA[(nComb - 2 - i + nComb) % nComb]));
  assert.equal(polygonSelfIntersects(combMixed), false);
  assert.equal(polygonSelfIntersects(combMixedCW), false);
  assert.ok(Math.abs(polygonArea(combMixed) - 70350) < 1e-3);
  assert.ok(Math.abs(polygonArea(combMixed) - polygonArea(combMixedCW)) < 1e-3);

  // (f) Narrow 3-dart packing CW/CCW parity + corner-adjacent concave Bezier darts + quad_convex t=0.5 non-clamping
  const ccwNarrow = {
    points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }],
    edges: [{}, {}, {}, {}],
    darts: [
      { edgeIndex: 0, t: 0.95, widthMm: 2, depthMm: 15 },
      { edgeIndex: 0, t: 0.97, widthMm: 2, depthMm: 15 },
      { edgeIndex: 0, t: 0.98, widthMm: 2, depthMm: 15 },
    ],
  };
  const cwNarrow = {
    points: [{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 0 }],
    edges: [{}, {}, {}, {}],
    darts: [
      { edgeIndex: 3, t: 0.05, widthMm: 2, depthMm: 15 },
      { edgeIndex: 3, t: 0.03, widthMm: 2, depthMm: 15 },
      { edgeIndex: 3, t: 0.02, widthMm: 2, depthMm: 15 },
    ],
  };
  const outCCWNarrow = samplePieceOutline(ccwNarrow);
  const outCWNarrow = samplePieceOutline(cwNarrow);
  assert.equal(outCCWNarrow.length, 13);
  assert.equal(outCWNarrow.length, 13);
  assert.ok(Math.abs(polygonArea(outCCWNarrow) - polygonArea(outCWNarrow)) < 1e-6);
  const cutCCWNarrow = computePieceCutBoundary(ccwNarrow);
  const cutCWNarrow = computePieceCutBoundary(cwNarrow);
  assert.equal(polygonSelfIntersects(cutCCWNarrow), false);
  assert.equal(polygonSelfIntersects(cutCWNarrow), false);
  assert.ok(Math.abs(polygonArea(cutCCWNarrow) - polygonArea(cutCWNarrow)) < 1e-6);

  // Corner-adjacent concave Bezier darts (quad_concave & cubic_s)
  for (const curve of [
    { cp: { x: 150, y: 80 } },
    { cp1: { x: 90, y: 90 }, cp2: { x: 210, y: -50 } },
  ]) {
    const ccwBezier = {
      points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }],
      edges: [{ curve }, {}, {}, {}],
      darts: [
        { edgeIndex: 0, t: 0.97, widthMm: 20, depthMm: 45 },
        { edgeIndex: 0, t: 0.98, widthMm: 20, depthMm: 55 },
        { edgeIndex: 0, t: 0.99, widthMm: 20, depthMm: 60 },
      ],
    };
    const cwBezier = {
      points: [{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 0 }],
      edges: [{}, {}, {}, { curve: curve.cp1 ? { cp1: curve.cp2, cp2: curve.cp1 } : curve }],
      darts: [
        { edgeIndex: 3, t: 0.03, widthMm: 20, depthMm: 45 },
        { edgeIndex: 3, t: 0.02, widthMm: 20, depthMm: 55 },
        { edgeIndex: 3, t: 0.01, widthMm: 20, depthMm: 60 },
      ],
    };
    const oA = samplePieceOutline(ccwBezier);
    const oB = samplePieceOutline(cwBezier);
    const cA = computePieceCutBoundary(ccwBezier);
    const cB = computePieceCutBoundary(cwBezier);
    assert.equal(polygonSelfIntersects(oA), false);
    assert.equal(polygonSelfIntersects(oB), false);
    assert.equal(polygonSelfIntersects(cA), false);
    assert.equal(polygonSelfIntersects(cB), false);
    assert.ok(Math.abs(polygonArea(oA) - polygonArea(oB)) < 1e-3);
    assert.ok(Math.abs(polygonArea(cA) - polygonArea(cB)) < 1e-3);
  }

  // quad_convex t=0.5 non-clamping check (full 30mm depth preserved)
  const quadConvex = {
    points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }],
    edges: [{ curve: { cp: { x: 150, y: -60 } } }, {}, {}, {}],
    darts: [{ edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 30 }],
  };
  const qcOut = samplePieceOutline(quadConvex);
  assert.equal(polygonSelfIntersects(qcOut), false);
  // Apex at x=150 should sit at y = -30 + 30 = 0 (unclamped 30mm inward from curve midpoint (150, -30))
  const apexPt = qcOut.find((pt) => Math.abs(pt.x - 150) < 1e-4 && Math.abs(pt.y) < 1e-4);
  assert.ok(apexPt, 'quad_convex t=0.5 dart apex should not be falsely clamped');

  // Degenerate zero-start-tangent cubic (cp1 === p0) with narrow folded darts & SA=40 (CW & CCW parity + non-self-intersecting)
  const degenCurve = { cp1: { x: 0, y: 0 }, cp2: { x: 250, y: 50 } };
  const degenCCW = {
    points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }],
    seamAllowance: 40,
    edges: [{ curve: degenCurve }, {}, {}, {}],
    darts: [0.95, 0.97, 0.98].map((t) => ({ edgeIndex: 0, t, widthMm: 2, depthMm: 15, folded: true })),
  };
  const degenCW = {
    points: [{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 0 }],
    seamAllowance: 40,
    edges: [{}, {}, {}, { curve: { cp1: degenCurve.cp2, cp2: degenCurve.cp1 } }],
    darts: [0.95, 0.97, 0.98].map((t) => ({ edgeIndex: 3, t: 1 - t, widthMm: 2, depthMm: 15, folded: true })),
  };
  const cutDegenCCW = computePieceCutBoundary(degenCCW);
  const cutDegenCW = computePieceCutBoundary(degenCW);
  assert.equal(polygonSelfIntersects(cutDegenCCW), false);
  assert.equal(polygonSelfIntersects(cutDegenCW), false);
  assert.equal(cutDegenCCW.length, cutDegenCW.length);
  assert.ok(Math.abs(polygonArea(cutDegenCCW) - polygonArea(cutDegenCW)) < 1e-6);
});

test('17. M1 r4 regression — pants backRiseMm outseam coupling, types.mjs validation parity, dart-vs-dart V-leg collision & grainline y-finiteness', () => {
  // (a) Defect 1: generatePantsPattern side outseam vs center-back rise coupling
  const pantsConfigs = [
    { backRiseMm: ' 960 ' },
    { inseamMm: 250, frontRiseMm: 160, backRiseMm: 280 },
    { frontRiseMm: 350, backRiseMm: 200 },
    { frontRiseMm: 500, backRiseMm: 120, inseamMm: 250, hipMm: 1800, waistMm: 400 },
    { waistMm: 400, hipMm: 2500, inseamMm: 250, frontRiseMm: 160, backRiseMm: 960, seamAllowance: 25 },
  ];
  for (const cfg of pantsConfigs) {
    const p = generateTemplatePattern('pants', cfg);
    assert.equal(validatePatternProject(p, { requireNonEmpty: true }).valid, true);
    const badSeams = validatePatternSeams(p).filter((r) => !r.valid);
    assert.equal(badSeams.length, 0, `pants(${JSON.stringify(cfg)}) bad seams: ${JSON.stringify(badSeams)}`);

    const frontLeg = p.pieces.find((pc) => pc.id === 'front_leg_left');
    const backLeg = p.pieces.find((pc) => pc.id === 'back_leg_left');
    const frontOutseamLen = dist2D(frontLeg.points[4], frontLeg.points[0]);
    const backOutseamLen = dist2D(backLeg.points[4], backLeg.points[0]);
    assert.ok(
      Math.abs(frontOutseamLen - backOutseamLen) < 1e-3,
      `Front vs back side outseam mismatch: ${frontOutseamLen} vs ${backOutseamLen}`
    );

    for (const pc of p.pieces) {
      const net = samplePieceOutline(pc);
      const cut = computePieceCutBoundary(pc);
      assert.equal(polygonSelfIntersects(net), false, `${pc.id} net self-intersects`);
      assert.equal(polygonSelfIntersects(cut), false, `${pc.id} cut self-intersects`);
      assert.ok(polygonArea(cut) >= polygonArea(net));
    }
  }

  // (b) Defect 2: validateSeam & normalizePatternProject validation parity
  const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  const triPiece = { id: 'p', points: tri, edges: [{}, {}, {}] };
  const badValues = [null, '', 0, false, 'bad', 123, [], {}];

  for (const v of badValues) {
    assert.throws(
      () =>
        validateSeam(
          { id: 's', pieceA: 'p', edgeA: 0, pieceB: 'p', edgeB: 1, internalLineIdB: v },
          new Map([['p', triPiece]])
        ),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
    assert.throws(
      () =>
        normalizePatternProject({
          unit: 'mm',
          pieces: [triPiece],
          seams: [{ id: 's', pieceA: 'p', edgeA: 0, pieceB: 'p', edgeB: 1, internalLineIdB: v }],
        }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
    assert.throws(
      () =>
        normalizePatternProject({
          unit: 'mm',
          pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], notches: [{ edgeIndex: 0, t: 0.5, type: v }] }],
          seams: [],
        }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_NOTCH'
    );
    assert.throws(
      () =>
        validatePatternPiece({
          id: 'p',
          points: tri,
          edges: [{}, {}, {}],
          notches: [{ edgeIndex: 0, t: 0.5, type: v }],
        }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_NOTCH'
    );
  }

  const badCurves = [
    { cp1: { x: 10, y: 10 } },
    { cp2: { x: 10, y: 10 } },
    { cp1: { x: 10, y: 10 }, cp2: null },
    { cp1: { x: Number.NaN, y: 10 }, cp2: { x: 20, y: 20 } },
    { cp: null },
    { cp: { x: 10, y: 'bad' } },
    {},
  ];
  for (const curve of badCurves) {
    assert.throws(
      () => normalizePatternProject({ unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{ curve }, {}, {}] }] }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_CURVE'
    );
    assert.throws(
      () => validatePatternPiece({ id: 'p', points: tri, edges: [{ curve }, {}, {}] }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_CURVE'
    );
  }

  // (c) Defect 3: clampDartApexToBoundary dart-vs-dart V-leg collision & CW/CCW parity
  const reversePieceForTest = (piece) => {
    const n = piece.points.length;
    const pts = [...piece.points].reverse();
    const edges = Array.from({ length: n }, (_, i) => {
      const srcIdx = (n - 2 - i + n) % n;
      const e = piece.edges?.[srcIdx] || {};
      const out = { ...e };
      if (e.curve?.cp1 && e.curve?.cp2) {
        out.curve = { cp1: e.curve.cp2, cp2: e.curve.cp1 };
      }
      return out;
    });
    const darts = (piece.darts || []).map((d) => ({
      ...d,
      edgeIndex: (n - 2 - d.edgeIndex + n) % n,
      t: 1 - d.t,
    }));
    return { ...piece, points: pts, edges, darts };
  };

  const dartCollisionCases = [
    {
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      edges: [{}, {}, {}, {}],
      seamAllowance: 10,
      darts: [
        { edgeIndex: 0, t: 0.9, widthMm: 10, depthMm: 30, folded: false },
        { edgeIndex: 1, t: 0.1, widthMm: 10, depthMm: 30, folded: false },
      ],
    },
    {
      points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 160 }, { x: 0, y: 160 }],
      edges: [{ curve: { cp1: { x: 50, y: 140 }, cp2: { x: 150, y: 140 } } }, {}, {}, {}],
      seamAllowance: 10,
      darts: [
        { edgeIndex: 0, t: 0.2, widthMm: 12, depthMm: 60, folded: false },
        { edgeIndex: 0, t: 0.8, widthMm: 12, depthMm: 60, folded: false },
      ],
    },
    {
      points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }],
      edges: [{}, {}, {}],
      seamAllowance: 12,
      darts: [
        { edgeIndex: 0, t: 0.1, widthMm: 12, depthMm: 45, folded: false },
        { edgeIndex: 2, t: 0.9, widthMm: 12, depthMm: 45, folded: false },
      ],
    },
  ];

  for (const ccw of dartCollisionCases) {
    const cw = reversePieceForTest(ccw);
    const outCCW = samplePieceOutline(ccw, 16);
    const outCW = samplePieceOutline(cw, 16);
    const cutCCW = computePieceCutBoundary(ccw, 16);
    const cutCW = computePieceCutBoundary(cw, 16);
    assert.equal(polygonSelfIntersects(outCCW), false);
    assert.equal(polygonSelfIntersects(outCW), false);
    assert.equal(polygonSelfIntersects(cutCCW), false);
    assert.equal(polygonSelfIntersects(cutCW), false);
    assert.ok(Math.abs(polygonArea(outCCW) - polygonArea(outCW)) < 1e-4);
    assert.ok(Math.abs(polygonArea(cutCCW) - polygonArea(cutCW)) < 1e-3);

    const mesh = generateClothMesh2D(outCCW, 20);
    let negTris = 0;
    for (const [a, b, c] of mesh.triangles) {
      const pa = mesh.vertices[a];
      const pb = mesh.vertices[b];
      const pc = mesh.vertices[c];
      if (((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)) * 0.5 <= 0) {
        negTris++;
      }
    }
    assert.equal(negTris, 0);
    const topo = computeEulerCharacteristic(mesh.vertices, mesh.triangles);
    assert.equal(topo.euler, 1);
  }

  // (d) Minor 4: createFreeformPiece grainline start/end y-finiteness guard
  const grainY = createFreeformPiece('GrainMissingY', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], {
    grainline: { start: { x: 0 }, end: { x: 10, y: 10 } },
  });
  assert.equal(grainY.grainline.angleDeg, 90);
});

test('18. M1 r5 regression — curved-piece winding, mirrorPieceAcrossEdge grainline shift, createFreeformPiece incomplete grainline/SA, types.mjs code parity & extreme pants guard', () => {
  const reversePiece = (piece) => {
    const n = piece.points.length;
    const pts = [...piece.points].reverse();
    const edges = Array.from({ length: n }, (_, i) => {
      const srcIdx = (n - 2 - i + n) % n;
      const e = piece.edges?.[srcIdx] || {};
      const out = { ...e };
      if (e.curve?.cp1 && e.curve?.cp2) {
        out.curve = { cp1: { ...e.curve.cp2 }, cp2: { ...e.curve.cp1 } };
      } else if (e.curve?.cp) {
        out.curve = { cp: { ...e.curve.cp } };
      }
      return out;
    });
    const darts = (piece.darts || []).map((d) => ({
      ...d,
      edgeIndex: (n - 2 - d.edgeIndex + n) % n,
      t: 1 - d.t,
    }));
    const notches = (piece.notches || []).map((nt) => ({
      ...nt,
      edgeIndex: (n - 2 - nt.edgeIndex + n) % n,
      t: 1 - nt.t,
    }));
    return { ...piece, points: pts, edges, darts, notches };
  };

  // (1) Curved-piece winding classification on collinear-baseline & chord-flipped curved pieces
  const dome = {
    id: 'dome',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }],
    edges: [{}, {}, { curve: { cp1: { x: 200, y: 150 }, cp2: { x: 0, y: 150 } } }],
    seamAllowance: 10,
    darts: [{ edgeIndex: 2, t: 0.5, widthMm: 12, depthMm: 25, folded: false }],
    notches: [{ edgeIndex: 2, t: 0.25, type: 'single' }],
  };
  const domeFolded = {
    ...dome,
    id: 'domeFolded',
    darts: [{ edgeIndex: 2, t: 0.5, widthMm: 12, depthMm: 25, folded: true }],
  };
  const hsCollinear = {
    id: 'hsCollinear',
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 160, y: 0 }, { x: 200, y: 0 }],
    edges: [{}, {}, {}, { curve: { cp1: { x: 200, y: 160 }, cp2: { x: 0, y: 160 } } }],
    seamAllowance: 10,
    darts: [{ edgeIndex: 3, t: 0.5, widthMm: 14, depthMm: 25, folded: false }],
    notches: [{ edgeIndex: 3, t: 0.3, type: 'single' }],
  };
  const crescent = {
    id: 'crescent',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 10 }],
    edges: [{ curve: { cp: { x: 50, y: 120 } } }, {}, {}],
    seamAllowance: 10,
    darts: [{ edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 15, folded: false }],
    notches: [{ edgeIndex: 0, t: 0.25, type: 'single' }],
  };

  for (const ccwOrCw of [dome, domeFolded, hsCollinear, crescent]) {
    assert.equal(validatePatternPiece(ccwOrCw).valid, true);
    const flipped = reversePiece(ccwOrCw);
    const outA = samplePieceOutline(ccwOrCw, 16);
    const outB = samplePieceOutline(flipped, 16);
    const cutA = computePieceCutBoundary(ccwOrCw, 16);
    const cutB = computePieceCutBoundary(flipped, 16);

    assert.equal(polygonSelfIntersects(outA), false, `${ccwOrCw.id} outline self-intersects`);
    assert.equal(polygonSelfIntersects(outB), false, `${ccwOrCw.id} flipped outline self-intersects`);
    assert.equal(polygonSelfIntersects(cutA), false, `${ccwOrCw.id} cut self-intersects`);
    assert.equal(polygonSelfIntersects(cutB), false, `${ccwOrCw.id} flipped cut self-intersects`);

    const outAreaA = polygonArea(outA);
    const outAreaB = polygonArea(outB);
    const cutAreaA = polygonArea(cutA);
    const cutAreaB = polygonArea(cutB);
    assert.ok(Math.abs(outAreaA - outAreaB) < 1e-3, `${ccwOrCw.id} outArea mismatch: ${outAreaA} vs ${outAreaB}`);
    assert.ok(Math.abs(cutAreaA - cutAreaB) < 1e-3, `${ccwOrCw.id} cutArea mismatch: ${cutAreaA} vs ${cutAreaB}`);
    assert.ok(cutAreaA > outAreaA, `${ccwOrCw.id} cutArea (${cutAreaA}) must exceed outArea (${outAreaA})`);

    const notchA = computePieceNotches(ccwOrCw)[0];
    const notchB = computePieceNotches(flipped)[0];
    assert.ok(notchA.normal.y > 0, `${ccwOrCw.id} notch normal should point outward (y > 0), got ${notchA.normal.y}`);
    assert.ok(dist2D(notchA.normal, notchB.normal) < 1e-6, `${ccwOrCw.id} CW/CCW notch normal mismatch`);

    const mesh = generateClothMesh2D(outA, 20);
    let negTris = 0;
    for (const [a, b, c] of mesh.triangles) {
      const pa = mesh.vertices[a];
      const pb = mesh.vertices[b];
      const pc = mesh.vertices[c];
      if (((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)) * 0.5 <= 0) negTris++;
    }
    assert.equal(negTris, 0, `${ccwOrCw.id} mesh had negative triangles`);
  }

  // (2) mirrorPieceAcrossEdge shifts grainline.start & end by shiftPt (world invariance & inside mirrored piece)
  const mirTri = createFreeformPiece('MirTri', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }], {
    position: { x: 40, y: 200 },
    grainline: { angleDeg: 90, start: { x: 80, y: 20 }, end: { x: 80, y: 120 } },
  });
  const worldBefore = transformPiecePoints([mirTri.grainline.start, mirTri.grainline.end], mirTri);
  mirrorPieceAcrossEdge(mirTri, 0);
  const worldAfter = transformPiecePoints([mirTri.grainline.start, mirTri.grainline.end], mirTri);
  assert.ok(dist2D(worldBefore[0], worldAfter[0]) < 1e-6);
  assert.ok(dist2D(worldBefore[1], worldAfter[1]) < 1e-6);
  const mirOutline = samplePieceOutline(mirTri, 12);
  assert.equal(pointInPolygon(mirTri.grainline.start, mirOutline), true);
  assert.equal(pointInPolygon(mirTri.grainline.end, mirOutline), true);
  assert.equal(validatePatternPiece(mirTri).valid, true);

  // (3) createFreeformPiece incomplete grainline & negative/non-finite seamAllowance
  const incompleteGrain = createFreeformPiece(
    'IncompleteGrain',
    [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }],
    {
      seamAllowance: -5,
      edges: [{ seamAllowance: -2 }, {}, {}, {}],
      grainline: { start: { x: 150 }, end: { x: 250, y: 300 } },
    }
  );
  assert.equal(incompleteGrain.seamAllowance, 0);
  assert.equal(incompleteGrain.edges[0].seamAllowance, 0);
  assert.equal(incompleteGrain.grainline.angleDeg, 90);
  assert.equal(incompleteGrain.grainline.start, undefined);
  assert.equal(incompleteGrain.grainline.end, undefined);
  assert.equal(validatePatternPiece(incompleteGrain).valid, true);
  const compGrain = computePieceGrainline(incompleteGrain);
  assert.ok(Number.isFinite(compGrain.start.x) && Number.isFinite(compGrain.end.y));

  const negRect = createRectanglePiece('NegRect', 120, 80, { seamAllowance: -10 });
  assert.equal(negRect.seamAllowance, 0);
  assert.equal(validatePatternPiece(negRect).valid, true);

  // (4) types.mjs full error-code parity between validatePatternProject and normalizePatternProject
  const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  const parityCases = [
    {
      code: 'INVALID_PIECE',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], seamAllowance: Number.NaN }] },
    },
    {
      code: 'INVALID_PIECE',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], rotation: Number.POSITIVE_INFINITY }] },
    },
    {
      code: 'INVALID_PIECE',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], position: { x: Number.NaN, y: 0 } }] },
    },
    {
      code: 'INVALID_PIECE',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], rotationOrigin: { x: 0, y: Number.NaN } }] },
    },
    {
      code: 'INVALID_EDGES',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{ seamAllowance: null }, {}, {}].map((e, i) => (i === 0 ? { seamAllowance: Number.NaN } : e)) }] },
    },
    {
      code: 'INVALID_NOTCH',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], notches: [{ edgeIndex: 0, t: 0.5, depthMm: Number.NaN }] }] },
    },
    {
      code: 'INVALID_DART',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], darts: [{ edgeIndex: 0, t: 0.5, widthMm: Number.NaN, depthMm: 20 }] }] },
    },
    {
      code: 'INVALID_DART',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], darts: [{ edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: Number.NaN }] }] },
    },
    {
      code: 'INVALID_POINTS',
      project: { unit: 'mm', pieces: [{ id: 'p', points: [{ x: Number.NaN, y: 0 }, tri[1], tri[2]], edges: [{}, {}, {}] }] },
    },
    {
      code: 'INVALID_INTERNAL_LINE',
      project: {
        unit: 'mm',
        pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], internalLines: [{ id: 'il', points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 10 }] }] }],
      },
    },
    {
      code: 'INVALID_GRAINLINE',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], grainline: { angleDeg: Number.NaN } }] },
    },
    {
      code: 'INVALID_GRAINLINE',
      project: { unit: 'mm', pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], grainline: { angleDeg: 90, start: { x: Number.NaN, y: 0 } } }] },
    },
    {
      code: 'INVALID_PLACEMENT_3D',
      project: {
        unit: 'mm',
        pieces: [{ id: 'p', points: tri, edges: [{}, {}, {}], placement3D: { offset: { x: Number.NaN, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } } }],
      },
    },
  ];
  for (const tc of parityCases) {
    let valErr = null;
    let normErr = null;
    try {
      validatePatternProject(tc.project);
    } catch (e) {
      valErr = e;
    }
    try {
      normalizePatternProject(tc.project);
    } catch (e) {
      normErr = e;
    }
    assert.ok(valErr instanceof ValidationError, `Expected validatePatternProject to throw for ${tc.code}`);
    assert.ok(normErr instanceof ValidationError, `Expected normalizePatternProject to throw for ${tc.code}`);
    assert.equal(valErr.code, tc.code);
    assert.equal(normErr.code, tc.code);
  }

  // (5) generatePantsPattern extreme hip-to-inseam guard
  for (const cfg of [
    { waistMm: 800, hipMm: 4500, inseamMm: 250, frontRiseMm: 160, backRiseMm: 200, ankleWidthMm: 200 },
    { waistMm: 400, hipMm: 2500, inseamMm: 250, frontRiseMm: 450, backRiseMm: 120, ankleWidthMm: 200 },
    { waistMm: 400, hipMm: 2500, inseamMm: 250, frontRiseMm: 450, backRiseMm: 200, ankleWidthMm: 200 },
    { waistMm: 400, hipMm: 6000, inseamMm: 250, frontRiseMm: 160, backRiseMm: 200, ankleWidthMm: 200 },
    { waistMm: 400, hipMm: 10000, inseamMm: 250, frontRiseMm: 160, backRiseMm: 200, ankleWidthMm: 200 },
  ]) {
    const p = generateTemplatePattern('pants', cfg);
    assert.equal(validatePatternProject(p, { requireNonEmpty: true }).valid, true);
    const badSeams = validatePatternSeams(p).filter((r) => !r.valid);
    assert.equal(badSeams.length, 0, `extreme pants(${JSON.stringify(cfg)}) bad seams: ${JSON.stringify(badSeams)}`);
    for (const pc of p.pieces) {
      const net = samplePieceOutline(pc, 24);
      const cut = computePieceCutBoundary(pc, 24);
      assert.equal(polygonSelfIntersects(net), false, `${pc.id} net self-intersects`);
      assert.equal(polygonSelfIntersects(cut), false, `${pc.id} cut self-intersects`);
      assert.ok(polygonArea(cut) > polygonArea(net), `${pc.id} cut area must exceed net area`);
      const mesh = generateClothMesh2D(net, 35);
      let negTris = 0;
      for (const [a, b, c] of mesh.triangles) {
        const pa = mesh.vertices[a];
        const pb = mesh.vertices[b];
        const pcV = mesh.vertices[c];
        if (((pb.x - pa.x) * (pcV.y - pa.y) - (pb.y - pa.y) * (pcV.x - pa.x)) * 0.5 <= 0) negTris++;
      }
      assert.equal(negTris, 0, `${pc.id} mesh has ${negTris} negative triangles`);
    }
  }
});

test('19. M1 r6 regression — computePieceNotches null edge SA, imperative CAD non-finite guards, freeform/rect options & 31:1 pants guard', () => {
  // (1) computePieceNotches: edge.seamAllowance: null inherits piece.seamAllowance (Challenger 1)
  for (const [pieceSa, expectedNullDepth] of [
    [20, 6],
    [4, 3],
    [0, 5],
  ]) {
    const nullEdgePiece = {
      id: `null_sa_${pieceSa}`,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      edges: [{ seamAllowance: null }, { seamAllowance: undefined }, { seamAllowance: 0 }, {}],
      seamAllowance: pieceSa,
      notches: [
        { edgeIndex: 0, t: 0.5, type: 'single' },
        { edgeIndex: 1, t: 0.5, type: 'single' },
        { edgeIndex: 2, t: 0.5, type: 'single' },
      ],
    };
    assert.equal(validatePatternPiece(nullEdgePiece).valid, true);
    assert.equal(computePieceMeasurements(nullEdgePiece).edges[0].seamAllowanceMm, pieceSa);
    const notches = computePieceNotches(nullEdgePiece);
    const depthNull = dist2D(notches[0].lines[0][0], notches[0].lines[0][1]);
    const depthUndef = dist2D(notches[1].lines[0][0], notches[1].lines[0][1]);
    const depthZero = dist2D(notches[2].lines[0][0], notches[2].lines[0][1]);
    assert.ok(Math.abs(depthNull - expectedNullDepth) < 1e-6, `SA=${pieceSa} null depth=${depthNull}`);
    assert.ok(Math.abs(depthUndef - expectedNullDepth) < 1e-6, `SA=${pieceSa} undef depth=${depthUndef}`);
    assert.ok(Math.abs(depthZero - 5) < 1e-6, `explicit 0 SA depth=${depthZero}`);
  }

  // (2) Imperative CAD helpers: addDartToPiece, addNotchToPiece, splitPieceEdge, deletePieceVertex, mirrorPieceAcrossEdge
  const rDart = createRectanglePiece('RDart', 100, 100);
  addDartToPiece(rDart, { edgeIndex: 0, t: Number.NaN, widthMm: 'abc', depthMm: Number.POSITIVE_INFINITY });
  assert.deepEqual(validatePatternPiece(rDart, 'rDart', { throwOnError: false }).errors, []);
  assert.ok(Number.isFinite(rDart.darts[0].t) && rDart.darts[0].t > 0 && rDart.darts[0].t < 1);

  const rNotch = createRectanglePiece('RNotch', 100, 100);
  addNotchToPiece(rNotch, { edgeIndex: Number.NaN, t: Number.NaN, depthMm: 'abc' });
  assert.deepEqual(validatePatternPiece(rNotch, 'rNotch', { throwOnError: false }).errors, []);
  assert.equal(rNotch.notches[0].edgeIndex, 0);
  assert.equal(rNotch.notches[0].t, 0.5);
  assert.equal(rNotch.notches[0].depthMm, 5);

  const pantsSplit = generateTemplatePattern('pants');
  splitPieceEdge(pantsSplit.pieces[0], 0, Number.NaN, pantsSplit);
  assert.deepEqual(validatePatternProject(pantsSplit, { throwOnError: false }).errors, []);

  const rSplitEdge = createRectanglePiece('RSplitEdge', 100, 100);
  splitPieceEdge(rSplitEdge, Number.NaN, 0.5);
  assert.deepEqual(validatePatternPiece(rSplitEdge, 'rSplitEdge', { throwOnError: false }).errors, []);
  assert.equal(rSplitEdge.points.length, 5);

  const rMirror = createRectanglePiece('RMirror', 100, 100);
  mirrorPieceAcrossEdge(rMirror, Number.NaN);
  assert.deepEqual(validatePatternPiece(rMirror, 'rMirror', { throwOnError: false }).errors, []);
  assert.equal(rMirror.points.length, 6);

  const rSym = createRectanglePiece('RSym', 120, 100);
  addDartToPiece(rSym, { edgeIndex: 1.5, t: Symbol('t'), widthMm: Symbol('w'), depthMm: Symbol('d') });
  addNotchToPiece(rSym, { edgeIndex: Symbol('e'), t: Symbol('t'), depthMm: Symbol('d') });
  splitPieceEdge(rSym, 1.5, Symbol('t'));
  deletePieceVertex(rSym, Number.NaN);
  assert.throws(
    () => mirrorPieceAcrossEdge(rSym, Symbol('m')),
    (err) => err?.code === 'SELF_INTERSECTING_MIRROR'
  );
  assert.deepEqual(validatePatternPiece(rSym, 'rSym', { throwOnError: false }).errors, []);

  const rMirSym = createRectanglePiece('RMirSym', 120, 100);
  mirrorPieceAcrossEdge(rMirSym, Symbol('m'));
  assert.deepEqual(validatePatternPiece(rMirSym, 'rMirSym', { throwOnError: false }).errors, []);
  assert.equal(rMirSym.points.length, 6);
  assert.equal(polygonSelfIntersects(rMirSym.points), false);

  // (3) createFreeformPiece & createRectanglePiece option guards
  const rfNaN = createRectanglePiece('RF', 100, 100, { onFold: true, foldEdgeIndex: Number.NaN });
  assert.deepEqual(validatePatternPiece(rfNaN, 'rf', { throwOnError: false }).errors, []);
  assert.equal(rfNaN.edges[3].seamAllowance, 0);

  const rfFrac = createRectanglePiece('RFFrac', 100, 100, { onFold: true, foldEdgeIndex: 1.5 });
  assert.deepEqual(validatePatternPiece(rfFrac, 'rfFrac', { throwOnError: false }).errors, []);
  assert.equal(rfFrac.edges[1].seamAllowance, 0);
  assert.deepEqual(rfFrac.internalLines[0].points, [
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);

  const ffBadOpts = createFreeformPiece(
    'FF',
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    {
      quantity: Number.NaN,
      rotation: Number.POSITIVE_INFINITY,
      position: { x: 10 },
      internalLines: [
        { id: 'bad_il', points: [{ x: Number.NaN, y: 0 }, { x: 20, y: 20 }] },
        { id: 'good_il', points: [{ x: 10, y: 10 }, { x: 30, y: 20 }] },
      ],
    }
  );
  assert.deepEqual(validatePatternPiece(ffBadOpts, 'ff', { throwOnError: false }).errors, []);
  assert.equal(ffBadOpts.quantity, 1);
  assert.equal(ffBadOpts.rotation, 0);
  assert.deepEqual(ffBadOpts.position, { x: 10, y: 0 });
  assert.equal(ffBadOpts.internalLines.length, 1);
  assert.equal(ffBadOpts.internalLines[0].id, 'good_il');

  // (4) Pathological 31:1 and 50:1 hip-to-waist generatePantsPattern guard
  for (const cfg of [
    { waistMm: 400, hipMm: 12500, inseamMm: 877, frontRiseMm: 160, backRiseMm: 120, ankleWidthMm: 223 },
    { waistMm: 400, hipMm: 20000, inseamMm: 877, frontRiseMm: 160, backRiseMm: 120, ankleWidthMm: 223 },
  ]) {
    const p = generateTemplatePattern('pants', cfg);
    assert.equal(validatePatternProject(p, { requireNonEmpty: true }).valid, true);
    const badSeams = validatePatternSeams(p).filter((r) => !r.valid);
    assert.equal(badSeams.length, 0, `pathological pants(${JSON.stringify(cfg)}) bad seams: ${JSON.stringify(badSeams)}`);

    const backLeg = p.pieces.find((pc) => pc.id === 'back_leg_left');
    const sw = backLeg.points[0];
    const cw = backLeg.points[1];
    const hem = backLeg.points[4];
    const outseamXAtCw = sw.x + (hem.x - sw.x) * ((cw.y - sw.y) / Math.max(1, hem.y - sw.y));
    assert.ok(cw.x > outseamXAtCw + 2, `centerWaist (${cw.x}) must sit >2mm right of outseamXAt (${outseamXAtCw})`);

    for (const pc of p.pieces) {
      const net = samplePieceOutline(pc, 24);
      const cut = computePieceCutBoundary(pc, 24);
      assert.equal(polygonSelfIntersects(net), false, `${pc.id} net self-intersects`);
      assert.equal(polygonSelfIntersects(cut), false, `${pc.id} cut self-intersects`);
      assert.ok(polygonArea(cut) > polygonArea(net), `${pc.id} cut area must exceed net area`);
      const mesh = generateClothMesh2D(net, 60);
      let negTris = 0;
      for (const [a, b, c] of mesh.triangles) {
        const pa = mesh.vertices[a];
        const pb = mesh.vertices[b];
        const pcV = mesh.vertices[c];
        if (((pb.x - pa.x) * (pcV.y - pa.y) - (pb.y - pa.y) * (pcV.x - pa.x)) * 0.5 <= 0) negTris++;
      }
      assert.equal(negTris, 0, `${pc.id} mesh has ${negTris} negative triangles`);
      const topo = computeEulerCharacteristic(mesh.vertices, mesh.triangles);
      assert.equal(topo.euler, 1, `${pc.id} mesh Euler=${topo.euler} != 1`);
    }
  }
});

test('20. M1 r7 regression — piece.seamAllowance null parity, seam walk/validate non-finite guards & freeform/rect curve/id/placement3D/Symbol guards', () => {
  // (1) piece.seamAllowance: null & edge.seamAllowance: null consistency across geometry.mjs (Challenger 1)
  const nullPiece = {
    id: 'null_piece_sa',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    edges: [{ seamAllowance: null }, { seamAllowance: undefined }, {}, { seamAllowance: 10 }],
    seamAllowance: null,
    notches: [{ edgeIndex: 0, t: 0.5, type: 'single' }],
  };
  const nullNotches = computePieceNotches(nullPiece);
  const nullCut = computePieceCutBoundary(nullPiece);
  const nullMeas = computePieceMeasurements(nullPiece);
  assert.ok(Math.abs(dist2D(nullNotches[0].lines[0][0], nullNotches[0].lines[0][1]) - 6) < 1e-6);
  assert.ok(Math.abs(nullNotches[0].lines[0][1].y - -6) < 1e-6);
  for (let ei = 0; ei < 4; ei++) {
    assert.equal(nullMeas.edges[ei].seamAllowanceMm, 10);
  }
  assert.ok(Math.abs(polygonArea(nullCut) - 14400) < 1e-4, `Expected 14400, got ${polygonArea(nullCut)}`);
  assert.ok(Math.abs(Math.min(...nullCut.map((pt) => pt.y)) - -10) < 1e-4);

  // CW parity and offsetPolygonOutward(points, null, ...) inheritance
  const cwNullPiece = {
    ...nullPiece,
    id: 'null_piece_sa_cw',
    points: [...nullPiece.points].reverse(),
  };
  const cwNullCut = computePieceCutBoundary(cwNullPiece);
  const cwNullMeas = computePieceMeasurements(cwNullPiece);
  assert.ok(Math.abs(polygonArea(cwNullCut) - 14400) < 1e-4);
  for (let ei = 0; ei < 4; ei++) {
    assert.equal(cwNullMeas.edges[ei].seamAllowanceMm, 10);
  }
  const offNullDefault = offsetPolygonOutward(nullPiece.points, null, [null, undefined, 0, 10]);
  assert.ok(Math.abs(polygonArea(offNullDefault) - 13200) < 1e-4);
  const offNullAll = offsetPolygonOutward(nullPiece.points, null, [null, null, null, null]);
  assert.ok(Math.abs(polygonArea(offNullAll) - 14400) < 1e-4);

  // (2) validatePatternSeams & computeSeamWalkTransform guards (Challenger 2 Finding 1)
  const badSeamValues = [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0', null, undefined, Symbol('e'), 10n];
  for (const badVal of badSeamValues) {
    const pEdgeA = generateTemplatePattern('tote_bag');
    pEdgeA.seams[0].edgeA = badVal;
    const resA = validatePatternSeams(pEdgeA);
    assert.equal(resA[0].valid, false);
    assert.equal(resA[0].status, 'invalid_seam');

    const pEdgeB = generateTemplatePattern('tote_bag');
    pEdgeB.seams[0].edgeB = badVal;
    const resB = validatePatternSeams(pEdgeB);
    assert.equal(resB[0].valid, false);
    assert.equal(resB[0].status, 'invalid_seam');

    const pWalkA = generateTemplatePattern('tote_bag');
    pWalkA.seams[0].edgeA = badVal;
    assert.throws(
      () => computeSeamWalkTransform(pWalkA, pWalkA.seams[0].id, 10),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
  }

  for (const badRange of [
    { tStartA: Number.NaN, tEndA: 1 },
    { tStartA: 0, tEndA: Symbol('t') },
    { tStartB: 10n, tEndB: 1 },
    { tStartA: 0.7, tEndA: 0.3 },
    { tStartB: -0.1, tEndB: 1.2 },
  ]) {
    const pRange = generateTemplatePattern('tote_bag');
    Object.assign(pRange.seams[0], badRange);
    const resR = validatePatternSeams(pRange);
    assert.equal(resR[0].valid, false);
    assert.equal(resR[0].status, 'invalid_seam');
  }

  for (const badSeg of [Number.NaN, 1.5, -1, 99, Symbol('seg'), 10n]) {
    const hVal = generateTemplatePattern('hoodie');
    const pocketSeam = hVal.seams.find((s) => s.id === 'seam_pocket_top');
    pocketSeam.internalSegmentIndexB = badSeg;
    const resS = validatePatternSeams(hVal);
    const pocketReport = resS.find((r) => r.seamId === 'seam_pocket_top');
    assert.equal(pocketReport.valid, false);
    assert.equal(pocketReport.status, 'invalid_seam');

    const wtSeg = computeSeamWalkTransform(hVal, 'seam_pocket_top', 10);
    assert.ok(Number.isFinite(wtSeg.walkMm) && Number.isFinite(wtSeg.translation.x) && Number.isFinite(wtSeg.translation.y));
    assert.ok(wtSeg.transformedPointsB.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)));
  }

  const hoodieWalk = generateTemplatePattern('hoodie');
  for (const badWalk of [Number.NaN, 'abc', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined, Symbol('w'), 10n]) {
    const wt = computeSeamWalkTransform(hoodieWalk, 'seam_pocket_top', badWalk);
    assert.equal(wt.walkMm, 0);
    assert.ok(Number.isFinite(wt.translation.x) && Number.isFinite(wt.translation.y));
    assert.ok(wt.matrix.every(Number.isFinite));
    assert.ok(wt.transformedPointsB.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)));
  }

  // (3) createFreeformPiece & createRectanglePiece curve/id/placement3D/Symbol guards (Challenger 2 Finding 2)
  const tri = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
  ];
  const badCurves = [
    { cp: { x: Number.NaN, y: 10 } },
    { cp: { x: Symbol('x'), y: 10 } },
    { cp: { x: 10n, y: 10 } },
    { cp1: { x: 20, y: 10 }, cp2: { x: Number.POSITIVE_INFINITY, y: 10 } },
    { cp1: { x: 20, y: Symbol('y') }, cp2: { x: 80, y: 10 } },
    'not_an_object',
  ];
  for (const badCurve of badCurves) {
    const pCurve = createFreeformPiece('FF', tri, { edges: [{ curve: badCurve }, {}, {}] });
    assert.equal(pCurve.edges[0].curve, undefined);
    assert.deepEqual(validatePatternPiece(pCurve, 'ff', { throwOnError: false }).errors, []);
  }

  const pValidCurve = createFreeformPiece('FFValid', [
    { x: 10, y: 20 },
    { x: 110, y: 20 },
    { x: 10, y: 120 },
  ], {
    edges: [{ curve: { cp: { x: 60, y: 5 } } }, {}, {}],
  });
  assert.deepEqual(pValidCurve.edges[0].curve, { cp: { x: 50, y: -15 } });
  assert.deepEqual(validatePatternPiece(pValidCurve, 'ffValid', { throwOnError: false }).errors, []);

  for (const badId of ['   ', '', 123, null, undefined, Symbol('id'), 10n]) {
    const pIdPlace = createFreeformPiece('FF Id', tri, {
      id: badId,
      placement3D: {
        offset: { x: Number.NaN, y: Symbol('y'), z: 10n },
        normal: { x: 0, y: 0, z: 0 },
        up: { x: Number.NaN, y: 1, z: 0 },
      },
    });
    assert.equal(typeof pIdPlace.id, 'string');
    assert.ok(pIdPlace.id.trim().length > 0);
    assert.deepEqual(validatePatternPiece(pIdPlace, 'ffIdPlace', { throwOnError: false }).errors, []);
    assert.ok(Math.hypot(pIdPlace.placement3D.normal.x, pIdPlace.placement3D.normal.y, pIdPlace.placement3D.normal.z) > 0.5);
    assert.equal(pIdPlace.placement3D.up, undefined);
  }

  for (const badDim of [Symbol('w'), 10n, Number.NaN, Number.POSITIVE_INFINITY, 'abc', 0, -25]) {
    assert.throws(
      () => createRectanglePiece('R', badDim, 100),
      (err) => err instanceof ValidationError && err.code === 'INVALID_DIMENSIONS'
    );
    assert.throws(
      () => createRectanglePiece({ name: 'R', widthMm: 100, heightMm: badDim }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_DIMENSIONS'
    );
  }
});

test('21. M1 r8 regression — NaN/Symbol/null-element guards in geometry/templates/types & seam edgeA/edgeB parity', () => {
  // Repro 1: validatePatternSeams returns invalid_seam on NaN piece vertices, curve CPs, or internalLine points
  {
    const pat = generateTemplatePattern('tote_bag', {}, 'mm');
    const cloned = structuredClone(pat);
    cloned.pieces[0].points[0].x = Number.NaN;
    const affectedIds = new Set(
      cloned.seams
        .filter((s) => s.pieceA === cloned.pieces[0].id || s.pieceB === cloned.pieces[0].id)
        .map((s) => s.id)
    );
    assert.ok(affectedIds.size > 0);
    const reports = validatePatternSeams(cloned);
    const affected = reports.filter((r) => affectedIds.has(r.seamId));
    assert.equal(affected.length, affectedIds.size);
    for (const r of affected) {
      assert.equal(r.valid, false);
      assert.equal(r.status, 'invalid_seam');
    }

    const patCurveNaN = structuredClone(pat);
    patCurveNaN.pieces[0].edges[0] = {
      ...patCurveNaN.pieces[0].edges[0],
      curve: { type: 'bezier', cp1: { x: Number.NaN, y: 10 }, cp2: { x: 20, y: 20 } },
    };
    const curveIds = new Set(
      patCurveNaN.seams
        .filter((s) => (s.pieceA === patCurveNaN.pieces[0].id && s.edgeA === 0) ||
                       (s.pieceB === patCurveNaN.pieces[0].id && s.edgeB === 0))
        .map((s) => s.id)
    );
    const curveReports = validatePatternSeams(patCurveNaN).filter((r) => curveIds.has(r.seamId));
    assert.ok(curveReports.length > 0);
    for (const r of curveReports) {
      assert.equal(r.valid, false);
      assert.equal(r.status, 'invalid_seam');
    }

    const pA = createRectanglePiece('A', 100, 100);
    const pB = createPatternPiece({
      ...createRectanglePiece('B', 100, 100),
      internalLines: [
        { id: 'il_nan', type: 'stitch_line', points: [{ x: 10, y: Number.NaN }, { x: 10, y: 90 }] },
      ],
    });
    const internalPat = createPatternProject({
      pieces: [pA, pB],
      seams: [
        createSeam({ id: 's_il_nan', pieceA: pA.id, edgeA: 0, pieceB: pB.id, internalLineIdB: 'il_nan', internalSegmentIndexB: 0 }),
      ],
    });
    const ilReports = validatePatternSeams(internalPat);
    assert.equal(ilReports.length, 1);
    assert.equal(ilReports[0].valid, false);
    assert.equal(ilReports[0].status, 'invalid_seam');
  }

  // Reviewer 2 Minor #1: validatePatternSeams validates side B & finite lengths BEFORE registering duplicate_edge intervals
  {
    const pA = createRectanglePiece('A', 100, 100);
    const pB = createRectanglePiece('B', 100, 100);
    const pC = createRectanglePiece('C', 100, 100);
    const badBPat = createPatternProject({
      pieces: [pA, pB, pC],
      seams: [
        createSeam({ id: 'bad_b', pieceA: pA.id, edgeA: 0, tStartA: 0, tEndA: 1, pieceB: pB.id, edgeB: 1.5, tStartB: 0, tEndB: 1 }),
        createSeam({ id: 'good_extra', pieceA: pA.id, edgeA: 0, tStartA: 0, tEndA: 1, pieceB: pC.id, edgeB: 0, tStartB: 0, tEndB: 1 }),
      ],
    });
    const rBadB = validatePatternSeams(badBPat);
    assert.equal(rBadB[0].valid, false);
    assert.equal(rBadB[0].status, 'invalid_seam');
    assert.equal(rBadB[1].valid, true);
    assert.equal(rBadB[1].status, 'ok');

    const pBNan = structuredClone(pB);
    pBNan.points[0].x = Number.NaN;
    const nanBPat = createPatternProject({
      pieces: [pA, pBNan, pC],
      seams: [
        createSeam({ id: 'nan_b', pieceA: pA.id, edgeA: 0, tStartA: 0, tEndA: 1, pieceB: pBNan.id, edgeB: 0, tStartB: 0, tEndB: 1 }),
        createSeam({ id: 'good_after_nan', pieceA: pA.id, edgeA: 0, tStartA: 0, tEndA: 1, pieceB: pC.id, edgeB: 0, tStartB: 0, tEndB: 1 }),
      ],
    });
    const rNanB = validatePatternSeams(nanBPat);
    assert.equal(rNanB[0].valid, false);
    assert.equal(rNanB[0].status, 'invalid_seam');
    assert.equal(rNanB[1].valid, true);
    assert.equal(rNanB[1].status, 'ok');
  }

  // Repro 2 & finite walk guards: computeSeamWalkTransform & transformPiecePoints sanitize Symbol/BigInt rotation/position and throw INVALID_SEAM on NaN vertices
  {
    const pat = generateTemplatePattern('tote_bag', {}, 'mm');
    const symPat = structuredClone(pat);
    symPat.pieces[0].rotation = Symbol('r');
    symPat.pieces[0].position = { x: Symbol('px'), y: 10n };
    const seamId = symPat.seams[0].id;
    const walk = computeSeamWalkTransform(symPat, seamId);
    assert.ok(Number.isFinite(walk.translation.x));
    assert.ok(Number.isFinite(walk.translation.y));
    assert.ok(Number.isFinite(walk.angleRad));
    assert.ok(Number.isFinite(walk.contactPointWorld.x));
    assert.ok(Number.isFinite(walk.contactPointWorld.y));
    assert.ok(Number.isFinite(walk.transformedPointsB[0].x));

    const pts = transformPiecePoints(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
      {
        rotation: Symbol('rot'),
        position: { x: 5n, y: Symbol('y') },
      }
    );
    assert.equal(pts.length, 3);
    assert.ok(Number.isFinite(pts[0].x) && Number.isFinite(pts[0].y));

    const nanWalkPat = structuredClone(pat);
    nanWalkPat.pieces[0].points[0].x = Number.NaN;
    assert.throws(
      () => computeSeamWalkTransform(nanWalkPat, seamId),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
  }

  // Repros 3-7 & collection null/non-array guards
  {
    const p1 = createRectanglePiece('P1', 100, 100);
    const p2 = createRectanglePiece('P2', 100, 100);
    p1.darts = [null, { id: 'd1', edgeIndex: 0, tCenter: 0.5, widthMm: 10, depthMm: 30, folded: false }];
    p1.notches = [null];
    p1.internalLines = [null];
    p1.edges = null;

    const patNulls = {
      pieces: [p1, p2],
      seams: [
        null,
        { id: 's_missing_il', pieceA: p1.id, edgeA: 0, pieceB: p1.id, internalLineIdB: 'nope' },
      ],
    };
    const seamRep = validatePatternSeams(patNulls);
    assert.equal(seamRep.length, 2);
    assert.equal(seamRep[0].valid, false);
    assert.equal(seamRep[0].status, 'invalid_seam');
    assert.equal(seamRep[1].valid, false);
    assert.equal(seamRep[1].status, 'missing_piece');

    assert.throws(
      () => computeSeamWalkTransform({ pieces: [p1], seams: [null] }, 's1'),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
    assert.throws(
      () => computeSeamWalkTransform(patNulls, 's_missing_il'),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );

    const toggled = toggleDartFold(p1, 'd1');
    assert.equal(toggled.darts.length, 2);
    assert.equal(toggled.darts[1].folded, true);
    const unchangedToggle = toggleDartFold({ ...createRectanglePiece('NoD', 100, 100), darts: [null] }, 'missing');
    assert.equal(unchangedToggle.name, 'NoD');

    const withDart = addDartToPiece({ ...createRectanglePiece('D', 100, 100), darts: [null] }, {
      edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 25,
    });
    assert.equal(withDart.darts.length, 2);
    assert.equal(withDart.darts[1].widthMm, 10);

    const withNotch = addNotchToPiece({ ...createRectanglePiece('N', 100, 100), notches: [null] }, {
      edgeIndex: 0, t: 0.5, type: 'v',
    });
    assert.equal(withNotch.notches.length, 2);
    assert.equal(withNotch.notches[1].type, 'v');

    const splitRes = splitPieceEdge(p1, 0, 0.5);
    assert.equal(splitRes.points.length, 5);
    const delRes = deletePieceVertex(splitRes, 1);
    assert.equal(delRes.points.length, 4);
    const mirRes = mirrorPieceAcrossEdge(p1, 0);
    assert.equal(mirRes.points.length, 6);
  }

  // Repro 8: generateTemplatePattern Symbol templateId -> ValidationError UNKNOWN_TEMPLATE
  {
    assert.throws(
      () => generateTemplatePattern(Symbol('tpl')),
      (err) => err instanceof ValidationError && err.code === 'UNKNOWN_TEMPLATE'
    );
  }

  // Repros 9-11: types.mjs Symbol/BigInt error formatting & schema factories
  {
    assert.throws(
      () => mmToUnit(10, Symbol('u')),
      (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
    );
    assert.throws(
      () => unitToMm(10, Symbol('u')),
      (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
    );
    assert.throws(
      () => mmToUnit(Symbol('v'), 'mm'),
      (err) => err instanceof ValidationError && err.code === 'NON_FINITE_NUMBER'
    );
    assert.throws(
      () => validatePatternProject({ unit: Symbol('u'), pieces: [], seams: [] }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
    );
    assert.throws(
      () => normalizePatternProject({ unit: 'mm', displayUnit: Symbol('du'), pieces: [], seams: [] }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_UNIT'
    );
    const pMap = new Map([
      ['a', createRectanglePiece('A', 100, 100)],
      ['b', createRectanglePiece('B', 100, 100)],
    ]);
    assert.throws(
      () => validateSeam({
        id: 's1', pieceA: Symbol('a'), edgeA: 0, pieceB: 'b', edgeB: 0,
      }, pMap),
      (err) => err instanceof ValidationError && err.code === 'SEAM_MISSING_PIECE'
    );
    assert.throws(
      () => validateSeam({
        id: 's1', pieceA: 'a', edgeA: Symbol('ea'), pieceB: 'b', edgeB: 0,
      }, pMap),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
    assert.throws(
      () => validateSeam({
        id: 's1', pieceA: 'a', edgeA: 0, tStartA: Symbol('ts'), pieceB: 'b', edgeB: 0,
      }, pMap),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM_RANGE'
    );
    assert.throws(
      () => validatePatternPiece({
        id: 'p1', name: 'P1',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
        edges: [{ type: 'line' }, { type: 'line' }, { type: 'line' }],
        notches: [{ id: 'n1', edgeIndex: 0, t: 0.5, type: Symbol('nt') }],
      }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_NOTCH'
    );

    const e = Core.createEdgeSpec({ curve: { cp1: { x: Symbol('x'), y: 10n }, cp2: { x: 1, y: 2 } } });
    assert.ok(Number.isNaN(e.curve.cp1.x) && Number.isNaN(e.curve.cp1.y));
    const n = Core.createNotchSpec({ edgeIndex: Symbol('ei'), t: 10n, depthMm: Symbol('d') });
    assert.equal(n.edgeIndex, 0);
    assert.equal(n.t, 0.5);
    assert.equal(n.depthMm, 5);
    const d = Core.createDartSpec({ widthMm: Symbol('w'), depthMm: 10n });
    assert.equal(d.widthMm, 20);
    assert.equal(d.depthMm, 80);
    const il = Core.createInternalLineSpec({ points: [{ x: Symbol('x'), y: 5n }] });
    assert.ok(Number.isNaN(il.points[0].x) && Number.isNaN(il.points[0].y));
    const pc = createPatternPiece({ rotation: Symbol('r'), position: { x: 1n, y: Symbol('y') } });
    assert.ok(Number.isNaN(pc.rotation) && Number.isNaN(pc.position.x) && Number.isNaN(pc.position.y));
    const sm = createSeam({ edgeA: Symbol('ea'), tStartA: 5n });
    assert.ok(Number.isNaN(sm.edgeA) && Number.isNaN(sm.tStartA));
  }

  // Repro 12: normalizePatternProject rejects seam.edgeA: undefined & seam.edgeB: undefined (without internalLineIdB)
  {
    const p1 = createRectanglePiece('A', 100, 100);
    const p2 = createRectanglePiece('B', 100, 100);
    assert.throws(
      () => normalizePatternProject({
        pieces: [p1, p2],
        seams: [{ id: 's_no_ea', pieceA: p1.id, pieceB: p2.id, edgeB: 0 }],
      }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );
    assert.throws(
      () => normalizePatternProject({
        pieces: [p1, p2],
        seams: [{ id: 's_no_eb', pieceA: p1.id, edgeA: 0, pieceB: p2.id }],
      }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_SEAM'
    );

    const p2WithIl = createPatternPiece({
      ...p2,
      internalLines: [{ id: 'il_ok', type: 'stitch_line', points: [{ x: 10, y: 10 }, { x: 90, y: 10 }] }],
    });
    const normIl = normalizePatternProject({
      pieces: [p1, p2WithIl],
      seams: [{ id: 's_il_ok', pieceA: p1.id, edgeA: 0, pieceB: p2WithIl.id, internalLineIdB: 'il_ok' }],
    });
    assert.equal(normIl.seams[0].internalLineIdB, 'il_ok');
    assert.equal(normIl.seams[0].edgeB, 0);
  }
});

test('22. M1 r9 regression — curveSegments/miterLimit bounds, Object.create(null) numeric safety, template null params, edges.length Symbol & CAD Symbol edgeIndex guards', () => {
  // Challenger 1 Finding 1: segments/curveSegments sanitization & upper-bound clamping
  {
    const sq = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const cp = {
      id: 'cp',
      points: sq,
      edges: [{ curve: { cp: { x: 50, y: -20 } } }, {}, {}, {}],
      seamAllowance: 10,
    };
    const cpWithDart = {
      ...cp,
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 20 }],
    };

    const baselineOutline = samplePieceOutline(cp, 16);
    const baselineCut = computePieceCutBoundary(cp, 16);
    const baselineArea = computePieceMeasurements(cp, { curveSegments: 16 }).netAreaMm2;
    const baselineArc = edgeArcLength(sq[0], sq[1], cp.edges[0].curve, 64);

    assert.equal(baselineOutline.length, 19);
    assert.ok(baselineArea > 10500);

    for (const badSeg of [Infinity, -Infinity, NaN, 'bad', null, undefined, Symbol('c'), 10n, Object.create(null)]) {
      const outline = samplePieceOutline(cp, badSeg);
      assert.equal(outline.length, baselineOutline.length);
      const cut = computePieceCutBoundary(cp, badSeg);
      assert.equal(cut.length, baselineCut.length);
      const meas = computePieceMeasurements(cp, { curveSegments: badSeg });
      assert.ok(Math.abs(meas.netAreaMm2 - baselineArea) < 1e-6);

      const dartOutline = samplePieceOutline(cpWithDart, badSeg);
      assert.ok(dartOutline.length >= 19 && dartOutline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
      const dartCut = computePieceCutBoundary(cpWithDart, badSeg);
      assert.ok(dartCut.length >= 19 && dartCut.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

      const edgePts = Core.sampleEdgePoints(sq[0], sq[1], cp.edges[0].curve, badSeg);
      assert.equal(edgePts.length, 17);
      const table = Core.buildEdgeArcTable(sq[0], sq[1], cp.edges[0].curve, badSeg);
      assert.equal(table.ts.length, 65);
      assert.ok(Math.abs(edgeArcLength(sq[0], sq[1], cp.edges[0].curve, badSeg) - baselineArc) < 1e-6);
    }

    // Huge finite segment count is bounded cleanly (no OOM/hang)
    const clampedTable = Core.buildEdgeArcTable(sq[0], sq[1], cp.edges[0].curve, 1e9);
    assert.equal(clampedTable.ts.length, 4097);
    const clampedOutline = samplePieceOutline(cp, 1e9);
    assert.equal(clampedOutline.length, 4099);
  }

  // Challenger 1 Finding 2: offsetPolygonOutward & computePieceCutBoundary miterLimit sanitization
  {
    const sq = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const sharp = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 10, y: 15 },
    ];
    const expectedSq = offsetPolygonOutward(sq, 10, null, 3.0);
    const expectedSharp = offsetPolygonOutward(sharp, 10, null, 3.0);
    for (const badMiter of [Symbol('m'), 10n, NaN, Infinity, null, Object.create(null)]) {
      const outSq = offsetPolygonOutward(sq, 10, null, badMiter);
      assert.equal(outSq.length, expectedSq.length);
      assert.ok(Math.abs(polygonArea(outSq) - polygonArea(expectedSq)) < 1e-6);

      const outSharp = offsetPolygonOutward(sharp, 10, null, badMiter);
      assert.equal(outSharp.length, expectedSharp.length);
      assert.ok(Math.abs(polygonArea(outSharp) - polygonArea(expectedSharp)) < 1e-6);

      const cutSharp = computePieceCutBoundary(
        { id: 'sh', points: sharp, edges: [{}, {}, {}], seamAllowance: 10 },
        16,
        { miterLimit: badMiter }
      );
      assert.ok(cutSharp.length >= 3 && cutSharp.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    }
  }

  // Reviewer 2 Minor #2: computePieceMeasurements filters null/non-object darts & notches for counts
  {
    const piece = {
      ...createRectanglePiece('Counts', 120, 100),
      darts: [null, undefined, 'bad', 42, { id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 25 }],
      notches: [null, 'bad', { id: 'n1', edgeIndex: 1, t: 0.5, type: 'single' }, { id: 'n2', edgeIndex: 2, t: 0.5, type: 'v' }],
    };
    const meas = computePieceMeasurements(piece);
    assert.equal(meas.dartCount, 1);
    assert.equal(meas.notchCount, 2);
  }

  // Challenger 2 Finding 1: piece.edges?.length safeString + catch block records unexpected errors when throwOnError=false
  {
    const pSymLen = createRectanglePiece('R', 100, 100);
    pSymLen.edges = { length: Symbol('len') };
    assert.throws(
      () => validatePatternPiece(pSymLen, 'p', { throwOnError: true }),
      (err) => err instanceof ValidationError && err.code === 'INVALID_EDGES'
    );
    const resPieceFalse = validatePatternPiece(pSymLen, 'p', { throwOnError: false });
    assert.equal(resPieceFalse.valid, false);
    assert.equal(resPieceFalse.errors.length, 1);
    assert.equal(resPieceFalse.errors[0].code, 'INVALID_EDGES');

    const resProjFalse = validatePatternProject(
      { unit: 'mm', pieces: [pSymLen], seams: [] },
      { throwOnError: false }
    );
    assert.equal(resProjFalse.valid, false);
    assert.equal(resProjFalse.errors.length, 1);
    assert.equal(resProjFalse.errors[0].code, 'INVALID_EDGES');

    const pBadToStr = createRectanglePiece('R2', 100, 100);
    pBadToStr.edges = { length: { toString() { throw new Error('boom'); } } };
    assert.equal(validatePatternPiece(pBadToStr, 'p', { throwOnError: false }).valid, false);

    // Unexpected throwing getter inside validatePatternPiece / validateSeam / validatePatternProject
    const pThrowGetter = createRectanglePiece('G', 100, 100);
    Object.defineProperty(pThrowGetter, 'edges', {
      get() {
        throw new Error('getter boom');
      },
    });
    const resGetterPiece = validatePatternPiece(pThrowGetter, 'p', { throwOnError: false });
    assert.equal(resGetterPiece.valid, false);
    assert.equal(resGetterPiece.errors.length, 1);
    assert.ok(resGetterPiece.errors[0] instanceof ValidationError);

    const resGetterProj = validatePatternProject(
      { unit: 'mm', pieces: [pThrowGetter], seams: [] },
      { throwOnError: false }
    );
    assert.equal(resGetterProj.valid, false);
    assert.equal(resGetterProj.errors.length, 1);

    const badSeamGetter = { pieceA: 'a', edgeA: 0, pieceB: 'b', edgeB: 0 };
    Object.defineProperty(badSeamGetter, 'internalLineIdB', {
      get() {
        throw new Error('seam getter boom');
      },
    });
    const pMap = new Map([
      ['a', createRectanglePiece('A', 100, 100)],
      ['b', createRectanglePiece('B', 100, 100)],
    ]);
    const resGetterSeam = validateSeam(badSeamGetter, pMap, 's', { throwOnError: false });
    assert.equal(resGetterSeam.valid, false);
    assert.equal(resGetterSeam.errors.length, 1);
  }

  // Challenger 2 Finding 2: null / primitive params across generateTemplatePattern and all 5 generators
  {
    const expectedCounts = {
      tshirt: 5,
      hoodie: 8,
      pants: 5,
      tote_bag: 7,
      stl_cover: 4,
    };
    for (const [tid, count] of Object.entries(expectedCounts)) {
      for (const badParams of [null, undefined, 42, 'invalid']) {
        const pat = generateTemplatePattern(tid, badParams, null);
        assert.equal(pat.pieces.length, count);
        assert.equal(validatePatternProject(pat).valid, true);
        assert.ok(validatePatternSeams(pat).every((r) => r.valid));
      }
    }
    assert.equal(Core.generateTShirtPattern(null).pieces.length, 5);
    assert.equal(Core.generateHoodiePattern(null).pieces.length, 8);
    assert.equal(Core.generatePantsPattern(null).pieces.length, 5);
    assert.equal(Core.generateToteBagPattern(null).pieces.length, 7);
    assert.equal(Core.generateSTLCoverPattern(null, null).pieces.length, 4);
  }

  // Challenger 2 Finding 3: validatePatternSeams formats Symbol & Object.create(null) piece names safely
  {
    const pA = createRectanglePiece('A', 100, 100);
    pA.name = Symbol('nm');
    const pB = createRectanglePiece('B', 100, 100);
    pB.name = Object.create(null);
    const reports = validatePatternSeams({
      pieces: [pA, pB],
      seams: [{ id: 's', pieceA: pA.id, edgeA: 0, pieceB: pB.id, edgeB: 0 }],
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].valid, true);
    assert.equal(reports[0].name, 'Symbol(nm) <-> [object Object]');
  }

  // Challenger 2 Finding 4: toSafeNumber (types.mjs) & safeNumber (geometry.mjs) handle Object.create(null) & throwing valueOf
  {
    const nullProto = Object.create(null);
    const throwingVal = {
      valueOf() {
        throw new Error('no primitive');
      },
      toString() {
        throw new Error('no string');
      },
    };
    for (const hostile of [nullProto, throwingVal]) {
      const e = Core.createEdgeSpec({ seamAllowance: hostile, curve: { cp: { x: hostile, y: 10 } } });
      assert.equal(e.seamAllowance, 10);
      assert.ok(Number.isNaN(e.curve.cp.x));

      const n = Core.createNotchSpec({ edgeIndex: hostile, t: hostile, depthMm: hostile });
      assert.equal(n.edgeIndex, 0);
      assert.equal(n.t, 0.5);
      assert.equal(n.depthMm, 5);

      const d = Core.createDartSpec({ edgeIndex: hostile, t: hostile, widthMm: hostile, depthMm: hostile });
      assert.equal(d.edgeIndex, 0);
      assert.equal(d.widthMm, 20);
      assert.equal(d.depthMm, 80);

      const il = Core.createInternalLineSpec({ points: [{ x: hostile, y: 0 }] });
      assert.ok(Number.isNaN(il.points[0].x));

      const pc = createPatternPiece({ rotation: hostile, position: { x: hostile, y: 0 } });
      assert.ok(Number.isNaN(pc.rotation) && Number.isNaN(pc.position.x));

      const sm = createSeam({ edgeA: hostile, tStartA: hostile });
      assert.ok(Number.isNaN(sm.edgeA) && Number.isNaN(sm.tStartA));

      const sq = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];
      assert.equal(offsetPolygonOutward(sq, hostile, null, hostile).length, 4);
      const tPts = transformPiecePoints(sq, { rotation: hostile, position: { x: hostile, y: 10 } });
      assert.equal(tPts[0].x, 0);
      assert.equal(tPts[0].y, 10);
    }
  }

  // Challenger 2 Finding 5: splitPieceEdge, deletePieceVertex (including CW reversal), & mirrorPieceAcrossEdge Symbol edgeIndex/seam guards
  {
    const makeHostilePiece = () => {
      const p = createRectanglePiece('D', 100, 100);
      p.darts = [
        { id: Symbol('did'), edgeIndex: Symbol('ei'), t: Symbol('dt'), widthMm: 10, depthMm: 20 },
        { id: 'd_valid', edgeIndex: 2, t: 0.5, widthMm: 10, depthMm: 20 },
      ];
      p.notches = [
        { id: Symbol('nid'), edgeIndex: Symbol('ei'), t: Symbol('nt') },
        { id: 'n_valid', edgeIndex: 2, t: 0.5, type: 'single' },
      ];
      return p;
    };

    const pSplit = makeHostilePiece();
    const patSplit = {
      pieces: [pSplit],
      seams: [
        { id: Symbol('sid'), pieceA: pSplit.id, edgeA: Symbol('ea'), pieceB: pSplit.id, edgeB: Symbol('eb') },
        { id: 's_valid', pieceA: pSplit.id, edgeA: 2, pieceB: pSplit.id, edgeB: 3 },
      ],
    };
    splitPieceEdge(pSplit, 0, 0.5, patSplit);
    assert.equal(pSplit.points.length, 5);
    assert.equal(pSplit.darts[1].edgeIndex, 3);
    assert.equal(pSplit.notches[1].edgeIndex, 3);
    assert.equal(patSplit.seams[1].edgeA, 3);
    assert.equal(patSplit.seams[1].edgeB, 4);

    // deletePieceVertex (CCW normal path)
    const pDel = makeHostilePiece();
    const patDel = {
      pieces: [pDel],
      seams: [{ id: 's_sym', pieceA: pDel.id, edgeA: Symbol('ea'), pieceB: pDel.id, edgeB: Symbol('eb') }],
    };
    deletePieceVertex(pDel, 0, patDel);
    assert.equal(pDel.points.length, 3);
    assert.equal(pDel.darts[1].edgeIndex, 1);

    // deletePieceVertex with CW winding reversal + Symbol edgeIndex/edgeA/edgeB
    const pDelCW = createRectanglePiece('CW', 100, 100);
    pDelCW.points.reverse();
    pDelCW.darts = [{ id: 'd_sym', edgeIndex: Symbol('ei'), t: Symbol('t'), widthMm: 10, depthMm: 20 }];
    pDelCW.notches = [{ id: 'n_sym', edgeIndex: Symbol('ei'), t: Symbol('t') }];
    const patDelCW = {
      pieces: [pDelCW],
      seams: [{ id: 's_sym', pieceA: pDelCW.id, edgeA: Symbol('ea'), pieceB: pDelCW.id, edgeB: Symbol('eb') }],
    };
    deletePieceVertex(pDelCW, 0, patDelCW);
    assert.equal(pDelCW.points.length, 3);
    assert.ok(signedPolygonArea(pDelCW.points) > 0);

    // mirrorPieceAcrossEdge
    const pMir = makeHostilePiece();
    const patMir = {
      pieces: [pMir],
      seams: [{ id: 's_sym', pieceA: pMir.id, edgeA: Symbol('ea'), pieceB: pMir.id, edgeB: Symbol('eb') }],
    };
    mirrorPieceAcrossEdge(pMir, 0, patMir);
    assert.equal(pMir.points.length, 6);
    assert.equal(pMir.darts.length, 2);
    assert.equal(pMir.notches.length, 2);
  }
});

test('23. M1 r10 regression — splitPieceEdge self-seam tStart/tEnd sanitization & createNotchSpec/createDartSpec edgeCount integer bounds', () => {
  const throwingVal = {
    valueOf() {
      throw new Error('boom');
    },
    toString() {
      throw new Error('boom');
    },
  };
  const hostileVals = [
    Symbol('ts'),
    10n,
    Object.create(null),
    throwingVal,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    'not-a-number',
  ];

  // 1. splitPieceEdge self-seam (matchA && matchB) non-straddling with hostile tStartA/tEndB
  for (const hostile of hostileVals) {
    const p = createRectanglePiece('SelfHostile', 200, 100);
    const pat = {
      pieces: [p],
      seams: [
        {
          id: 's_self',
          pieceA: p.id,
          edgeA: 0,
          pieceB: p.id,
          edgeB: 0,
          tStartA: hostile,
          tEndA: 0.4,
          tStartB: 0.6,
          tEndB: hostile,
        },
      ],
    };
    splitPieceEdge(p, 0, 0.5, pat);
    assert.equal(pat.seams.length, 1);
    const s = pat.seams[0];
    assert.equal(s.edgeA, 0);
    assert.ok(Math.abs(s.tStartA - 0) < 1e-9);
    assert.ok(Math.abs(s.tEndA - 0.8) < 1e-9);
    assert.equal(s.edgeB, 1);
    assert.ok(Math.abs(s.tStartB - 0.2) < 1e-9);
    assert.ok(Math.abs(s.tEndB - 1) < 1e-9);
    const report = validatePatternSeams(pat);
    assert.equal(report[0].valid, true);
  }

  // 1b. splitPieceEdge self-seam where A straddles & B is non-straddling with hostile tStartB
  {
    const p = createRectanglePiece('SelfStraddleA', 200, 100);
    const pat = {
      pieces: [p],
      seams: [
        {
          id: 's_sa',
          pieceA: p.id,
          edgeA: 0,
          pieceB: p.id,
          edgeB: 0,
          tStartA: Symbol('a0'),
          tEndA: Number.NaN,
          tStartB: Object.create(null),
          tEndB: 0.25,
        },
      ],
    };
    splitPieceEdge(p, 0, 0.5, pat);
    assert.equal(pat.seams.length, 2);
    for (const s of pat.seams) {
      assert.ok(Number.isFinite(s.tStartA) && Number.isFinite(s.tEndA));
      assert.ok(Number.isFinite(s.tStartB) && Number.isFinite(s.tEndB));
      assert.ok(s.tStartA >= 0 && s.tStartA <= s.tEndA && s.tEndA <= 1);
      assert.ok(s.tStartB >= 0 && s.tStartB <= s.tEndB && s.tEndB <= 1);
    }
    assert.equal(pat.seams[0].edgeA, 0);
    assert.equal(pat.seams[1].edgeA, 1);
  }

  // 1c. splitPieceEdge self-seam where B straddles & A is non-straddling with hostile tStartA
  {
    const p = createRectanglePiece('SelfStraddleB', 200, 100);
    const pat = {
      pieces: [p],
      seams: [
        {
          id: 's_sb',
          pieceA: p.id,
          edgeA: 0,
          pieceB: p.id,
          edgeB: 0,
          tStartA: throwingVal,
          tEndA: 0.25,
          tStartB: Number.NaN,
          tEndB: Number.POSITIVE_INFINITY,
        },
      ],
    };
    splitPieceEdge(p, 0, 0.5, pat);
    assert.equal(pat.seams.length, 2);
    for (const s of pat.seams) {
      assert.ok(Number.isFinite(s.tStartA) && Number.isFinite(s.tEndA));
      assert.ok(Number.isFinite(s.tStartB) && Number.isFinite(s.tEndB));
      assert.ok(s.tStartA >= 0 && s.tStartA <= s.tEndA && s.tEndA <= 1);
      assert.ok(s.tStartB >= 0 && s.tStartB <= s.tEndB && s.tEndB <= 1);
    }
    assert.equal(pat.seams[0].edgeB, 0);
    assert.equal(pat.seams[1].edgeB, 1);
  }

  // 1d. Inverted/clamped self-seam tStart > tEnd stays ordered and bounded in [0, 1]
  {
    const p = createRectanglePiece('SelfInverted', 200, 100);
    const pat = {
      pieces: [p],
      seams: [
        {
          id: 's_inv',
          pieceA: p.id,
          edgeA: 0,
          pieceB: p.id,
          edgeB: 0,
          tStartA: 0.8,
          tEndA: 0.2,
          tStartB: 0.3,
          tEndB: 0.1,
        },
      ],
    };
    splitPieceEdge(p, 0, 0.5, pat);
    assert.equal(pat.seams.length, 1);
    const s = pat.seams[0];
    assert.ok(s.tStartA >= 0 && s.tStartA <= s.tEndA && s.tEndA <= 1);
    assert.ok(s.tStartB >= 0 && s.tStartB <= s.tEndB && s.tEndB <= 1);
  }

  // 2. createNotchSpec & createDartSpec edgeCount integer bounds
  for (const badCount of [...hostileVals, 0, -5, 0.3]) {
    const n = Core.createNotchSpec({ edgeIndex: 3 }, badCount);
    const d = Core.createDartSpec({ edgeIndex: 3 }, badCount);
    assert.equal(n.edgeIndex, 0);
    assert.equal(d.edgeIndex, 0);
    assert.ok(Number.isInteger(n.edgeIndex));
    assert.ok(Number.isInteger(d.edgeIndex));
  }

  assert.equal(Core.createNotchSpec({ edgeIndex: 3 }, 2.7).edgeIndex, 1);
  assert.equal(Core.createDartSpec({ edgeIndex: 3 }, 2.7).edgeIndex, 1);
  assert.equal(Core.createNotchSpec({ edgeIndex: -1 }, 3.9).edgeIndex, 2);
  assert.equal(Core.createDartSpec({ edgeIndex: -1 }, 3.9).edgeIndex, 2);
  assert.ok(Number.isInteger(Core.createNotchSpec({ edgeIndex: 3 }, 2.7).edgeIndex));
  assert.ok(Number.isInteger(Core.createDartSpec({ edgeIndex: 3 }, 2.7).edgeIndex));

  const triPiece = createPatternPiece({
    id: 'tri_edge_bounds',
    name: 'Tri',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 80 },
    ],
    notches: [{ edgeIndex: 5 }],
    darts: [{ edgeIndex: -1 }],
  });
  assert.equal(triPiece.notches[0].edgeIndex, 2);
  assert.equal(triPiece.darts[0].edgeIndex, 2);
  assert.equal(validatePatternPiece(triPiece).valid, true);

  // 3. formatUnitValue & formatLength decimals clamping
  assert.equal(formatUnitValue(25.4, 'in', 1), '1.0 in');
  assert.equal(Core.formatLength(50, 'cm', 0), '5 cm');
  assert.equal(formatUnitValue(25.4, 'in', -3), '1 in');
  assert.equal(Core.formatLength(25.4, 'in', 50), '1.00000000000000000000 in');
  for (const badDec of [...hostileVals, null, '', '   ']) {
    assert.equal(formatUnitValue(25.4, 'in', badDec), '1.0 in');
    assert.equal(Core.formatLength(25.4, 'in', badDec), '1.0 in');
  }
});




