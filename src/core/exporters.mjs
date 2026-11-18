/**
 * True-Scale 1:1 Physical Exporters (F22 SVG, F23 Multi-Page Tiled PDF 1.4, F24 CAD DXF, JSON).
 * Imports strictly from ./types.mjs, ./geometry.mjs, and ./nesting.mjs.
 * Zero external dependencies. All internal geometry operates in canonical millimeters (mm).
 */

import {
  ValidationError,
  SCHEMA_VERSION,
  isValidUnit,
  normalizePatternProject,
  validatePatternPiece,
} from './types.mjs';
import {
  computePieceCutBoundary,
  samplePieceOutline,
  computePieceNotches,
  computePieceGrainline,
  transformPiecePoints,
  polygonBounds,
  polygonCentroid,
} from './geometry.mjs';
import { nestPatternPieces } from './nesting.mjs';

export const MM_TO_PT = 72 / 25.4;

const MAX_PIECE_QUANTITY = 10000;
const MAX_PDF_TILES = 3000;
const MAX_PDF_GRID_DIM = 500;

const isFinitePt2 = (pt) =>
  pt !== null &&
  typeof pt === 'object' &&
  !Array.isArray(pt) &&
  Number.isFinite(pt.x) &&
  Number.isFinite(pt.y);

export const PAGE_FORMATS = Object.freeze({
  LETTER: Object.freeze({
    id: 'LETTER',
    name: 'US Letter (8.5" x 11")',
    widthMm: 215.9,
    heightMm: 279.4,
  }),
  A4: Object.freeze({
    id: 'A4',
    name: 'ISO A4 (210 x 297 mm)',
    widthMm: 210,
    heightMm: 297,
  }),
  A0: Object.freeze({
    id: 'A0',
    name: 'ISO A0 Plotter (841 x 1189 mm)',
    widthMm: 841,
    heightMm: 1189,
  }),
  '36x24_MAT': Object.freeze({
    id: '36x24_MAT',
    name: '36" x 24" Cutting Mat (914.4 x 609.6 mm)',
    widthMm: 914.4,
    heightMm: 609.6,
  }),
  TABLOID: Object.freeze({
    id: 'TABLOID',
    name: 'US Tabloid (11" x 17")',
    widthMm: 279.4,
    heightMm: 431.8,
  }),
});

export const PDF_PAGE_FORMATS = PAGE_FORMATS;

function finiteOr(val, fallback) {
  if (
    val === null ||
    val === undefined ||
    typeof val === 'boolean' ||
    typeof val === 'symbol' ||
    typeof val === 'bigint' ||
    typeof val === 'object' ||
    (typeof val === 'string' && val.trim() === '')
  ) {
    return fallback;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function resolvePieceId(piece, idx) {
  if (typeof piece?.id === 'string' && piece.id.length > 0) return piece.id;
  if (piece?.id !== undefined && piece?.id !== null && typeof piece.id !== 'symbol') {
    const s = String(piece.id);
    if (s.length > 0) return s;
  }
  return `piece_${idx + 1}`;
}

function resolvePieceName(piece, idx) {
  if (typeof piece?.name === 'string' && piece.name.length > 0) return piece.name;
  if (piece?.name !== undefined && piece?.name !== null && typeof piece.name !== 'symbol') {
    const s = String(piece.name);
    if (s.length > 0) return s;
  }
  if (typeof piece?.id === 'string' && piece.id.length > 0) return piece.id;
  if (piece?.id !== undefined && piece?.id !== null && typeof piece.id !== 'symbol') {
    const s = String(piece.id);
    if (s.length > 0) return s;
  }
  return `Piece ${idx + 1}`;
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

function fmtNum(v, decimals = 4) {
  const n = finiteOr(v, 0);
  const s = n.toFixed(decimals);
  return s === '-0.0000' || s === '-0.000' || s === '-0.00' ? (0).toFixed(decimals) : s;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeDxfText(str) {
  return String(str ?? '')
    .replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ')
    .trim();
}

function encodePdfWinAnsiLiteral(str) {
  let s = String(str ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\u2116/g, 'No.')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00D7/g, 'x')
    .trim();

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x5c || code === 0x28 || code === 0x29) {
      out += '\\' + s[i];
    } else if (code >= 0x20 && code <= 0x7e) {
      out += s[i];
    } else if (code >= 0xa0 && code <= 0xff) {
      out += '\\' + code.toString(8).padStart(3, '0');
    } else if (code > 0xff) {
      // Attempt NFD decomposition to salvage base Latin characters
      const base = s[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (base.length > 0 && base.charCodeAt(0) >= 0x20 && base.charCodeAt(0) <= 0x7e) {
        for (const ch of base) {
          const c = ch.charCodeAt(0);
          if (c === 0x5c || c === 0x28 || c === 0x29) out += '\\' + ch;
          else if (c >= 0x20 && c <= 0x7e) out += ch;
          else out += '?';
        }
      } else {
        out += '?';
      }
    }
  }
  return out;
}

function estimateAdaptiveCurveSegments(piece, maxErrMm = 0.01) {
  const pts = Array.isArray(piece?.points) ? piece.points : [];
  const edges = Array.isArray(piece?.edges) ? piece.edges : [];
  const n = pts.length;
  let maxSegs = 48;
  for (let i = 0; i < n; i++) {
    const curve = edges[i]?.curve;
    if (!curve) continue;
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    if (!p0 || !p1) continue;
    let dMax = 0;
    if (curve.cp1 && curve.cp2) {
      const d1 = Math.hypot(
        p0.x - 2 * curve.cp1.x + curve.cp2.x,
        p0.y - 2 * curve.cp1.y + curve.cp2.y
      );
      const d2 = Math.hypot(
        curve.cp1.x - 2 * curve.cp2.x + p1.x,
        curve.cp1.y - 2 * curve.cp2.y + p1.y
      );
      dMax = Math.max(d1, d2);
    } else if (curve.cp) {
      dMax =
        (2 / 3) *
        Math.hypot(p0.x - 2 * curve.cp.x + p1.x, p0.y - 2 * curve.cp.y + p1.y);
    }
    if (dMax > 1e-6) {
      const segs = Math.ceil(Math.sqrt((0.75 * dMax) / maxErrMm));
      if (segs > maxSegs) maxSegs = segs;
    }
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 200) {
      maxSegs = Math.max(maxSegs, 64);
    }
  }
  return Math.min(256, Math.max(48, maxSegs));
}

function hasSparseHoles(arr) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr)) return true;
  }
  return false;
}

function validateMmPieceWithTypes(piece, pIdx) {
  const n = piece.points.length;
  let checkEdges;
  if (piece.edges === undefined) {
    checkEdges = piece.points.map((_, i) => ({ name: `Edge ${i + 1}` }));
  } else if (
    Array.isArray(piece.edges) &&
    piece.edges.length === n &&
    !hasSparseHoles(piece.edges)
  ) {
    // Preserve Test 15 compatibility (m4_server_e2e.test.mjs:2872, server.mjs:1082):
    // dense null/undefined edge slots act as default straight edges, while non-object entries reject.
    checkEdges = piece.edges.map((e) => (e === null || e === undefined ? {} : e));
  } else {
    checkEdges = piece.edges;
  }

  const checkPiece = {
    ...piece,
    id:
      typeof piece.id === 'string' && piece.id.trim().length > 0
        ? piece.id
        : `piece_${pIdx + 1}`,
    quantity: typeof piece.quantity === 'symbol' ? 1 : piece.quantity,
    edges: checkEdges,
  };
  validatePatternPiece(checkPiece, `pieces[${pIdx}]`, { throwOnError: true });
}

function normalizePatternInput(pattern) {
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern) || !Array.isArray(pattern.pieces)) {
    throw new ValidationError('Exporter expects a pattern object with a pieces array', {
      code: 'INVALID_PATTERN',
      path: 'pattern',
    });
  }
  if (hasSparseHoles(pattern.pieces)) {
    throw new ValidationError('Pattern pieces array must not contain sparse holes', {
      code: 'INVALID_PIECE',
      path: 'pieces',
    });
  }
  for (let i = 0; i < pattern.pieces.length; i++) {
    const piece = pattern.pieces[i];
    if (!piece || typeof piece !== 'object' || Array.isArray(piece)) continue;
    if (hasSparseHoles(piece.points)) {
      throw new ValidationError(`Piece points must not contain sparse holes at pieces[${i}].points`, {
        code: 'INVALID_POINTS',
        path: `pieces[${i}].points`,
      });
    }
    if (hasSparseHoles(piece.edges)) {
      throw new ValidationError(`Piece edges must not contain sparse holes at pieces[${i}].edges`, {
        code: 'INVALID_EDGES',
        path: `pieces[${i}].edges`,
      });
    }
    if (hasSparseHoles(piece.notches)) {
      throw new ValidationError(`Piece notches must not contain sparse holes at pieces[${i}].notches`, {
        code: 'INVALID_NOTCH',
        path: `pieces[${i}].notches`,
      });
    }
    if (hasSparseHoles(piece.darts)) {
      throw new ValidationError(`Piece darts must not contain sparse holes at pieces[${i}].darts`, {
        code: 'INVALID_DART',
        path: `pieces[${i}].darts`,
      });
    }
    if (hasSparseHoles(piece.internalLines)) {
      throw new ValidationError(`Piece internalLines must not contain sparse holes at pieces[${i}].internalLines`, {
        code: 'INVALID_INTERNAL_LINE',
        path: `pieces[${i}].internalLines`,
      });
    }
    if (Array.isArray(piece.internalLines)) {
      for (let j = 0; j < piece.internalLines.length; j++) {
        const il = piece.internalLines[j];
        if (il && typeof il === 'object' && hasSparseHoles(il.points)) {
          throw new ValidationError(
            `Internal line points must not contain sparse holes at pieces[${i}].internalLines[${j}].points`,
            {
              code: 'INVALID_INTERNAL_LINE',
              path: `pieces[${i}].internalLines[${j}].points`,
            }
          );
        }
      }
    }
  }
  if (pattern.unit !== undefined && pattern.unit !== 'mm') {
    if (!isValidUnit(pattern.unit)) {
      throw new ValidationError(`Unsupported pattern unit "${String(pattern.unit)}"`, {
        code: 'INVALID_UNIT',
        path: 'pattern.unit',
      });
    }
    const normalized = normalizePatternProject(pattern, { allowEmpty: true });
    normalized.pieces = normalized.pieces.map((p, idx) => ({
      ...p,
      grainLock: parseBoolFlag(pattern.pieces[idx]?.grainLock),
    }));
    return normalized;
  }
  return pattern;
}

function pieceHasDarts(piece) {
  return (
    Array.isArray(piece.darts) &&
    piece.darts.some((d) => d && typeof d === 'object' && finiteOr(d.widthMm, 0) > 0 && finiteOr(d.depthMm, 0) > 0)
  );
}

function pieceHasAnySeamAllowance(piece) {
  const defaultSa =
    piece.seamAllowance !== undefined && piece.seamAllowance !== null
      ? finiteOr(piece.seamAllowance, 10)
      : 10;
  const edges = Array.isArray(piece.edges) ? piece.edges : [];
  if (edges.length === 0) return defaultSa > 1e-6;
  for (let i = 0; i < piece.points.length; i++) {
    const edgeSa = edges[i]?.seamAllowance;
    const eff = edgeSa !== undefined && edgeSa !== null ? finiteOr(edgeSa, defaultSa) : defaultSa;
    if (eff > 1e-6) return true;
  }
  return false;
}

function extractNativeNetSegments(piece) {
  if (pieceHasDarts(piece)) return null;
  const pts = piece.points;
  const n = pts.length;
  if (n < 3) return null;
  const edges = Array.isArray(piece.edges) ? piece.edges : [];
  const wPts = transformPiecePoints(pts, piece);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const to = wPts[(i + 1) % n];
    const curve = edges[i]?.curve;
    if (curve && curve.cp1 && curve.cp2) {
      const [wCp1, wCp2] = transformPiecePoints([curve.cp1, curve.cp2], piece);
      segs.push({ type: 'C', cp1: wCp1, cp2: wCp2, to });
    } else if (curve && curve.cp) {
      const [wCp] = transformPiecePoints([curve.cp], piece);
      segs.push({ type: 'Q', cp: wCp, to });
    } else {
      segs.push({ type: 'L', to });
    }
  }
  return { start: wPts[0], segs };
}

function mapNativeSegments(nativePath, fn) {
  if (!nativePath) return null;
  return {
    start: fn(nativePath.start),
    segs: nativePath.segs.map((s) => {
      if (s.type === 'C') return { type: 'C', cp1: fn(s.cp1), cp2: fn(s.cp2), to: fn(s.to) };
      if (s.type === 'Q') return { type: 'Q', cp: fn(s.cp), to: fn(s.to) };
      return { type: 'L', to: fn(s.to) };
    }),
  };
}

function deduplicateClosedRing(pts, eps = 1e-5) {
  if (!Array.isArray(pts) || pts.length === 0) return [];
  const out = [];
  for (const p of pts) {
    if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > eps) {
      out.push(p);
    }
  }
  if (out.length >= 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) {
    out.pop();
  }
  return out;
}

function buildPieceGeometryEntry(piece, pIdx, mapper, copySuffix = '', copyMeta = {}) {
  const segs = estimateAdaptiveCurveSegments(piece, 0.01);
  const netRaw = samplePieceOutline(piece, segs, { worldSpace: true });
  const cutRaw = computePieceCutBoundary(piece, segs, { worldSpace: true });
  const notchesRaw = computePieceNotches(piece, { worldSpace: true });
  const grainRaw = computePieceGrainline(piece, { worldSpace: true });
  const nativeNetRaw = extractNativeNetSegments(piece);

  const netPoints = deduplicateClosedRing(netRaw.map(mapper));
  const cutPoints = deduplicateClosedRing(cutRaw.map(mapper));
  const nativeNet = mapNativeSegments(nativeNetRaw, mapper);
  const hasSeamAllowance = pieceHasAnySeamAllowance(piece);
  const cutEqualsNet = !hasSeamAllowance && nativeNet !== null;

  const notches = notchesRaw.map((nt) => ({
    ...nt,
    position: mapper(nt.position),
    lines: nt.lines.map(([a, b]) => [mapper(a), mapper(b)]),
  }));

  const grainline = {
    start: mapper(grainRaw.start),
    end: mapper(grainRaw.end),
    angleDeg: grainRaw.angleDeg,
  };

  const internalLines = (Array.isArray(piece.internalLines) ? piece.internalLines : [])
    .filter((il) => il && Array.isArray(il.points) && il.points.length >= 2)
    .map((il) => ({
      ...il,
      points: transformPiecePoints(il.points, piece).map(mapper),
    }));

  const cutBounds = polygonBounds(cutPoints);
  const netBounds = polygonBounds(netPoints);
  const renderPts = [...cutPoints, ...netPoints];
  for (const nt of notches) {
    for (const [a, b] of nt.lines) {
      renderPts.push(a, b);
    }
  }
  if (grainline?.start) renderPts.push(grainline.start);
  if (grainline?.end) renderPts.push(grainline.end);
  for (const il of internalLines) {
    for (const pt of il.points) {
      renderPts.push(pt);
    }
  }
  const renderBounds = polygonBounds(renderPts);
  const center = polygonCentroid(netPoints);

  let validatedQty = 1;
  if (piece.quantity !== undefined && typeof piece.quantity !== 'symbol') {
    const qNum = typeof piece.quantity === 'number' ? piece.quantity : NaN;
    if (!Number.isFinite(qNum) || !Number.isInteger(qNum) || qNum < 1 || qNum > MAX_PIECE_QUANTITY) {
      throw new ValidationError(
        `Piece quantity must be an integer between 1 and ${MAX_PIECE_QUANTITY} at pieces[${pIdx}].quantity`,
        {
          code: 'INVALID_PIECE',
          path: `pieces[${pIdx}].quantity`,
        }
      );
    }
    validatedQty = qNum;
  }

  return {
    id: resolvePieceId(piece, pIdx) + copySuffix,
    name: resolvePieceName(piece, pIdx),
    role: piece.role || 'custom',
    onFold: parseBoolFlag(piece.onFold),
    quantity: validatedQty,
    hasSeamAllowance,
    cutEqualsNet,
    cutPoints,
    netPoints,
    nativeNet,
    notches,
    grainline,
    internalLines,
    cutBounds,
    netBounds,
    renderBounds,
    center,
    ...copyMeta,
  };
}

function prepareExportGeometry(pattern, options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const needsTypesPieceCheck = !pattern?.unit || pattern.unit === 'mm';
  const normPattern = normalizePatternInput(pattern);
  const originX = finiteOr(safeOptions.originX, 15);
  const originY = finiteOr(safeOptions.originY, 15);
  const padRight = finiteOr(safeOptions.padRight, originX);
  const padBottom = finiteOr(safeOptions.padBottom, 15);
  const emptyWidthMm = originX + padRight;
  const emptyHeightMm = originY + padBottom;
  if (
    !Number.isFinite(originX) ||
    !Number.isFinite(originY) ||
    !Number.isFinite(padRight) ||
    !Number.isFinite(padBottom) ||
    !Number.isFinite(emptyWidthMm) ||
    !Number.isFinite(emptyHeightMm) ||
    emptyWidthMm > 1e15 ||
    emptyHeightMm > 1e15
  ) {
    throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
      code: 'EXPORT_TOO_LARGE',
      path: 'options',
    });
  }

  if (normPattern.pieces.length === 0) {
    return {
      pattern: normPattern,
      pieces: [],
      contentMinX: originX,
      contentMinY: originY,
      contentMaxX: originX,
      contentMaxY: originY,
      totalWidthMm: emptyWidthMm,
      totalHeightMm: emptyHeightMm,
    };
  }

  for (let pIdx = 0; pIdx < normPattern.pieces.length; pIdx++) {
    const piece = normPattern.pieces[pIdx];
    if (!piece || typeof piece !== 'object' || Array.isArray(piece) || !Array.isArray(piece.points)) {
      throw new ValidationError(`Piece at index ${pIdx} must be an object with a points array`, {
        code: 'INVALID_PIECE',
        path: `pieces[${pIdx}]`,
      });
    }
    if (piece.points.length < 3) {
      throw new ValidationError(`Piece at index ${pIdx} must have >= 3 points`, {
        code: 'INVALID_PIECE',
        path: `pieces[${pIdx}].points`,
      });
    }
    for (let ptIdx = 0; ptIdx < piece.points.length; ptIdx++) {
      if (!(ptIdx in piece.points) || !isFinitePt2(piece.points[ptIdx])) {
        throw new ValidationError(`Piece points must be finite {x, y} objects at pieces[${pIdx}].points`, {
          code: 'INVALID_PIECE',
          path: `pieces[${pIdx}].points[${ptIdx}]`,
        });
      }
    }
    if (needsTypesPieceCheck) {
      validateMmPieceWithTypes(piece, pIdx);
    }
  }

  const rawEntries = [];

  if (safeOptions.layout === 'nested' || (safeOptions.nestingResult !== undefined && safeOptions.nestingResult !== null)) {
    if (safeOptions.nestingResult !== undefined && safeOptions.nestingResult !== null) {
      if (typeof safeOptions.nestingResult !== 'object' || Array.isArray(safeOptions.nestingResult)) {
        throw new ValidationError('Invalid options.nestingResult: expected an object', {
          code: 'INVALID_OPTIONS',
          path: 'options.nestingResult',
        });
      }
      if (
        safeOptions.nestingResult.placements !== undefined &&
        !Array.isArray(safeOptions.nestingResult.placements)
      ) {
        throw new ValidationError('Invalid options.nestingResult.placements: expected an array', {
          code: 'INVALID_OPTIONS',
          path: 'options.nestingResult.placements',
        });
      }
    }
    let nestOptions = safeOptions;
    if (
      safeOptions.nestingOptions &&
      typeof safeOptions.nestingOptions === 'object' &&
      !Array.isArray(safeOptions.nestingOptions)
    ) {
      const definedNestingOptions = Object.fromEntries(
        Object.entries(safeOptions.nestingOptions).filter(([, v]) => v !== undefined)
      );
      nestOptions = { ...safeOptions, ...definedNestingOptions };
    }
    const nestResult =
      safeOptions.nestingResult ||
      nestPatternPieces(normPattern, nestOptions);
    const pieceMap = new Map();
    normPattern.pieces.forEach((p, i) => {
      const key = resolvePieceId(p, i);
      if (!pieceMap.has(key)) pieceMap.set(key, { piece: p, idx: i });
    });

    const placements = Array.isArray(nestResult.placements) ? nestResult.placements : [];
    const sheetLengthMm = finiteOr(nestResult.sheetLengthMm, 0);
    for (let plIdx = 0; plIdx < placements.length; plIdx++) {
      const pl = placements[plIdx];
      if (!(plIdx in placements) || !pl || typeof pl !== 'object' || Array.isArray(pl)) {
        throw new ValidationError(`Invalid placement entry at nestingResult.placements[${plIdx}]`, {
          code: 'INVALID_OPTIONS',
          path: `options.nestingResult.placements[${plIdx}]`,
        });
      }
      let found = null;
      if (
        Number.isInteger(pl.pieceIndex) &&
        pl.pieceIndex >= 0 &&
        pl.pieceIndex < normPattern.pieces.length
      ) {
        const candidate = normPattern.pieces[pl.pieceIndex];
        if (!pl.pieceId || resolvePieceId(candidate, pl.pieceIndex) === pl.pieceId) {
          found = { piece: candidate, idx: pl.pieceIndex };
        }
      }
      if (!found && typeof pl.pieceId === 'string') {
        found = pieceMap.get(pl.pieceId) || null;
      }
      if (!found) continue;
      const { piece, idx } = found;
      const segs = estimateAdaptiveCurveSegments(piece, 0.01);
      const localCutWorld = computePieceCutBoundary(piece, segs, { worldSpace: true });
      const lb = polygonBounds(localCutWorld);
      const plX = finiteOr(pl.x, 0);
      const plY = finiteOr(pl.y, 0);
      const sheetIdx = finiteOr(pl.sheetIndex, 0);
      if (
        (typeof pl.x === 'number' && !Number.isFinite(pl.x)) ||
        (typeof pl.y === 'number' && !Number.isFinite(pl.y)) ||
        (typeof pl.sheetIndex === 'number' && !Number.isFinite(pl.sheetIndex)) ||
        (typeof nestResult.sheetLengthMm === 'number' && !Number.isFinite(nestResult.sheetLengthMm)) ||
        Math.abs(plX) > 1e15 ||
        Math.abs(plY) > 1e15
      ) {
        throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
          code: 'EXPORT_TOO_LARGE',
          path: 'options.nestingResult',
        });
      }
      const copyIdx = finiteOr(pl.copyIndex, 0);
      const rotated90 = parseBoolFlag(pl.rotated90);
      const sheetOffsetY =
        sheetIdx > 0 && sheetLengthMm > 0
          ? sheetIdx * (sheetLengthMm + 20)
          : 0;
      if (!Number.isFinite(sheetOffsetY) || Math.abs(sheetOffsetY) > 1e15) {
        throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
          code: 'EXPORT_TOO_LARGE',
          path: 'options.nestingResult',
        });
      }

      const mapper = (pt) => {
        const lx = pt.x - lb.minX;
        const ly = pt.y - lb.minY;
        const out = rotated90
          ? {
              x: plX + (lb.height - ly),
              y: sheetOffsetY + plY + lx,
            }
          : {
              x: plX + lx,
              y: sheetOffsetY + plY + ly,
            };
        if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) {
          throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
            code: 'EXPORT_TOO_LARGE',
            path: 'pieces',
          });
        }
        return out;
      };

      const suffix = copyIdx > 0 ? `__copy${copyIdx}` : '';
      rawEntries.push(buildPieceGeometryEntry(piece, idx, mapper, suffix, { rotated90 }));
    }
  } else {
    normPattern.pieces.forEach((piece, idx) => {
      rawEntries.push(buildPieceGeometryEntry(piece, idx, (pt) => ({ x: pt.x, y: pt.y })));
    });
  }

  if (rawEntries.length === 0) {
    return {
      pattern: normPattern,
      pieces: [],
      contentMinX: originX,
      contentMinY: originY,
      contentMaxX: originX,
      contentMaxY: originY,
      totalWidthMm: originX + padRight,
      totalHeightMm: originY + padBottom,
    };
  }

  let rawMinX = Infinity;
  let rawMinY = Infinity;
  let rawMaxX = -Infinity;
  let rawMaxY = -Infinity;

  const includePt = (pt) => {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
        code: 'EXPORT_TOO_LARGE',
        path: 'pieces',
      });
    }
    if (pt.x < rawMinX) rawMinX = pt.x;
    if (pt.y < rawMinY) rawMinY = pt.y;
    if (pt.x > rawMaxX) rawMaxX = pt.x;
    if (pt.y > rawMaxY) rawMaxY = pt.y;
  };

  for (const entry of rawEntries) {
    for (const pt of entry.cutPoints) includePt(pt);
    for (const pt of entry.netPoints) includePt(pt);
    if (entry.nativeNet) {
      includePt(entry.nativeNet.start);
      for (const seg of entry.nativeNet.segs) {
        includePt(seg.to);
        if (seg.cp) includePt(seg.cp);
        if (seg.cp1) includePt(seg.cp1);
        if (seg.cp2) includePt(seg.cp2);
      }
    }
    for (const nt of entry.notches) {
      includePt(nt.position);
      for (const [a, b] of nt.lines) {
        includePt(a);
        includePt(b);
      }
    }
    if (entry.grainline) {
      includePt(entry.grainline.start);
      includePt(entry.grainline.end);
    }
    for (const il of entry.internalLines) {
      for (const pt of il.points) {
        includePt(pt);
      }
    }
  }

  if (
    !Number.isFinite(rawMinX) ||
    !Number.isFinite(rawMinY) ||
    !Number.isFinite(rawMaxX) ||
    !Number.isFinite(rawMaxY)
  ) {
    throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
      code: 'EXPORT_TOO_LARGE',
      path: 'pieces',
    });
  }

  const shiftX = originX - rawMinX;
  const shiftY = originY - rawMinY;
  const contentW = rawMaxX - rawMinX;
  const contentH = rawMaxY - rawMinY;
  const totalWidthMm = originX + contentW + padRight;
  const totalHeightMm = originY + contentH + padBottom;
  if (
    !Number.isFinite(shiftX) ||
    !Number.isFinite(shiftY) ||
    !Number.isFinite(contentW) ||
    !Number.isFinite(contentH) ||
    !Number.isFinite(totalWidthMm) ||
    !Number.isFinite(totalHeightMm) ||
    Math.abs(rawMinX) > 1e15 ||
    Math.abs(rawMaxX) > 1e15 ||
    Math.abs(rawMinY) > 1e15 ||
    Math.abs(rawMaxY) > 1e15 ||
    totalWidthMm > 1e15 ||
    totalHeightMm > 1e15
  ) {
    throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
      code: 'EXPORT_TOO_LARGE',
      path: 'pieces',
    });
  }
  const shiftFn = (pt) => {
    const x = pt.x + shiftX;
    const y = pt.y + shiftY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ValidationError('Export geometry bounds exceed maximum finite dimensions.', {
        code: 'EXPORT_TOO_LARGE',
        path: 'pieces',
      });
    }
    return { x, y };
  };

  const pieces = rawEntries.map((e) => {
    const cutPoints = e.cutPoints.map(shiftFn);
    const netPoints = e.netPoints.map(shiftFn);
    const nativeNet = mapNativeSegments(e.nativeNet, shiftFn);
    const notches = e.notches.map((nt) => ({
      ...nt,
      position: shiftFn(nt.position),
      lines: nt.lines.map(([a, b]) => [shiftFn(a), shiftFn(b)]),
    }));
    const grainline = {
      start: shiftFn(e.grainline.start),
      end: shiftFn(e.grainline.end),
      angleDeg: e.grainline.angleDeg,
    };
    const internalLines = e.internalLines.map((il) => ({
      ...il,
      points: il.points.map(shiftFn),
    }));
    const cutBounds = polygonBounds(cutPoints);
    const netBounds = polygonBounds(netPoints);
    const renderPts = [...cutPoints, ...netPoints];
    for (const nt of notches) {
      for (const [a, b] of nt.lines) {
        renderPts.push(a, b);
      }
    }
    if (grainline?.start) renderPts.push(grainline.start);
    if (grainline?.end) renderPts.push(grainline.end);
    for (const il of internalLines) {
      for (const pt of il.points) {
        renderPts.push(pt);
      }
    }
    const renderBounds = polygonBounds(renderPts);
    const center = polygonCentroid(netPoints);

    return {
      ...e,
      cutPoints,
      netPoints,
      nativeNet,
      notches,
      grainline,
      internalLines,
      cutBounds,
      netBounds,
      renderBounds,
      center,
    };
  });

  return {
    pattern: normPattern,
    pieces,
    contentMinX: originX,
    contentMinY: originY,
    contentMaxX: originX + contentW,
    contentMaxY: originY + contentH,
    totalWidthMm,
    totalHeightMm,
  };
}

function svgNativePathD(nativePath) {
  const parts = [`M ${fmtNum(nativePath.start.x)} ${fmtNum(nativePath.start.y)}`];
  for (const s of nativePath.segs) {
    if (s.type === 'C') {
      parts.push(
        `C ${fmtNum(s.cp1.x)} ${fmtNum(s.cp1.y)} ${fmtNum(s.cp2.x)} ${fmtNum(s.cp2.y)} ${fmtNum(s.to.x)} ${fmtNum(s.to.y)}`
      );
    } else if (s.type === 'Q') {
      parts.push(`Q ${fmtNum(s.cp.x)} ${fmtNum(s.cp.y)} ${fmtNum(s.to.x)} ${fmtNum(s.to.y)}`);
    } else {
      parts.push(`L ${fmtNum(s.to.x)} ${fmtNum(s.to.y)}`);
    }
  }
  parts.push('Z');
  return parts.join(' ');
}

function svgPolyPathD(pts, closed = true) {
  if (!pts || pts.length === 0) return '';
  const parts = [`M ${fmtNum(pts[0].x)} ${fmtNum(pts[0].y)}`];
  for (let i = 1; i < pts.length; i++) {
    parts.push(`L ${fmtNum(pts[i].x)} ${fmtNum(pts[i].y)}`);
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

function grainArrowheads(grainline, wingLen = 5.0) {
  const dx = grainline.end.x - grainline.start.x;
  const dy = grainline.end.y - grainline.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return [];
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const w = Math.min(wingLen, len * 0.25);
  const hw = w * 0.55;
  const segs = [];
  // Arrow at end
  segs.push([
    grainline.end,
    { x: grainline.end.x - ux * w + px * hw, y: grainline.end.y - uy * w + py * hw },
  ]);
  segs.push([
    grainline.end,
    { x: grainline.end.x - ux * w - px * hw, y: grainline.end.y - uy * w - py * hw },
  ]);
  // Arrow at start
  segs.push([
    grainline.start,
    { x: grainline.start.x + ux * w + px * hw, y: grainline.start.y + uy * w + py * hw },
  ]);
  segs.push([
    grainline.start,
    { x: grainline.start.x + ux * w - px * hw, y: grainline.start.y + uy * w - py * hw },
  ]);
  return segs;
}

// ============================================================================
// F22: True-Scale 1:1 SVG Exporter
// ============================================================================

export function exportSVG(pattern, options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const marginMm = Math.max(0, finiteOr(safeOptions.marginMm, 15));
  const calBandH = 66;
  const prep = prepareExportGeometry(pattern, {
    ...safeOptions,
    originX: marginMm,
    originY: marginMm + calBandH,
    padRight: marginMm,
    padBottom: marginMm,
  });

  const minCalWidth = marginMm + 120 + marginMm;
  const totalW = Math.max(minCalWidth, prep.totalWidthMm);
  const totalH = prep.pieces.length > 0 ? prep.totalHeightMm : marginMm + calBandH + marginMm;
  if (!Number.isFinite(totalW) || !Number.isFinite(totalH) || totalW > 1e15 || totalH > 1e15) {
    throw new ValidationError(`SVG export dimensions exceed maximum safe bounds (${totalW} x ${totalH} mm)`, {
      code: 'EXPORT_TOO_LARGE',
      path: 'marginMm',
    });
  }

  const cal50X = marginMm;
  const cal50Y = marginMm;
  const cal2InX = marginMm + 60;
  const cal2InY = marginMm;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(totalW)}mm" height="${fmtNum(totalH)}mm" viewBox="0 0 ${fmtNum(totalW)} ${fmtNum(totalH)}" data-scale="1:1" data-units="mm" data-project="${escapeXml(prep.pattern.name || 'Pattern')}">`
  );
  lines.push(`  <title>${escapeXml(prep.pattern.name || 'Pattern Project')} — 1:1 Scale (mm)</title>`);

  // Calibration layer
  lines.push('  <g id="calibration-square" stroke="#0f172a" stroke-width="0.35" fill="none">');
  lines.push(
    `    <rect x="${fmtNum(cal50X)}" y="${fmtNum(cal50Y)}" width="50.0000" height="50.0000" />`
  );
  lines.push(
    `    <rect x="${fmtNum(cal2InX)}" y="${fmtNum(cal2InY)}" width="50.8000" height="50.8000" stroke="#475569" />`
  );
  lines.push(
    `    <text x="${fmtNum(cal50X + 2)}" y="${fmtNum(cal50Y + 56)}" font-family="sans-serif" font-size="3.6" fill="#0f172a" stroke="none">50.0 x 50.0 mm</text>`
  );
  lines.push(
    `    <text x="${fmtNum(cal2InX + 2)}" y="${fmtNum(cal2InY + 56)}" font-family="sans-serif" font-size="3.6" fill="#475569" stroke="none">2.00 x 2.00 in (50.8 mm)</text>`
  );
  lines.push('  </g>');

  const usedSvgIds = new Set([
    'calibration-square',
    'cut-lines',
    'seam-lines',
    'notches',
    'grainlines',
    'internal-lines',
    'labels',
  ]);
  const pieceSvgIds = prep.pieces.map((p) => {
    const rawId = p.id !== undefined && p.id !== null && String(p.id) !== '' ? String(p.id) : 'piece';
    const base = rawId.replace(/[^A-Za-z0-9._-]/g, '_') || 'piece';
    let candidate = base;
    let suffixNum = 2;
    while (usedSvgIds.has(`cut-${candidate}`) || usedSvgIds.has(`seam-${candidate}`)) {
      candidate = `${base}-${suffixNum++}`;
    }
    usedSvgIds.add(`cut-${candidate}`);
    usedSvgIds.add(`seam-${candidate}`);
    return candidate;
  });

  // Cut lines layer
  lines.push('  <g id="cut-lines" stroke="#111827" stroke-width="0.45" fill="none">');
  prep.pieces.forEach((p, idx) => {
    const d = p.cutEqualsNet ? svgNativePathD(p.nativeNet) : svgPolyPathD(p.cutPoints, true);
    lines.push(`    <path id="cut-${pieceSvgIds[idx]}" d="${d}" />`);
  });
  lines.push('  </g>');

  // Seam lines layer
  lines.push('  <g id="seam-lines" stroke="#2563eb" stroke-width="0.35" stroke-dasharray="3,2" fill="none">');
  prep.pieces.forEach((p, idx) => {
    const d = p.nativeNet ? svgNativePathD(p.nativeNet) : svgPolyPathD(p.netPoints, true);
    lines.push(`    <path id="seam-${pieceSvgIds[idx]}" d="${d}" />`);
  });
  lines.push('  </g>');

  // Notches layer
  lines.push('  <g id="notches" stroke="#dc2626" stroke-width="0.35" fill="none">');
  for (const p of prep.pieces) {
    for (const nt of p.notches) {
      for (const [a, b] of nt.lines) {
        lines.push(
          `    <line x1="${fmtNum(a.x)}" y1="${fmtNum(a.y)}" x2="${fmtNum(b.x)}" y2="${fmtNum(b.y)}" />`
        );
      }
    }
  }
  lines.push('  </g>');

  // Grainlines layer
  lines.push('  <g id="grainlines" stroke="#059669" stroke-width="0.35" fill="none">');
  for (const p of prep.pieces) {
    lines.push(
      `    <line x1="${fmtNum(p.grainline.start.x)}" y1="${fmtNum(p.grainline.start.y)}" x2="${fmtNum(p.grainline.end.x)}" y2="${fmtNum(p.grainline.end.y)}" />`
    );
    for (const [a, b] of grainArrowheads(p.grainline)) {
      lines.push(
        `    <line x1="${fmtNum(a.x)}" y1="${fmtNum(a.y)}" x2="${fmtNum(b.x)}" y2="${fmtNum(b.y)}" />`
      );
    }
  }
  lines.push('  </g>');

  // Internal lines layer
  lines.push('  <g id="internal-lines" stroke="#7c3aed" stroke-width="0.35" stroke-dasharray="4,2" fill="none">');
  for (const p of prep.pieces) {
    for (const il of p.internalLines) {
      lines.push(`    <path d="${svgPolyPathD(il.points, false)}" />`);
    }
  }
  lines.push('  </g>');

  // Labels layer
  lines.push('  <g id="labels" font-family="sans-serif" fill="#0f172a">');
  for (const p of prep.pieces) {
    const foldTag = p.onFold ? ' [CUT ON FOLD]' : '';
    const qtyTag = p.quantity > 1 ? ` (Qty ${p.quantity})` : '';
    const labelText = `${p.name}${foldTag}${qtyTag}`;
    lines.push(
      `    <text x="${fmtNum(p.center.x)}" y="${fmtNum(p.center.y)}" font-size="4.5" text-anchor="middle">${escapeXml(labelText)}</text>`
    );
  }
  lines.push('  </g>');

  lines.push('</svg>');
  return lines.join('\n');
}

// ============================================================================
// F23: Multi-Page Tiled PDF 1.4 Exporter (Pure JS, Byte-Exact xref)
// ============================================================================

function resolvePageFormatKey(fmtKey) {
  if (typeof fmtKey !== 'string') return null;
  const trimmed = fmtKey.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  return Object.keys(PAGE_FORMATS).find((k) => k.toUpperCase() === upper) || null;
}

function resolvePageFormat(options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const fmtKey = safeOptions.pageFormat ?? safeOptions.format ?? 'LETTER';
  const canonicalKey = resolvePageFormatKey(fmtKey);
  const base = canonicalKey ? PAGE_FORMATS[canonicalKey] : null;
  let widthMm = finiteOr(safeOptions.pageWidthMm ?? safeOptions.widthMm, base?.widthMm ?? PAGE_FORMATS.LETTER.widthMm);
  let heightMm = finiteOr(safeOptions.pageHeightMm ?? safeOptions.heightMm, base?.heightMm ?? PAGE_FORMATS.LETTER.heightMm);
  if (widthMm <= 20) widthMm = PAGE_FORMATS.LETTER.widthMm;
  if (heightMm <= 20) heightMm = PAGE_FORMATS.LETTER.heightMm;
  if (safeOptions.orientation === 'landscape' && heightMm > widthMm) {
    [widthMm, heightMm] = [heightMm, widthMm];
  }
  return {
    id: base?.id ?? (typeof fmtKey === 'string' ? fmtKey : 'CUSTOM'),
    widthMm,
    heightMm,
  };
}

function colIndexToLetters(colIdx) {
  let n = colIdx + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function exportTiledPDF(pattern, options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const pageSpec = resolvePageFormat(safeOptions);
  const pageW = pageSpec.widthMm;
  const pageH = pageSpec.heightMm;
  if (!Number.isFinite(pageW) || !Number.isFinite(pageH) || pageW > 1e15 || pageH > 1e15) {
    throw new ValidationError(`PDF page dimensions exceed maximum safe bounds (${pageW} x ${pageH} mm)`, {
      code: 'EXPORT_TOO_LARGE',
      path: 'pageFormat',
    });
  }
  const marginMm = Math.max(0, Math.min(pageW * 0.25, pageH * 0.25, finiteOr(safeOptions.marginMm, 10)));
  const printableW = Math.max(10, pageW - 2 * marginMm);
  const printableH = Math.max(10, pageH - 2 * marginMm);
  const overlapMm = Math.max(0, Math.min(printableW * 0.45, printableH * 0.45, finiteOr(safeOptions.overlapMm, 15)));

  const stepX = Math.max(1, printableW - overlapMm);
  const stepY = Math.max(1, printableH - overlapMm);

  const contentPad = 4;
  // Strip PDF page-size/format options so they do not collide with roll width/preset in prepareExportGeometry -> nestPatternPieces.
  // Explicit options.nestingOptions (e.g. nestingOptions.widthMm) is preserved and merged inside prepareExportGeometry.
  const {
    widthMm: _pageWidthMm,
    heightMm: _pageHeightMm,
    format: _pageFormat,
    pageWidthMm: _explicitPageWidthMm,
    pageHeightMm: _explicitPageHeightMm,
    pageFormat: _explicitPageFormat,
    ...exportOptions
  } = safeOptions;
  const prep = prepareExportGeometry(pattern, {
    ...exportOptions,
    originX: contentPad,
    originY: contentPad,
    padRight: contentPad,
    padBottom: contentPad,
  });

  const contentW = prep.pieces.length > 0 ? prep.totalWidthMm : 0;
  const contentH = prep.pieces.length > 0 ? prep.totalHeightMm : 0;

  const cols =
    contentW <= printableW + 1e-6
      ? 1
      : 1 + Math.ceil((contentW - printableW - 1e-6) / stepX);
  const rows =
    contentH <= printableH + 1e-6
      ? 1
      : 1 + Math.ceil((contentH - printableH - 1e-6) / stepY);

  if (
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    cols > MAX_PDF_GRID_DIM ||
    rows > MAX_PDF_GRID_DIM ||
    cols * rows > MAX_PDF_TILES
  ) {
    throw new ValidationError(
      `PDF export exceeds maximum tile limit (${cols}x${rows} = ${cols * rows} pages, max ${MAX_PDF_TILES}).`,
      {
        code: 'EXPORT_TOO_LARGE',
        path: 'options',
      }
    );
  }

  const includeAssemblyMap = parseBoolFlag(safeOptions.includeAssemblyMap);
  const skipBlankTiles = parseBoolFlag(safeOptions.skipBlankTiles);

  const pageWPt = pageW * MM_TO_PT;
  const pageHPt = pageH * MM_TO_PT;
  const marginPt = marginMm * MM_TO_PT;
  const printableWPt = printableW * MM_TO_PT;
  const printableHPt = printableH * MM_TO_PT;

  const pageAbsToPdfPt = (pxMm, pyMm) => [
    pxMm * MM_TO_PT,
    (pageH - pyMm) * MM_TO_PT,
  ];

  // Pre-evaluate which tiles contain at least one pattern piece
  const tileActive = Array.from({ length: rows }, () => new Array(cols).fill(false));
  let activeTileCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!skipBlankTiles) {
        tileActive[r][c] = true;
        activeTileCount++;
        continue;
      }
      const tOx = c * stepX;
      const tOy = r * stepY;
      const wMinX = tOx - 2;
      const wMaxX = tOx + printableW + 2;
      const wMinY = tOy - 2;
      const wMaxY = tOy + printableH + 2;
      let hit = false;
      for (const p of prep.pieces) {
        const b = p.renderBounds || p.cutBounds;
        if (!(b.maxX < wMinX || b.minX > wMaxX || b.maxY < wMinY || b.minY > wMaxY)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        tileActive[r][c] = true;
        activeTileCount++;
      }
    }
  }
  if (activeTileCount === 0) {
    tileActive[0][0] = true;
    activeTileCount = 1;
  }
  const skippedTileCount = rows * cols - activeTileCount;

  const pageStreams = [];
  const willEmitAssemblyMap = Boolean(includeAssemblyMap && activeTileCount + 1 <= MAX_PDF_TILES);

  if (willEmitAssemblyMap) {
    const mapOps = [];
    // Frame
    mapOps.push('q');
    mapOps.push('0.70 0.70 0.70 RG 0.50 w [] 0 d');
    mapOps.push(`${fmtNum(marginPt)} ${fmtNum(marginPt)} ${fmtNum(printableWPt)} ${fmtNum(printableHPt)} re S`);
    mapOps.push('Q');

    // Header & Summary
    const [hdrX, hdrY] = pageAbsToPdfPt(marginMm + 6, marginMm + 7);
    const mapTitle = `TILE ASSEMBLY MAP - ${prep.pattern.name || 'Pattern'} (${pageSpec.id} 1:1 - Print at 100% Actual Size)`;
    mapOps.push('BT');
    mapOps.push('/F1 9.0 Tf 0.08 0.10 0.15 rg');
    mapOps.push(`1 0 0 1 ${fmtNum(hdrX)} ${fmtNum(hdrY)} Tm`);
    mapOps.push(`(${encodePdfWinAnsiLiteral(mapTitle)}) Tj`);
    mapOps.push('ET');

    const [subX, subY] = pageAbsToPdfPt(marginMm + 6, marginMm + 13);
    const skipNote = skippedTileCount > 0 ? ` (${skippedTileCount} blank skipped)` : '';
    const subTitle = `Grid: ${cols} cols x ${rows} rows | Pattern Tiles: ${activeTileCount}${skipNote} | Overlap: ${overlapMm.toFixed(1)} mm | Page 1 = Overview + Scale Test`;
    mapOps.push('BT');
    mapOps.push('/F1 6.8 Tf 0.32 0.36 0.44 rg');
    mapOps.push(`1 0 0 1 ${fmtNum(subX)} ${fmtNum(subY)} Tm`);
    mapOps.push(`(${encodePdfWinAnsiLiteral(subTitle)}) Tj`);
    mapOps.push('ET');

    const hasMapCalBox = printableW >= 118 && printableH >= 135;
    const mapTopMm = marginMm + 18;
    const mapBottomReserveMm = hasMapCalBox ? 62 : 8;
    const availMapW = Math.max(20, printableW - 14);
    const availMapH = Math.max(24, printableH - 18 - mapBottomReserveMm);
    const gridSpanW = Math.max(1, (cols - 1) * stepX + printableW);
    const gridSpanH = Math.max(1, (rows - 1) * stepY + printableH);
    const mScale = Math.min(availMapW / gridSpanW, availMapH / gridSpanH);
    const drawW = gridSpanW * mScale;
    const drawH = gridSpanH * mScale;
    const mapOx = marginMm + (printableW - drawW) * 0.5;
    const mapOy = mapTopMm + (availMapH - drawH) * 0.5;

    const mapToPdfPt = (wxMm, wyMm) =>
      pageAbsToPdfPt(mapOx + wxMm * mScale, mapOy + wyMm * mScale);

    // Draw tile cells on assembly map
    let nextPdfPageNo = 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellX0 = c * stepX;
        const cellY0 = r * stepY;
        const cellW = c < cols - 1 ? stepX : printableW;
        const cellH = r < rows - 1 ? stepY : printableH;
        const [rxPt, ryBottomPt] = mapToPdfPt(cellX0, cellY0 + cellH);
        const rwPt = cellW * mScale * MM_TO_PT;
        const rhPt = cellH * mScale * MM_TO_PT;
        const code = `${colIndexToLetters(c)}${r + 1}`;

        if (tileActive[r][c]) {
          const pNo = nextPdfPageNo++;
          mapOps.push('q');
          mapOps.push('0.95 0.97 1.00 rg 0.55 0.63 0.75 RG 0.45 w [] 0 d');
          mapOps.push(`${fmtNum(rxPt)} ${fmtNum(ryBottomPt)} ${fmtNum(rwPt)} ${fmtNum(rhPt)} re B`);
          mapOps.push('Q');
          if (rwPt >= 18 && rhPt >= 11) {
            const [tx, ty] = mapToPdfPt(cellX0 + 2.5 / mScale, cellY0 + 4.2 / mScale);
            const cellLbl = rwPt >= 38 ? `${code} (p.${pNo})` : code;
            mapOps.push('BT');
            mapOps.push('/F1 5.8 Tf 0.18 0.24 0.34 rg');
            mapOps.push(`1 0 0 1 ${fmtNum(tx)} ${fmtNum(ty)} Tm`);
            mapOps.push(`(${encodePdfWinAnsiLiteral(cellLbl)}) Tj`);
            mapOps.push('ET');
          }
        } else {
          mapOps.push('q');
          mapOps.push('0.80 0.83 0.88 RG 0.35 w [2 2] 0 d');
          mapOps.push(`${fmtNum(rxPt)} ${fmtNum(ryBottomPt)} ${fmtNum(rwPt)} ${fmtNum(rhPt)} re S`);
          mapOps.push('Q');
          if (rwPt >= 26 && rhPt >= 11) {
            const [tx, ty] = mapToPdfPt(cellX0 + 2.5 / mScale, cellY0 + 4.2 / mScale);
            mapOps.push('BT');
            mapOps.push('/F1 5.2 Tf 0.62 0.66 0.72 rg');
            mapOps.push(`1 0 0 1 ${fmtNum(tx)} ${fmtNum(ty)} Tm`);
            mapOps.push(`(${encodePdfWinAnsiLiteral(`${code} skip`)}) Tj`);
            mapOps.push('ET');
          }
        }
      }
    }

    // Draw scaled pattern piece silhouettes across the tile grid
    for (const p of prep.pieces) {
      const pts = p.cutPoints && p.cutPoints.length >= 3 ? p.cutPoints : p.netPoints;
      if (!pts || pts.length < 3) continue;
      const stride = Math.max(1, Math.ceil(pts.length / 96));
      mapOps.push('q');
      mapOps.push('0.12 0.35 0.78 RG 0.80 w [] 0 d');
      const [s0x, s0y] = mapToPdfPt(pts[0].x, pts[0].y);
      mapOps.push(`${fmtNum(s0x)} ${fmtNum(s0y)} m`);
      for (let i = stride; i < pts.length; i += stride) {
        const [px, py] = mapToPdfPt(pts[i].x, pts[i].y);
        mapOps.push(`${fmtNum(px)} ${fmtNum(py)} l`);
      }
      mapOps.push('h S');
      mapOps.push('Q');

      if (p.center) {
        const [cxPt, cyPt] = mapToPdfPt(p.center.x, p.center.y);
        mapOps.push('BT');
        mapOps.push('/F1 6.0 Tf 0.08 0.14 0.28 rg');
        mapOps.push(`1 0 0 1 ${fmtNum(cxPt - 14)} ${fmtNum(cyPt)} Tm`);
        mapOps.push(`(${encodePdfWinAnsiLiteral(String(p.name || '').slice(0, 26))}) Tj`);
        mapOps.push('ET');
      }
    }

    // Full 1:1 calibration squares on Page 1 Overview so users can test-print Page 1 alone!
    if (hasMapCalBox) {
      const cal50X = pageW - marginMm - 55;
      const cal50Y = pageH - marginMm - 54;
      const [c50xPt, c50yBottomPt] = pageAbsToPdfPt(cal50X, cal50Y + 50.0);
      const c50Pt = 50.0 * MM_TO_PT;
      mapOps.push('q');
      mapOps.push('0.05 0.05 0.05 RG 0.65 w [] 0 d');
      mapOps.push(`${fmtNum(c50xPt)} ${fmtNum(c50yBottomPt)} ${fmtNum(c50Pt)} ${fmtNum(c50Pt)} re S`);
      mapOps.push('Q');
      const [t50x, t50y] = pageAbsToPdfPt(cal50X + 2, cal50Y + 26);
      mapOps.push('BT /F1 6.2 Tf 0.05 0.05 0.05 rg');
      mapOps.push(`1 0 0 1 ${fmtNum(t50x)} ${fmtNum(t50y)} Tm (CALIBRATION 50.0 x 50.0 mm) Tj ET`);

      const cal2X = cal50X - 56;
      const cal2Y = pageH - marginMm - 54.8;
      const [c2xPt, c2yBottomPt] = pageAbsToPdfPt(cal2X, cal2Y + 50.8);
      const c2Pt = 50.8 * MM_TO_PT;
      mapOps.push('q');
      mapOps.push('0.35 0.35 0.35 RG 0.50 w [] 0 d');
      mapOps.push(`${fmtNum(c2xPt)} ${fmtNum(c2yBottomPt)} ${fmtNum(c2Pt)} ${fmtNum(c2Pt)} re S`);
      mapOps.push('Q');
      const [t2x, t2y] = pageAbsToPdfPt(cal2X + 2, cal2Y + 26);
      mapOps.push('BT /F1 6.2 Tf 0.35 0.35 0.35 rg');
      mapOps.push(`1 0 0 1 ${fmtNum(t2x)} ${fmtNum(t2y)} Tm (2.00 x 2.00 in / 50.8 mm) Tj ET`);
    }

    pageStreams.push(mapOps.join('\n'));
  }

  let tileCalDrawn = false;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!tileActive[row][col]) continue;
      const tileOriginX = col * stepX;
      const tileOriginY = row * stepY;

      const toPdfPt = (xMm, yMm) => [
        (xMm - tileOriginX + marginMm) * MM_TO_PT,
        (pageH - (yMm - tileOriginY + marginMm)) * MM_TO_PT,
      ];

      const ops = [];

      // 1. Tile margin border frame (recognized as tile border by verify_exports)
      ops.push('q');
      ops.push('0.70 0.70 0.70 RG 0.50 w [] 0 d');
      ops.push(`${fmtNum(marginPt)} ${fmtNum(marginPt)} ${fmtNum(printableWPt)} ${fmtNum(printableHPt)} re S`);
      ops.push('Q');

      // 2. Corner registration diamonds (6x6mm) & crosshairs at the 4 printable corners
      const corners = [
        [marginMm, marginMm],
        [pageW - marginMm, marginMm],
        [marginMm, pageH - marginMm],
        [pageW - marginMm, pageH - marginMm],
      ];
      ops.push('q');
      ops.push('0.20 0.20 0.20 RG 0.45 w [] 0 d');
      const diaR = 3.0;
      for (const [cx, cy] of corners) {
        const [xT, yT] = pageAbsToPdfPt(cx, cy - diaR);
        const [xR, yR] = pageAbsToPdfPt(cx + diaR, cy);
        const [xB, yB] = pageAbsToPdfPt(cx, cy + diaR);
        const [xL, yL] = pageAbsToPdfPt(cx - diaR, cy);
        ops.push(
          `${fmtNum(xT)} ${fmtNum(yT)} m ${fmtNum(xR)} ${fmtNum(yR)} l ${fmtNum(xB)} ${fmtNum(yB)} l ${fmtNum(xL)} ${fmtNum(yL)} l h S`
        );
      }
      ops.push('Q');

      // 3. Tile grid label
      const tileTag = `R${row + 1}C${col + 1} (${colIndexToLetters(col)}${row + 1})`;
      const headerLabel = `${tileTag} | ${prep.pattern.name || 'Pattern'} | ${pageSpec.id} 1:1`;
      const [lblX, lblY] = pageAbsToPdfPt(marginMm + 5, marginMm + 4.5);
      ops.push('BT');
      ops.push('/F1 7.5 Tf 0.25 0.25 0.25 rg');
      ops.push(`1 0 0 1 ${fmtNum(lblX)} ${fmtNum(lblY)} Tm`);
      ops.push(`(${encodePdfWinAnsiLiteral(headerLabel)}) Tj`);
      ops.push('ET');

      // 4. First emitted tile measurable calibration squares (outside piece clip, inside printable frame)
      if (!tileCalDrawn) {
        tileCalDrawn = true;
        if (printableW >= 54 && printableH >= 54) {
          const calSize = 50.0;
          const cal50X = Math.max(marginMm + 2, pageW - marginMm - 55);
          const cal50Y = Math.max(marginMm + 2, pageH - marginMm - 55);
          const [c50xPt, c50yBottomPt] = pageAbsToPdfPt(cal50X, cal50Y + calSize);
          const c50SizePt = calSize * MM_TO_PT;

          ops.push('q');
          ops.push('0.05 0.05 0.05 RG 0.65 w [] 0 d');
          ops.push(`${fmtNum(c50xPt)} ${fmtNum(c50yBottomPt)} ${fmtNum(c50SizePt)} ${fmtNum(c50SizePt)} re S`);
          ops.push('Q');

          const [calTxtX, calTxtY] = pageAbsToPdfPt(cal50X + 2, cal50Y + 26);
          ops.push('BT');
          ops.push('/F1 6.5 Tf 0.05 0.05 0.05 rg');
          ops.push(`1 0 0 1 ${fmtNum(calTxtX)} ${fmtNum(calTxtY)} Tm`);
          ops.push('(CALIBRATION 50.0 x 50.0 mm) Tj');
          ops.push('ET');

          if (printableW >= 115 && printableH >= 60) {
            const cal2Size = 50.8;
            const cal2X = Math.max(marginMm + 2, cal50X - 56);
            const cal2Y = Math.max(marginMm + 2, pageH - marginMm - 55.8);
            const [c2xPt, c2yBottomPt] = pageAbsToPdfPt(cal2X, cal2Y + cal2Size);
            const c2SizePt = cal2Size * MM_TO_PT;

            ops.push('q');
            ops.push('0.35 0.35 0.35 RG 0.50 w [] 0 d');
            ops.push(`${fmtNum(c2xPt)} ${fmtNum(c2yBottomPt)} ${fmtNum(c2SizePt)} ${fmtNum(c2SizePt)} re S`);
            ops.push('Q');

            const [c2TxtX, c2TxtY] = pageAbsToPdfPt(cal2X + 2, cal2Y + 26);
            ops.push('BT');
            ops.push('/F1 6.5 Tf 0.35 0.35 0.35 rg');
            ops.push(`1 0 0 1 ${fmtNum(c2TxtX)} ${fmtNum(c2TxtY)} Tm`);
            ops.push('(2.00 x 2.00 in / 50.8 mm) Tj');
            ops.push('ET');
          }
        } else if (printableW >= 24 && printableH >= 24) {
          const calSize = 20.0;
          const calX = Math.max(marginMm + 2, pageW - marginMm - (calSize + 2));
          const calY = Math.max(marginMm + 2, pageH - marginMm - (calSize + 2));
          const [cxPt, cyBottomPt] = pageAbsToPdfPt(calX, calY + calSize);
          const cSizePt = calSize * MM_TO_PT;

          ops.push('q');
          ops.push('0.05 0.05 0.05 RG 0.65 w [] 0 d');
          ops.push(`${fmtNum(cxPt)} ${fmtNum(cyBottomPt)} ${fmtNum(cSizePt)} ${fmtNum(cSizePt)} re S`);
          ops.push('Q');

          const [calTxtX, calTxtY] = pageAbsToPdfPt(calX + 1.5, calY + 11);
          ops.push('BT');
          ops.push('/F1 4.5 Tf 0.05 0.05 0.05 rg');
          ops.push(`1 0 0 1 ${fmtNum(calTxtX)} ${fmtNum(calTxtY)} Tm`);
          ops.push('(20.0 x 20.0 mm) Tj');
          ops.push('ET');
        } else if (printableW >= 14 && printableH >= 14) {
          const calSize = 10.0;
          const calX = Math.max(marginMm + 2, pageW - marginMm - (calSize + 2));
          const calY = Math.max(marginMm + 2, pageH - marginMm - (calSize + 2));
          const [cxPt, cyBottomPt] = pageAbsToPdfPt(calX, calY + calSize);
          const cSizePt = calSize * MM_TO_PT;

          ops.push('q');
          ops.push('0.05 0.05 0.05 RG 0.65 w [] 0 d');
          ops.push(`${fmtNum(cxPt)} ${fmtNum(cyBottomPt)} ${fmtNum(cSizePt)} ${fmtNum(cSizePt)} re S`);
          ops.push('Q');

          const [calTxtX, calTxtY] = pageAbsToPdfPt(calX + 1.0, calY + 6);
          ops.push('BT');
          ops.push('/F1 3.5 Tf 0.05 0.05 0.05 rg');
          ops.push(`1 0 0 1 ${fmtNum(calTxtX)} ${fmtNum(calTxtY)} Tm`);
          ops.push('(10mm) Tj');
          ops.push('ET');
        }
      }

      // 5. Clipped printable viewport containing pattern pieces intersecting this tile
      ops.push('q');
      ops.push(`${fmtNum(marginPt)} ${fmtNum(marginPt)} ${fmtNum(printableWPt)} ${fmtNum(printableHPt)} re W n`);

      const winMinX = tileOriginX - 2;
      const winMaxX = tileOriginX + printableW + 2;
      const winMinY = tileOriginY - 2;
      const winMaxY = tileOriginY + printableH + 2;

      for (const p of prep.pieces) {
        const b = p.renderBounds || p.cutBounds;
        if (b.maxX < winMinX || b.minX > winMaxX || b.maxY < winMinY || b.minY > winMaxY) {
          continue;
        }

        // Cut boundary (solid dark stroke)
        if (p.cutPoints.length >= 3) {
          ops.push('0.07 0.09 0.15 RG 0.85 w [] 0 d');
          if (p.cutEqualsNet && p.nativeNet) {
            const [sx, sy] = toPdfPt(p.nativeNet.start.x, p.nativeNet.start.y);
            ops.push(`${fmtNum(sx)} ${fmtNum(sy)} m`);
            let cur = p.nativeNet.start;
            for (const s of p.nativeNet.segs) {
              if (s.type === 'C') {
                const [x1, y1] = toPdfPt(s.cp1.x, s.cp1.y);
                const [x2, y2] = toPdfPt(s.cp2.x, s.cp2.y);
                const [x3, y3] = toPdfPt(s.to.x, s.to.y);
                ops.push(`${fmtNum(x1)} ${fmtNum(y1)} ${fmtNum(x2)} ${fmtNum(y2)} ${fmtNum(x3)} ${fmtNum(y3)} c`);
              } else if (s.type === 'Q') {
                // Degree elevate quadratic (cur, cp, to) -> cubic
                const c1 = { x: cur.x + (2 / 3) * (s.cp.x - cur.x), y: cur.y + (2 / 3) * (s.cp.y - cur.y) };
                const c2 = { x: s.to.x + (2 / 3) * (s.cp.x - s.to.x), y: s.to.y + (2 / 3) * (s.cp.y - s.to.y) };
                const [x1, y1] = toPdfPt(c1.x, c1.y);
                const [x2, y2] = toPdfPt(c2.x, c2.y);
                const [x3, y3] = toPdfPt(s.to.x, s.to.y);
                ops.push(`${fmtNum(x1)} ${fmtNum(y1)} ${fmtNum(x2)} ${fmtNum(y2)} ${fmtNum(x3)} ${fmtNum(y3)} c`);
              } else {
                const [lx, ly] = toPdfPt(s.to.x, s.to.y);
                ops.push(`${fmtNum(lx)} ${fmtNum(ly)} l`);
              }
              cur = s.to;
            }
            ops.push('h S');
          } else {
            const [sx, sy] = toPdfPt(p.cutPoints[0].x, p.cutPoints[0].y);
            ops.push(`${fmtNum(sx)} ${fmtNum(sy)} m`);
            for (let i = 1; i < p.cutPoints.length; i++) {
              const [px, py] = toPdfPt(p.cutPoints[i].x, p.cutPoints[i].y);
              ops.push(`${fmtNum(px)} ${fmtNum(py)} l`);
            }
            ops.push('h S');
          }
        }

        // Net seam line (dashed blue, emitted when SA > 0)
        if (p.hasSeamAllowance && p.netPoints.length >= 3) {
          ops.push('0.15 0.39 0.92 RG 0.65 w [4 3] 0 d');
          if (p.nativeNet) {
            const [sx, sy] = toPdfPt(p.nativeNet.start.x, p.nativeNet.start.y);
            ops.push(`${fmtNum(sx)} ${fmtNum(sy)} m`);
            let cur = p.nativeNet.start;
            for (const s of p.nativeNet.segs) {
              if (s.type === 'C') {
                const [x1, y1] = toPdfPt(s.cp1.x, s.cp1.y);
                const [x2, y2] = toPdfPt(s.cp2.x, s.cp2.y);
                const [x3, y3] = toPdfPt(s.to.x, s.to.y);
                ops.push(`${fmtNum(x1)} ${fmtNum(y1)} ${fmtNum(x2)} ${fmtNum(y2)} ${fmtNum(x3)} ${fmtNum(y3)} c`);
              } else if (s.type === 'Q') {
                const c1 = { x: cur.x + (2 / 3) * (s.cp.x - cur.x), y: cur.y + (2 / 3) * (s.cp.y - cur.y) };
                const c2 = { x: s.to.x + (2 / 3) * (s.cp.x - s.to.x), y: s.to.y + (2 / 3) * (s.cp.y - s.to.y) };
                const [x1, y1] = toPdfPt(c1.x, c1.y);
                const [x2, y2] = toPdfPt(c2.x, c2.y);
                const [x3, y3] = toPdfPt(s.to.x, s.to.y);
                ops.push(`${fmtNum(x1)} ${fmtNum(y1)} ${fmtNum(x2)} ${fmtNum(y2)} ${fmtNum(x3)} ${fmtNum(y3)} c`);
              } else {
                const [lx, ly] = toPdfPt(s.to.x, s.to.y);
                ops.push(`${fmtNum(lx)} ${fmtNum(ly)} l`);
              }
              cur = s.to;
            }
            ops.push('h S');
          } else {
            const [sx, sy] = toPdfPt(p.netPoints[0].x, p.netPoints[0].y);
            ops.push(`${fmtNum(sx)} ${fmtNum(sy)} m`);
            for (let i = 1; i < p.netPoints.length; i++) {
              const [px, py] = toPdfPt(p.netPoints[i].x, p.netPoints[i].y);
              ops.push(`${fmtNum(px)} ${fmtNum(py)} l`);
            }
            ops.push('h S');
          }
        }

        // Notches (solid red, <= 6mm)
        if (p.notches.length > 0) {
          ops.push('0.86 0.15 0.15 RG 0.65 w [] 0 d');
          for (const nt of p.notches) {
            for (const [a, b] of nt.lines) {
              const [ax, ay] = toPdfPt(a.x, a.y);
              const [bx, by] = toPdfPt(b.x, b.y);
              ops.push(`${fmtNum(ax)} ${fmtNum(ay)} m ${fmtNum(bx)} ${fmtNum(by)} l S`);
            }
          }
        }

        // Grainline (solid emerald + <= 5mm arrowheads)
        {
          ops.push('0.02 0.59 0.41 RG 0.60 w [] 0 d');
          const [gx0, gy0] = toPdfPt(p.grainline.start.x, p.grainline.start.y);
          const [gx1, gy1] = toPdfPt(p.grainline.end.x, p.grainline.end.y);
          ops.push(`${fmtNum(gx0)} ${fmtNum(gy0)} m ${fmtNum(gx1)} ${fmtNum(gy1)} l S`);
          for (const [a, b] of grainArrowheads(p.grainline, 5.0)) {
            const [ax, ay] = toPdfPt(a.x, a.y);
            const [bx, by] = toPdfPt(b.x, b.y);
            ops.push(`${fmtNum(ax)} ${fmtNum(ay)} m ${fmtNum(bx)} ${fmtNum(by)} l S`);
          }
        }

        // Internal lines (dashed purple open paths)
        if (p.internalLines.length > 0) {
          ops.push('0.49 0.23 0.93 RG 0.65 w [4 3] 0 d');
          for (const il of p.internalLines) {
            if (il.points.length < 2) continue;
            const [ix0, iy0] = toPdfPt(il.points[0].x, il.points[0].y);
            ops.push(`${fmtNum(ix0)} ${fmtNum(iy0)} m`);
            for (let k = 1; k < il.points.length; k++) {
              const [ix, iy] = toPdfPt(il.points[k].x, il.points[k].y);
              ops.push(`${fmtNum(ix)} ${fmtNum(iy)} l`);
            }
            ops.push('S');
          }
        }

        // Piece label
        const [cxPt, cyPt] = toPdfPt(p.center.x, p.center.y);
        const foldTag = p.onFold ? ' [FOLD]' : '';
        const qtyTag = p.quantity > 1 ? ` x${p.quantity}` : '';
        const lbl = `${p.name}${foldTag}${qtyTag}`;
        ops.push('BT');
        ops.push('/F1 8.5 Tf 0.06 0.09 0.16 rg');
        ops.push(`1 0 0 1 ${fmtNum(cxPt)} ${fmtNum(cyPt)} Tm`);
        ops.push(`(${encodePdfWinAnsiLiteral(lbl)}) Tj`);
        ops.push('ET');
      }

      ops.push('Q'); // end viewport clip
      pageStreams.push(ops.join('\n'));
    }
  }

  // Assemble PDF 1.4 objects with byte-exact xref offsets
  const objects = new Map();
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  let nextId = 4;

  const pageIds = [];
  for (const streamText of pageStreams) {
    const contentId = nextId++;
    const pageId = nextId++;
    const streamBuf = Buffer.from(streamText, 'ascii');
    objects.set(
      contentId,
      Buffer.concat([
        Buffer.from(`<< /Length ${streamBuf.length} >>\nstream\n`, 'ascii'),
        streamBuf,
        Buffer.from('\nendstream', 'ascii'),
      ])
    );
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmtNum(pageWPt, 3)} ${fmtNum(pageHPt, 3)}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
        'ascii'
      )
    );
    pageIds.push(pageId);
  }

  objects.set(
    catalogId,
    Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'ascii')
  );
  objects.set(
    pagesId,
    Buffer.from(
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
      'ascii'
    )
  );
  objects.set(
    fontId,
    Buffer.from(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      'ascii'
    )
  );

  const chunks = [];
  let bytePos = 0;
  const pushChunk = (buf) => {
    chunks.push(buf);
    bytePos += buf.length;
  };

  pushChunk(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const maxObjId = nextId - 1;
  const offsets = new Array(maxObjId + 1).fill(0);
  for (let id = 1; id <= maxObjId; id++) {
    offsets[id] = bytePos;
    pushChunk(Buffer.from(`${id} 0 obj\n`, 'ascii'));
    pushChunk(objects.get(id));
    pushChunk(Buffer.from('\nendobj\n', 'ascii'));
  }

  const xrefOffset = bytePos;
  const xrefLines = [`xref\n`, `0 ${maxObjId + 1}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id <= maxObjId; id++) {
    xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  pushChunk(Buffer.from(xrefLines.join(''), 'ascii'));
  pushChunk(
    Buffer.from(
      `trailer\n<< /Size ${maxObjId + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'ascii'
    )
  );

  const pdfBytes = Buffer.concat(chunks);
  const pdfString = pdfBytes.toString('latin1');

  return {
    pdfBytes,
    pdfString,
    pageCount: pageIds.length,
    tilePageCount: activeTileCount,
    skippedTileCount,
    hasAssemblyMap: willEmitAssemblyMap,
    rows,
    cols,
    pageFormat: pageSpec.id,
    pageWidthMm: pageW,
    pageHeightMm: pageH,
  };
}

// ============================================================================
// F24: True-Scale 1:1 CAD DXF Exporter (AC1015, $INSUNITS=4, TABLES/LAYER)
// ============================================================================

export function exportDXF(pattern, options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const marginMm = Math.max(0, finiteOr(safeOptions.marginMm, 15));
  const prep = prepareExportGeometry(pattern, {
    ...safeOptions,
    originX: marginMm + 65,
    originY: marginMm,
    padRight: marginMm,
    padBottom: marginMm,
  });

  const totalW = Math.max(marginMm + 65 + marginMm, prep.totalWidthMm);
  const totalH = Math.max(marginMm + 60 + marginMm, prep.totalHeightMm);
  if (!Number.isFinite(totalW) || !Number.isFinite(totalH) || totalW > 1e15 || totalH > 1e15) {
    throw new ValidationError(`DXF export dimensions exceed maximum safe bounds (${totalW} x ${totalH} mm)`, {
      code: 'EXPORT_TOO_LARGE',
      path: 'marginMm',
    });
  }

  const flipY = (y) => totalH - y;

  const lines = [];
  const pair = (code, value) => {
    lines.push(String(code), String(value));
  };

  // HEADER
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1015');
  pair(9, '$INSUNITS');
  pair(70, 4); // Millimeters
  pair(9, '$MEASUREMENT');
  pair(70, 1); // Metric
  pair(9, '$EXTMIN');
  pair(10, '0.0000');
  pair(20, '0.0000');
  pair(30, '0.0000');
  pair(9, '$EXTMAX');
  pair(10, fmtNum(totalW));
  pair(20, fmtNum(totalH));
  pair(30, '0.0000');
  pair(0, 'ENDSEC');

  // TABLES -> LAYER
  const layers = [
    { name: 'CUT', color: 7 },
    { name: 'SEAM', color: 5 },
    { name: 'NOTCH', color: 1 },
    { name: 'GRAINLINE', color: 3 },
    { name: 'INTERNAL', color: 6 },
    { name: 'TEXT', color: 2 },
    { name: 'CALIBRATION', color: 4 },
  ];

  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, layers.length);
  for (const lyr of layers) {
    pair(0, 'LAYER');
    pair(2, lyr.name);
    pair(70, 0);
    pair(62, lyr.color);
    pair(6, 'CONTINUOUS');
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  // ENTITIES
  const emitLwPolyline = (layer, pts, closed = true) => {
    const verts = closed ? deduplicateClosedRing(pts) : pts;
    if (verts.length < (closed ? 3 : 2)) return;
    pair(0, 'LWPOLYLINE');
    pair(8, layer);
    pair(90, verts.length);
    pair(70, closed ? 1 : 0);
    for (const pt of verts) {
      pair(10, fmtNum(pt.x));
      pair(20, fmtNum(flipY(pt.y)));
    }
  };

  const emitLine = (layer, a, b) => {
    pair(0, 'LINE');
    pair(8, layer);
    pair(10, fmtNum(a.x));
    pair(20, fmtNum(flipY(a.y)));
    pair(30, '0.0000');
    pair(11, fmtNum(b.x));
    pair(21, fmtNum(flipY(b.y)));
    pair(31, '0.0000');
  };

  const emitText = (layer, pt, height, text) => {
    const clean = sanitizeDxfText(text) || 'Piece';
    pair(0, 'TEXT');
    pair(8, layer);
    pair(10, fmtNum(pt.x));
    pair(20, fmtNum(flipY(pt.y)));
    pair(30, '0.0000');
    pair(40, fmtNum(height, 2));
    pair(1, clean);
  };

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  // Calibration 50x50mm square as closed LWPOLYLINE
  const calX = marginMm;
  const calY = marginMm;
  emitLwPolyline(
    'CALIBRATION',
    [
      { x: calX, y: calY },
      { x: calX + 50, y: calY },
      { x: calX + 50, y: calY + 50 },
      { x: calX, y: calY + 50 },
    ],
    true
  );
  emitText('TEXT', { x: calX, y: calY + 56 }, 4.0, 'CALIBRATION 50.0 x 50.0 mm');

  for (const p of prep.pieces) {
    emitLwPolyline('CUT', p.cutPoints, true);
    if (p.hasSeamAllowance) {
      emitLwPolyline('SEAM', p.netPoints, true);
    }
    for (const nt of p.notches) {
      for (const [a, b] of nt.lines) {
        emitLine('NOTCH', a, b);
      }
    }
    emitLine('GRAINLINE', p.grainline.start, p.grainline.end);
    for (const [a, b] of grainArrowheads(p.grainline, 5.0)) {
      emitLine('GRAINLINE', a, b);
    }
    for (const il of p.internalLines) {
      emitLwPolyline('INTERNAL', il.points, false);
    }
    const foldTag = p.onFold ? ' [FOLD]' : '';
    const qtyTag = p.quantity > 1 ? ` x${p.quantity}` : '';
    emitText('TEXT', p.center, 5.0, `${p.name}${foldTag}${qtyTag}`);
  }

  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return lines.join('\n') + '\n';
}

// ============================================================================
// JSON Round-Trip Serialization
// ============================================================================

export function exportPatternJSON(pattern) {
  if (!pattern || typeof pattern !== 'object' || !Array.isArray(pattern.pieces)) {
    throw new ValidationError('exportPatternJSON expects a pattern object with a pieces array', {
      code: 'INVALID_PATTERN',
      path: 'pattern',
    });
  }
  const out = {
    schemaVersion: SCHEMA_VERSION,
    ...pattern,
    unit: pattern.unit || 'mm',
  };
  return JSON.stringify(out, null, 2);
}

export function importPatternJSON(jsonInput) {
  let data = jsonInput;
  if (typeof jsonInput === 'string') {
    try {
      data = JSON.parse(jsonInput);
    } catch (err) {
      throw new ValidationError(`Invalid pattern JSON: ${err.message}`, {
        code: 'INVALID_JSON',
        path: 'json',
      });
    }
  }
  const normalized = normalizePatternProject(data, { allowEmpty: true });
  if (Array.isArray(data?.pieces)) {
    normalized.pieces = normalized.pieces.map((p, idx) =>
      data.pieces[idx] && 'grainLock' in data.pieces[idx]
        ? { ...p, grainLock: parseBoolFlag(data.pieces[idx].grainLock) }
        : p
    );
  }
  return normalized;
}
