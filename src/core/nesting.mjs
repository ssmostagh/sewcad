/**
 * Fabric Roll & Cutting Mat Nesting Engine + Yield BOM (F25).
 * Imports strictly from ./types.mjs and ./geometry.mjs.
 * All coordinates and dimensions operate in canonical millimeters (mm).
 */

import {
  ValidationError,
  isValidUnit,
  normalizePatternProject,
  validatePatternPiece,
} from './types.mjs';
import {
  computePieceCutBoundary,
  samplePieceOutline,
  polygonArea,
  polygonBounds,
  polygonPerimeter,
} from './geometry.mjs';

const MAX_PIECE_QUANTITY = 10000;
const SHEET_BLOCK_SIZE = 64;

function buildParetoFrontier(rects, maxLen = Infinity) {
  if (!rects.length) return [];
  const sorted = [...rects].sort((a, b) => b.w - a.w || b.h - a.h);
  const out = [];
  let maxH = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.h > maxH + 1e-9) {
      out.push(r);
      maxH = r.h;
    }
  }
  if (out.length <= maxLen) return out;
  const chunk = Math.ceil(out.length / maxLen);
  const coarse = [];
  for (let i = 0; i < out.length; i += chunk) {
    const end = Math.min(out.length - 1, i + chunk - 1);
    coarse.push({ w: out[i].w, h: out[end].h });
  }
  return coarse;
}

function paretoCanFit(pareto, w, h) {
  for (let i = 0; i < pareto.length; i++) {
    const r = pareto[i];
    if (r.w >= w - 1e-6 && r.h >= h - 1e-6) return true;
  }
  return false;
}

function paretoCanFitAnyOrient(pareto, orients) {
  for (let o = 0; o < orients.length; o++) {
    if (paretoCanFit(pareto, orients[o].w, orients[o].h)) return true;
  }
  return false;
}

function computeSkylinePareto(sky, minAbsX, sheetMaxX, sheetMaxY) {
  if (!Number.isFinite(sheetMaxY)) {
    return [{ w: Math.max(0, sheetMaxX - minAbsX), h: Infinity }];
  }
  const m = sky.length;
  const leftBound = new Array(m);
  const stack = [];
  for (let i = 0; i < m; i++) {
    while (stack.length > 0 && sky[stack[stack.length - 1]].y <= sky[i].y) {
      stack.pop();
    }
    leftBound[i] =
      stack.length > 0
        ? stack[stack.length - 1] + 1 < m
          ? sky[stack[stack.length - 1] + 1].x
          : sheetMaxX
        : minAbsX;
    stack.push(i);
  }
  const rects = [];
  stack.length = 0;
  for (let i = m - 1; i >= 0; i--) {
    while (stack.length > 0 && sky[stack[stack.length - 1]].y <= sky[i].y) {
      stack.pop();
    }
    const rightX = stack.length > 0 ? sky[stack[stack.length - 1]].x : sheetMaxX;
    stack.push(i);
    const w = rightX - leftBound[i];
    const h = sheetMaxY - sky[i].y;
    if (w > -1e-6 && h > -1e-6) {
      rects.push({ w: Math.max(0, w), h: Math.max(0, h) });
    }
  }
  return buildParetoFrontier(rects);
}

const isFinitePt2 = (pt) =>
  pt !== null &&
  typeof pt === 'object' &&
  !Array.isArray(pt) &&
  Number.isFinite(pt.x) &&
  Number.isFinite(pt.y);

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

export const FABRIC_ROLL_PRESETS = Object.freeze([
  Object.freeze({
    id: 'roll_45in',
    name: '45" Standard Apparel Roll (1143 mm)',
    widthMm: 1143,
    lengthMm: null,
  }),
  Object.freeze({
    id: 'roll_54in',
    name: '54" Upholstery / Canvas / Denim Roll (1371.6 mm)',
    widthMm: 1371.6,
    lengthMm: null,
  }),
  Object.freeze({
    id: 'roll_60in',
    name: '60" Wide Knit / Jersey / Fleece Roll (1524 mm)',
    widthMm: 1524,
    lengthMm: null,
  }),
  Object.freeze({
    id: 'cutting_mat_36x24',
    name: '36" x 24" Rotary Cutting Mat (914.4 x 609.6 mm)',
    widthMm: 914.4,
    lengthMm: 609.6,
  }),
  Object.freeze({
    id: 'a0',
    name: 'ISO A0 Sheet / Plotter (841 x 1189 mm)',
    widthMm: 841,
    lengthMm: 1189,
  }),
  Object.freeze({
    id: 'cricut_24x12',
    name: 'Cricut 24" x 12" Cutting Mat (609.6 x 304.8 mm)',
    widthMm: 609.6,
    lengthMm: 304.8,
  }),
]);

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

function dist2(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function estimateAdaptiveCurveSegments(piece, maxErrMm = 0.015) {
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
    const chord = dist2(p0, p1);
    if (chord > 200) maxSegs = Math.max(maxSegs, 64);
  }
  return Math.min(256, Math.max(48, maxSegs));
}

function resolveRollSpec(options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const presetKey = safeOptions.rollPreset ?? safeOptions.preset ?? safeOptions.rollId ?? null;
  let preset = null;
  if (typeof presetKey === 'string' && presetKey.trim().length > 0) {
    const keyLower = presetKey.trim().toLowerCase();
    preset =
      FABRIC_ROLL_PRESETS.find((r) => r.id.toLowerCase() === keyLower) ||
      FABRIC_ROLL_PRESETS.find((r) => r.name.toLowerCase() === keyLower) ||
      null;
  }

  const explicitWidth = safeOptions.fabricWidthMm ?? safeOptions.rollWidthMm ?? safeOptions.widthMm;
  const parsedWidth = finiteOr(explicitWidth, NaN);
  const hasExplicitFiniteWidth = Number.isFinite(parsedWidth);
  const fabricWidthMm = hasExplicitFiniteWidth
    ? parsedWidth
    : preset?.widthMm ?? 1371.6;

  const explicitLength = safeOptions.sheetLengthMm ?? safeOptions.rollLengthMm ?? safeOptions.lengthMm;
  const parsedLength = finiteOr(explicitLength, NaN);
  const paginateSheets =
    safeOptions.paginateSheets !== undefined ? parseBoolFlag(safeOptions.paginateSheets) : true;
  let sheetLengthMm = null;
  if (Number.isFinite(parsedLength)) {
    sheetLengthMm = parsedLength > 0 ? parsedLength : null;
  } else if (
    preset &&
    preset.lengthMm !== null &&
    paginateSheets &&
    !hasExplicitFiniteWidth
  ) {
    sheetLengthMm = preset.lengthMm;
  }

  const safePresetId =
    preset?.id ??
    (typeof presetKey === 'string' && presetKey.trim().length > 0
      ? presetKey.trim()
      : 'custom');

  return {
    presetId: safePresetId,
    fabricWidthMm: Math.max(0, fabricWidthMm),
    sheetLengthMm,
  };
}

function rotatePolygon90CW(localPts, origWidth, origHeight) {
  // Maps [0, origWidth] x [0, origHeight] -> [0, origHeight] x [0, origWidth]
  return localPts.map((pt) => ({
    x: origHeight - pt.y,
    y: pt.x,
  }));
}

function getOrientationDims(item, rotated90) {
  return rotated90
    ? { w: item.height, h: item.width, rotationDeg: 90, rotated90: true }
    : { w: item.width, h: item.height, rotationDeg: 0, rotated90: false };
}

function canFitUsable(w, h, usableW, usableH) {
  return Number.isFinite(w) && Number.isFinite(h) && w <= usableW + 1e-6 && h <= usableH + 1e-6;
}

const _f64Buf = new Float64Array(1);
const _u64Buf = new BigUint64Array(_f64Buf.buffer);

function nextUp(x) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return Number.MIN_VALUE;
  _f64Buf[0] = x;
  _u64Buf[0] = x > 0 ? _u64Buf[0] + 1n : _u64Buf[0] - 1n;
  return _f64Buf[0];
}

function addCeil(a, b) {
  if (!(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return a + b;
  let s = a + b;
  if (!Number.isFinite(s)) return s;
  const err = a >= b ? s - a - b : s - b - a;
  if (err < 0) s = nextUp(s);
  return s;
}

function advanceWithSpacing(cur, dim, spacing, effDim) {
  const pieceMax = dim > 0 ? addCeil(cur, dim) : cur;
  if (!(spacing > 0)) return pieceMax;
  let next = addCeil(pieceMax, spacing);
  if (Number.isFinite(effDim) && effDim > 0) {
    const viaEff = addCeil(cur, effDim);
    if (viaEff > next) next = viaEff;
  }
  while (Number.isFinite(next) && (next - pieceMax < spacing || (next - cur) - dim < spacing)) {
    const bumped = nextUp(next);
    if (!Number.isFinite(bumped) || !(bumped > next)) return Infinity;
    next = bumped;
  }
  return next;
}

function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  const e = (a - (s - bb)) + (b - bb);
  return { s, e };
}

function exactCompareSum(minB, minA, spanA) {
  if (!Number.isFinite(minB) || !Number.isFinite(minA) || !Number.isFinite(spanA)) {
    return NaN;
  }
  const rawSum = minA + spanA;
  if (!Number.isFinite(rawSum) || !Number.isFinite(minB - rawSum)) {
    return exactCompareSum(minB * 0.25, minA * 0.25, spanA * 0.25) * 4;
  }
  const { s: endS, e: endE } = twoSum(minA, spanA);
  if (minB === endS) return -endE;
  const { s: dS, e: dE } = twoSum(minB, -endS);
  const { s: rS, e: rE } = twoSum(dE, -endE);
  const { s: gS, e: gE } = twoSum(dS, rS);
  const { s: fS, e: fE } = twoSum(gS, rE);
  const tail = gE + fE;
  const finalS = fS + tail;
  if (finalS !== 0) return finalS;
  return fS !== 0 ? fS : tail;
}

/**
 * Shelf Best-Fit packer over 1 or more sheets in sheet-absolute coordinates
 * [marginMm, fabricWidthMm - marginMm] x [marginMm, sheetLengthMm - marginMm].
 */
function packShelf(
  orderedItems,
  orientSelector,
  usableW,
  usableH,
  spacingMm,
  marginMm = 0,
  fabricWidthMm = usableW + 2 * marginMm,
  sheetLengthMm = Number.isFinite(usableH) ? usableH + 2 * marginMm : null
) {
  const minAbsX = marginMm;
  const minAbsY = marginMm;
  const sheetMaxX = fabricWidthMm - marginMm;
  const sheetMaxY = sheetLengthMm !== null ? sheetLengthMm - marginMm : Infinity;
  if (!Number.isFinite(sheetMaxX)) return [];

  const canPlaceAt = (x, y, w, h) =>
    !(w > 0 && x + w <= x) &&
    !(h > 0 && y + h <= y);

  const resolved = [];
  for (let i = 0; i < orderedItems.length; i++) {
    const item = orderedItems[i];
    const chosen = orientSelector(item, usableW, usableH);
    if (!chosen) continue;
    const { w, h, rotated90, rotationDeg } = chosen;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return [];
    const effW = spacingMm > 0 ? addCeil(w, spacingMm) : w;
    const effH = spacingMm > 0 ? addCeil(h, spacingMm) : h;
    resolved.push({ item, w, h, rotated90, rotationDeg, effW, effH });
  }
  if (resolved.length === 0) return [];

  const suffixMinW = new Array(resolved.length);
  const suffixMinH = new Array(resolved.length);
  let curMinW = Infinity;
  let curMinH = Infinity;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i].w < curMinW) curMinW = resolved[i].w;
    if (resolved[i].h < curMinH) curMinH = resolved[i].h;
    suffixMinW[i] = curMinW;
    suffixMinH[i] = curMinH;
  }

  const sheets = []; // { shelves: [{ y, h, maxPieceY, nextY, nextX }], nextY, remH, maxShelfRemW, maxShelfH }
  const blocks = []; // { maxRemH, maxShelfRemW, maxShelfH }
  const placements = [];
  let firstActiveSheet = 0;

  const updateSheetSummary = (sheet) => {
    sheet.remH = Number.isFinite(sheetMaxY)
      ? Number.isFinite(sheet.nextY)
        ? sheetMaxY - sheet.nextY
        : -Infinity
      : Infinity;
    let maxRemW = -Infinity;
    let maxSH = 0;
    for (let i = 0; i < sheet.shelves.length; i++) {
      const sh = sheet.shelves[i];
      const rw = Number.isFinite(sh.nextX) ? sheetMaxX - sh.nextX : -Infinity;
      if (rw > maxRemW) maxRemW = rw;
      if (sh.h > maxSH) maxSH = sh.h;
    }
    sheet.maxShelfRemW = maxRemW;
    sheet.maxShelfH = maxSH;
  };

  const recomputeBlock = (bIdx) => {
    const start = bIdx * SHEET_BLOCK_SIZE;
    const end = Math.min(sheets.length, start + SHEET_BLOCK_SIZE);
    let maxRemH = -Infinity;
    let maxShelfRemW = -Infinity;
    let maxShelfH = 0;
    for (let i = start; i < end; i++) {
      const sh = sheets[i];
      if (sh.remH > maxRemH) maxRemH = sh.remH;
      if (sh.maxShelfRemW > maxShelfRemW) maxShelfRemW = sh.maxShelfRemW;
      if (sh.maxShelfH > maxShelfH) maxShelfH = sh.maxShelfH;
    }
    blocks[bIdx] = { maxRemH, maxShelfRemW, maxShelfH };
  };

  const canSheetFitDims = (remH, maxShelfRemW, maxShelfH, w, h) =>
    h <= remH + 1e-6 || (w <= maxShelfRemW + 1e-6 && h <= maxShelfH + 1e-6);

  for (let rIdx = 0; rIdx < resolved.length; rIdx++) {
    const { item, w, h, rotated90, rotationDeg, effW, effH } = resolved[rIdx];
    const minRemW = suffixMinW[rIdx];
    const minRemH = suffixMinH[rIdx];

    while (firstActiveSheet < sheets.length) {
      const sh0 = sheets[firstActiveSheet];
      if (canSheetFitDims(sh0.remH, sh0.maxShelfRemW, sh0.maxShelfH, minRemW, minRemH)) break;
      firstActiveSheet++;
    }

    let placed = false;
    const startBlock = firstActiveSheet >> 6;
    for (let bIdx = startBlock; bIdx < blocks.length && !placed; bIdx++) {
      const blk = blocks[bIdx];
      if (!canSheetFitDims(blk.maxRemH, blk.maxShelfRemW, blk.maxShelfH, w, h)) {
        continue;
      }
      const sStart = Math.max(firstActiveSheet, bIdx * SHEET_BLOCK_SIZE);
      const sEnd = Math.min(sheets.length, (bIdx + 1) * SHEET_BLOCK_SIZE);
      for (let sIdx = sStart; sIdx < sEnd; sIdx++) {
        const sheet = sheets[sIdx];
        if (!canSheetFitDims(sheet.remH, sheet.maxShelfRemW, sheet.maxShelfH, w, h)) {
          continue;
        }
        // Best-fit existing shelf on this sheet
        let bestShelf = null;
        let bestNextX = NaN;
        let bestRemW = Infinity;
        for (const shelf of sheet.shelves) {
          if (h > shelf.h) continue;
          const curX = shelf.nextX;
          if (!Number.isFinite(curX) || (w > 0 && curX >= sheetMaxX)) continue;
          if (!canPlaceAt(curX, shelf.y, w, h)) continue;
          const pieceMaxX = w > 0 ? addCeil(curX, w) : curX;
          const pieceMaxY = h > 0 ? addCeil(shelf.y, h) : shelf.y;
          if (
            !Number.isFinite(pieceMaxX) ||
            !Number.isFinite(pieceMaxY) ||
            (w > 0 && pieceMaxX <= curX) ||
            (h > 0 && pieceMaxY <= shelf.y) ||
            pieceMaxX > sheetMaxX + 1e-6 ||
            pieceMaxY > sheetMaxY + 1e-6 ||
            pieceMaxY > shelf.maxPieceY
          ) {
            continue;
          }
          const nextYCheck = advanceWithSpacing(shelf.y, h, spacingMm, effH);
          if (nextYCheck > shelf.nextY) continue;
          const nextX = advanceWithSpacing(curX, w, spacingMm, effW);
          const remW = sheetMaxX - pieceMaxX;
          if (Number.isFinite(remW) && remW < bestRemW) {
            bestRemW = remW;
            bestShelf = shelf;
            bestNextX = nextX;
          }
        }
        if (bestShelf) {
          placements.push({
            item,
            sheetIndex: sIdx,
            x: bestShelf.nextX,
            y: bestShelf.y,
            w,
            h,
            rotated90,
            rotationDeg,
          });
          bestShelf.nextX = bestNextX;
          updateSheetSummary(sheet);
          recomputeBlock(bIdx);
          placed = true;
          break;
        }

        // Try opening a new shelf on this sheet
        const curY = sheet.nextY;
        if (Number.isFinite(curY) && (h === 0 || curY < sheetMaxY) && canPlaceAt(minAbsX, curY, w, h)) {
          const pieceMaxX = w > 0 ? addCeil(minAbsX, w) : minAbsX;
          const pieceMaxY = h > 0 ? addCeil(curY, h) : curY;
          if (
            Number.isFinite(pieceMaxX) &&
            Number.isFinite(pieceMaxY) &&
            (w === 0 || pieceMaxX > minAbsX) &&
            (h === 0 || pieceMaxY > curY) &&
            pieceMaxX <= sheetMaxX + 1e-6 &&
            pieceMaxY <= sheetMaxY + 1e-6
          ) {
            const nextShelfX = advanceWithSpacing(minAbsX, w, spacingMm, effW);
            const nextSheetY = advanceWithSpacing(curY, h, spacingMm, effH);
            const newShelf = { y: curY, h, maxPieceY: pieceMaxY, nextY: nextSheetY, nextX: nextShelfX };
            sheet.shelves.push(newShelf);
            sheet.nextY = nextSheetY;
            placements.push({
              item,
              sheetIndex: sIdx,
              x: minAbsX,
              y: curY,
              w,
              h,
              rotated90,
              rotationDeg,
            });
            updateSheetSummary(sheet);
            recomputeBlock(bIdx);
            placed = true;
            break;
          }
        }
      }
    }

    if (!placed) {
      if (!canPlaceAt(minAbsX, minAbsY, w, h)) return [];
      const pieceMaxX = w > 0 ? addCeil(minAbsX, w) : minAbsX;
      const pieceMaxY = h > 0 ? addCeil(minAbsY, h) : minAbsY;
      if (
        !Number.isFinite(pieceMaxX) ||
        !Number.isFinite(pieceMaxY) ||
        (w > 0 && pieceMaxX <= minAbsX) ||
        (h > 0 && pieceMaxY <= minAbsY) ||
        pieceMaxX > sheetMaxX + 1e-6 ||
        pieceMaxY > sheetMaxY + 1e-6
      ) {
        return [];
      }
      const initNextX = advanceWithSpacing(minAbsX, w, spacingMm, effW);
      const initNextY = advanceWithSpacing(minAbsY, h, spacingMm, effH);
      const sIdx = sheets.length;
      const newShelf = { y: minAbsY, h, maxPieceY: pieceMaxY, nextY: initNextY, nextX: initNextX };
      const sheet = { shelves: [newShelf], nextY: initNextY, remH: 0, maxShelfRemW: 0, maxShelfH: 0 };
      updateSheetSummary(sheet);
      sheets.push(sheet);
      recomputeBlock(sIdx >> 6);
      placements.push({
        item,
        sheetIndex: sIdx,
        x: minAbsX,
        y: minAbsY,
        w,
        h,
        rotated90,
        rotationDeg,
      });
    }
  }

  return placements;
}

/**
 * Skyline Bottom-Left packer over 1 or more sheets in sheet-absolute coordinates.
 * Tests both 0° and 90° (when allowed) across skyline segments to minimize height growth.
 */
function packSkyline(
  orderedItems,
  usableW,
  usableH,
  spacingMm,
  marginMm = 0,
  fabricWidthMm = usableW + 2 * marginMm,
  sheetLengthMm = Number.isFinite(usableH) ? usableH + 2 * marginMm : null
) {
  const minAbsX = marginMm;
  const minAbsY = marginMm;
  const sheetMaxX = fabricWidthMm - marginMm;
  const sheetMaxY = sheetLengthMm !== null ? sheetLengthMm - marginMm : Infinity;
  if (!Number.isFinite(sheetMaxX)) return [];

  const skylines = []; // each sheet: [{ x, y, w }] in sheet-absolute coordinates
  const placements = [];

  const mergeSkyline = (sky) => {
    for (let i = 0; i < sky.length - 1; i++) {
      if (sky[i].y === sky[i + 1].y) {
        const nextEnd = i + 2 < sky.length ? sky[i + 2].x : sheetMaxX;
        sky[i].w = Math.max(0, nextEnd - sky[i].x);
        sky.splice(i + 1, 1);
        i--;
      }
    }
  };

  const addSkylineLevel = (sky, idx, nextX, nextY) => {
    const startX = sky[idx].x;
    const clampedNextX = Math.min(sheetMaxX, nextX);
    const newSeg = { x: startX, y: nextY, w: Math.max(0, clampedNextX - startX) };
    sky.splice(idx, 0, newSeg);
    for (let i = idx + 1; i < sky.length; i++) {
      const seg = sky[i];
      if (seg.x < clampedNextX) {
        const segEnd = i + 1 < sky.length ? sky[i + 1].x : sheetMaxX;
        if (segEnd <= clampedNextX) {
          sky.splice(i, 1);
          i--;
        } else {
          seg.x = clampedNextX;
          seg.w = Math.max(0, segEnd - clampedNextX);
          break;
        }
      } else {
        break;
      }
    }
    mergeSkyline(sky);
  };

  const findBestOnSheet = (sky, orients) => {
    let best = null;
    for (const ori of orients) {
      if (
        !Number.isFinite(ori.w) ||
        !Number.isFinite(ori.h) ||
        ori.w > usableW + 1e-6 ||
        ori.h > usableH + 1e-6
      ) {
        continue;
      }

      for (let i = 0; i < sky.length; i++) {
        const startX = sky[i].x;
        if (!Number.isFinite(startX) || (ori.w > 0 && startX >= sheetMaxX)) break;
        if (ori.w > 0 && startX + ori.w <= startX) continue;

        const pieceMaxX = ori.w > 0 ? addCeil(startX, ori.w) : startX;
        if (
          !Number.isFinite(pieceMaxX) ||
          (ori.w > 0 && pieceMaxX <= startX) ||
          pieceMaxX > sheetMaxX + 1e-6
        ) {
          break;
        }
        const rawNextX = advanceWithSpacing(startX, ori.w, spacingMm, ori.effW);
        const nextX = Math.min(sheetMaxX, rawNextX);
        const reqEndX = Math.min(sheetMaxX, Math.max(pieceMaxX, nextX));

        let maxY = sky[i].y;
        let j = i;
        let coveredEnd = startX;
        while (j < sky.length) {
          if (sky[j].y > maxY) maxY = sky[j].y;
          const segEnd = j + 1 < sky.length ? sky[j + 1].x : sheetMaxX;
          coveredEnd = segEnd;
          j++;
          if (segEnd >= reqEndX) break;
        }
        if (coveredEnd < reqEndX) continue;
        if (ori.h > 0 && maxY + ori.h <= maxY) continue;

        const pieceMaxY = ori.h > 0 ? addCeil(maxY, ori.h) : maxY;
        if (
          !Number.isFinite(pieceMaxY) ||
          (ori.h > 0 && pieceMaxY <= maxY) ||
          pieceMaxY > sheetMaxY + 1e-6
        ) {
          continue;
        }
        const nextY = advanceWithSpacing(maxY, ori.h, spacingMm, ori.effH);
        if (!Number.isFinite(nextY) || (ori.h > 0 && nextY <= maxY)) {
          continue;
        }

        const topY = pieceMaxY; // real piece top (excluding trailing spacing)
        let wastedBelow = 0;
        let rem = Math.max(0, reqEndX - startX);
        for (let k = i; k < sky.length && rem > 0; k++) {
          const segEnd = k + 1 < sky.length ? sky[k + 1].x : sheetMaxX;
          const take = Math.min(rem, Math.max(0, segEnd - sky[k].x));
          wastedBelow += take * (maxY - sky[k].y);
          rem -= take;
        }
        if (!Number.isFinite(wastedBelow)) wastedBelow = Number.MAX_VALUE;

        if (
          !best ||
          topY < best.topY - 1e-6 ||
          (Math.abs(topY - best.topY) <= 1e-6 &&
            (maxY < best.y - 1e-6 ||
              (Math.abs(maxY - best.y) <= 1e-6 &&
                (wastedBelow < best.wastedBelow - 1e-6 ||
                  (Math.abs(wastedBelow - best.wastedBelow) <= 1e-6 &&
                    (ori.rotated90 ? 1 : 0) < (best.rotated90 ? 1 : 0))))))
        ) {
          best = {
            idx: i,
            x: startX,
            y: maxY,
            nextX,
            nextY,
            topY,
            wastedBelow,
            w: ori.w,
            h: ori.h,
            rotated90: ori.rotated90,
            rotationDeg: ori.rotationDeg,
          };
        }
      }
    }
    return best;
  };

  const entries = [];
  for (let i = 0; i < orderedItems.length; i++) {
    const item = orderedItems[i];
    const orients = [];
    if (canFitUsable(item.width, item.height, usableW, usableH)) {
      const d = getOrientationDims(item, false);
      const effW = spacingMm > 0 ? addCeil(d.w, spacingMm) : d.w;
      const effH = spacingMm > 0 ? addCeil(d.h, spacingMm) : d.h;
      orients.push({ ...d, effW, effH });
    }
    if (item.canRotate90 && canFitUsable(item.height, item.width, usableW, usableH)) {
      const d = getOrientationDims(item, true);
      const effW = spacingMm > 0 ? addCeil(d.w, spacingMm) : d.w;
      const effH = spacingMm > 0 ? addCeil(d.h, spacingMm) : d.h;
      orients.push({ ...d, effW, effH });
    }
    if (orients.length === 0) continue;
    let minW = orients[0].w;
    let minH = orients[0].h;
    for (let o = 1; o < orients.length; o++) {
      if (orients[o].w < minW) minW = orients[o].w;
      if (orients[o].h < minH) minH = orients[o].h;
    }
    entries.push({ item, orients, minW, minH });
  }
  if (entries.length === 0) return [];

  const suffixMinW = new Array(entries.length);
  const suffixMinH = new Array(entries.length);
  let curMinW = Infinity;
  let curMinH = Infinity;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].minW < curMinW) curMinW = entries[i].minW;
    if (entries[i].minH < curMinH) curMinH = entries[i].minH;
    suffixMinW[i] = curMinW;
    suffixMinH[i] = curMinH;
  }

  const sheetParetos = [];
  const blockParetos = [];
  let firstActiveSheet = 0;

  const recomputeSkyBlock = (bIdx) => {
    const start = bIdx * SHEET_BLOCK_SIZE;
    const end = Math.min(sheetParetos.length, start + SHEET_BLOCK_SIZE);
    const merged = [];
    for (let i = start; i < end; i++) {
      const p = sheetParetos[i];
      for (let k = 0; k < p.length; k++) merged.push(p[k]);
    }
    blockParetos[bIdx] = buildParetoFrontier(merged, 8);
  };

  for (let eIdx = 0; eIdx < entries.length; eIdx++) {
    const { item, orients } = entries[eIdx];
    const minRemW = suffixMinW[eIdx];
    const minRemH = suffixMinH[eIdx];

    while (firstActiveSheet < skylines.length) {
      if (paretoCanFit(sheetParetos[firstActiveSheet], minRemW, minRemH)) break;
      firstActiveSheet++;
    }

    let placed = false;
    const startBlock = firstActiveSheet >> 6;
    for (let bIdx = startBlock; bIdx < blockParetos.length && !placed; bIdx++) {
      if (!paretoCanFitAnyOrient(blockParetos[bIdx], orients)) {
        continue;
      }
      const sStart = Math.max(firstActiveSheet, bIdx * SHEET_BLOCK_SIZE);
      const sEnd = Math.min(skylines.length, (bIdx + 1) * SHEET_BLOCK_SIZE);
      for (let sIdx = sStart; sIdx < sEnd; sIdx++) {
        if (!paretoCanFitAnyOrient(sheetParetos[sIdx], orients)) {
          continue;
        }
        const cand = findBestOnSheet(skylines[sIdx], orients);
        if (cand) {
          addSkylineLevel(skylines[sIdx], cand.idx, cand.nextX, cand.nextY);
          sheetParetos[sIdx] = computeSkylinePareto(skylines[sIdx], minAbsX, sheetMaxX, sheetMaxY);
          recomputeSkyBlock(bIdx);
          placements.push({
            item,
            sheetIndex: sIdx,
            x: cand.x,
            y: cand.y,
            w: cand.w,
            h: cand.h,
            rotated90: cand.rotated90,
            rotationDeg: cand.rotationDeg,
          });
          placed = true;
          break;
        }
      }
    }

    if (!placed) {
      const sIdx = skylines.length;
      const sky = [{ x: minAbsX, y: minAbsY, w: Math.max(0, sheetMaxX - minAbsX) }];
      const cand = findBestOnSheet(sky, orients);
      if (cand) {
        addSkylineLevel(sky, cand.idx, cand.nextX, cand.nextY);
        skylines.push(sky);
        sheetParetos.push(computeSkylinePareto(sky, minAbsX, sheetMaxX, sheetMaxY));
        recomputeSkyBlock(sIdx >> 6);
        placements.push({
          item,
          sheetIndex: sIdx,
          x: cand.x,
          y: cand.y,
          w: cand.w,
          h: cand.h,
          rotated90: cand.rotated90,
          rotationDeg: cand.rotationDeg,
        });
      }
    }
  }

  return placements;
}

function evaluateCandidate(rawPlacements, marginMm, sheetLengthMm) {
  if (!rawPlacements.length) {
    return {
      sheetCount: 0,
      requiredLengthMm: 0,
      maxSheetUsedLengthMm: 0,
      lastSheetMaxY: 0,
      rotations: 0,
      sheetMaxY: [],
      rawPlacements,
    };
  }
  const sheetMaxY = [];
  let rotations = 0;
  for (const pl of rawPlacements) {
    while (sheetMaxY.length <= pl.sheetIndex) sheetMaxY.push(0);
    const pieceMaxY = pl.h > 0 ? addCeil(pl.y, pl.h) : pl.y;
    const rawEndY = marginMm > 0 ? addCeil(pieceMaxY, marginMm) : pieceMaxY;
    const endY = Number.isFinite(rawEndY) ? rawEndY : Number.MAX_VALUE;
    if (endY > sheetMaxY[pl.sheetIndex]) {
      sheetMaxY[pl.sheetIndex] = endY;
    }
    if (pl.rotated90) rotations++;
  }
  const sheetCount = sheetMaxY.length;
  let maxSheetUsedLengthMm = 0;
  for (let i = 0; i < sheetCount; i++) {
    if (sheetMaxY[i] > maxSheetUsedLengthMm) {
      maxSheetUsedLengthMm = sheetMaxY[i];
    }
  }
  const lastSheetMaxY = sheetMaxY[sheetCount - 1];
  let requiredLengthMm = 0;
  if (sheetLengthMm !== null && sheetCount > 1) {
    requiredLengthMm = (sheetCount - 1) * sheetLengthMm + lastSheetMaxY;
  } else {
    requiredLengthMm = sheetMaxY[0];
  }
  return {
    sheetCount,
    requiredLengthMm,
    maxSheetUsedLengthMm,
    lastSheetMaxY,
    rotations,
    sheetMaxY,
    rawPlacements,
  };
}

function verifyNoOverlaps(placements) {
  const bySheet = new Map();
  for (const pl of placements) {
    const w = Number.isFinite(pl.width) ? pl.width : pl.maxX - pl.minX;
    const h = Number.isFinite(pl.height) ? pl.height : pl.maxY - pl.minY;
    if (
      !Number.isFinite(pl.minX) ||
      !Number.isFinite(pl.maxX) ||
      !Number.isFinite(pl.minY) ||
      !Number.isFinite(pl.maxY) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h)
    ) {
      throw new Error(
        `Nesting invariant violation: non-finite placement bounds for ${pl.pieceName}`
      );
    }
    if ((w > 0 && pl.minX + w <= pl.minX) || (h > 0 && pl.minY + h <= pl.minY)) {
      throw new Error(
        `Nesting invariant violation: ULP-collapsed placement bounds for ${pl.pieceName}`
      );
    }
    if (!bySheet.has(pl.sheetIndex)) bySheet.set(pl.sheetIndex, []);
    bySheet.get(pl.sheetIndex).push({ pl, w, h });
  }
  for (const list of bySheet.values()) {
    const sorted = [...list].sort((a, b) => a.pl.minX - b.pl.minX || a.pl.minY - b.pl.minY);
    for (let i = 0; i < sorted.length; i++) {
      const { pl: a, w: aw, h: ah } = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const { pl: b, w: bw, h: bh } = sorted[j];
        const dx = b.minX - a.minX;
        const gapX = exactCompareSum(b.minX, a.minX, aw);
        if (b.minX >= a.maxX && gapX >= 0 && dx >= aw) break;
        const posAreas = aw > 0 && ah > 0 && bw > 0 && bh > 0;
        const loY = a.minY <= b.minY ? { pl: a, h: ah } : { pl: b, h: bh };
        const hiY = a.minY <= b.minY ? { pl: b, h: bh } : { pl: a, h: ah };
        const dy = hiY.pl.minY - loY.pl.minY;
        const gapY = exactCompareSum(hiY.pl.minY, loY.pl.minY, loY.h);
        const overlapsY = hiY.pl.minY < loY.pl.maxY || gapY < 0 || dy < loY.h;
        if (
          !Number.isFinite(dx) ||
          !Number.isFinite(gapX) ||
          !Number.isFinite(dy) ||
          !Number.isFinite(gapY) ||
          (posAreas && overlapsY)
        ) {
          const ox = Math.max(0, Math.min(Math.max(a.maxX - b.minX, -gapX, aw - dx), bw));
          const oy = Math.max(0, Math.min(Math.max(loY.pl.maxY - hiY.pl.minY, -gapY, loY.h - dy), hiY.h));
          const oxStr = Number.isFinite(ox) ? ox.toFixed(3) : 'Inf';
          const oyStr = Number.isFinite(oy) ? oy.toFixed(3) : 'Inf';
          throw new Error(
            `Nesting invariant violation: overlapping placements ${a.pieceName} and ${b.pieceName} (${oxStr}x${oyStr}mm)`
          );
        }
      }
    }
  }
}

export function nestPatternPieces(pattern, options = {}) {
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern) || !Array.isArray(pattern.pieces)) {
    throw new ValidationError('nestPatternPieces expects a pattern object with a pieces array', {
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

  const grainLockByIndex = Array.from(pattern.pieces, (p) => parseBoolFlag(p?.grainLock));
  let normPattern = pattern;
  const needsTypesPieceCheck = !pattern.unit || pattern.unit === 'mm';
  if (pattern.unit !== undefined && pattern.unit !== 'mm') {
    if (!isValidUnit(pattern.unit)) {
      throw new ValidationError(`Unsupported pattern unit "${String(pattern.unit)}"`, {
        code: 'INVALID_UNIT',
        path: 'pattern.unit',
      });
    }
    normPattern = normalizePatternProject(pattern, { allowEmpty: true });
  }

  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const { presetId, fabricWidthMm, sheetLengthMm } = resolveRollSpec(safeOptions);
  const marginMm = Math.max(0, finiteOr(safeOptions.marginMm, 10));
  const spacingMm = Math.max(0, finiteOr(safeOptions.spacingMm, 8));
  const lockGrainline = parseBoolFlag(safeOptions.lockGrainline);
  const allowRotate90 =
    safeOptions.allowRotate90 !== undefined ? parseBoolFlag(safeOptions.allowRotate90) : !lockGrainline;

  const usableW = fabricWidthMm - 2 * marginMm;
  const usableH = sheetLengthMm !== null ? sheetLengthMm - 2 * marginMm : Infinity;
  if (
    marginMm > 1e15 ||
    spacingMm > 1e15 ||
    !Number.isFinite(2 * marginMm) ||
    !Number.isFinite(usableW) ||
    !Number.isFinite(marginMm + spacingMm) ||
    (usableW > 0 && !Number.isFinite(usableW + spacingMm)) ||
    (Number.isFinite(usableH) && usableH > 0 && !Number.isFinite(usableH + spacingMm))
  ) {
    throw new ValidationError(
      'Nesting marginMm/spacingMm options exceed safe finite bounds.',
      {
        code: 'INVALID_OPTIONS',
        path: spacingMm > 1e15 ? 'options.spacingMm' : 'options.marginMm',
      }
    );
  }

  if (normPattern.pieces.length === 0) {
    return {
      presetId,
      fabricWidthMm,
      rollWidthMm: fabricWidthMm,
      sheetLengthMm,
      requiredLengthMm: 0,
      usedLengthMm: 0,
      requiredMeters: 0,
      requiredYards: 0,
      totalCutAreaMm2: 0,
      totalNetAreaMm2: 0,
      totalAreaMm2: 0,
      utilizationPct: 0,
      wastePct: 0,
      totalCutPerimeterMm: 0,
      totalSewPerimeterMm: 0,
      totalSeamLengthMm: 0,
      pieceCount: 0,
      totalCutPieceCount: 0,
      seamCount: Array.isArray(normPattern.seams) ? normPattern.seams.length : 0,
      placements: [],
      unfittedPieces: [],
      sheets: [],
      sheetCount: 0,
    };
  }

  const items = [];
  const unfittedPieces = [];
  let requestedCutAreaMm2 = 0;
  let requestedNetAreaMm2 = 0;
  let requestedCutPerimMm = 0;
  let requestedSewPerimMm = 0;
  let totalCutPieceCount = 0;

  for (let pIdx = 0; pIdx < normPattern.pieces.length; pIdx++) {
    const piece = normPattern.pieces[pIdx];
    if (
      !(pIdx in normPattern.pieces) ||
      !piece ||
      typeof piece !== 'object' ||
      Array.isArray(piece) ||
      !Array.isArray(piece.points) ||
      piece.points.length < 3
    ) {
      throw new ValidationError(`Piece at index ${pIdx} must have >= 3 points`, {
        code: 'INVALID_PIECE',
        path: `pieces[${pIdx}]`,
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

    const segs = estimateAdaptiveCurveSegments(piece, 0.015);
    const netWorld = samplePieceOutline(piece, segs, { worldSpace: true });
    const cutWorld = computePieceCutBoundary(piece, segs, { worldSpace: true });
    const bounds = polygonBounds(cutWorld);
    const localCutPoly = cutWorld.map((pt) => ({
      x: pt.x - bounds.minX,
      y: pt.y - bounds.minY,
    }));

    const cutArea = polygonArea(cutWorld);
    const netArea = polygonArea(netWorld);
    const cutPerim = polygonPerimeter(cutWorld);
    const sewPerim = polygonPerimeter(netWorld);

    const rawQ = piece.quantity;
    let qty = 1;
    if (rawQ !== undefined && typeof rawQ !== 'symbol') {
      const qNum = typeof rawQ === 'number' ? rawQ : NaN;
      if (!Number.isFinite(qNum) || !Number.isInteger(qNum) || qNum < 1 || qNum > MAX_PIECE_QUANTITY) {
        throw new ValidationError(
          `Piece quantity must be an integer between 1 and ${MAX_PIECE_QUANTITY} at pieces[${pIdx}].quantity`,
          {
            code: 'INVALID_PIECE',
            path: `pieces[${pIdx}].quantity`,
          }
        );
      }
      qty = qNum;
    }
    if (totalCutPieceCount + qty > MAX_PIECE_QUANTITY) {
      throw new ValidationError(
        `Total cut piece quantity across pattern exceeds maximum (${MAX_PIECE_QUANTITY})`,
        {
          code: 'TOO_MANY_PIECES',
          path: `pieces[${pIdx}].quantity`,
        }
      );
    }
    const onFold = parseBoolFlag(piece.onFold);
    const grainLocked = lockGrainline || grainLockByIndex[pIdx] || parseBoolFlag(piece.grainLock);
    const canRotate90 = allowRotate90 && !grainLocked;

    for (let copyIndex = 0; copyIndex < qty; copyIndex++) {
      totalCutPieceCount++;
      requestedCutAreaMm2 += cutArea;
      requestedNetAreaMm2 += netArea;
      requestedCutPerimMm += cutPerim;
      requestedSewPerimMm += sewPerim;

      const fits0 = usableW > 0 && usableH > 0 && canFitUsable(bounds.width, bounds.height, usableW, usableH);
      const fits90 =
        canRotate90 &&
        usableW > 0 &&
        usableH > 0 &&
        canFitUsable(bounds.height, bounds.width, usableW, usableH);

      const pieceId = resolvePieceId(piece, pIdx);
      const pieceName = resolvePieceName(piece, pIdx);

      if (!fits0 && !fits90) {
        unfittedPieces.push({
          pieceIndex: pIdx,
          pieceId,
          pieceName,
          copyIndex,
          widthMm: Number.isFinite(bounds.width) ? bounds.width : Number.MAX_VALUE,
          heightMm: Number.isFinite(bounds.height) ? bounds.height : Number.MAX_VALUE,
          onFold,
          reason: !canRotate90 && canFitUsable(bounds.height, bounds.width, usableW, usableH)
            ? 'GRAINLINE_LOCKED_EXCEEDS_WIDTH'
            : 'EXCEEDS_USABLE_SHEET_BOUNDS',
        });
        continue;
      }

      items.push({
        pieceIndex: pIdx,
        pieceId,
        pieceName,
        copyIndex,
        onFold,
        canRotate90,
        width: bounds.width,
        height: bounds.height,
        cutArea,
        netArea,
        cutPerim,
        sewPerim,
        localCutPoly,
      });
    }
  }

  let bestEval = null;

  if (items.length > 0) {
    const candidates = [];

    // 1. No-rotation baseline (only rotates if 0° cannot fit and canRotate90 is true)
    const noRotItems = [...items].sort((a, b) => b.height - a.height || b.width - a.width);
    candidates.push(
      packShelf(
        noRotItems,
        (it, uW, uH) => {
          if (canFitUsable(it.width, it.height, uW, uH)) return getOrientationDims(it, false);
          if (it.canRotate90 && canFitUsable(it.height, it.width, uW, uH)) return getOrientationDims(it, true);
          return null;
        },
        usableW,
        usableH,
        spacingMm,
        marginMm,
        fabricWidthMm,
        sheetLengthMm
      )
    );

    if (allowRotate90) {
      // 2. Narrow-first: orient w <= h when allowed and feasible (minimizes shelf width usage)
      const narrowPref = (it, uW, uH) => {
        const prefer90 = it.canRotate90 && it.height < it.width && canFitUsable(it.height, it.width, uW, uH);
        if (prefer90) return getOrientationDims(it, true);
        if (canFitUsable(it.width, it.height, uW, uH)) return getOrientationDims(it, false);
        if (it.canRotate90 && canFitUsable(it.height, it.width, uW, uH)) return getOrientationDims(it, true);
        return null;
      };
      const narrowSorted = [...items].sort((a, b) => {
        const ha = a.canRotate90 ? Math.max(a.width, a.height) : a.height;
        const hb = b.canRotate90 ? Math.max(b.width, b.height) : b.height;
        return hb - ha || b.cutArea - a.cutArea;
      });
      candidates.push(packShelf(narrowSorted, narrowPref, usableW, usableH, spacingMm, marginMm, fabricWidthMm, sheetLengthMm));

      // 3. Flat-first: orient h <= w when allowed and feasible (minimizes shelf height)
      const flatPref = (it, uW, uH) => {
        const prefer90 = it.canRotate90 && it.width < it.height && canFitUsable(it.height, it.width, uW, uH);
        if (prefer90) return getOrientationDims(it, true);
        if (canFitUsable(it.width, it.height, uW, uH)) return getOrientationDims(it, false);
        if (it.canRotate90 && canFitUsable(it.height, it.width, uW, uH)) return getOrientationDims(it, true);
        return null;
      };
      const flatSorted = [...items].sort((a, b) => {
        const ha = a.canRotate90 ? Math.min(a.width, a.height) : a.height;
        const hb = b.canRotate90 ? Math.min(b.width, b.height) : b.height;
        return hb - ha || b.cutArea - a.cutArea;
      });
      candidates.push(packShelf(flatSorted, flatPref, usableW, usableH, spacingMm, marginMm, fabricWidthMm, sheetLengthMm));

      // 4. Skyline Bottom-Left sorted by max dimension desc
      const skyMaxDim = [...items].sort(
        (a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || b.cutArea - a.cutArea
      );
      candidates.push(packSkyline(skyMaxDim, usableW, usableH, spacingMm, marginMm, fabricWidthMm, sheetLengthMm));

      // 5. Skyline Bottom-Left sorted by area desc
      const skyArea = [...items].sort((a, b) => b.cutArea - a.cutArea || b.height - a.height);
      candidates.push(packSkyline(skyArea, usableW, usableH, spacingMm, marginMm, fabricWidthMm, sheetLengthMm));
    } else {
      // Skyline without 90° rotation
      const skyNoRot = [...items].sort((a, b) => b.height - a.height || b.cutArea - a.cutArea);
      candidates.push(packSkyline(skyNoRot, usableW, usableH, spacingMm, marginMm, fabricWidthMm, sheetLengthMm));
    }

    for (const cand of candidates) {
      if (cand.length !== items.length) continue;
      const ev = evaluateCandidate(cand, marginMm, sheetLengthMm);
      const bestReq = bestEval ? bestEval.requiredLengthMm : Infinity;
      const reqDiff = ev.requiredLengthMm - bestReq;
      const sameReq =
        ev.requiredLengthMm === bestReq ||
        (Number.isFinite(ev.requiredLengthMm) &&
          Number.isFinite(bestReq) &&
          Math.abs(reqDiff) <= 1e-6);
      const betterReq =
        (Number.isFinite(ev.requiredLengthMm) && !Number.isFinite(bestReq)) ||
        (Number.isFinite(ev.requiredLengthMm) &&
          Number.isFinite(bestReq) &&
          ev.requiredLengthMm < bestReq - 1e-6);
      if (
        !bestEval ||
        ev.sheetCount < bestEval.sheetCount ||
        (ev.sheetCount === bestEval.sheetCount &&
          (betterReq ||
            (sameReq &&
              (ev.lastSheetMaxY < bestEval.lastSheetMaxY - 1e-6 ||
                (Math.abs(ev.lastSheetMaxY - bestEval.lastSheetMaxY) <= 1e-6 &&
                  (ev.maxSheetUsedLengthMm < bestEval.maxSheetUsedLengthMm - 1e-6 ||
                    (Math.abs(ev.maxSheetUsedLengthMm - bestEval.maxSheetUsedLengthMm) <= 1e-6 &&
                      ev.rotations < bestEval.rotations)))))))
      ) {
        bestEval = ev;
      }
    }

    if (!bestEval) {
      throw new ValidationError('Nesting coordinates lack representable float64 precision at given marginMm.', {
        code: 'INVALID_OPTIONS',
        path: 'options.marginMm',
      });
    }
  }

  const placements = [];
  let placedCutAreaMm2 = 0;

  if (bestEval) {
    for (const raw of bestEval.rawPlacements) {
      const { item, sheetIndex, x, y, w, h, rotated90, rotationDeg } = raw;
      const maxX = w > 0 ? addCeil(x, w) : x;
      const maxY = h > 0 ? addCeil(y, h) : y;
      const localPts = rotated90
        ? rotatePolygon90CW(item.localCutPoly, item.width, item.height)
        : item.localCutPoly;
      const polygon = localPts.map((pt) => ({ x: x + pt.x, y: y + pt.y }));
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(maxY) ||
        polygon.some((pt) => !Number.isFinite(pt.x) || !Number.isFinite(pt.y))
      ) {
        throw new ValidationError('Nesting placement coordinates overflow finite bounds.', {
          code: 'INVALID_OPTIONS',
          path: 'options',
        });
      }
      const safeAreaMm2 = Number.isFinite(item.cutArea) ? item.cutArea : Number.MAX_VALUE;

      placedCutAreaMm2 += safeAreaMm2;
      placements.push({
        pieceIndex: item.pieceIndex,
        pieceId: item.pieceId,
        pieceName: item.pieceName,
        name: item.pieceName,
        instanceIndex: item.copyIndex,
        copyIndex: item.copyIndex,
        sheetIndex,
        x,
        y,
        offsetX: x,
        offsetY: y,
        minX: x,
        minY: y,
        maxX,
        maxY,
        width: w,
        height: h,
        widthMm: w,
        heightMm: h,
        rotationDeg,
        rotated90,
        onFold: item.onFold,
        areaMm2: safeAreaMm2,
        points: polygon,
        polygon,
      });
    }
  }

  verifyNoOverlaps(placements);

  const finiteSummaryNum = (val, decimals = 2) => {
    const safe = Number.isFinite(val) ? val : Number.MAX_VALUE;
    const res = Number(safe.toFixed(decimals));
    return Number.isFinite(res) ? res : safe;
  };

  const normalizedPlacementArea = (pl, normW, normH) => {
    if (!(normW > 0) || !(normH > 0)) return 0;
    if (Array.isArray(pl.polygon) && pl.polygon.length >= 3) {
      const scaled = pl.polygon.map((pt) => ({ x: pt.x / normW, y: pt.y / normH }));
      const area = polygonArea(scaled);
      if (Number.isFinite(area) && (area > 0 || !(pl.areaMm2 > 0))) return area;
    }
    const rectArea = (pl.width / normW) * (pl.height / normH);
    return Number.isFinite(rectArea) ? rectArea : 0;
  };

  const sheetCount = bestEval ? bestEval.sheetCount : 0;
  const rawRequiredLengthMm = bestEval ? bestEval.requiredLengthMm : 0;
  const requiredLengthMm = finiteSummaryNum(rawRequiredLengthMm, 4);
  const placementsBySheet = Array.from({ length: sheetCount }, () => []);
  for (let i = 0; i < placements.length; i++) {
    const pl = placements[i];
    if (pl.sheetIndex >= 0 && pl.sheetIndex < sheetCount) {
      placementsBySheet[pl.sheetIndex].push(pl);
    }
  }
  const sheets = [];
  for (let sIdx = 0; sIdx < sheetCount; sIdx++) {
    const sPlacements = placementsBySheet[sIdx];
    const usedLen = bestEval.sheetMaxY[sIdx];
    const sheetLenForArea = sheetLengthMm !== null && sIdx < sheetCount - 1 ? sheetLengthMm : usedLen;
    const sheetArea = fabricWidthMm * sheetLenForArea;
    const sCutArea = sPlacements.reduce((sum, pl) => sum + pl.areaMm2, 0);
    let sheetUtilPct = 0;
    if (sheetLenForArea > 0 && fabricWidthMm > 0) {
      if (Number.isFinite(sheetArea) && sheetArea > 0 && Number.isFinite(sCutArea)) {
        sheetUtilPct = Math.min(100, Number(((sCutArea / sheetArea) * 100).toFixed(2)));
      } else {
        const normCutSum = sPlacements.reduce(
          (sum, pl) => sum + normalizedPlacementArea(pl, fabricWidthMm, sheetLenForArea),
          0
        );
        sheetUtilPct = Math.min(100, Math.max(0, Number((normCutSum * 100).toFixed(2))));
      }
    }
    sheets.push({
      sheetIndex: sIdx,
      widthMm: fabricWidthMm,
      lengthMm: sheetLengthMm,
      usedLengthMm: finiteSummaryNum(usedLen, 4),
      pieceCount: sPlacements.length,
      utilizationPct: Number.isFinite(sheetUtilPct) ? sheetUtilPct : 0,
      placements: sPlacements,
    });
  }

  const totalFabricAreaMm2 =
    sheetCount === 0
      ? 0
      : sheetLengthMm !== null && sheetCount > 1
        ? fabricWidthMm * ((sheetCount - 1) * sheetLengthMm + bestEval.sheetMaxY[sheetCount - 1])
        : fabricWidthMm * rawRequiredLengthMm;

  let utilizationPct = 0;
  if (sheetCount > 0 && fabricWidthMm > 0) {
    if (
      Number.isFinite(totalFabricAreaMm2) &&
      totalFabricAreaMm2 > 0 &&
      Number.isFinite(placedCutAreaMm2)
    ) {
      utilizationPct = Math.min(
        100,
        Number(((placedCutAreaMm2 / totalFabricAreaMm2) * 100).toFixed(2))
      );
    } else {
      let maxLen = Math.max(sheetLengthMm || 0, 1);
      if (bestEval) {
        for (let i = 0; i < bestEval.sheetMaxY.length; i++) {
          if (bestEval.sheetMaxY[i] > maxLen) maxLen = bestEval.sheetMaxY[i];
        }
      }
      const normTotalLen =
        sheetLengthMm !== null && sheetCount > 1
          ? (sheetCount - 1) * (sheetLengthMm / maxLen) +
            bestEval.sheetMaxY[sheetCount - 1] / maxLen
          : rawRequiredLengthMm / maxLen;
      if (Number.isFinite(normTotalLen) && normTotalLen > 0) {
        const normPlacedArea = placements.reduce(
          (sum, pl) => sum + normalizedPlacementArea(pl, fabricWidthMm, maxLen),
          0
        );
        utilizationPct = Math.min(
          100,
          Math.max(0, Number(((normPlacedArea / normTotalLen) * 100).toFixed(2)))
        );
      }
    }
  }
  if (!Number.isFinite(utilizationPct)) utilizationPct = 0;
  const wastePct =
    placements.length > 0 ? Number(Math.max(0, 100 - utilizationPct).toFixed(2)) : 0;

  return {
    presetId,
    fabricWidthMm,
    rollWidthMm: fabricWidthMm,
    sheetLengthMm,
    requiredLengthMm,
    usedLengthMm: requiredLengthMm,
    requiredMeters: finiteSummaryNum(
      Number.isFinite(rawRequiredLengthMm) ? rawRequiredLengthMm / 1000 : Number.MAX_VALUE / 1000,
      4
    ),
    requiredYards: finiteSummaryNum(
      Number.isFinite(rawRequiredLengthMm) ? rawRequiredLengthMm / 914.4 : Number.MAX_VALUE / 914.4,
      4
    ),
    totalCutAreaMm2: finiteSummaryNum(requestedCutAreaMm2, 2),
    totalNetAreaMm2: finiteSummaryNum(requestedNetAreaMm2, 2),
    totalAreaMm2: finiteSummaryNum(requestedCutAreaMm2, 2),
    placedCutAreaMm2: finiteSummaryNum(placedCutAreaMm2, 2),
    utilizationPct,
    wastePct,
    totalCutPerimeterMm: finiteSummaryNum(requestedCutPerimMm, 2),
    totalSewPerimeterMm: finiteSummaryNum(requestedSewPerimMm, 2),
    totalSeamLengthMm: finiteSummaryNum(requestedSewPerimMm, 2),
    pieceCount: normPattern.pieces.length,
    totalCutPieceCount,
    seamCount: Array.isArray(normPattern.seams) ? normPattern.seams.length : 0,
    placements,
    unfittedPieces,
    sheets,
    sheetCount,
  };
}
