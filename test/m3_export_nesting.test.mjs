import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ValidationError,
  unitToMm,
} from '../src/core/types.mjs';
import {
  computePieceCutBoundary,
  polygonArea,
  polygonBounds,
  polygonPerimeter,
} from '../src/core/geometry.mjs';
import {
  generateTemplatePattern,
  createRectanglePiece,
  createFreeformPiece,
  addDartToPiece,
  addNotchToPiece,
} from '../src/core/templates.mjs';
import {
  FABRIC_ROLL_PRESETS,
  nestPatternPieces,
} from '../src/core/nesting.mjs';
import {
  MM_TO_PT,
  PAGE_FORMATS,
  PDF_PAGE_FORMATS,
  exportSVG,
  exportTiledPDF,
  exportDXF,
  exportPatternJSON,
  importPatternJSON,
} from '../src/core/exporters.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const VERIFY_EXPORTS_PY = path.join(PROJECT_ROOT, 'e2e_tests', 'verify_exports.py');

function assertNear(actual, expected, tol, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ? msg + ': ' : ''}expected ${actual} to be within ${tol} of ${expected}`
  );
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'psv2-m3-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runVerifyExports(format, contentOrBuffer, expectations = {}) {
  return withTempDir(async (tmpDir) => {
    const ext = format === 'pdf' ? 'pdf' : format === 'dxf' ? 'dxf' : 'svg';
    const filePath = path.join(tmpDir, `export.${ext}`);
    const expPath = path.join(tmpDir, 'expectations.json');
    if (typeof contentOrBuffer === 'string') {
      await fs.writeFile(filePath, contentOrBuffer, 'utf8');
    } else {
      await fs.writeFile(filePath, contentOrBuffer);
    }
    await fs.writeFile(expPath, JSON.stringify(expectations), 'utf8');
    try {
      const { stdout } = await execFileAsync(
        'python3',
        [VERIFY_EXPORTS_PY, '--format', format, '--file', filePath, '--expectations', expPath],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      return JSON.parse(stdout);
    } catch (err) {
      if (err.stdout) {
        try {
          return JSON.parse(err.stdout);
        } catch {
          // fall through
        }
      }
      throw err;
    }
  });
}

function assertValidPdfXref(pdfBytes) {
  const buf = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
  const latin1 = buf.toString('latin1');
  assert.ok(latin1.startsWith('%PDF-1.4\n'), 'PDF must start with %PDF-1.4');

  const m = latin1.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  assert.ok(m, 'PDF missing startxref / %%EOF');
  const xrefPos = Number(m[1]);
  assert.ok(latin1.slice(xrefPos, xrefPos + 5) === 'xref\n', `xref offset ${xrefPos} does not point to xref`);

  const xrefBody = latin1.slice(xrefPos + 5, m.index);
  const lines = xrefBody.split('\n');
  const [, countStr] = lines[0].trim().split(/\s+/);
  const objCount = Number(countStr);
  assert.ok(objCount >= 4, `Expected >= 4 PDF objects in xref, got ${objCount}`);

  for (let id = 1; id < objCount; id++) {
    const entry = lines[1 + id];
    assert.ok(entry && entry.length === 19, `xref entry ${id} malformed: ${JSON.stringify(entry)}`);
    const [offsetStr, genStr, flag] = entry.trim().split(/\s+/);
    assert.equal(genStr, '00000');
    assert.equal(flag, 'n');
    const off = Number(offsetStr);
    const header = latin1.slice(off, off + 20);
    assert.ok(
      header.startsWith(`${id} 0 obj\n`),
      `xref offset ${off} for obj ${id} points to ${JSON.stringify(header)}`
    );
  }
}

function assertNoOverlapsAndInBounds(nest, fabricWidthMm) {
  const bySheet = new Map();
  for (const pl of nest.placements) {
    assert.ok(Number.isFinite(pl.x) && Number.isFinite(pl.y));
    assert.ok(pl.width > 0 && pl.height > 0);
    assert.ok(pl.x >= -1e-6 && pl.x + pl.width <= fabricWidthMm + 1e-6, `Exceeded roll width: ${pl.pieceName}`);
    if (!bySheet.has(pl.sheetIndex)) bySheet.set(pl.sheetIndex, []);
    bySheet.get(pl.sheetIndex).push(pl);
  }
  for (const list of bySheet.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        assert.ok(ox <= 1e-4 || oy <= 1e-4, `Overlapping placements: ${a.pieceName} and ${b.pieceName}`);
      }
    }
  }
}

// ============================================================================
// 1. Module Isolation & Export Contract
// ============================================================================

test('M3 Contract: exports expected APIs and imports strictly from M1 leaf/geometry modules', async () => {
  assert.ok(Array.isArray(FABRIC_ROLL_PRESETS) && FABRIC_ROLL_PRESETS.length >= 5);
  assert.equal(typeof nestPatternPieces, 'function');
  assert.ok(PAGE_FORMATS.LETTER && PAGE_FORMATS.A4 && PAGE_FORMATS.A0 && PAGE_FORMATS['36x24_MAT'] && PAGE_FORMATS.TABLOID);
  assert.equal(PDF_PAGE_FORMATS, PAGE_FORMATS);
  assert.equal(typeof exportSVG, 'function');
  assert.equal(typeof exportTiledPDF, 'function');
  assert.equal(typeof exportDXF, 'function');
  assert.equal(typeof exportPatternJSON, 'function');
  assert.equal(typeof importPatternJSON, 'function');

  const nestingSrc = await fs.readFile(path.join(PROJECT_ROOT, 'src/core/nesting.mjs'), 'utf8');
  const exportersSrc = await fs.readFile(path.join(PROJECT_ROOT, 'src/core/exporters.mjs'), 'utf8');
  for (const src of [nestingSrc, exportersSrc]) {
    assert.ok(!/index\.mjs|templates\.mjs|stl\.mjs|materials\.mjs|physics\.mjs/.test(src), 'Forbidden cross-milestone import found');
  }
});

// ============================================================================
// 2. Fabric Roll & Cutting Mat Nesting (F25)
// ============================================================================

test('F25 Nesting: starter blocks pack cleanly with zero overlaps across 45"/54"/60" rolls', () => {
  for (const tplId of ['tshirt', 'hoodie', 'pants', 'tote_bag']) {
    const pattern = generateTemplatePattern(tplId);
    for (const preset of FABRIC_ROLL_PRESETS.slice(0, 3)) {
      const nest = nestPatternPieces(pattern, { rollPreset: preset.id, marginMm: 10, spacingMm: 8 });
      assert.equal(nest.fabricWidthMm, preset.widthMm);
      assert.equal(nest.rollWidthMm, preset.widthMm);
      assert.equal(nest.unfittedPieces.length, 0, `${tplId} had unfitted pieces on ${preset.id}`);
      assert.ok(nest.placements.length >= pattern.pieces.length);
      assert.ok(nest.requiredLengthMm > 0 && nest.requiredMeters > 0 && nest.requiredYards > 0);
      assert.ok(nest.utilizationPct > 0 && nest.utilizationPct <= 100);
      assertNear(nest.utilizationPct + nest.wastePct, 100, 0.05, `${tplId} util+waste`);
      assertNoOverlapsAndInBounds(nest, preset.widthMm);
    }
  }
});

test('F25 Nesting: honors quantity, onFold, flush spacing, allowRotate90, lockGrainline & multi-sheet mats', () => {
  // Quantity expansion
  const pQty = createRectanglePiece('CutThree', 200, 300, { seamAllowance: 10, quantity: 3 });
  const qtyNest = nestPatternPieces({ id: 'q3', unit: 'mm', pieces: [pQty], seams: [] }, { fabricWidthMm: 1000 });
  assert.equal(qtyNest.placements.length, 3);
  assert.equal(qtyNest.totalCutPieceCount, 3);
  assertNear(qtyNest.totalNetAreaMm2, 3 * 200 * 300, 1);
  assertNear(qtyNest.totalCutAreaMm2, 3 * 220 * 320, 1);

  // T2-F25-2: 3 x (600x250) on 1000mm flush -> rotate 90° packs 3 x (250x600) in 600mm
  const bars = [1, 2, 3].map((i) => createRectanglePiece(`Bar${i}`, 600, 250, { id: `b${i}`, seamAllowance: 0 }));
  const patBars = { id: 'bars', unit: 'mm', pieces: bars, seams: [] };
  const noRot = nestPatternPieces(patBars, { fabricWidthMm: 1000, marginMm: 0, spacingMm: 0, allowRotate90: false });
  const withRot = nestPatternPieces(patBars, { fabricWidthMm: 1000, marginMm: 0, spacingMm: 0, allowRotate90: true });
  assertNear(noRot.requiredLengthMm, 750, 0.1);
  assert.ok(withRot.requiredLengthMm <= 600.1, `Expected <=600mm, got ${withRot.requiredLengthMm}`);

  // lockGrainline / piece.grainLock blocks 90° rotation
  const wide = createRectanglePiece('WideLocked', 1050, 200, { seamAllowance: 0 });
  wide.grainLock = true;
  const lockedNest = nestPatternPieces({ id: 'lk', unit: 'mm', pieces: [wide], seams: [] }, {
    fabricWidthMm: 914.4,
    allowRotate90: true,
  });
  assert.equal(lockedNest.placements.length, 0);
  assert.equal(lockedNest.unfittedPieces.length, 1);
  assert.equal(lockedNest.unfittedPieces[0].reason, 'GRAINLINE_LOCKED_EXCEEDS_WIDTH');

  // onFold preserved & valid utilization
  const foldPiece = createRectanglePiece('FoldBodice', 200, 400, { seamAllowance: 10, onFold: true });
  const foldNest = nestPatternPieces({ id: 'fld', unit: 'mm', pieces: [foldPiece], seams: [] }, { rollPreset: 'roll_45in' });
  assert.equal(foldNest.placements.length, 1);
  assert.equal(foldNest.placements[0].onFold, true);
  assert.ok(foldNest.utilizationPct > 0 && foldNest.utilizationPct <= 100);

  // Flush 100% utilization
  const f1 = createRectanglePiece('F1', 400, 300, { id: 'f1', seamAllowance: 0 });
  const f2 = createRectanglePiece('F2', 400, 300, { id: 'f2', seamAllowance: 0 });
  const flushNest = nestPatternPieces({ id: 'fl', unit: 'mm', pieces: [f1, f2], seams: [] }, {
    fabricWidthMm: 800,
    marginMm: 0,
    spacingMm: 0,
    allowRotate90: false,
  });
  assertNear(flushNest.requiredLengthMm, 300, 0.05);
  assertNear(flushNest.utilizationPct, 100, 0.1);

  // Multi-sheet 36x24 mat (914.4 x 609.6 mm) & unfitted pants leg (> 914.4 mm)
  const matBlocks = [1, 2, 3, 4].map((i) => createRectanglePiece(`M${i}`, 400, 400, { id: `m${i}`, seamAllowance: 0 }));
  const matNest = nestPatternPieces({ id: 'mat', unit: 'mm', pieces: matBlocks, seams: [] }, {
    rollPreset: 'cutting_mat_36x24',
    marginMm: 10,
    spacingMm: 10,
  });
  assert.equal(matNest.sheetCount, 2);
  assert.equal(matNest.sheets.length, 2);
  assertNoOverlapsAndInBounds(matNest, 914.4);

  const pants = generateTemplatePattern('pants');
  const pantsMat = nestPatternPieces(pants, { rollPreset: 'cutting_mat_36x24', marginMm: 10, spacingMm: 10 });
  assert.ok(pantsMat.unfittedPieces.length >= 4, 'Oversized pants legs must be reported in unfittedPieces on 36x24 mat');

  // Empty pattern & imperial unit input
  const emptyNest = nestPatternPieces({ id: 'emp', unit: 'mm', pieces: [], seams: [] });
  assert.equal(emptyNest.requiredLengthMm, 0);
  assert.equal(emptyNest.utilizationPct, 0);
  assert.deepEqual(emptyNest.placements, []);

  const inPiece = createRectanglePiece('InPanel', 10, 8, { seamAllowance: 0, quantity: 2 });
  const inNest = nestPatternPieces({ id: 'in_proj', unit: 'in', pieces: [inPiece], seams: [] }, { fabricWidthMm: 914.4 });
  assert.equal(inNest.placements.length, 2);
  assertNear(inNest.totalNetAreaMm2, 2 * unitToMm(10, 'in') * unitToMm(8, 'in'), 1);
});

// ============================================================================
// 3. True-Scale 1:1 SVG Exporter (F22)
// ============================================================================

test('F22 SVG: 1:1 mm scale, semantic layers, native Beziers, rotation, XML escaping & empty pattern', async () => {
  // Empty pattern
  const emptySvg = exportSVG({ id: 'empty', name: 'Empty', unit: 'mm', pieces: [], seams: [] });
  const emptyRep = await runVerifyExports('svg', emptySvg, { requireCalibrationSquare: true, checkScale1to1: true });
  assert.equal(emptyRep.ok, true, JSON.stringify(emptyRep.errors));

  // Hostile XML characters + rotation 37° + negative coordinates
  const rect = createRectanglePiece('Front <Panel> & "A&B" \'1\'', 120, 60, {
    seamAllowance: 0,
    rotation: 37,
    position: { x: -200, y: -150 },
  });
  const rotPat = { id: 'rot', name: 'Test <Proj> & "Quotes" \'S\'', unit: 'mm', pieces: [rect], seams: [] };
  const rotSvg = exportSVG(rotPat);
  const rad = (37 * Math.PI) / 180;
  const expW = 120 * Math.abs(Math.cos(rad)) + 60 * Math.abs(Math.sin(rad));
  const expH = 120 * Math.abs(Math.sin(rad)) + 60 * Math.abs(Math.cos(rad));
  const rotRep = await runVerifyExports('svg', rotSvg, {
    checkScale1to1: true,
    requireCalibrationSquare: true,
    require2InCalibrationSquare: true,
    expectedLayers: ['calibration', 'cut', 'seam'],
    expectedPieces: [{ widthMm: expW, heightMm: expH, areaMm2: 7200, tolMm: 0.1 }],
  });
  assert.equal(rotRep.ok, true, JSON.stringify(rotRep.errors));
  assert.ok(rotRep.metrics.viewBox[0] >= 0 && rotRep.metrics.viewBox[1] >= 0);

  // High-curvature >250mm cubic Bezier (native C command in SVG)
  const curved = createFreeformPiece('Curved', [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 200 },
    { x: 0, y: 200 },
  ], { seamAllowance: 10 });
  curved.edges[0].curve = { cp1: { x: 60, y: -140 }, cp2: { x: 240, y: 140 } };
  const curvedSvg = exportSVG({ id: 'c', name: 'Curved', unit: 'mm', pieces: [curved], seams: [] });
  assert.ok(/<path[^>]*\sd="M\s+[^"]*C\s+/.test(curvedSvg), 'SVG seam path must emit native cubic Bezier C commands');
  const cutB = polygonBounds(computePieceCutBoundary(curved, 64));
  const cutArea = polygonArea(computePieceCutBoundary(curved, 64));
  const curvedRep = await runVerifyExports('svg', curvedSvg, {
    checkScale1to1: true,
    requireCalibrationSquare: true,
    expectedPieces: [{ widthMm: cutB.width, heightMm: cutB.height, areaMm2: cutArea, areaTolPct: 0.5, tolMm: 0.1 }],
  });
  assert.equal(curvedRep.ok, true, JSON.stringify(curvedRep.errors));

  // Nested layout with quantity=2
  const pair = createRectanglePiece('Pair', 100, 80, { seamAllowance: 10, quantity: 2 });
  const nestedSvg = exportSVG({ id: 'ns', name: 'Nested', unit: 'mm', pieces: [pair], seams: [] }, {
    layout: 'nested',
    fabricWidthMm: 600,
  });
  const nestedRep = await runVerifyExports('svg', nestedSvg, {
    checkScale1to1: true,
    expectedPieces: [
      { widthMm: 100, heightMm: 80, tolMm: 0.1 },
      { widthMm: 100, heightMm: 80, tolMm: 0.1 },
    ],
  });
  assert.equal(nestedRep.ok, true, JSON.stringify(nestedRep.errors));
});

// ============================================================================
// 4. Multi-Page Tiled PDF 1.4 Exporter (F23)
// ============================================================================

test('F23 PDF: byte-exact xref with UTF-8 names, single-page LETTER/A4/A0 fits, internalLines & multi-page E08 parity', async () => {
  // Byte-exact xref even with non-ASCII UTF-8 & control characters
  const utf8Piece = createRectanglePiece('Pièce №1 — 日本語\nLine2', 130, 90, { seamAllowance: 10 });
  const utf8Pdf = exportTiledPDF(
    { id: 'u8', name: 'Projet Édition — テスト', unit: 'mm', pieces: [utf8Piece], seams: [] },
    { pageFormat: 'A4' }
  );
  assert.equal(utf8Pdf.pageCount, 1);
  assert.equal(utf8Pdf.pdfBytes.length, Buffer.from(utf8Pdf.pdfString, 'latin1').length);
  assertValidPdfXref(utf8Pdf.pdfBytes);
  const a4Rep = await runVerifyExports('pdf', utf8Pdf.pdfBytes, {
    pageFormat: 'A4',
    exactPages: 1,
    requireCalibrationSquare: true,
    checkPage1PieceBounds: true,
    expectedPieces: [{ widthMm: 130, heightMm: 90, tolMm: 0.1 }],
  });
  assert.equal(a4Rep.ok, true, JSON.stringify(a4Rep.errors));

  // Single-page fits: 60x40+SA=5 on LETTER, 175x115 on A4, 700x500+SA=10 on A0
  const tiny = exportTiledPDF(
    { id: 't', name: 'Tiny', unit: 'mm', pieces: [createRectanglePiece('T', 60, 40, { seamAllowance: 5 })], seams: [] },
    { pageFormat: 'LETTER' }
  );
  assert.equal(tiny.pageCount, 1);
  assert.equal((await runVerifyExports('pdf', tiny.pdfBytes, {
    pageFormat: 'LETTER',
    exactPages: 1,
    expectedPieces: [{ widthMm: 70, heightMm: 50, tolMm: 0.1 }],
  })).ok, true);

  const a0 = exportTiledPDF(
    { id: 'a0', name: 'A0', unit: 'mm', pieces: [createRectanglePiece('Big', 700, 500, { seamAllowance: 10 })], seams: [] },
    { pageFormat: 'A0' }
  );
  assert.equal(a0.pageCount, 1);
  assert.equal((await runVerifyExports('pdf', a0.pdfBytes, {
    pageFormat: 'A0',
    exactPages: 1,
    expectedPieces: [{ widthMm: 720, heightMm: 520, tolMm: 0.1 }],
  })).ok, true);

  // internalLines rendered as dashed vector lines
  const pocketPiece = createRectanglePiece('PocketBody', 160, 180, {
    seamAllowance: 10,
    internalLines: [
      { id: 'fold1', type: 'fold', points: [{ x: 10, y: 90 }, { x: 150, y: 90 }] },
      { id: 'pock1', type: 'pocket', points: [{ x: 30, y: 40 }, { x: 130, y: 40 }, { x: 130, y: 120 }] },
    ],
  });
  const ilPdf = exportTiledPDF({ id: 'il', name: 'Internal', unit: 'mm', pieces: [pocketPiece], seams: [] }, {
    pageFormat: 'LETTER',
  });
  assert.equal(ilPdf.pageCount, 1);
  const ilRep = await runVerifyExports('pdf', ilPdf.pdfBytes, {
    pageFormat: 'LETTER',
    requireCalibrationSquare: true,
    requireDashedLines: true,
    requireInternalLines: true,
  });
  assert.equal(ilRep.ok, true, JSON.stringify(ilRep.errors));

  // Multi-page 900x900 on LETTER with 15mm overlap (E08 tile overlap parity <= 0.1 mm)
  const big900 = exportTiledPDF(
    { id: 'big', name: 'Grid900', unit: 'mm', pieces: [createRectanglePiece('Grid', 900, 900, { seamAllowance: 0 })], seams: [] },
    { pageFormat: 'LETTER', overlapMm: 15 }
  );
  assert.ok(big900.rows >= 3 && big900.cols >= 3);
  assert.equal(big900.pageCount, big900.rows * big900.cols);
  assertValidPdfXref(big900.pdfBytes);
  const e08Rep = await runVerifyExports('pdf', big900.pdfBytes, {
    pageFormat: 'LETTER',
    overlapMm: 15,
    minPages: 9,
    requireCalibrationSquare: true,
    requireRegistrationMarks: true,
    expectedTextSubstrings: ['R1C1', 'R2C2'],
  });
  assert.equal(e08Rep.ok, true, JSON.stringify(e08Rep.errors));
  assert.ok(e08Rep.metrics.tileParityMaxErrMm <= 0.05);
  assertNear(e08Rep.metrics.measuredOverlapMm, 15.0, 0.05);

  // Empty PDF
  const emptyPdf = exportTiledPDF({ id: 'ep', name: 'Empty', unit: 'mm', pieces: [], seams: [] }, { pageFormat: 'LETTER' });
  assert.equal(emptyPdf.pageCount, 1);
  assert.equal((await runVerifyExports('pdf', emptyPdf.pdfBytes, { pageFormat: 'LETTER', requireCalibrationSquare: true })).ok, true);
});

// ============================================================================
// 5. True-Scale 1:1 CAD DXF Exporter (F24)
// ============================================================================

test('F24 DXF: AC1015, $INSUNITS=4, TABLES/LAYER, closed LWPOLYLINE, curved/rotated/sanitized & empty', async () => {
  const emptyDxf = exportDXF({ id: 'ed', name: 'EmptyDXF', unit: 'mm', pieces: [], seams: [] });
  assert.ok(emptyDxf.endsWith('0\nENDSEC\n0\nEOF\n'));
  const emptyRep = await runVerifyExports('dxf', emptyDxf, {
    requireInsUnits4: true,
    requireTablesLayer: true,
    requireCalibrationSquare: true,
  });
  assert.equal(emptyRep.ok, true, JSON.stringify(emptyRep.errors));

  // Newline + special char sanitization + rotation=90 + negative coords + cubic curve
  const pRot = createRectanglePiece('Back\nPanel & "1"', 160, 70, {
    seamAllowance: 0,
    rotation: 90,
    position: { x: -200, y: -120 },
  });
  const dxfRot = exportDXF({ id: 'dr', name: 'DxfRot', unit: 'mm', pieces: [pRot], seams: [] });
  const rotRep = await runVerifyExports('dxf', dxfRot, {
    requireInsUnits4: true,
    requireTablesLayer: true,
    expectedLayers: ['CUT', 'SEAM', 'NOTCH', 'GRAINLINE', 'INTERNAL', 'TEXT', 'CALIBRATION'],
    expectedPieces: [{ widthMm: 70, heightMm: 160, areaMm2: 11200, tolMm: 0.1 }],
  });
  assert.equal(rotRep.ok, true, JSON.stringify(rotRep.errors));

  const pCurve = createRectanglePiece('DxfCurve', 260, 180, { seamAllowance: 10 });
  pCurve.edges[0].curve = { cp1: { x: 60, y: 120 }, cp2: { x: 200, y: 120 } };
  const dxfCurve = exportDXF({ id: 'dc', name: 'DxfCurve', unit: 'mm', pieces: [pCurve], seams: [] });
  const cutB = polygonBounds(computePieceCutBoundary(pCurve, 64));
  const cutPerim = polygonPerimeter(computePieceCutBoundary(pCurve, 64));
  const curveRep = await runVerifyExports('dxf', dxfCurve, {
    requireClosedLwpolyline: true,
    expectedPieces: [{ widthMm: cutB.width, heightMm: cutB.height, perimeterMm: cutPerim, tolMm: 0.1 }],
  });
  assert.equal(curveRep.ok, true, JSON.stringify(curveRep.errors));
});

// ============================================================================
// 6. 3-Way Cross-Format Parity, Starter Blocks & JSON Round-Trip
// ============================================================================

test('Cross-format 3-way SVG/PDF/DXF parity (<= 0.1 mm), starter blocks & JSON round-trip', async () => {
  let darted = createRectanglePiece('DartedCurve', 160, 110, { seamAllowance: 10, rotation: 15 });
  darted.edges[2].curve = { cp1: { x: 120, y: 140 }, cp2: { x: 40, y: 140 } };
  darted = addDartToPiece(darted, 0, { t: 0.5, widthMm: 20, depthMm: 45, folded: false });

  const project = {
    id: 'parity_proj',
    name: 'Parity3Way',
    unit: 'mm',
    pieces: [darted],
    seams: [],
  };

  const cutWorld = computePieceCutBoundary(darted, 64, { worldSpace: true });
  const cutB = polygonBounds(cutWorld);
  const cutArea = polygonArea(cutWorld);
  const cutPerim = polygonPerimeter(cutWorld);

  const exp = {
    expectedPieces: [
      {
        widthMm: cutB.width,
        heightMm: cutB.height,
        areaMm2: cutArea,
        perimeterMm: cutPerim,
        areaTolPct: 0.5,
        tolMm: 0.1,
      },
    ],
  };

  const svg = exportSVG(project);
  const dxf = exportDXF(project);
  const pdf = exportTiledPDF(project, { pageFormat: 'A4' });

  const [rSvg, rDxf, rPdf] = await Promise.all([
    runVerifyExports('svg', svg, { ...exp, checkScale1to1: true }),
    runVerifyExports('dxf', dxf, exp),
    runVerifyExports('pdf', pdf.pdfBytes, { ...exp, pageFormat: 'A4', checkPage1PieceBounds: true }),
  ]);
  assert.equal(rSvg.ok, true, `SVG parity failed: ${JSON.stringify(rSvg.errors)}`);
  assert.equal(rDxf.ok, true, `DXF parity failed: ${JSON.stringify(rDxf.errors)}`);
  assert.equal(rPdf.ok, true, `PDF parity failed: ${JSON.stringify(rPdf.errors)}`);

  // Starter block exports (tshirt, hoodie, tote_bag on LETTER; pants on A0 & LETTER xref/pdfinfo)
  for (const tplId of ['tshirt', 'hoodie', 'pants', 'tote_bag']) {
    const pat = generateTemplatePattern(tplId);
    const tSvg = exportSVG(pat);
    const tDxf = exportDXF(pat);
    const pdfFmt = tplId === 'pants' ? 'A0' : 'LETTER';
    const tPdf = exportTiledPDF(pat, { pageFormat: pdfFmt });
    assertValidPdfXref(tPdf.pdfBytes);
    const [sRep, dRep, pRep] = await Promise.all([
      runVerifyExports('svg', tSvg, { checkScale1to1: true, requireCalibrationSquare: true }),
      runVerifyExports('dxf', tDxf, { requireInsUnits4: true, requireTablesLayer: true, requireCalibrationSquare: true }),
      runVerifyExports('pdf', tPdf.pdfBytes, {
        pageFormat: pdfFmt,
        requireCalibrationSquare: true,
        requireInternalLines: tplId === 'hoodie' || tplId === 'tote_bag',
      }),
    ]);
    assert.equal(sRep.ok, true, `${tplId} SVG failed: ${JSON.stringify(sRep.errors)}`);
    assert.equal(dRep.ok, true, `${tplId} DXF failed: ${JSON.stringify(dRep.errors)}`);
    assert.equal(pRep.ok, true, `${tplId} PDF (${pdfFmt}) failed: ${JSON.stringify(pRep.errors)}`);
  }

  // JSON round-trip (mm and imperial 'in' normalization + strict error rejection)
  const tote = generateTemplatePattern('tote_bag');
  const restored = importPatternJSON(exportPatternJSON(tote));
  assert.equal(restored.unit, 'mm');
  assert.equal(restored.pieces.length, tote.pieces.length);
  assert.equal(restored.seams.length, tote.seams.length);

  const inchProj = {
    id: 'in_roundtrip',
    name: 'InchRoundtrip',
    unit: 'in',
    pieces: [createRectanglePiece('Plate', 6, 4, { seamAllowance: 0 })],
    seams: [],
  };
  const restoredIn = importPatternJSON(exportPatternJSON(inchProj));
  assert.equal(restoredIn.unit, 'mm');
  const bIn = polygonBounds(restoredIn.pieces[0].points);
  assertNear(bIn.width, 152.4, 1e-4);
  assertNear(bIn.height, 101.6, 1e-4);

  assert.throws(() => importPatternJSON('{bad json'), ValidationError);
  assert.throws(() => importPatternJSON('{"pieces": "nope"}'), ValidationError);
  assert.throws(() => importPatternJSON('{"pieces": [{"points": []}]}'), ValidationError);
});

// ============================================================================
// 7. Iteration 2 Regression Tests (Notch/InternalLines Bounds, Small-Page Calib, Hardening)
// ============================================================================

function extractPdfPageStreams(pdfBytes) {
  const text = Buffer.from(pdfBytes).toString('latin1');
  const streams = [];
  let pos = 0;
  while (true) {
    const start = text.indexOf('stream\n', pos);
    if (start === -1) break;
    const end = text.indexOf('\nendstream', start);
    if (end === -1) break;
    streams.push(text.slice(start + 7, end));
    pos = end + 10;
  }
  return streams;
}

test('Regression: outward notch and internalLines expand export bounds and are NOT culled on adjacent PDF tiles', async () => {
  // 1. Outward notch (SA=0, depthMm=10) on w=189 crosses onto Page 2 of LETTER (printableW=195.9, overlap=0)
  let notchPiece = createRectanglePiece('NotchOnlyA', 189, 100, { seamAllowance: 0 });
  notchPiece = addNotchToPiece(notchPiece, { edgeIndex: 1, t: 0.5, type: 'single', depthMm: 10 });
  const notchPat = { id: 'na', name: 'NotchOnlyA', unit: 'mm', pieces: [notchPiece], seams: [] };
  const notchPdf = exportTiledPDF(notchPat, { pageFormat: 'LETTER', marginMm: 10, overlapMm: 0 });
  assert.equal(notchPdf.cols, 2, 'Outward notch extending beyond printableW must expand PDF to 2 cols');
  assert.equal(notchPdf.rows, 1);
  assertValidPdfXref(notchPdf.pdfBytes);
  const notchStreams = extractPdfPageStreams(notchPdf.pdfBytes);
  assert.equal(notchStreams.length, 2);
  assert.ok(notchStreams[1].includes('0.86 0.15 0.15 RG'), 'Page 2 must render outward red notch (not culled by cutBounds)');
  assert.ok(notchStreams[1].includes('(NotchOnlyA) Tj'), 'Page 2 must render piece block containing outward notch');

  // 2. internalLines extending beyond cutBounds (X and Y) expand PDF cols/rows, SVG viewBox, and DXF $EXTMAX
  let extPiece = createRectanglePiece('ExtInternal', 180, 100, {
    seamAllowance: 0,
    internalLines: [
      { id: 'il_x', type: 'grain', points: [{ x: 100, y: 50 }, { x: 240, y: 50 }] },
      { id: 'il_y', type: 'fold', points: [{ x: 90, y: 50 }, { x: 90, y: 290 }] },
    ],
  });
  extPiece = addNotchToPiece(extPiece, { edgeIndex: 1, t: 0.5, type: 'single', depthMm: 15 });
  const extPat = { id: 'ext', name: 'ExtInternal', unit: 'mm', pieces: [extPiece], seams: [] };

  const extPdf = exportTiledPDF(extPat, { pageFormat: 'LETTER', marginMm: 10, overlapMm: 0 });
  assert.ok(extPdf.cols >= 2, `Expected cols >= 2 for internalLine maxX=240, got ${extPdf.cols}`);
  assert.ok(extPdf.rows >= 2, `Expected rows >= 2 for internalLine maxY=290, got ${extPdf.rows}`);
  assertValidPdfXref(extPdf.pdfBytes);
  const extStreams = extractPdfPageStreams(extPdf.pdfBytes);
  // R1C2 (index 1) must contain the purple dashed internal line extending to X=240
  assert.ok(extStreams[1].includes('0.49 0.23 0.93 RG'), 'Tile R1C2 must render internalLines extending past cutBounds');
  // R2C1 (index extPdf.cols) must contain the purple dashed internal line extending to Y=290
  assert.ok(extStreams[extPdf.cols].includes('0.49 0.23 0.93 RG'), 'Tile R2C1 must render internalLines extending past cutBounds');

  const extSvg = exportSVG(extPat, { marginMm: 15 });
  const vbMatch = extSvg.match(/viewBox="([^"]+)"/);
  assert.ok(vbMatch, 'SVG missing viewBox');
  const [, , vbW, vbH] = vbMatch[1].split(/\s+/).map(Number);
  assert.ok(vbW >= 240 + 30 - 1e-4, `SVG viewBox width ${vbW} must cover internalLine maxX=240 + margins`);
  assert.ok(vbH >= 290 + 66 + 30 - 1e-4, `SVG viewBox height ${vbH} must cover internalLine maxY=290 + calBand + margins`);

  const extDxf = exportDXF(extPat, { marginMm: 15 });
  const extMaxMatch = extDxf.match(/\$EXTMAX\s+10\s+([\d.-]+)\s+20\s+([\d.-]+)/);
  assert.ok(extMaxMatch, 'DXF missing $EXTMAX');
  assert.ok(Number(extMaxMatch[1]) >= 240 + 65 + 30 - 1e-4, 'DXF $EXTMAX X must cover internalLine maxX');
  assert.ok(Number(extMaxMatch[2]) >= 290 + 30 - 1e-4, 'DXF $EXTMAX Y must cover internalLine maxY');

  // 3. Single-page fits (T1-F23-3, T1-F23-5, T2-F23-1, T2-F23-3, T3-22) remain strictly 1 page
  const singleFits = [
    [createRectanglePiece('T1_F23_3', 130, 90, { seamAllowance: 10 }), { pageFormat: 'A4' }],
    [
      createRectanglePiece('T1_F23_5', 160, 180, {
        seamAllowance: 10,
        internalLines: [
          { id: 'f1', type: 'fold', points: [{ x: 10, y: 90 }, { x: 150, y: 90 }] },
          { id: 'p1', type: 'pocket', points: [{ x: 30, y: 40 }, { x: 130, y: 40 }] },
        ],
      }),
      { pageFormat: 'LETTER' },
    ],
    [createRectanglePiece('T2_F23_1', 60, 40, { seamAllowance: 5 }), { pageFormat: 'LETTER' }],
    [createRectanglePiece('T2_F23_3', 700, 500, { seamAllowance: 10 }), { pageFormat: 'A0' }],
    [createRectanglePiece('T3_22', 175, 115, { seamAllowance: 0 }), { pageFormat: 'A4' }],
  ];
  for (const [piece, opts] of singleFits) {
    const res = exportTiledPDF({ id: piece.name, name: piece.name, unit: 'mm', pieces: [piece], seams: [] }, opts);
    assert.equal(res.pageCount, 1, `Expected 1 page for ${piece.name} on ${opts.pageFormat}, got ${res.pageCount}`);
  }
});

test('Regression: Page 1 calibration square never overflows MediaBox on small custom PDF pages', async () => {
  const smallPat = { id: 'sm', name: 'Small', unit: 'mm', pieces: [createRectanglePiece('S', 25, 25, { seamAllowance: 0 })], seams: [] };

  for (const [w, h, m, expectedSize] of [
    [60, 60, 10, 20],
    [40, 40, 3, 20],
    [25, 25, 2, 10],
    [21, 21, 5, null],
  ]) {
    const res = exportTiledPDF(smallPat, { pageFormat: 'custom', pageWidthMm: w, pageHeightMm: h, marginMm: m, overlapMm: 2 });
    assertValidPdfXref(res.pdfBytes);
    const match = res.pdfString.match(/0\.05 0\.05 0\.05 RG[^\n]*\n([^\n]+) re S/);
    if (expectedSize === null) {
      assert.equal(match, null, `Expected calibration square omitted on ${w}x${h} m=${m}`);
    } else {
      assert.ok(match, `Expected ${expectedSize}mm calibration square on ${w}x${h} m=${m}`);
      const [rx, ry, rw, rh] = match[1].split(/\s+/).map((v) => Number(v) / MM_TO_PT);
      assertNear(rw, expectedSize, 0.02, `${w}x${h} cal width`);
      assertNear(rh, expectedSize, 0.02, `${w}x${h} cal height`);
      assert.ok(rx >= m - 1e-3 && rx + rw <= w - m + 1e-3, `Cal X [${rx}, ${rx + rw}] outside [${m}, ${w - m}]`);
      assert.ok(ry >= m - 1e-3 && ry + rh <= h - m + 1e-3, `Cal Y [${ry}, ${ry + rh}] outside [${m}, ${h - m}]`);
    }
  }

  // Standard pages retain 50.0 x 50.0 mm calibration square
  const stdPdf = exportTiledPDF(smallPat, { pageFormat: 'LETTER' });
  const stdRep = await runVerifyExports('pdf', stdPdf.pdfBytes, {
    pageFormat: 'LETTER',
    exactPages: 1,
    requireCalibrationSquare: true,
    calibSizeMm: 50.0,
    calibTolMm: 0.1,
  });
  assert.equal(stdRep.ok, true, JSON.stringify(stdRep.errors));
});

test('Regression: duplicate piece.id in nested layout and Symbol piece.quantity are handled safely', async () => {
  // Duplicate piece.id under layout: 'nested'
  const pA = createRectanglePiece('PieceA', 50, 50, { id: 'dup', seamAllowance: 0 });
  const pB = createRectanglePiece('PieceB', 90, 70, { id: 'dup', seamAllowance: 0 });
  const dupPat = { id: 'dup_proj', name: 'DupIds', unit: 'mm', pieces: [pA, pB], seams: [] };

  const nest = nestPatternPieces(dupPat, { fabricWidthMm: 500, marginMm: 10, spacingMm: 10 });
  assert.equal(nest.placements.length, 2);
  assert.equal(nest.placements[0].pieceIndex !== nest.placements[1].pieceIndex, true);

  const dupSvg = exportSVG(dupPat, { layout: 'nested', nestingResult: nest });
  const dupDxf = exportDXF(dupPat, { layout: 'nested', nestingResult: nest });
  const dupPdf = exportTiledPDF(dupPat, { layout: 'nested', nestingResult: nest, pageFormat: 'A4' });

  const exp = {
    expectedPieces: [
      { widthMm: 50, heightMm: 50, areaMm2: 2500, tolMm: 0.2 },
      { widthMm: 90, heightMm: 70, areaMm2: 6300, tolMm: 0.2 },
    ],
  };
  const [sRep, dRep, pRep] = await Promise.all([
    runVerifyExports('svg', dupSvg, { ...exp, checkScale1to1: true }),
    runVerifyExports('dxf', dupDxf, exp),
    runVerifyExports('pdf', dupPdf.pdfBytes, { ...exp, pageFormat: 'A4' }),
  ]);
  assert.equal(sRep.ok, true, `Dup SVG failed: ${JSON.stringify(sRep.errors)}`);
  assert.equal(dRep.ok, true, `Dup DXF failed: ${JSON.stringify(dRep.errors)}`);
  assert.equal(pRep.ok, true, `Dup PDF failed: ${JSON.stringify(pRep.errors)}`);

  // Symbol piece.quantity does not throw TypeError and defaults to 1
  const symPiece = createRectanglePiece('SymQty', 100, 80, { seamAllowance: 0 });
  symPiece.quantity = Symbol('bad');
  const symNest = nestPatternPieces({ id: 'sq', unit: 'mm', pieces: [symPiece], seams: [] }, { fabricWidthMm: 500 });
  assert.equal(symNest.placements.length, 1);
  assert.equal(symNest.totalCutPieceCount, 1);

  // SVG XML id attributes must be strictly unique even when distinct pieces share piece.id and quantity > 1
  const pDup1 = createRectanglePiece('DupOne', 60, 40, { id: 'dup', seamAllowance: 5, quantity: 2 });
  const pDup2 = createRectanglePiece('DupTwo', 80, 50, { id: 'dup', seamAllowance: 5, quantity: 2 });
  const dupMultiPat = { id: 'dup_multi', name: 'DupMulti', unit: 'mm', pieces: [pDup1, pDup2], seams: [] };
  const dupMultiSvg = exportSVG(dupMultiPat, { layout: 'nested', fabricWidthMm: 600 });
  const svgIds = [...dupMultiSvg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(svgIds.length, new Set(svgIds).size, `Expected unique SVG id attributes, got duplicates in ${JSON.stringify(svgIds)}`);
  const pathIds = [...dupMultiSvg.matchAll(/<path\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(pathIds.filter((id) => id.startsWith('cut-')).length, 4);
  assert.equal(pathIds.filter((id) => id.startsWith('seam-')).length, 4);
  const dupDefaultSvg = exportSVG(dupMultiPat);
  const defaultIds = [...dupDefaultSvg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(defaultIds.length, new Set(defaultIds).size);
  const dupMultiRep = await runVerifyExports('svg', dupMultiSvg, {
    checkScale1to1: true,
    expectedPieces: [
      { widthMm: 70, heightMm: 50, allowRotate90: true, tolMm: 0.2 },
      { widthMm: 70, heightMm: 50, allowRotate90: true, tolMm: 0.2 },
      { widthMm: 90, heightMm: 60, allowRotate90: true, tolMm: 0.2 },
      { widthMm: 90, heightMm: 60, allowRotate90: true, tolMm: 0.2 },
    ],
  });
  assert.equal(dupMultiRep.ok, true, `DupMulti SVG failed: ${JSON.stringify(dupMultiRep.errors)}`);
});

test('Regression: nested SVG/DXF/PDF exports preserve piece.grainLock across mm, in, and cm patterns', async () => {
  const specs = [
    {
      unit: 'in',
      wideW: 40, // 1016 mm > 914.4 mm roll width
      wideH: 8,  // 203.2 mm <= usable width when rotated 90°
      fitW: 10,  // 254 mm
      fitH: 6,   // 152.4 mm
    },
    {
      unit: 'cm',
      wideW: 100, // 1000 mm > 914.4 mm roll width
      wideH: 20,  // 200 mm
      fitW: 25,   // 250 mm
      fitH: 15,   // 150 mm
    },
    {
      unit: 'mm',
      wideW: 1000,
      wideH: 200,
      fitW: 250,
      fitH: 150,
    },
  ];

  for (const s of specs) {
    const lockedPat = {
      id: `gl_locked_${s.unit}`,
      name: `Locked_${s.unit}`,
      unit: s.unit,
      pieces: [
        {
          id: 'wide_locked',
          name: 'WideLocked',
          seamAllowance: 0,
          grainLock: true,
          points: [
            { x: 0, y: 0 },
            { x: s.wideW, y: 0 },
            { x: s.wideW, y: s.wideH },
            { x: 0, y: s.wideH },
          ],
          edges: [
            { seamAllowance: 0 },
            { seamAllowance: 0 },
            { seamAllowance: 0 },
            { seamAllowance: 0 },
          ],
        },
        {
          id: 'small_fit',
          name: 'SmallFit',
          seamAllowance: 0,
          grainLock: true,
          points: [
            { x: 0, y: 0 },
            { x: s.fitW, y: 0 },
            { x: s.fitW, y: s.fitH },
            { x: 0, y: s.fitH },
          ],
          edges: [
            { seamAllowance: 0 },
            { seamAllowance: 0 },
            { seamAllowance: 0 },
            { seamAllowance: 0 },
          ],
        },
      ],
      seams: [],
    };

    const nestOpts = { layout: 'nested', fabricWidthMm: 914.4, allowRotate90: true, pageFormat: 'A0' };
    const nest = nestPatternPieces(lockedPat, nestOpts);
    assert.equal(nest.unfittedPieces.length, 1, `${s.unit}: expected 1 unfitted grain-locked piece`);
    assert.equal(nest.unfittedPieces[0].reason, 'GRAINLINE_LOCKED_EXCEEDS_WIDTH');
    assert.equal(nest.placements.length, 1, `${s.unit}: expected SmallFit placed`);

    const svg = exportSVG(lockedPat, nestOpts);
    const dxf = exportDXF(lockedPat, nestOpts);
    const pdf = exportTiledPDF(lockedPat, nestOpts);

    assert.equal(svg.includes('WideLocked'), false, `${s.unit} grainLock=true must NOT place WideLocked in nested SVG`);
    assert.equal(dxf.includes('WideLocked'), false, `${s.unit} grainLock=true must NOT place WideLocked in nested DXF`);
    assert.equal(pdf.pdfString.includes('WideLocked'), false, `${s.unit} grainLock=true must NOT place WideLocked in nested PDF`);

    assert.equal(svg.includes('SmallFit'), true, `${s.unit} nested SVG must still place SmallFit`);
    assert.equal(dxf.includes('SmallFit'), true, `${s.unit} nested DXF must still place SmallFit`);
    assert.equal(pdf.pdfString.includes('SmallFit'), true, `${s.unit} nested PDF must still place SmallFit`);

    // JSON round-trip preserves grainLock
    const roundTripped = importPatternJSON(exportPatternJSON(lockedPat));
    assert.equal(roundTripped.pieces[0].grainLock, true, `${s.unit} importPatternJSON must preserve grainLock`);

    // Compare against grainLock: false -> WideLocked IS rotated 90° and placed
    const unlockedPat = {
      ...lockedPat,
      id: `gl_unlocked_${s.unit}`,
      pieces: lockedPat.pieces.map((p) => ({ ...p, grainLock: false })),
    };
    const unlockedNest = nestPatternPieces(unlockedPat, nestOpts);
    assert.equal(unlockedNest.unfittedPieces.length, 0, `${s.unit}: unlocked piece must rotate 90° and fit`);
    assert.equal(unlockedNest.placements.length, 2);
    assert.equal(unlockedNest.placements.some((pl) => pl.pieceId === 'wide_locked' && pl.rotated90), true);

    const unlockedSvg = exportSVG(unlockedPat, nestOpts);
    const unlockedDxf = exportDXF(unlockedPat, nestOpts);
    const unlockedPdf = exportTiledPDF(unlockedPat, nestOpts);

    assert.equal(unlockedSvg.includes('WideLocked'), true, `${s.unit} grainLock=false must place WideLocked in nested SVG`);
    assert.equal(unlockedDxf.includes('WideLocked'), true, `${s.unit} grainLock=false must place WideLocked in nested DXF`);
    assert.equal(unlockedPdf.pdfString.includes('WideLocked'), true, `${s.unit} grainLock=false must place WideLocked in nested PDF`);

    const fitWMm = unitToMm(s.fitW, s.unit);
    const fitHMm = unitToMm(s.fitH, s.unit);
    const wideWMm = unitToMm(s.wideW, s.unit);
    const wideHMm = unitToMm(s.wideH, s.unit);
    const unlockedExp = {
      expectedPieces: [
        { widthMm: wideHMm, heightMm: wideWMm, areaMm2: wideWMm * wideHMm, tolMm: 0.2 },
        { widthMm: fitWMm, heightMm: fitHMm, areaMm2: fitWMm * fitHMm, allowRotate90: true, tolMm: 0.2 },
      ],
    };
    const [uSvgRep, uDxfRep, uPdfRep] = await Promise.all([
      runVerifyExports('svg', unlockedSvg, { ...unlockedExp, checkScale1to1: true }),
      runVerifyExports('dxf', unlockedDxf, unlockedExp),
      runVerifyExports('pdf', unlockedPdf.pdfBytes, { ...unlockedExp, pageFormat: 'A0' }),
    ]);
    assert.equal(uSvgRep.ok, true, `${s.unit} unlocked SVG verify failed: ${JSON.stringify(uSvgRep.errors)}`);
    assert.equal(uDxfRep.ok, true, `${s.unit} unlocked DXF verify failed: ${JSON.stringify(uDxfRep.errors)}`);
    assert.equal(uPdfRep.ok, true, `${s.unit} unlocked PDF verify failed: ${JSON.stringify(uPdfRep.errors)}`);
  }
});

test('Regression: SVG XML id attributes are strict unique NCNames under whitespace normalization and special characters', async () => {
  const idCases = [
    { id: 'foo\nbar', w: 50, h: 40, qty: 1 },
    { id: 'foo bar', w: 52, h: 40, qty: 1 },
    { id: 'foo\tbar', w: 54, h: 40, qty: 1 },
    { id: 'foo\rbar', w: 56, h: 40, qty: 1 },
    { id: 'foo\r\nbar', w: 58, h: 40, qty: 1 },
    { id: '<>&"\'', w: 60, h: 40, qty: 1 },
    { id: 'lines', w: 62, h: 40, qty: 1 },
    { id: 'cut-lines', w: 64, h: 40, qty: 1 },
    { id: 'a', w: 66, h: 40, qty: 2 },
    { id: 'a-2', w: 68, h: 40, qty: 1 },
    { id: 'a__copy1', w: 70, h: 40, qty: 1 },
    { id: '   ', w: 72, h: 40, qty: 1 },
  ];

  const pieces = idCases.map((c, idx) =>
    createRectanglePiece(`P_${idx}`, c.w, c.h, {
      id: c.id,
      seamAllowance: 5,
      quantity: c.qty,
      position: { x: idx * 90, y: 0 },
    })
  );
  const pat = { id: 'ncname_pat', name: 'NCName_Test', unit: 'mm', pieces, seams: [] };

  const defaultSvg = exportSVG(pat);
  const nestedSvg = exportSVG(pat, { layout: 'nested', fabricWidthMm: 1200, allowRotate90: false });

  const checkXmlIds = async (svgText, expectedCutPaths) => {
    const pyScript = [
      'import sys, re, json, lxml.etree as ET',
      'root = ET.fromstring(sys.stdin.read().encode("utf-8"))',
      'ids = [el.get("id") for el in root.iter() if el.get("id") is not None]',
      'nc = re.compile(r"^[A-Za-z_][A-Za-z0-9._-]*$")',
      'cut_ids = [i for i in ids if i.startswith("cut-") and i != "cut-lines"]',
      'seam_ids = [i for i in ids if i.startswith("seam-") and i != "seam-lines"]',
      'print(json.dumps({',
      '  "total": len(ids),',
      '  "unique": len(set(ids)),',
      '  "duplicates": [i for i in ids if ids.count(i) > 1],',
      '  "invalidNcnames": [i for i in ids if not nc.match(i)],',
      '  "cutCount": len(cut_ids),',
      '  "seamCount": len(seam_ids),',
      '}))',
    ].join('\n');

    const res = await new Promise((resolve, reject) => {
      const child = execFile(
        'python3',
        ['-c', pyScript],
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`${err.message}\n${stderr}`));
          resolve(JSON.parse(stdout));
        }
      );
      child.stdin.write(svgText);
      child.stdin.end();
    });

    assert.equal(res.total, res.unique, `Duplicate XML ids after lxml normalization: ${JSON.stringify(res.duplicates)}`);
    assert.deepEqual(res.invalidNcnames, [], `Invalid XML NCName ids: ${JSON.stringify(res.invalidNcnames)}`);
    assert.equal(res.cutCount, expectedCutPaths);
    assert.equal(res.seamCount, expectedCutPaths);
  };

  // Default layout emits 1 path per piece entry (12 pieces); nested layout expands quantity=2 (13 cut paths)
  await checkXmlIds(defaultSvg, idCases.length);
  await checkXmlIds(nestedSvg, idCases.reduce((s, c) => s + c.qty, 0));

  const [defRep, nestRep] = await Promise.all([
    runVerifyExports('svg', defaultSvg, {
      checkScale1to1: true,
      requireCalibrationSquare: true,
      expectedPieces: idCases.map((c) => ({ widthMm: c.w + 10, heightMm: c.h + 10, tolMm: 0.2 })),
    }),
    runVerifyExports('svg', nestedSvg, {
      checkScale1to1: true,
      requireCalibrationSquare: true,
      expectedPieces: idCases.flatMap((c) =>
        Array.from({ length: c.qty }, () => ({ widthMm: c.w + 10, heightMm: c.h + 10, tolMm: 0.2 }))
      ),
    }),
  ]);
  assert.equal(defRep.ok, true, `Default NCName SVG verify failed: ${JSON.stringify(defRep.errors)}`);
  assert.equal(nestRep.ok, true, `Nested NCName SVG verify failed: ${JSON.stringify(nestRep.errors)}`);
});

test('Regression: nestingOptions merges with top-level export options and grainLock string "false"/"0" is treated as false', async () => {
  // 1. Partial nestingOptions preserves top-level allowRotate90: false and fabricWidthMm
  const wideUnlocked = createRectanglePiece('WideBar', 1000, 200, { id: 'wide_bar', seamAllowance: 0 });
  const smallFit = createRectanglePiece('SmallBar', 250, 150, { id: 'small_bar', seamAllowance: 0 });
  const mergePat = { id: 'merge_opts', name: 'MergeOpts', unit: 'mm', pieces: [wideUnlocked, smallFit], seams: [] };

  const mergedNoRotOpts = {
    layout: 'nested',
    fabricWidthMm: 914.4,
    allowRotate90: false,
    nestingOptions: { marginMm: 10 },
    pageFormat: 'A0',
  };
  const svgNoRot = exportSVG(mergePat, mergedNoRotOpts);
  const dxfNoRot = exportDXF(mergePat, mergedNoRotOpts);
  const pdfNoRot = exportTiledPDF(mergePat, mergedNoRotOpts);

  assert.equal(svgNoRot.includes('WideBar'), false, 'allowRotate90: false must not be dropped when nestingOptions is partial');
  assert.equal(dxfNoRot.includes('WideBar'), false, 'allowRotate90: false must be preserved in DXF export');
  assert.equal(pdfNoRot.pdfString.includes('WideBar'), false, 'allowRotate90: false must be preserved in PDF export');
  assert.equal(svgNoRot.includes('SmallBar'), true);
  assert.equal(dxfNoRot.includes('SmallBar'), true);
  assert.equal(pdfNoRot.pdfString.includes('SmallBar'), true);

  // Explicit key inside nestingOptions still overrides top-level option
  const overrideOpts = {
    layout: 'nested',
    fabricWidthMm: 914.4,
    allowRotate90: false,
    nestingOptions: { allowRotate90: true, marginMm: 10 },
  };
  const svgOverride = exportSVG(mergePat, overrideOpts);
  assert.equal(svgOverride.includes('WideBar'), true, 'nestingOptions.allowRotate90: true should override top-level false');

  // 2. String grainLock: 'false' / '0' does not coerce to true in nesting, exporters, or JSON import
  for (const [unit, wideW, wideH] of [
    ['mm', 1000, 200],
    ['in', 40, 8],
    ['cm', 100, 20],
  ]) {
    for (const falseStr of ['false', '0']) {
      const pat = {
        id: `str_false_${unit}_${falseStr}`,
        name: `StrFalse_${unit}`,
        unit,
        pieces: [
          {
            id: 'wide_str_false',
            name: 'WideStrFalse',
            seamAllowance: 0,
            grainLock: falseStr,
            points: [
              { x: 0, y: 0 },
              { x: wideW, y: 0 },
              { x: wideW, y: wideH },
              { x: 0, y: wideH },
            ],
            edges: [
              { seamAllowance: 0 },
              { seamAllowance: 0 },
              { seamAllowance: 0 },
              { seamAllowance: 0 },
            ],
          },
        ],
        seams: [],
      };

      const nestOpts = { layout: 'nested', fabricWidthMm: 914.4, allowRotate90: true, pageFormat: 'A0' };
      const nest = nestPatternPieces(pat, nestOpts);
      assert.equal(nest.unfittedPieces.length, 0, `${unit} grainLock=${JSON.stringify(falseStr)} should rotate and fit`);
      assert.equal(nest.placements.length, 1);
      assert.equal(nest.placements[0].rotated90, true);

      const svg = exportSVG(pat, nestOpts);
      const dxf = exportDXF(pat, nestOpts);
      const pdf = exportTiledPDF(pat, nestOpts);
      assert.equal(svg.includes('WideStrFalse'), true, `${unit} grainLock=${JSON.stringify(falseStr)} must place in SVG`);
      assert.equal(dxf.includes('WideStrFalse'), true, `${unit} grainLock=${JSON.stringify(falseStr)} must place in DXF`);
      assert.equal(pdf.pdfString.includes('WideStrFalse'), true, `${unit} grainLock=${JSON.stringify(falseStr)} must place in PDF`);

      const rt = importPatternJSON(exportPatternJSON(pat));
      assert.equal(rt.pieces[0].grainLock, false, `${unit} importPatternJSON must normalize grainLock=${JSON.stringify(falseStr)} to false`);
    }
  }
});

test('Regression: nestingOptions strips undefined keys / ignores arrays and resolveRollSpec treats fabricWidthMm: null like undefined', () => {
  const wideBar = createRectanglePiece('WideBar', 1000, 200, { id: 'wide_bar', seamAllowance: 0 });
  const wideTall = createRectanglePiece('WideTall', 1000, 950, { id: 'wide_tall', seamAllowance: 0 });
  const smallBar = createRectanglePiece('SmallBar', 250, 150, { id: 'small_bar', seamAllowance: 0 });

  // 1. Explicit undefined keys in nestingOptions must not clobber top-level allowRotate90, fabricWidthMm, or lockGrainline
  const patBars = { id: 'undef_merge', name: 'UndefMerge', unit: 'mm', pieces: [wideBar, smallBar], seams: [] };
  const undefMergeOpts = {
    layout: 'nested',
    allowRotate90: false,
    fabricWidthMm: 914.4,
    lockGrainline: true,
    nestingOptions: {
      allowRotate90: undefined,
      fabricWidthMm: undefined,
      lockGrainline: undefined,
      marginMm: 10,
    },
    pageFormat: 'A0',
  };
  for (const [label, out] of [
    ['SVG', exportSVG(patBars, undefMergeOpts)],
    ['DXF', exportDXF(patBars, undefMergeOpts)],
    ['PDF', exportTiledPDF(patBars, undefMergeOpts).pdfString],
  ]) {
    assert.equal(out.includes('WideBar'), false, `${label}: explicit undefined keys in nestingOptions must not clobber allowRotate90:false/fabricWidthMm:914.4/lockGrainline:true`);
    assert.equal(out.includes('SmallBar'), true, `${label}: SmallBar should still be placed`);
  }

  // Verify lockGrainline: true alone is preserved even when allowRotate90: true and nestingOptions.lockGrainline is undefined
  const lockGrainOpts = {
    layout: 'nested',
    allowRotate90: true,
    fabricWidthMm: 914.4,
    lockGrainline: true,
    nestingOptions: { lockGrainline: undefined, fabricWidthMm: undefined, marginMm: 10 },
    pageFormat: 'A0',
  };
  assert.equal(exportSVG(patBars, lockGrainOpts).includes('WideBar'), false, 'SVG: lockGrainline:true must survive undefined in nestingOptions');
  assert.equal(exportDXF(patBars, lockGrainOpts).includes('WideBar'), false, 'DXF: lockGrainline:true must survive undefined in nestingOptions');
  assert.equal(exportTiledPDF(patBars, lockGrainOpts).pdfString.includes('WideBar'), false, 'PDF: lockGrainline:true must survive undefined in nestingOptions');

  // Verify fabricWidthMm: 914.4 alone is preserved against default 1371.6mm when nestingOptions.fabricWidthMm is undefined
  const patWideTall = { id: 'width_check_pat', name: 'WidthCheckProject', unit: 'mm', pieces: [wideTall, smallBar], seams: [] };
  const widthOpts = {
    layout: 'nested',
    fabricWidthMm: 914.4,
    nestingOptions: { fabricWidthMm: undefined, marginMm: 10 },
    pageFormat: 'A0',
  };
  for (const [label, out] of [
    ['SVG', exportSVG(patWideTall, widthOpts)],
    ['DXF', exportDXF(patWideTall, widthOpts)],
    ['PDF', exportTiledPDF(patWideTall, widthOpts).pdfString],
  ]) {
    assert.equal(out.includes('WideTall'), false, `${label}: fabricWidthMm:914.4 must not fall back to 1371.6`);
    assert.equal(out.includes('SmallBar'), true, `${label}: SmallBar should still be placed`);
  }

  // 2. Array nestingOptions is ignored safely without clobbering or polluting options
  const arrayOpts = {
    layout: 'nested',
    allowRotate90: false,
    fabricWidthMm: 914.4,
    lockGrainline: true,
    nestingOptions: ['bad'],
    pageFormat: 'A0',
  };
  for (const [label, out] of [
    ['SVG', exportSVG(patBars, arrayOpts)],
    ['DXF', exportDXF(patBars, arrayOpts)],
    ['PDF', exportTiledPDF(patBars, arrayOpts).pdfString],
  ]) {
    assert.equal(out.includes('WideBar'), false, `${label}: array nestingOptions must be ignored safely`);
    assert.equal(out.includes('SmallBar'), true, `${label}: SmallBar should be placed when nestingOptions is array`);
  }

  // 3. resolveRollSpec preserves preset.lengthMm when fabricWidthMm is null or non-finite
  const matPat = {
    id: 'mat_null_width',
    name: 'MatNullWidth',
    unit: 'mm',
    pieces: [createRectanglePiece('Block', 400, 400, { seamAllowance: 0, quantity: 3 })],
    seams: [],
  };
  for (const nonFiniteWidth of [null, undefined, NaN, '', '   ', 'bad', Infinity, -Infinity, Symbol('w'), 1n]) {
    const matNest = nestPatternPieces(matPat, { rollPreset: 'cutting_mat_36x24', fabricWidthMm: nonFiniteWidth });
    assert.equal(matNest.presetId, 'cutting_mat_36x24');
    assert.equal(matNest.fabricWidthMm, 914.4, `width=${String(nonFiniteWidth)} must fall back to 914.4`);
    assert.equal(matNest.sheetLengthMm, 609.6, `width=${String(nonFiniteWidth)} must preserve 609.6 sheetLengthMm`);
    assert.equal(matNest.sheetCount, 2, `width=${String(nonFiniteWidth)} must paginate into 2 mat sheets`);
  }

  // Explicit finite fabricWidthMm still clears preset.lengthMm unless sheetLengthMm is given
  const customWidthMat = nestPatternPieces(matPat, { rollPreset: 'cutting_mat_36x24', fabricWidthMm: 850 });
  assert.equal(customWidthMat.fabricWidthMm, 850);
  assert.equal(customWidthMat.sheetLengthMm, null);
  assert.equal(customWidthMat.sheetCount, 1);
});

test('Regression: exportTiledPDF strips top-level page widthMm/heightMm/format from nestingOptions and handles Symbol piece.id', async () => {
  // 1. Wide piece (450x600 + SA=10 -> 470x620) must NOT be dropped by PDF page widthMm: 215.9 under layout: 'nested'
  const widePat = {
    id: 'pdf_width_collision',
    name: 'PdfWidthCollision',
    unit: 'mm',
    pieces: [createRectanglePiece('FrontPanel', 450, 600, { seamAllowance: 10 })],
    seams: [],
  };

  const nestedCustomPdf = exportTiledPDF(widePat, {
    layout: 'nested',
    format: 'CUSTOM',
    widthMm: 215.9,
    heightMm: 279.4,
  });
  assert.equal(nestedCustomPdf.pageWidthMm, 215.9);
  assert.equal(nestedCustomPdf.pageHeightMm, 279.4);
  assert.ok(
    nestedCustomPdf.pageCount >= 6 && nestedCustomPdf.pageCount === nestedCustomPdf.cols * nestedCustomPdf.rows,
    `Expected multi-page tiled PDF for 470x620 piece, got ${nestedCustomPdf.pageCount}`
  );
  assert.equal(nestedCustomPdf.pdfString.includes('FrontPanel'), true, 'FrontPanel must not be dropped by PDF page widthMm');
  assertValidPdfXref(nestedCustomPdf.pdfBytes);
  const customRep = await runVerifyExports('pdf', nestedCustomPdf.pdfBytes, {
    pageFormat: 'LETTER',
    requireCalibrationSquare: true,
    requireRegistrationMarks: true,
    expectedTextSubstrings: ['FrontPanel'],
  });
  assert.equal(customRep.ok, true, `Custom nested PDF verify failed: ${JSON.stringify(customRep.errors)}`);

  // 2. With rollPreset: 'cutting_mat_36x24' + top-level page widthMm/heightMm, mat preset still places multi-copy wide pieces cleanly
  const matWidePat = {
    id: 'pdf_mat_collision',
    name: 'PdfMatCollision',
    unit: 'mm',
    pieces: [createRectanglePiece('MatPanel', 450, 500, { seamAllowance: 10, quantity: 2 })],
    seams: [],
  };
  const matNestedPdf = exportTiledPDF(matWidePat, {
    layout: 'nested',
    rollPreset: 'cutting_mat_36x24',
    widthMm: 215.9,
    heightMm: 279.4,
  });
  assert.equal(matNestedPdf.pdfString.includes('MatPanel'), true, 'MatPanel must fit on 914.4x609.6 mat despite PDF page widthMm:215.9');
  assertValidPdfXref(matNestedPdf.pdfBytes);

  // 3. Explicit options.nestingOptions.widthMm is still honored even when top-level widthMm is stripped
  const narrowNestPdf = exportTiledPDF(widePat, {
    layout: 'nested',
    widthMm: 215.9,
    heightMm: 279.4,
    nestingOptions: { widthMm: 300 },
  });
  assert.equal(narrowNestPdf.pdfString.includes('FrontPanel'), false, 'Explicit nestingOptions.widthMm: 300 must constrain roll width');

  const wideNestPdf = exportTiledPDF(widePat, {
    layout: 'nested',
    widthMm: 215.9,
    heightMm: 279.4,
    nestingOptions: { widthMm: 600 },
  });
  assert.equal(wideNestPdf.pdfString.includes('FrontPanel'), true, 'Explicit nestingOptions.widthMm: 600 must allow FrontPanel');

  // 4. Symbol piece.id / piece.name does not throw TypeError in exporters or nesting
  const symPiece = createRectanglePiece('SymPanel', 80, 60, { seamAllowance: 5 });
  symPiece.id = Symbol('bad_id');
  const symPat = { id: 'sym_id', name: 'SymId', unit: 'mm', pieces: [symPiece], seams: [] };
  const symNest = nestPatternPieces(symPat, { fabricWidthMm: 500 });
  assert.equal(symNest.placements.length, 1);
  const symSvg = exportSVG(symPat, { layout: 'nested', fabricWidthMm: 500 });
  const symDxf = exportDXF(symPat, { layout: 'nested', fabricWidthMm: 500 });
  const symPdf = exportTiledPDF(symPat, { layout: 'nested', fabricWidthMm: 500, pageFormat: 'LETTER' });
  assert.equal(symSvg.includes('SymPanel'), true);
  assert.equal(symDxf.includes('SymPanel'), true);
  assert.equal(symPdf.pdfString.includes('SymPanel'), true);
  assertValidPdfXref(symPdf.pdfBytes);
});
