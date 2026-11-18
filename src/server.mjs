/**
 * Zero-dependency HTTP Server for pattern_studio_v2.
 * Serves the static Studio frontend, isomorphic /src/core/* modules,
 * workspace STL discovery/streaming, CAD/unwrapping/XPBD simulation/export APIs,
 * and prints local + SSH port-forward access instructions on startup.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import {
  SCHEMA_VERSION,
  UNIT_FACTORS,
  ValidationError,
  TEMPLATE_CATALOG,
  MATERIAL_PRESETS,
  WEAVE_TYPES,
  FABRIC_ROLL_PRESETS,
  PAGE_FORMATS,
  DEFAULT_AVATAR,
  polygonBounds,
  polygonArea,
  samplePieceOutline,
  triangulatePolygon,
  generateTemplatePattern,
  validatePatternSeams,
  parseSTL,
  unwrapSTLToPattern,
  getMaterialConfig,
  createParametricAvatar,
  ClothSimulation,
  nestPatternPieces,
  exportSVG,
  exportTiledPDF,
  exportDXF,
  exportPatternJSON,
} from './core/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKSPACE_ROOT = path.resolve(DEFAULT_PROJECT_ROOT, '..');
const DEFAULT_PUBLIC_DIR = path.join(DEFAULT_PROJECT_ROOT, 'public');
const DEFAULT_CORE_DIR = path.join(DEFAULT_PROJECT_ROOT, 'src', 'core');

const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024; // 25 MB
const RAW_JSON_OFFLOAD_THRESHOLD_BYTES = 128 * 1024; // 128 KB

function toTransferableUint8Array(bufOrView) {
  if (
    bufOrView instanceof Uint8Array &&
    bufOrView.byteOffset === 0 &&
    bufOrView.byteLength === bufOrView.buffer.byteLength
  ) {
    return bufOrView;
  }
  return new Uint8Array(bufOrView);
}

function encodeJsonBytes(payload) {
  return toTransferableUint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));
}

const STATIC_MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
});

export class HttpError extends Error {
  constructor(statusCode, message, code = 'HTTP_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isPlainObject(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

function safeObj(val) {
  return isPlainObject(val) ? val : {};
}

function safePatternName(name) {
  if (name === undefined || name === null) return 'Pattern';
  if (typeof name === 'symbol' || typeof name === 'object' || typeof name === 'function') {
    return 'Pattern';
  }
  const s = String(name).trim();
  return s.length > 0 ? s : 'Pattern';
}

function safePieceLabel(val, fallback) {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') return val.length > 0 ? val : fallback;
  if (typeof val === 'symbol' || typeof val === 'object' || typeof val === 'function') {
    return fallback;
  }
  const s = String(val);
  return s.length > 0 ? s : fallback;
}

function assertOptionalString(val, fieldName, code = 'INVALID_INPUT') {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new HttpError(400, `Invalid ${fieldName}: expected a string.`, code);
  }
  return val;
}

function assertOptionalFiniteInput(val, fieldName, code = 'INVALID_INPUT') {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new HttpError(400, `Invalid ${fieldName}: expected a finite number.`, code);
    }
    return val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') {
      throw new HttpError(400, `Invalid ${fieldName}: expected a finite number.`, code);
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new HttpError(400, `Invalid ${fieldName}: expected a finite number.`, code);
    }
    return n;
  }
  throw new HttpError(400, `Invalid ${fieldName}: expected a finite number.`, code);
}

const OPTION_STRING_FIELDS = [
  'rollPreset',
  'preset',
  'rollId',
  'pageFormat',
  'format',
  'orientation',
  'layout',
  'unit',
];

const OPTION_FINITE_FIELDS = [
  'fabricWidthMm',
  'rollWidthMm',
  'widthMm',
  'heightMm',
  'sheetLengthMm',
  'rollLengthMm',
  'lengthMm',
  'requiredLengthMm',
  'marginMm',
  'spacingMm',
  'gapMm',
  'pageWidthMm',
  'pageHeightMm',
  'overlapMm',
  'originX',
  'originY',
  'padRight',
  'padBottom',
  'scale',
  'tileMarginMm',
  'tileOverlapMm',
  'fontSize',
  'lineWidth',
  'maxEdgeLengthMm',
  'substeps',
  'dt',
  'gravityMmS2',
  'steps',
];

const OPTION_BOOLEAN_FIELDS = [
  'allowRotate90',
  'lockGrainline',
  'paginateSheets',
  'includeSeamAllowance',
  'includeNotches',
  'includeGrainline',
  'includeLabels',
  'showGrid',
  'tileMarks',
  'includeAssemblyMap',
  'skipBlankTiles',
];

const REQUEST_ENVELOPE_KEYS = new Set(['pattern', 'format', 'options']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stripUnsafeKeys(obj) {
  if (!isPlainObject(obj)) return {};
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    out[key] = val;
  }
  return out;
}

function extractTopLevelOptions(body) {
  if (!isPlainObject(body)) return {};
  const out = {};
  for (const [key, val] of Object.entries(body)) {
    if (REQUEST_ENVELOPE_KEYS.has(key) || UNSAFE_OBJECT_KEYS.has(key)) continue;
    out[key] = val;
  }
  return out;
}

function assertStrictFiniteNumber(val, fieldName, code = 'INVALID_INPUT') {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new HttpError(400, `Invalid ${fieldName}: expected a finite number.`, code);
  }
  return val;
}

function assertFinitePoint2D(pt, fieldName, code = 'INVALID_INPUT') {
  if (
    !isPlainObject(pt) ||
    typeof pt.x !== 'number' ||
    !Number.isFinite(pt.x) ||
    typeof pt.y !== 'number' ||
    !Number.isFinite(pt.y)
  ) {
    throw new HttpError(400, `Invalid ${fieldName}: expected finite {x, y}.`, code);
  }
  return pt;
}

function assertFiniteVec3(vec, fieldName, code = 'INVALID_INPUT') {
  if (
    !isPlainObject(vec) ||
    typeof vec.x !== 'number' ||
    !Number.isFinite(vec.x) ||
    typeof vec.y !== 'number' ||
    !Number.isFinite(vec.y) ||
    typeof vec.z !== 'number' ||
    !Number.isFinite(vec.z)
  ) {
    throw new HttpError(400, `Invalid ${fieldName}: expected finite {x, y, z}.`, code);
  }
  return vec;
}

function assertNestingFinite(val, fieldName, allowNull = false) {
  if (val === undefined) return undefined;
  if (val === null) {
    if (allowNull) return null;
    throw new HttpError(
      400,
      `Invalid ${fieldName}: expected a finite number.`,
      'INVALID_NESTING_RESULT'
    );
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new HttpError(
        400,
        `Invalid ${fieldName}: expected a finite number.`,
        'INVALID_NESTING_RESULT'
      );
    }
    return val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') {
      throw new HttpError(
        400,
        `Invalid ${fieldName}: expected a finite number.`,
        'INVALID_NESTING_RESULT'
      );
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new HttpError(
        400,
        `Invalid ${fieldName}: expected a finite number.`,
        'INVALID_NESTING_RESULT'
      );
    }
    return n;
  }
  throw new HttpError(
    400,
    `Invalid ${fieldName}: expected a finite number.`,
    'INVALID_NESTING_RESULT'
  );
}

const NESTING_RESULT_NUMERIC_FIELDS = [
  'fabricWidthMm',
  'rollWidthMm',
  'sheetWidthMm',
  'requiredLengthMm',
  'usedLengthMm',
  'requiredMeters',
  'requiredYards',
  'totalCutAreaMm2',
  'totalNetAreaMm2',
  'totalAreaMm2',
  'placedCutAreaMm2',
  'utilization',
  'utilizationPct',
  'wastePct',
  'totalCutPerimeterMm',
  'totalSewPerimeterMm',
  'totalSeamLengthMm',
  'totalCutLengthMm',
  'pieceCount',
  'totalCutPieceCount',
  'seamCount',
  'sheetCount',
];

const NESTING_PLACEMENT_NUMERIC_FIELDS = [
  'pieceIndex',
  'instanceIndex',
  'copyIndex',
  'sheetIndex',
  'x',
  'y',
  'offsetX',
  'offsetY',
  'minX',
  'minY',
  'maxX',
  'maxY',
  'width',
  'height',
  'widthMm',
  'heightMm',
  'rotationDeg',
  'areaMm2',
];

const NESTING_SHEET_NUMERIC_FIELDS = [
  'sheetIndex',
  'widthMm',
  'usedLengthMm',
  'pieceCount',
  'utilizationPct',
  'utilization',
  'usedAreaMm2',
];

const MAX_SHEET_LENGTH_MM = 50_000;
const MAX_NEST_TOTAL_LENGTH_MM = 1_000_000;
const MAX_FABRIC_WIDTH_MM = 50_000;
const MIN_FABRIC_DIM_MM = 10;
const MAX_MARGIN_OR_SPACING_MM = 5_000;

const MAX_SA_PIECE_POINTS = 120;
const MAX_SA_PATTERN_POINTS = 1_000;
const MAX_SA_PIECE_CURVED_EDGES = 32;
const MAX_PIECE_CURVED_EDGES = 128;
const MAX_SA_PIECE_SAMPLED_VERTICES = 2_500;
const MAX_PIECE_SAMPLED_VERTICES = 12_000;

const MAX_PATTERN_SAMPLED_VERTICES = 24_000;
const MAX_PATTERN_SA_QUADRATIC_WORK = 8_000_000;
const MAX_PATTERN_CURVED_SA_WORK = 25_000_000;
const MAX_EXPORT_TOTAL_SAMPLED_VERTICES = 60_000;
const MAX_EXPORT_SA_QUADRATIC_WORK = 12_000_000;
const MAX_EXPORT_SA_RAW_QUAD_WORK = 900_000;
const MAX_EXPORT_CURVED_SA_WORK = 40_000_000;
const MAX_SA_RAW_POINTS_FOURTH = 250_000_000;
const MAX_PATTERN_DART_WORK = 40_000;
const MAX_EXPORT_DART_WORK = 80_000;
const MAX_PATTERN_INTERNAL_LINE_POINTS = 25_000;
const MAX_EXPORT_INTERNAL_LINE_POINTS = 50_000;
const MAX_PDF_TILE_INTERNAL_LINE_POINTS = 250_000;
const MAX_PDF_TILE_NOTCHES = 100_000;
const MAX_PDF_TILE_DARTS = 50_000;
const MAX_PDF_TILE_CONTOUR_VERTICES = 1_500_000;
const MAX_PDF_TILE_PIECE_INTERSECTIONS = 15_000;

const MAX_STL_TRIANGLES = 25_000;

const NESTING_INTEGER_FIELDS = new Set([
  'sheetCount',
  'pieceCount',
  'totalCutPieceCount',
]);
const NESTING_SHEET_LEN_FIELDS = new Set([
  'fabricWidthMm',
  'rollWidthMm',
  'sheetWidthMm',
]);
const NESTING_TOTAL_LEN_FIELDS = new Set([
  'requiredLengthMm',
  'usedLengthMm',
]);
const PLACEMENT_INTEGER_FIELDS = new Set([
  'pieceIndex',
  'instanceIndex',
  'copyIndex',
  'sheetIndex',
]);
const PLACEMENT_DIM_FIELDS = new Set([
  'width',
  'height',
  'widthMm',
  'heightMm',
]);
const PLACEMENT_COORD_FIELDS = new Set([
  'x',
  'y',
  'offsetX',
  'offsetY',
  'minX',
  'minY',
  'maxX',
  'maxY',
]);

function validateNestingAndExportOptions(rawOpts, fieldPath = 'options') {
  if (rawOpts !== undefined && rawOpts !== null && !isPlainObject(rawOpts)) {
    throw new HttpError(400, `Invalid ${fieldPath}: expected a plain object.`, 'INVALID_OPTIONS');
  }
  const opts = stripUnsafeKeys(rawOpts);
  for (const key of OPTION_STRING_FIELDS) {
    assertOptionalString(opts[key], `${fieldPath}.${key}`, 'INVALID_OPTIONS');
  }
  if (opts.orientation !== undefined && opts.orientation !== null) {
    const ori = opts.orientation.trim().toLowerCase();
    if (ori !== 'portrait' && ori !== 'landscape') {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.orientation "${opts.orientation}": expected "portrait" or "landscape".`,
        'INVALID_OPTIONS'
      );
    }
    opts.orientation = ori;
  }
  if (opts.layout !== undefined && opts.layout !== null) {
    const lay = opts.layout.trim().toLowerCase();
    if (lay !== 'cad' && lay !== 'nested') {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.layout "${opts.layout}": expected "cad" or "nested".`,
        'INVALID_OPTIONS'
      );
    }
    opts.layout = lay;
  }
  if (opts.unit !== undefined && opts.unit !== null) {
    const u = opts.unit.trim().toLowerCase();
    if (u !== 'mm' && u !== 'cm' && u !== 'in') {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.unit "${opts.unit}": expected "mm", "cm", or "in".`,
        'INVALID_OPTIONS'
      );
    }
    opts.unit = u;
  }
  for (const rKey of ['rollPreset', 'preset', 'rollId']) {
    if (opts[rKey] !== undefined && opts[rKey] !== null) {
      const k = opts[rKey].trim().toLowerCase();
      const matched =
        k.length > 0 &&
        (k === 'custom' ||
          k === 'cricut_24x12' ||
          FABRIC_ROLL_PRESETS.some(
            (r) => r.id.toLowerCase() === k || r.name.toLowerCase() === k
          ));
      if (!matched) {
        throw new HttpError(
          400,
          `Invalid ${fieldPath}.${rKey} "${opts[rKey]}": unknown roll preset.`,
          'INVALID_OPTIONS'
        );
      }
    }
  }
  for (const key of OPTION_FINITE_FIELDS) {
    const coerced = assertOptionalFiniteInput(opts[key], `${fieldPath}.${key}`, 'INVALID_OPTIONS');
    if (coerced !== undefined) {
      opts[key] = coerced;
      if (key === 'sheetLengthMm' || key === 'rollLengthMm' || key === 'lengthMm') {
        if (coerced !== 0 && (coerced < MIN_FABRIC_DIM_MM || coerced > MAX_SHEET_LENGTH_MM)) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be 0 or between ${MIN_FABRIC_DIM_MM} and ${MAX_SHEET_LENGTH_MM} mm.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'requiredLengthMm') {
        if (coerced < 0 || coerced > MAX_NEST_TOTAL_LENGTH_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between 0 and ${MAX_NEST_TOTAL_LENGTH_MM} mm.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'fabricWidthMm' || key === 'rollWidthMm' || key === 'widthMm') {
        if (coerced < MIN_FABRIC_DIM_MM || coerced > MAX_FABRIC_WIDTH_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between ${MIN_FABRIC_DIM_MM} and ${MAX_FABRIC_WIDTH_MM} mm.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'heightMm' || key === 'pageWidthMm' || key === 'pageHeightMm') {
        if (coerced < 0 || coerced > MAX_SHEET_LENGTH_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between 0 and ${MAX_SHEET_LENGTH_MM} mm.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (
        key === 'marginMm' ||
        key === 'spacingMm' ||
        key === 'gapMm' ||
        key === 'overlapMm' ||
        key === 'padRight' ||
        key === 'padBottom' ||
        key === 'tileMarginMm' ||
        key === 'tileOverlapMm'
      ) {
        if (coerced < 0 || coerced > MAX_MARGIN_OR_SPACING_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between 0 and ${MAX_MARGIN_OR_SPACING_MM} mm.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'originX' || key === 'originY') {
        if (Math.abs(coerced) > MAX_SHEET_LENGTH_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: magnitude must be <= ${MAX_SHEET_LENGTH_MM} mm.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'scale') {
        if (coerced < 0.01 || coerced > 100) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between 0.01 and 100.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'fontSize') {
        if (coerced < 1 || coerced > 500) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between 1 and 500.`,
            'INVALID_OPTIONS'
          );
        }
      } else if (key === 'lineWidth') {
        if (coerced < 0.01 || coerced > 100) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.${key}: must be between 0.01 and 100.`,
            'INVALID_OPTIONS'
          );
        }
      }
    }
  }
  for (const boolKey of OPTION_BOOLEAN_FIELDS) {
    const val = opts[boolKey];
    if (val === undefined || val === null) continue;
    if (typeof val === 'boolean') continue;
    if (typeof val === 'string') {
      const norm = val.trim().toLowerCase();
      if (norm === 'true' || norm === '1' || norm === 'yes' || norm === 'on') {
        opts[boolKey] = true;
        continue;
      }
      if (norm === 'false' || norm === '0' || norm === 'no' || norm === 'off') {
        opts[boolKey] = false;
        continue;
      }
    }
    throw new HttpError(
      400,
      `Invalid ${fieldPath}.${boolKey}: expected a boolean.`,
      'INVALID_OPTIONS'
    );
  }
  if (opts.nestingOptions !== undefined && opts.nestingOptions !== null) {
    if (!isPlainObject(opts.nestingOptions)) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.nestingOptions: expected an object.`,
        'INVALID_OPTIONS'
      );
    }
    opts.nestingOptions = validateNestingAndExportOptions(
      opts.nestingOptions,
      `${fieldPath}.nestingOptions`
    );
  }
  if (opts.nestingResult !== undefined && opts.nestingResult !== null) {
    if (!isPlainObject(opts.nestingResult)) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.nestingResult: expected an object.`,
        'INVALID_NESTING_RESULT'
      );
    }
    const nr = stripUnsafeKeys(opts.nestingResult);
    if (nr.sheetLengthMm !== undefined) {
      nr.sheetLengthMm = assertNestingFinite(
        nr.sheetLengthMm,
        `${fieldPath}.nestingResult.sheetLengthMm`,
        true
      );
      if (
        nr.sheetLengthMm !== null &&
        nr.sheetLengthMm !== 0 &&
        (nr.sheetLengthMm < MIN_FABRIC_DIM_MM || nr.sheetLengthMm > MAX_SHEET_LENGTH_MM)
      ) {
        throw new HttpError(
          400,
          `Invalid ${fieldPath}.nestingResult.sheetLengthMm: must be 0 or between ${MIN_FABRIC_DIM_MM} and ${MAX_SHEET_LENGTH_MM} mm.`,
          'INVALID_NESTING_RESULT'
        );
      }
    }
    for (const key of NESTING_RESULT_NUMERIC_FIELDS) {
      if (nr[key] !== undefined) {
        nr[key] = assertNestingFinite(nr[key], `${fieldPath}.nestingResult.${key}`, false);
        if (nr[key] < 0) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.nestingResult.${key}: must be >= 0.`,
            'INVALID_NESTING_RESULT'
          );
        }
        if (NESTING_INTEGER_FIELDS.has(key) && (!Number.isInteger(nr[key]) || nr[key] > MAX_NESTING_PLACEMENTS)) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.nestingResult.${key}: must be a non-negative integer <= ${MAX_NESTING_PLACEMENTS}.`,
            'INVALID_NESTING_RESULT'
          );
        }
        if (NESTING_SHEET_LEN_FIELDS.has(key) && nr[key] > MAX_SHEET_LENGTH_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.nestingResult.${key}: must be <= ${MAX_SHEET_LENGTH_MM} mm.`,
            'INVALID_NESTING_RESULT'
          );
        }
        if (NESTING_TOTAL_LEN_FIELDS.has(key) && nr[key] > MAX_NEST_TOTAL_LENGTH_MM) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.nestingResult.${key}: must be <= ${MAX_NEST_TOTAL_LENGTH_MM} mm.`,
            'INVALID_NESTING_RESULT'
          );
        }
      }
    }
    if (!Array.isArray(nr.placements)) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.nestingResult.placements: expected an array of placement objects.`,
        'INVALID_NESTING_RESULT'
      );
    }
    if (nr.placements.length > MAX_NESTING_PLACEMENTS) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.nestingResult.placements: exceeds maximum allowed placements (${MAX_NESTING_PLACEMENTS}).`,
        'INVALID_NESTING_RESULT'
      );
    }
    const safePlacements = [];
    for (let i = 0; i < nr.placements.length; i++) {
      const pl = nr.placements[i];
      if (!isPlainObject(pl)) {
        throw new HttpError(
          400,
          `Invalid ${fieldPath}.nestingResult.placements[${i}]: expected an object.`,
          'INVALID_NESTING_RESULT'
        );
      }
      const safePl = stripUnsafeKeys(pl);
      for (const strKey of ['pieceId', 'pieceName', 'name']) {
        assertOptionalString(
          safePl[strKey],
          `${fieldPath}.nestingResult.placements[${i}].${strKey}`,
          'INVALID_NESTING_RESULT'
        );
      }
      for (const boolKey of ['rotated90', 'rotated', 'onFold']) {
        if (safePl[boolKey] !== undefined && typeof safePl[boolKey] !== 'boolean') {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.nestingResult.placements[${i}].${boolKey}: expected a boolean.`,
            'INVALID_NESTING_RESULT'
          );
        }
      }
      for (const numKey of NESTING_PLACEMENT_NUMERIC_FIELDS) {
        if (safePl[numKey] !== undefined) {
          const val = assertNestingFinite(
            safePl[numKey],
            `${fieldPath}.nestingResult.placements[${i}].${numKey}`,
            false
          );
          safePl[numKey] = val;
          if (PLACEMENT_INTEGER_FIELDS.has(numKey)) {
            if (!Number.isInteger(val) || val < 0 || val > MAX_NESTING_PLACEMENTS) {
              throw new HttpError(
                400,
                `Invalid ${fieldPath}.nestingResult.placements[${i}].${numKey}: must be a non-negative integer <= ${MAX_NESTING_PLACEMENTS}.`,
                'INVALID_NESTING_RESULT'
              );
            }
          } else if (PLACEMENT_DIM_FIELDS.has(numKey)) {
            if (val < 0 || val > MAX_SHEET_LENGTH_MM) {
              throw new HttpError(
                400,
                `Invalid ${fieldPath}.nestingResult.placements[${i}].${numKey}: must be between 0 and ${MAX_SHEET_LENGTH_MM} mm.`,
                'INVALID_NESTING_RESULT'
              );
            }
          } else if (PLACEMENT_COORD_FIELDS.has(numKey)) {
            if (Math.abs(val) > MAX_NEST_TOTAL_LENGTH_MM) {
              throw new HttpError(
                400,
                `Invalid ${fieldPath}.nestingResult.placements[${i}].${numKey}: magnitude must be <= ${MAX_NEST_TOTAL_LENGTH_MM} mm.`,
                'INVALID_NESTING_RESULT'
              );
            }
          }
        }
      }
      if (safePl.x === undefined && safePl.offsetX !== undefined) {
        safePl.x = safePl.offsetX;
      }
      if (safePl.y === undefined && safePl.offsetY !== undefined) {
        safePl.y = safePl.offsetY;
      }
      if (
        safePl.x === undefined ||
        safePl.x === null ||
        !Number.isFinite(safePl.x) ||
        safePl.y === undefined ||
        safePl.y === null ||
        !Number.isFinite(safePl.y)
      ) {
        throw new HttpError(
          400,
          `Invalid ${fieldPath}.nestingResult.placements[${i}]: x and y placement coordinates are required.`,
          'INVALID_NESTING_RESULT'
        );
      }
      safePlacements.push(safePl);
    }
    nr.placements = safePlacements;
    if (nr.sheets !== undefined) {
      if (!Array.isArray(nr.sheets)) {
        throw new HttpError(
          400,
          `Invalid ${fieldPath}.nestingResult.sheets: expected an array of sheet objects.`,
          'INVALID_NESTING_RESULT'
        );
      }
      if (nr.sheets.length > MAX_NESTING_PLACEMENTS) {
        throw new HttpError(
          400,
          `Invalid ${fieldPath}.nestingResult.sheets: exceeds maximum allowed sheets (${MAX_NESTING_PLACEMENTS}).`,
          'INVALID_NESTING_RESULT'
        );
      }
      const safeSheets = [];
      for (let i = 0; i < nr.sheets.length; i++) {
        const sh = nr.sheets[i];
        if (!isPlainObject(sh)) {
          throw new HttpError(
            400,
            `Invalid ${fieldPath}.nestingResult.sheets[${i}]: expected an object.`,
            'INVALID_NESTING_RESULT'
          );
        }
        const safeSh = stripUnsafeKeys(sh);
        if (safeSh.lengthMm !== undefined) {
          safeSh.lengthMm = assertNestingFinite(
            safeSh.lengthMm,
            `${fieldPath}.nestingResult.sheets[${i}].lengthMm`,
            true
          );
          if (
            safeSh.lengthMm !== null &&
            safeSh.lengthMm !== 0 &&
            (safeSh.lengthMm < MIN_FABRIC_DIM_MM || safeSh.lengthMm > MAX_SHEET_LENGTH_MM)
          ) {
            throw new HttpError(
              400,
              `Invalid ${fieldPath}.nestingResult.sheets[${i}].lengthMm: must be 0 or between ${MIN_FABRIC_DIM_MM} and ${MAX_SHEET_LENGTH_MM} mm.`,
              'INVALID_NESTING_RESULT'
            );
          }
        }
        for (const numKey of NESTING_SHEET_NUMERIC_FIELDS) {
          if (safeSh[numKey] !== undefined) {
            const val = assertNestingFinite(
              safeSh[numKey],
              `${fieldPath}.nestingResult.sheets[${i}].${numKey}`,
              false
            );
            safeSh[numKey] = val;
            if (numKey === 'sheetIndex' || numKey === 'pieceCount') {
              if (!Number.isInteger(val) || val < 0 || val > MAX_NESTING_PLACEMENTS) {
                throw new HttpError(
                  400,
                  `Invalid ${fieldPath}.nestingResult.sheets[${i}].${numKey}: must be a non-negative integer <= ${MAX_NESTING_PLACEMENTS}.`,
                  'INVALID_NESTING_RESULT'
                );
              }
            } else if (numKey === 'widthMm') {
              if (val < 0 || val > MAX_SHEET_LENGTH_MM) {
                throw new HttpError(
                  400,
                  `Invalid ${fieldPath}.nestingResult.sheets[${i}].${numKey}: must be between 0 and ${MAX_SHEET_LENGTH_MM} mm.`,
                  'INVALID_NESTING_RESULT'
                );
              }
            } else if (numKey === 'usedLengthMm') {
              if (val < 0 || val > MAX_NEST_TOTAL_LENGTH_MM) {
                throw new HttpError(
                  400,
                  `Invalid ${fieldPath}.nestingResult.sheets[${i}].${numKey}: must be between 0 and ${MAX_NEST_TOTAL_LENGTH_MM} mm.`,
                  'INVALID_NESTING_RESULT'
                );
              }
            }
          }
        }
        safeSheets.push(safeSh);
      }
      nr.sheets = safeSheets;
    }
    opts.nestingResult = nr;
  }
  return opts;
}

const MAX_PATTERN_COORD_MM = 100000;
const MAX_PATTERN_SPAN_MM = 50000;
const MAX_PIECE_QUANTITY = 1000;
const MAX_PATTERN_PIECES = 200;
const MAX_TOTAL_CUT_PIECES = 1000;
const MAX_NESTING_PLACEMENTS = 2000;
const MAX_PIECE_POINTS = 1000;
const MAX_PATTERN_VERTICES = 5000;
const MAX_PIECE_EDGES = 1000;
const MAX_PIECE_NOTCHES = 200;
const MAX_PIECE_DARTS = 100;
const MAX_PIECE_INTERNAL_LINES = 100;
const MAX_INTERNAL_LINE_POINTS = 500;
const MAX_PATTERN_SEAMS = 1000;
const MAX_SEAM_ALLOWANCE_MM = 1000;
const MAX_NOTCH_DEPTH_MM = 1000;
const MAX_DART_DIM_MM = 10000;

function assertCutPieceBudget(pattern) {
  const pieces = Array.isArray(pattern?.pieces) ? pattern.pieces : [];
  if (pieces.length > MAX_PATTERN_PIECES) {
    throw new HttpError(
      400,
      `Pattern piece count (${pieces.length}) exceeds maximum allowed (${MAX_PATTERN_PIECES}).`,
      'PATTERN_TOO_LARGE'
    );
  }
  let totalCutPieces = 0;
  for (let i = 0; i < pieces.length; i++) {
    const rawQty = pieces[i]?.quantity;
    const n = typeof rawQty === 'number' ? rawQty : Number(rawQty);
    const effQty = Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
    totalCutPieces += effQty;
    if (totalCutPieces > MAX_TOTAL_CUT_PIECES) {
      throw new HttpError(
        400,
        `Pattern total cut-piece quantity (${totalCutPieces}) exceeds maximum allowed (${MAX_TOTAL_CUT_PIECES}).`,
        'PATTERN_TOO_LARGE'
      );
    }
  }
}

function assertPointWithinMmBounds(pt, unitScale, fieldName) {
  if (!pt) return;
  if (Math.abs(pt.x * unitScale) > MAX_PATTERN_COORD_MM || Math.abs(pt.y * unitScale) > MAX_PATTERN_COORD_MM) {
    throw new HttpError(
      400,
      `${fieldName} exceeds maximum allowed coordinate magnitude (${MAX_PATTERN_COORD_MM} mm).`,
      'PATTERN_TOO_LARGE'
    );
  }
}

function validateAndSanitizePattern(
  rawPattern,
  invalidCode = 'INVALID_PATTERN',
  invalidMsg = 'Requires a pattern object with a pieces array.',
  { validateSeamRefs = true } = {}
) {
  if (!isPlainObject(rawPattern) || !Array.isArray(rawPattern.pieces)) {
    throw new ValidationError(invalidMsg, { code: invalidCode, path: 'pattern' });
  }
  if (rawPattern.pieces.length > MAX_PATTERN_PIECES) {
    throw new HttpError(
      400,
      `Pattern piece count (${rawPattern.pieces.length}) exceeds maximum allowed (${MAX_PATTERN_PIECES}).`,
      'PATTERN_TOO_LARGE'
    );
  }
  if (rawPattern.unit !== undefined) {
    assertOptionalString(rawPattern.unit, 'pattern.unit', 'INVALID_UNIT');
    if (rawPattern.unit === null || !Object.hasOwn(UNIT_FACTORS, rawPattern.unit)) {
      throw new HttpError(
        400,
        `Unsupported pattern unit "${String(rawPattern.unit)}". Expected one of: ${Object.keys(UNIT_FACTORS).join(', ')}.`,
        'INVALID_UNIT'
      );
    }
  }
  const unitScale =
    rawPattern.unit && Object.hasOwn(UNIT_FACTORS, rawPattern.unit)
      ? UNIT_FACTORS[rawPattern.unit]
      : 1;

  let patMinX = Infinity;
  let patMinY = Infinity;
  let patMaxX = -Infinity;
  let patMaxY = -Infinity;
  let totalCutPieces = 0;

  const safePieces = [];
  const origPieceIds = [];
  let totalVertices = 0;
  let totalInternalLinePoints = 0;
  for (let i = 0; i < rawPattern.pieces.length; i++) {
    const pc = rawPattern.pieces[i];
    if (
      !isPlainObject(pc) ||
      !Array.isArray(pc.points) ||
      pc.points.length < 3 ||
      !pc.points.every(
        (pt) =>
          isPlainObject(pt) &&
          typeof pt.x === 'number' &&
          Number.isFinite(pt.x) &&
          typeof pt.y === 'number' &&
          Number.isFinite(pt.y)
      )
    ) {
      throw new HttpError(
        400,
        `Invalid pattern piece at index ${i}: each piece must have a points array with at least 3 finite {x, y} vertices.`,
        'INVALID_PIECE'
      );
    }
    if (pc.points.length > MAX_PIECE_POINTS) {
      throw new HttpError(
        400,
        `Pattern piece at index ${i} has ${pc.points.length} vertices, exceeding maximum allowed (${MAX_PIECE_POINTS}).`,
        'PATTERN_TOO_COMPLEX'
      );
    }
    totalVertices += pc.points.length;
    if (totalVertices > MAX_PATTERN_VERTICES) {
      throw new HttpError(
        400,
        `Pattern total vertex count (${totalVertices}) exceeds maximum allowed (${MAX_PATTERN_VERTICES}).`,
        'PATTERN_TOO_COMPLEX'
      );
    }
    let pieceMinX = Infinity;
    let pieceMinY = Infinity;
    let pieceMaxX = -Infinity;
    let pieceMaxY = -Infinity;
    for (let pIdx = 0; pIdx < pc.points.length; pIdx++) {
      const pt = pc.points[pIdx];
      assertPointWithinMmBounds(pt, unitScale, `pieces[${i}].points[${pIdx}]`);
      const xMm = pt.x * unitScale;
      const yMm = pt.y * unitScale;
      if (xMm < pieceMinX) pieceMinX = xMm;
      if (yMm < pieceMinY) pieceMinY = yMm;
      if (xMm > pieceMaxX) pieceMaxX = xMm;
      if (yMm > pieceMaxY) pieceMaxY = yMm;
      if (xMm < patMinX) patMinX = xMm;
      if (yMm < patMinY) patMinY = yMm;
      if (xMm > patMaxX) patMaxX = xMm;
      if (yMm > patMaxY) patMaxY = yMm;
    }
    if (pieceMaxX - pieceMinX > MAX_PATTERN_SPAN_MM || pieceMaxY - pieceMinY > MAX_PATTERN_SPAN_MM) {
      throw new HttpError(
        400,
        `Pattern piece at index ${i} exceeds maximum allowed span (${MAX_PATTERN_SPAN_MM} mm).`,
        'PATTERN_TOO_LARGE'
      );
    }
    const coercedSeamAllowance = assertOptionalFiniteInput(pc.seamAllowance, `pieces[${i}].seamAllowance`, 'INVALID_PIECE');
    if (
      coercedSeamAllowance !== undefined &&
      (coercedSeamAllowance < 0 || coercedSeamAllowance * unitScale > MAX_SEAM_ALLOWANCE_MM)
    ) {
      throw new HttpError(
        400,
        `Invalid pieces[${i}].seamAllowance: scaled value must be between 0 and ${MAX_SEAM_ALLOWANCE_MM} mm.`,
        'INVALID_PIECE'
      );
    }
    if (pc.quantity === null || (typeof pc.quantity === 'string' && pc.quantity.trim() === '')) {
      throw new HttpError(
        400,
        `Invalid pieces[${i}].quantity: expected an integer between 1 and ${MAX_PIECE_QUANTITY}.`,
        'INVALID_PIECE'
      );
    }
    const coercedQuantity = assertOptionalFiniteInput(pc.quantity, `pieces[${i}].quantity`, 'INVALID_PIECE');
    if (
      coercedQuantity !== undefined &&
      (!Number.isInteger(coercedQuantity) || coercedQuantity < 1 || coercedQuantity > MAX_PIECE_QUANTITY)
    ) {
      throw new HttpError(
        400,
        `Invalid pieces[${i}].quantity: must be an integer between 1 and ${MAX_PIECE_QUANTITY}.`,
        'INVALID_PIECE'
      );
    }
    const effectiveQty =
      coercedQuantity !== undefined && coercedQuantity >= 1
        ? Math.trunc(coercedQuantity)
        : 1;
    totalCutPieces += effectiveQty;
    if (totalCutPieces > MAX_TOTAL_CUT_PIECES) {
      throw new HttpError(
        400,
        `Pattern total cut-piece quantity (${totalCutPieces}) exceeds maximum allowed (${MAX_TOTAL_CUT_PIECES}).`,
        'PATTERN_TOO_LARGE'
      );
    }
    const coercedRotation = assertOptionalFiniteInput(pc.rotation, `pieces[${i}].rotation`, 'INVALID_PIECE');
    if (pc.position !== undefined && pc.position !== null) {
      assertFinitePoint2D(pc.position, `pieces[${i}].position`, 'INVALID_PIECE');
      assertPointWithinMmBounds(pc.position, unitScale, `pieces[${i}].position`);
    }
    if (pc.rotationOrigin !== undefined && pc.rotationOrigin !== null) {
      assertFinitePoint2D(pc.rotationOrigin, `pieces[${i}].rotationOrigin`, 'INVALID_PIECE');
      assertPointWithinMmBounds(pc.rotationOrigin, unitScale, `pieces[${i}].rotationOrigin`);
    }

    let safeEdges;
    if (pc.edges !== undefined) {
      if (!Array.isArray(pc.edges)) {
        throw new HttpError(
          400,
          `Invalid pattern piece at index ${i}: edges must be an array.`,
          'INVALID_EDGE'
        );
      }
      if (pc.edges.length > MAX_PIECE_EDGES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} has ${pc.edges.length} edges, exceeding maximum allowed (${MAX_PIECE_EDGES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      safeEdges = [];
      for (let j = 0; j < pc.edges.length; j++) {
        const edge = pc.edges[j];
        if (edge === undefined || edge === null) {
          safeEdges.push(edge);
          continue;
        }
        if (!isPlainObject(edge)) {
          throw new HttpError(
            400,
            `Invalid edge at pieces[${i}].edges[${j}]: expected an object.`,
            'INVALID_EDGE'
          );
        }
        const coercedEdgeSeamAllowance = assertOptionalFiniteInput(
          edge.seamAllowance,
          `pieces[${i}].edges[${j}].seamAllowance`,
          'INVALID_PIECE'
        );
        if (
          coercedEdgeSeamAllowance !== undefined &&
          (coercedEdgeSeamAllowance < 0 || coercedEdgeSeamAllowance * unitScale > MAX_SEAM_ALLOWANCE_MM)
        ) {
          throw new HttpError(
            400,
            `Invalid pieces[${i}].edges[${j}].seamAllowance: scaled value must be between 0 and ${MAX_SEAM_ALLOWANCE_MM} mm.`,
            'INVALID_EDGE'
          );
        }
        if (edge.curve !== undefined && edge.curve !== null) {
          if (!isPlainObject(edge.curve)) {
            throw new HttpError(
              400,
              `Invalid curve at pieces[${i}].edges[${j}].curve: expected an object.`,
              'INVALID_CURVE'
            );
          }
          if (
            edge.curve.type !== undefined &&
            edge.curve.type !== null &&
            typeof edge.curve.type !== 'string'
          ) {
            throw new HttpError(
              400,
              `Invalid curve.type at pieces[${i}].edges[${j}].curve.type: expected a string.`,
              'INVALID_CURVE'
            );
          }
          for (const cpKey of ['cp', 'cp1', 'cp2']) {
            const pt = edge.curve[cpKey];
            if (pt !== undefined && pt !== null) {
              assertFinitePoint2D(
                pt,
                `pieces[${i}].edges[${j}].curve.${cpKey}`,
                'INVALID_CURVE'
              );
              assertPointWithinMmBounds(pt, unitScale, `pieces[${i}].edges[${j}].curve.${cpKey}`);
              const xMm = pt.x * unitScale;
              const yMm = pt.y * unitScale;
              if (xMm < pieceMinX) pieceMinX = xMm;
              if (yMm < pieceMinY) pieceMinY = yMm;
              if (xMm > pieceMaxX) pieceMaxX = xMm;
              if (yMm > pieceMaxY) pieceMaxY = yMm;
              if (xMm < patMinX) patMinX = xMm;
              if (yMm < patMinY) patMinY = yMm;
              if (xMm > patMaxX) patMaxX = xMm;
              if (yMm > patMaxY) patMaxY = yMm;
            }
          }
        }
        safeEdges.push({
          ...edge,
          ...(edge.seamAllowance !== undefined ? { seamAllowance: coercedEdgeSeamAllowance } : {}),
          ...(edge.name !== undefined
            ? { name: safePieceLabel(edge.name, `Edge ${j + 1}`) }
            : {}),
        });
      }
    }
    if (pieceMaxX - pieceMinX > MAX_PATTERN_SPAN_MM || pieceMaxY - pieceMinY > MAX_PATTERN_SPAN_MM) {
      throw new HttpError(
        400,
        `Pattern piece at index ${i} (including curves) exceeds maximum allowed span (${MAX_PATTERN_SPAN_MM} mm).`,
        'PATTERN_TOO_LARGE'
      );
    }

    let safeDarts;
    if (pc.darts !== undefined && pc.darts !== null) {
      if (!Array.isArray(pc.darts)) {
        throw new HttpError(
          400,
          `Invalid pattern piece at index ${i}: darts must be an array.`,
          'INVALID_DART'
        );
      }
      if (pc.darts.length > MAX_PIECE_DARTS) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} has ${pc.darts.length} darts, exceeding maximum allowed (${MAX_PIECE_DARTS}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      safeDarts = [];
      for (let dIdx = 0; dIdx < pc.darts.length; dIdx++) {
        const dart = pc.darts[dIdx];
        if (!isPlainObject(dart)) {
          throw new HttpError(
            400,
            `Invalid dart at pieces[${i}].darts[${dIdx}]: expected an object.`,
            'INVALID_DART'
          );
        }
        for (const numKey of ['edgeIndex', 't', 'widthMm', 'depthMm']) {
          if (dart[numKey] !== undefined) {
            dart[numKey] = assertStrictFiniteNumber(
              dart[numKey],
              `pieces[${i}].darts[${dIdx}].${numKey}`,
              'INVALID_DART'
            );
          }
        }
        if (
          dart.edgeIndex !== undefined &&
          (!Number.isInteger(dart.edgeIndex) || dart.edgeIndex < 0 || dart.edgeIndex >= pc.points.length)
        ) {
          throw new HttpError(
            400,
            `Invalid dart at pieces[${i}].darts[${dIdx}].edgeIndex (${dart.edgeIndex}): out of bounds for ${pc.points.length} edges.`,
            'INVALID_DART'
          );
        }
        for (const dimKey of ['widthMm', 'depthMm']) {
          if (
            dart[dimKey] !== undefined &&
            (dart[dimKey] < 0 || dart[dimKey] * unitScale > MAX_DART_DIM_MM)
          ) {
            throw new HttpError(
              400,
              `Invalid pieces[${i}].darts[${dIdx}].${dimKey}: scaled value must be between 0 and ${MAX_DART_DIM_MM} mm.`,
              'INVALID_DART'
            );
          }
        }
        if (dart.folded !== undefined && typeof dart.folded !== 'boolean') {
          throw new HttpError(
            400,
            `Invalid dart at pieces[${i}].darts[${dIdx}].folded: expected a boolean.`,
            'INVALID_DART'
          );
        }
        safeDarts.push({
          ...dart,
          ...(dart.id !== undefined ? { id: safePieceLabel(dart.id, `dart_${dIdx + 1}`) } : {}),
        });
      }
    }

    let safeNotches;
    if (pc.notches !== undefined && pc.notches !== null) {
      if (!Array.isArray(pc.notches)) {
        throw new HttpError(
          400,
          `Invalid pattern piece at index ${i}: notches must be an array.`,
          'INVALID_NOTCH'
        );
      }
      if (pc.notches.length > MAX_PIECE_NOTCHES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} has ${pc.notches.length} notches, exceeding maximum allowed (${MAX_PIECE_NOTCHES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      safeNotches = [];
      for (let nIdx = 0; nIdx < pc.notches.length; nIdx++) {
        const notch = pc.notches[nIdx];
        if (!isPlainObject(notch)) {
          throw new HttpError(
            400,
            `Invalid notch at pieces[${i}].notches[${nIdx}]: expected an object.`,
            'INVALID_NOTCH'
          );
        }
        for (const numKey of ['edgeIndex', 't', 'depthMm']) {
          if (notch[numKey] !== undefined) {
            notch[numKey] = assertStrictFiniteNumber(
              notch[numKey],
              `pieces[${i}].notches[${nIdx}].${numKey}`,
              'INVALID_NOTCH'
            );
          }
        }
        if (
          notch.edgeIndex !== undefined &&
          (!Number.isInteger(notch.edgeIndex) || notch.edgeIndex < 0 || notch.edgeIndex >= pc.points.length)
        ) {
          throw new HttpError(
            400,
            `Invalid notch at pieces[${i}].notches[${nIdx}].edgeIndex (${notch.edgeIndex}): out of bounds for ${pc.points.length} edges.`,
            'INVALID_NOTCH'
          );
        }
        if (
          notch.depthMm !== undefined &&
          (notch.depthMm < 0 || notch.depthMm * unitScale > MAX_NOTCH_DEPTH_MM)
        ) {
          throw new HttpError(
            400,
            `Invalid pieces[${i}].notches[${nIdx}].depthMm: scaled value must be between 0 and ${MAX_NOTCH_DEPTH_MM} mm.`,
            'INVALID_NOTCH'
          );
        }
        if (notch.type !== undefined && notch.type !== null && typeof notch.type !== 'string') {
          throw new HttpError(
            400,
            `Invalid notch at pieces[${i}].notches[${nIdx}].type: expected a string.`,
            'INVALID_NOTCH'
          );
        }
        safeNotches.push({
          ...notch,
          ...(notch.id !== undefined
            ? { id: safePieceLabel(notch.id, `notch_${nIdx + 1}`) }
            : {}),
        });
      }
    }

    if (pc.grainline !== undefined && pc.grainline !== null) {
      if (!isPlainObject(pc.grainline)) {
        throw new HttpError(
          400,
          `Invalid grainline at pieces[${i}].grainline: expected an object.`,
          'INVALID_GRAINLINE'
        );
      }
      if (pc.grainline.angleDeg !== undefined) {
        assertStrictFiniteNumber(
          pc.grainline.angleDeg,
          `pieces[${i}].grainline.angleDeg`,
          'INVALID_GRAINLINE'
        );
      }
      for (const endKey of ['start', 'end']) {
        if (pc.grainline[endKey] !== undefined && pc.grainline[endKey] !== null) {
          assertFinitePoint2D(
            pc.grainline[endKey],
            `pieces[${i}].grainline.${endKey}`,
            'INVALID_GRAINLINE'
          );
          assertPointWithinMmBounds(pc.grainline[endKey], unitScale, `pieces[${i}].grainline.${endKey}`);
          const xMm = pc.grainline[endKey].x * unitScale;
          const yMm = pc.grainline[endKey].y * unitScale;
          if (xMm < pieceMinX) pieceMinX = xMm;
          if (yMm < pieceMinY) pieceMinY = yMm;
          if (xMm > pieceMaxX) pieceMaxX = xMm;
          if (yMm > pieceMaxY) pieceMaxY = yMm;
          if (xMm < patMinX) patMinX = xMm;
          if (yMm < patMinY) patMinY = yMm;
          if (xMm > patMaxX) patMaxX = xMm;
          if (yMm > patMaxY) patMaxY = yMm;
        }
      }
      if (pieceMaxX - pieceMinX > MAX_PATTERN_SPAN_MM || pieceMaxY - pieceMinY > MAX_PATTERN_SPAN_MM) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} (including grainline) exceeds maximum allowed span (${MAX_PATTERN_SPAN_MM} mm).`,
          'PATTERN_TOO_LARGE'
        );
      }
    }

    if (pc.placement3D !== undefined && pc.placement3D !== null) {
      if (!isPlainObject(pc.placement3D)) {
        throw new HttpError(
          400,
          `Invalid placement3D at pieces[${i}].placement3D: expected an object.`,
          'INVALID_PLACEMENT_3D'
        );
      }
      for (const vecKey of ['offset', 'normal', 'up']) {
        if (pc.placement3D[vecKey] !== undefined && pc.placement3D[vecKey] !== null) {
          assertFiniteVec3(
            pc.placement3D[vecKey],
            `pieces[${i}].placement3D.${vecKey}`,
            'INVALID_PLACEMENT_3D'
          );
        }
      }
    }

    let safeInternalLines;
    if (pc.internalLines !== undefined) {
      if (!Array.isArray(pc.internalLines)) {
        throw new HttpError(
          400,
          `Invalid pattern piece at index ${i}: internalLines must be an array.`,
          'INVALID_INTERNAL_LINE'
        );
      }
      if (pc.internalLines.length > MAX_PIECE_INTERNAL_LINES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} has ${pc.internalLines.length} internalLines, exceeding maximum allowed (${MAX_PIECE_INTERNAL_LINES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      safeInternalLines = [];
      for (let k = 0; k < pc.internalLines.length; k++) {
        const ln = pc.internalLines[k];
        if (!isPlainObject(ln)) {
          throw new HttpError(
            400,
            `Invalid internalLine at pieces[${i}].internalLines[${k}]: expected an object.`,
            'INVALID_INTERNAL_LINE'
          );
        }
        assertOptionalString(
          ln.type,
          `pieces[${i}].internalLines[${k}].type`,
          'INVALID_INTERNAL_LINE'
        );
        if (ln.points !== undefined) {
          if (
            !Array.isArray(ln.points) ||
            !ln.points.every(
              (pt) =>
                isPlainObject(pt) &&
                typeof pt.x === 'number' &&
                Number.isFinite(pt.x) &&
                typeof pt.y === 'number' &&
                Number.isFinite(pt.y)
            )
          ) {
            throw new HttpError(
              400,
              `Invalid internalLine points at pieces[${i}].internalLines[${k}]: expected an array of finite {x, y} points.`,
              'INVALID_INTERNAL_LINE'
            );
          }
          if (ln.points.length > MAX_INTERNAL_LINE_POINTS) {
            throw new HttpError(
              400,
              `Internal line at pieces[${i}].internalLines[${k}] has ${ln.points.length} points, exceeding maximum allowed (${MAX_INTERNAL_LINE_POINTS}).`,
              'PATTERN_TOO_COMPLEX'
            );
          }
          totalInternalLinePoints += ln.points.length;
          if (totalInternalLinePoints > MAX_PATTERN_INTERNAL_LINE_POINTS) {
            throw new HttpError(
              400,
              `Pattern total internalLine points (${totalInternalLinePoints}) exceeds maximum allowed (${MAX_PATTERN_INTERNAL_LINE_POINTS}).`,
              'PATTERN_TOO_COMPLEX'
            );
          }
          for (let lIdx = 0; lIdx < ln.points.length; lIdx++) {
            const lpt = ln.points[lIdx];
            assertPointWithinMmBounds(
              lpt,
              unitScale,
              `pieces[${i}].internalLines[${k}].points[${lIdx}]`
            );
            const xMm = lpt.x * unitScale;
            const yMm = lpt.y * unitScale;
            if (xMm < pieceMinX) pieceMinX = xMm;
            if (yMm < pieceMinY) pieceMinY = yMm;
            if (xMm > pieceMaxX) pieceMaxX = xMm;
            if (yMm > pieceMaxY) pieceMaxY = yMm;
            if (xMm < patMinX) patMinX = xMm;
            if (yMm < patMinY) patMinY = yMm;
            if (xMm > patMaxX) patMaxX = xMm;
            if (yMm > patMaxY) patMaxY = yMm;
          }
        }
        safeInternalLines.push({
          ...ln,
          ...(ln.id !== undefined ? { id: safePieceLabel(ln.id, `internal_${k + 1}`) } : {}),
          ...(ln.name !== undefined
            ? { name: safePieceLabel(ln.name, `Internal ${k + 1}`) }
            : {}),
        });
      }
      if (pieceMaxX - pieceMinX > MAX_PATTERN_SPAN_MM || pieceMaxY - pieceMinY > MAX_PATTERN_SPAN_MM) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} (including internalLines) exceeds maximum allowed span (${MAX_PATTERN_SPAN_MM} mm).`,
          'PATTERN_TOO_LARGE'
        );
      }
    }

    const origId = typeof pc.id === 'string' && pc.id.length > 0 ? pc.id : null;
    const sanitizedId = pc.id !== undefined ? safePieceLabel(pc.id, `piece_${i + 1}`) : undefined;
    origPieceIds.push(origId);
    safePieces.push({
      ...pc,
      ...(pc.seamAllowance !== undefined ? { seamAllowance: coercedSeamAllowance } : {}),
      ...(pc.quantity !== undefined ? { quantity: coercedQuantity } : {}),
      ...(pc.rotation !== undefined ? { rotation: coercedRotation } : {}),
      ...(safeEdges !== undefined ? { edges: safeEdges } : {}),
      ...(safeDarts !== undefined ? { darts: safeDarts } : {}),
      ...(safeNotches !== undefined ? { notches: safeNotches } : {}),
      ...(safeInternalLines !== undefined ? { internalLines: safeInternalLines } : {}),
      ...(pc.name !== undefined ? { name: safePieceLabel(pc.name, `Piece ${i + 1}`) } : {}),
      ...(sanitizedId !== undefined ? { id: sanitizedId } : {}),
    });
  }

  if (
    safePieces.length > 0 &&
    (patMaxX - patMinX > MAX_PATTERN_SPAN_MM || patMaxY - patMinY > MAX_PATTERN_SPAN_MM)
  ) {
    throw new HttpError(
      400,
      `Pattern overall span exceeds maximum allowed span (${MAX_PATTERN_SPAN_MM} mm).`,
      'PATTERN_TOO_LARGE'
    );
  }

  let safeSeams;
  if (rawPattern.seams !== undefined) {
    if (!Array.isArray(rawPattern.seams)) {
      throw new HttpError(
        400,
        'Invalid pattern.seams: expected an array of seam objects.',
        'INVALID_SEAM'
      );
    }
    if (rawPattern.seams.length > MAX_PATTERN_SEAMS) {
      throw new HttpError(
        400,
        `Pattern has ${rawPattern.seams.length} seams, exceeding maximum allowed (${MAX_PATTERN_SEAMS}).`,
        'PATTERN_TOO_COMPLEX'
      );
    }
    safeSeams = [];
    const pieceById = new Map();
    for (let pIdx = 0; pIdx < safePieces.length; pIdx++) {
      const pItem = safePieces[pIdx];
      const pid = resolveServerPieceId(pItem, pIdx);
      const entry = { piece: pItem, resolvedId: pid };
      if (!pieceById.has(pid)) pieceById.set(pid, entry);
      const origId = origPieceIds[pIdx];
      if (origId && !pieceById.has(origId)) pieceById.set(origId, entry);
    }
    const fallbackSanitizedPieces = [];
    for (let pIdx = 0; pIdx < safePieces.length; pIdx++) {
      const rawId = rawPattern.pieces[pIdx]?.id;
      if (
        rawId !== undefined &&
        typeof rawId !== 'string' &&
        typeof safePieces[pIdx].id === 'string' &&
        safePieces[pIdx].id === `piece_${pIdx + 1}`
      ) {
        fallbackSanitizedPieces.push(safePieces[pIdx]);
      }
    }
    const maxFallbackEdges = fallbackSanitizedPieces.reduce(
      (mx, p) => Math.max(mx, Array.isArray(p.points) ? p.points.length : 0),
      0
    );
    const unresolvedMissingRefs = new Set();
    for (let sIdx = 0; sIdx < rawPattern.seams.length; sIdx++) {
      const seam = rawPattern.seams[sIdx];
      if (!isPlainObject(seam)) {
        throw new HttpError(
          400,
          'Invalid pattern.seams: expected an array of seam objects.',
          'INVALID_SEAM'
        );
      }
      for (const strKey of ['pieceA', 'pieceB', 'internalLineIdB', 'type']) {
        assertOptionalString(seam[strKey], `pattern.seams[${sIdx}].${strKey}`, 'INVALID_SEAM');
      }
      if (
        seam.internalLineIdB !== undefined &&
        (typeof seam.internalLineIdB !== 'string' || seam.internalLineIdB.trim().length === 0)
      ) {
        throw new HttpError(
          400,
          `Invalid seam at pattern.seams[${sIdx}].internalLineIdB: non-empty string required when specified.`,
          'INVALID_SEAM'
        );
      }
      const coercedSeamNums = {};
      for (const numKey of [
        'edgeA',
        'edgeB',
        'tStartA',
        'tEndA',
        'tStartB',
        'tEndB',
        'internalSegmentIndexB',
      ]) {
        if (seam[numKey] !== undefined) {
          if (seam[numKey] === null || (typeof seam[numKey] === 'string' && seam[numKey].trim() === '')) {
            throw new HttpError(
              400,
              `Invalid seam at pattern.seams[${sIdx}].${numKey}: expected a finite number.`,
              'INVALID_SEAM'
            );
          }
          const coerced = assertOptionalFiniteInput(
            seam[numKey],
            `pattern.seams[${sIdx}].${numKey}`,
            'INVALID_SEAM'
          );
          coercedSeamNums[numKey] = coerced;
        }
      }

      if (typeof seam.pieceA !== 'string' || seam.pieceA.trim().length === 0) {
        throw new HttpError(
          400,
          `Invalid seam at pattern.seams[${sIdx}].pieceA: non-empty pieceA string is required.`,
          'INVALID_SEAM'
        );
      }
      if (typeof seam.pieceB !== 'string' || seam.pieceB.trim().length === 0) {
        throw new HttpError(
          400,
          `Invalid seam at pattern.seams[${sIdx}].pieceB: non-empty pieceB string is required.`,
          'INVALID_SEAM'
        );
      }

      const hasInternalTarget =
        typeof seam.internalLineIdB === 'string' && seam.internalLineIdB.trim().length > 0;
      const edgeA = coercedSeamNums.edgeA;
      if (edgeA === undefined || !Number.isInteger(edgeA) || edgeA < 0) {
        throw new HttpError(
          400,
          `Invalid seam at pattern.seams[${sIdx}].edgeA (${edgeA}): non-negative integer edgeA is required.`,
          'INVALID_SEAM'
        );
      }
      const edgeB = coercedSeamNums.edgeB;
      if (hasInternalTarget) {
        if (edgeB !== undefined && (!Number.isInteger(edgeB) || edgeB < 0)) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].edgeB (${edgeB}): non-negative integer edgeB is required when specified.`,
            'INVALID_SEAM'
          );
        }
      } else if (edgeB === undefined || !Number.isInteger(edgeB) || edgeB < 0) {
        throw new HttpError(
          400,
          `Invalid seam at pattern.seams[${sIdx}].edgeB (${edgeB}): non-negative integer edgeB is required.`,
          'INVALID_SEAM'
        );
      }

      const tStartA = coercedSeamNums.tStartA ?? 0;
      const tEndA = coercedSeamNums.tEndA ?? 1;
      const tStartB = coercedSeamNums.tStartB ?? 0;
      const tEndB = coercedSeamNums.tEndB ?? 1;
      if (tStartA < 0 || tEndA > 1 || tStartA >= tEndA) {
        throw new HttpError(
          400,
          `Invalid seam range [${tStartA}, ${tEndA}] at pattern.seams[${sIdx}].tStartA/tEndA.`,
          'INVALID_SEAM_RANGE'
        );
      }
      if (tStartB < 0 || tEndB > 1 || tStartB >= tEndB) {
        throw new HttpError(
          400,
          `Invalid seam range [${tStartB}, ${tEndB}] at pattern.seams[${sIdx}].tStartB/tEndB.`,
          'INVALID_SEAM_RANGE'
        );
      }

      let resolvedPieceA = seam.pieceA;
      let resolvedPieceB = seam.pieceB;
      const entryA = pieceById.get(seam.pieceA);
      if (!entryA) {
        if (validateSeamRefs || fallbackSanitizedPieces.length === 0) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].pieceA: piece "${seam.pieceA}" not found.`,
            'INVALID_SEAM'
          );
        }
        unresolvedMissingRefs.add(seam.pieceA);
        if (unresolvedMissingRefs.size > fallbackSanitizedPieces.length) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].pieceA: piece "${seam.pieceA}" not found.`,
            'INVALID_SEAM'
          );
        }
        if (edgeA >= maxFallbackEdges) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].edgeA (${edgeA}): out of bounds for piece "${seam.pieceA}".`,
            'INVALID_SEAM'
          );
        }
      } else {
        const pcA = entryA.piece;
        resolvedPieceA = entryA.resolvedId;
        if (edgeA >= pcA.points.length) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].edgeA (${edgeA}): out of bounds for piece "${seam.pieceA}" (${pcA.points.length} edges).`,
            'INVALID_SEAM'
          );
        }
      }

      const entryB = pieceById.get(seam.pieceB);
      if (!entryB) {
        if (validateSeamRefs || fallbackSanitizedPieces.length === 0) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].pieceB: piece "${seam.pieceB}" not found.`,
            'INVALID_SEAM'
          );
        }
        unresolvedMissingRefs.add(seam.pieceB);
        if (unresolvedMissingRefs.size > fallbackSanitizedPieces.length) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].pieceB: piece "${seam.pieceB}" not found.`,
            'INVALID_SEAM'
          );
        }
        if (hasInternalTarget) {
          const effectiveSegIdx =
            coercedSeamNums.internalSegmentIndexB !== undefined
              ? coercedSeamNums.internalSegmentIndexB
              : 0;
          const hasMatchingLine = fallbackSanitizedPieces.some((fp) => {
            const lineB = Array.isArray(fp.internalLines)
              ? fp.internalLines.find((il) => il && il.id === seam.internalLineIdB)
              : null;
            if (!lineB) return false;
            const segCount = Array.isArray(lineB.points) ? Math.max(0, lineB.points.length - 1) : 0;
            return (
              Number.isInteger(effectiveSegIdx) &&
              effectiveSegIdx >= 0 &&
              effectiveSegIdx < segCount
            );
          });
          if (!hasMatchingLine) {
            throw new HttpError(
              400,
              `Invalid seam at pattern.seams[${sIdx}].internalLineIdB: internal line "${seam.internalLineIdB}" not found or has no segments on piece "${seam.pieceB}".`,
              'INVALID_SEAM'
            );
          }
        } else if (edgeB >= maxFallbackEdges) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].edgeB (${edgeB}): out of bounds for piece "${seam.pieceB}".`,
            'INVALID_SEAM'
          );
        }
      } else {
        const pcB = entryB.piece;
        resolvedPieceB = entryB.resolvedId;
        if (hasInternalTarget) {
          const lineB = Array.isArray(pcB.internalLines)
            ? pcB.internalLines.find((il) => il && il.id === seam.internalLineIdB)
            : null;
          if (!lineB) {
            throw new HttpError(
              400,
              `Invalid seam at pattern.seams[${sIdx}].internalLineIdB: internal line "${seam.internalLineIdB}" not found on piece "${seam.pieceB}".`,
              'INVALID_SEAM'
            );
          }
          const effectiveSegIdx =
            coercedSeamNums.internalSegmentIndexB !== undefined
              ? coercedSeamNums.internalSegmentIndexB
              : 0;
          const segCount = Array.isArray(lineB.points) ? Math.max(0, lineB.points.length - 1) : 0;
          if (
            !Number.isInteger(effectiveSegIdx) ||
            effectiveSegIdx < 0 ||
            effectiveSegIdx >= segCount
          ) {
            throw new HttpError(
              400,
              `Invalid seam at pattern.seams[${sIdx}].internalSegmentIndexB (${effectiveSegIdx}): out of bounds.`,
              'INVALID_SEAM'
            );
          }
        } else if (edgeB >= pcB.points.length) {
          throw new HttpError(
            400,
            `Invalid seam at pattern.seams[${sIdx}].edgeB (${edgeB}): out of bounds for piece "${seam.pieceB}" (${pcB.points.length} edges).`,
            'INVALID_SEAM'
          );
        }
      }

      if (!hasInternalTarget && resolvedPieceA === resolvedPieceB && edgeA === edgeB) {
        const overlap = Math.min(tEndA, tEndB) - Math.max(tStartA, tStartB);
        if (overlap > 1e-6) {
          throw new HttpError(
            400,
            `Invalid self-identical seam on ${resolvedPieceA}:${edgeA} at pattern.seams[${sIdx}].`,
            'INVALID_SEAM'
          );
        }
      }
      safeSeams.push({
        ...seam,
        ...(resolvedPieceA !== undefined ? { pieceA: resolvedPieceA } : {}),
        ...(resolvedPieceB !== undefined ? { pieceB: resolvedPieceB } : {}),
        ...coercedSeamNums,
        ...(seam.id !== undefined ? { id: safePieceLabel(seam.id, `seam_${sIdx + 1}`) } : {}),
        ...(seam.name !== undefined ? { name: safePieceLabel(seam.name, `Seam ${sIdx + 1}`) } : {}),
      });
    }
  }

  const safeName = safePatternName(rawPattern.name);
  return {
    safeName,
    safePattern: {
      ...rawPattern,
      name: safeName,
      pieces: safePieces,
      ...(safeSeams !== undefined ? { seams: safeSeams } : {}),
    },
  };
}

function makeFileSlug(name, fallback = 'pattern') {
  const s = safePatternName(name)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (s || fallback).slice(0, 64);
}

/**
 * Safely resolves an untrusted relative URL path inside `rootDir`.
 * Rejects bad URI encoding (400), null bytes (403), directory traversal (403),
 * sibling prefix bypasses (403), and symlinks escaping `rootDir` (403).
 */
export function safeResolveInside(rootDir, unsafeRelPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(unsafeRelPath ?? ''));
  } catch {
    throw new HttpError(400, 'Malformed URI encoding in path.', 'BAD_URI');
  }

  if (decoded.includes('\0')) {
    throw new HttpError(403, 'Null byte in path is forbidden.', 'FORBIDDEN');
  }

  // Normalize Windows-style separators before resolving
  const normalizedSlash = decoded.replace(/\\/g, '/');
  const rel = normalizedSlash.replace(/^\/+/, '');
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.some((seg) => seg.startsWith('.'))) {
    // Block '..' segments and hidden dotfiles immediately
    if (segments.includes('..')) {
      throw new HttpError(403, 'Path traversal is forbidden.', 'FORBIDDEN');
    }
    throw new HttpError(403, 'Hidden files are forbidden.', 'FORBIDDEN');
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch {
    throw new HttpError(404, 'Root directory not found.', 'NOT_FOUND');
  }

  const candidate = path.resolve(rootReal, rel);
  const relCandidate = path.relative(rootReal, candidate);
  if (
    relCandidate === '..' ||
    relCandidate.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relCandidate)
  ) {
    throw new HttpError(403, 'Path escapes root directory.', 'FORBIDDEN');
  }

  if (!fs.existsSync(candidate)) {
    throw new HttpError(404, 'File not found.', 'NOT_FOUND');
  }

  let targetReal;
  try {
    targetReal = fs.realpathSync(candidate);
  } catch {
    throw new HttpError(404, 'File not found.', 'NOT_FOUND');
  }

  const relReal = path.relative(rootReal, targetReal);
  if (
    relReal === '..' ||
    relReal.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relReal)
  ) {
    throw new HttpError(403, 'Symlink target escapes root directory.', 'FORBIDDEN');
  }

  const stat = fs.statSync(targetReal);
  if (!stat.isFile()) {
    throw new HttpError(404, 'Requested path is not a regular file.', 'NOT_FOUND');
  }

  return targetReal;
}

function parseJsonObjectFromBytes(bytesOrBuffer) {
  if (!bytesOrBuffer || bytesOrBuffer.byteLength === 0) {
    return {};
  }
  const buf = Buffer.isBuffer(bytesOrBuffer)
    ? bytesOrBuffer
    : Buffer.from(bytesOrBuffer.buffer, bytesOrBuffer.byteOffset, bytesOrBuffer.byteLength);
  const rawText = buf.toString('utf8');
  if (rawText.trim().length === 0) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new HttpError(400, `Invalid JSON body: ${err.message}`, 'INVALID_JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, 'JSON request body must be a JSON object.', 'INVALID_JSON_BODY');
  }
  return parsed;
}

function readRawBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    const clHeader = req.headers['content-length'];
    if (clHeader !== undefined) {
      const contentLength = Number(clHeader);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        req.pause();
        finish(
          new HttpError(
            413,
            `Request payload exceeds limit of ${maxBytes} bytes.`,
            'PAYLOAD_TOO_LARGE'
          )
        );
        return;
      }
    }

    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.pause();
        finish(
          new HttpError(
            413,
            `Request payload exceeds limit of ${maxBytes} bytes.`,
            'PAYLOAD_TOO_LARGE'
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      if (totalBytes === 0) {
        finish(null, Buffer.alloc(0));
        return;
      }
      finish(null, Buffer.concat(chunks, totalBytes));
    });

    req.on('aborted', () => {
      finish(new HttpError(400, 'Request was aborted by client.', 'REQUEST_ABORTED'));
    });

    req.on('error', (err) => {
      finish(new HttpError(400, `Request stream error: ${err.message}`, 'STREAM_ERROR'));
    });
  });
}

/**
 * Reads and parses a JSON request body with strict byte limit (413),
 * settled-flag stream guards, and 400 on malformed JSON.
 */
export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const buf = await readRawBody(req, maxBytes);
  return parseJsonObjectFromBytes(buf);
}

function sendJson(res, statusCode, payload, extraHeaders = {}, headOnly = false) {
  const body = JSON.stringify(payload);
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(buf);
  }
}

function sendRaw(res, statusCode, payload, contentType, extraHeaders = {}, headOnly = false) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': String(buf.length),
    ...extraHeaders,
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(buf);
  }
}

/**
 * Discovers regular `.stl` files in `projectRoot` (`pattern_studio_v2/`)
 * and `workspaceRoot` (`3d_modeling/`), verifying realpath containment.
 */
export function discoverWorkspaceSTLFiles(
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT
) {
  const searchDirs = [
    { dir: projectRoot, location: 'project' },
    { dir: workspaceRoot, location: 'workspace' },
  ];
  const seen = new Map();

  for (const { dir, location } of searchDirs) {
    let dirReal;
    try {
      dirReal = fs.realpathSync(dir);
    } catch {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(dirReal, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.stl')) continue;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirReal, entry.name);
      let realFile;
      try {
        realFile = fs.realpathSync(fullPath);
      } catch {
        continue;
      }

      const rel = path.relative(dirReal, realFile);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(realFile);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      if (!seen.has(entry.name)) {
        seen.set(entry.name, {
          name: entry.name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          location,
          dir: dirReal,
          fullPath: realFile,
        });
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function toPublicStlList(entries) {
  return entries.map(({ name, sizeBytes, modifiedAt, location }) => ({
    name,
    sizeBytes,
    modifiedAt,
    location,
  }));
}

function resolveNamedWorkspaceStl(rawFile, projectRoot, workspaceRoot) {
  if (
    typeof rawFile !== 'string' ||
    rawFile.length === 0 ||
    rawFile.includes('/') ||
    rawFile.includes('\\') ||
    rawFile.includes('..') ||
    rawFile.includes('\0')
  ) {
    throw new HttpError(404, 'Workspace STL file not found.', 'STL_NOT_FOUND');
  }

  const files = discoverWorkspaceSTLFiles(projectRoot, workspaceRoot);
  const match = files.find((f) => f.name === rawFile);
  if (!match) {
    throw new HttpError(404, `Workspace STL file not found: ${rawFile}`, 'STL_NOT_FOUND');
  }

  const verifiedPath = safeResolveInside(match.dir, match.name);
  return {
    entry: match,
    buffer: fs.readFileSync(verifiedPath),
  };
}

function buildStlSummary(mesh) {
  return {
    name: mesh.name,
    format: mesh.format,
    triangleCount: mesh.triangleCount,
    faceCount: mesh.faceCount,
    edgeCount: mesh.edgeCount,
    vertexCount: mesh.vertexCount,
    shellCount: mesh.shellCount,
    surfaceAreaMm2: mesh.surfaceAreaMm2,
    volumeMm3: mesh.volumeMm3,
    bounds: mesh.bounds,
    dimensions: mesh.dimensions,
    center: mesh.center,
  };
}

function buildPublicMesh(mesh) {
  return {
    ...buildStlSummary(mesh),
    triangles: mesh.triangles,
  };
}

const MAX_PDF_TILES = 3000;
const MAX_PDF_GRID_DIM = 500;
const MIN_PDF_PAGE_DIM_MM = 20;
const MAX_SIM_PIECE_SPAN_MM = 10_000;
const MAX_SIM_PATTERN_SPAN_MM = 25_000;
const MAX_SIM_PIECE_SAMPLED_VERTICES = 400;
const MAX_SIM_TOTAL_SAMPLED_VERTICES = 1_500;
const MAX_SIM_PIECE_PERIM_EDGES = 3_000;
const MAX_SIM_PREMESH_MIN_TRIS = 32_000;
const MAX_SIM_TRIANGLES = 32_000;
const MAX_SIM_PARTICLES = 18_000;
const MAX_SIM_WORK_UNITS = 24_000_000;
const MAX_SIM_DART_WORK = 15_000;
const MAX_SIM_WORKERS = 2;
const MAX_SIM_QUEUE = 16;
const DEFAULT_SIM_TIMEOUT_MS = 480_000;
const MAX_EXPORT_WORKERS = 2;
const MAX_EXPORT_QUEUE = 16;
const DEFAULT_EXPORT_TIMEOUT_MS = 180_000;

function resolveServerPieceId(piece, idx) {
  if (typeof piece?.id === 'string' && piece.id.length > 0) return piece.id;
  if (piece?.id !== undefined && piece?.id !== null && typeof piece.id !== 'symbol') {
    const s = String(piece.id);
    if (s.length > 0) return s;
  }
  return `piece_${idx + 1}`;
}

function computePolygonPivotMm(points, unitScale) {
  let areaSum = 0;
  let cxAcc = 0;
  let cyAcc = 0;
  let vxAcc = 0;
  let vyAcc = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const x0 = p0.x * unitScale;
    const y0 = p0.y * unitScale;
    const x1 = p1.x * unitScale;
    const y1 = p1.y * unitScale;
    const cross = x0 * y1 - x1 * y0;
    areaSum += cross;
    cxAcc += (x0 + x1) * cross;
    cyAcc += (y0 + y1) * cross;
    vxAcc += x0;
    vyAcc += y0;
  }
  if (Math.abs(areaSum) > 1e-6) {
    return { x: cxAcc / (3 * areaSum), y: cyAcc / (3 * areaSum) };
  }
  return { x: vxAcc / n, y: vyAcc / n };
}

function estimatePieceCutBoundsMm(piece, unitScale) {
  let sa = Number.isFinite(piece.seamAllowance) ? Math.max(0, piece.seamAllowance) : 0;
  if (Array.isArray(piece.edges)) {
    for (const edge of piece.edges) {
      if (edge && Number.isFinite(edge.seamAllowance) && edge.seamAllowance > sa) {
        sa = edge.seamAllowance;
      }
    }
  }
  const oxMm = (piece.position && Number.isFinite(piece.position.x) ? piece.position.x : 0) * unitScale;
  const oyMm = (piece.position && Number.isFinite(piece.position.y) ? piece.position.y : 0) * unitScale;
  const pivot =
    piece.rotationOrigin &&
    Number.isFinite(piece.rotationOrigin.x) &&
    Number.isFinite(piece.rotationOrigin.y)
      ? { x: piece.rotationOrigin.x * unitScale, y: piece.rotationOrigin.y * unitScale }
      : computePolygonPivotMm(piece.points, unitScale);
  const rotDeg = Number.isFinite(piece.rotation) ? piece.rotation : 0;
  const hasRot = Math.abs(rotDeg % 360) > 1e-6;
  const rad = hasRot ? (rotDeg * Math.PI) / 180 : 0;
  const cosR = hasRot ? Math.cos(rad) : 1;
  const sinR = hasRot ? Math.sin(rad) : 0;
  const transformPt = (pt) => {
    const xMm = pt.x * unitScale;
    const yMm = pt.y * unitScale;
    if (!hasRot) return { x: xMm + oxMm, y: yMm + oyMm };
    const dx = xMm - pivot.x;
    const dy = yMm - pivot.y;
    return {
      x: pivot.x + dx * cosR - dy * sinR + oxMm,
      y: pivot.y + dx * sinR + dy * cosR + oyMm,
    };
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const expandCut = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const pt of piece.points) {
    const tp = transformPt(pt);
    expandCut(tp.x, tp.y);
  }

  if (Array.isArray(piece.edges)) {
    for (const edge of piece.edges) {
      const curve = edge?.curve;
      if (!curve) continue;
      for (const cpKey of ['cp', 'cp1', 'cp2']) {
        const pt = curve[cpKey];
        if (!pt) continue;
        const tp = transformPt(pt);
        expandCut(tp.x, tp.y);
      }
    }
  }

  const saMm = sa * unitScale;
  minX -= saMm;
  minY -= saMm;
  maxX += saMm;
  maxY += saMm;

  let maxNotchDepthMm = 0;
  if (Array.isArray(piece.notches)) {
    for (const notch of piece.notches) {
      if (!notch) continue;
      const dMm = Number.isFinite(notch.depthMm) ? Math.max(0, notch.depthMm) * unitScale : 5;
      if (dMm > maxNotchDepthMm) maxNotchDepthMm = dMm;
    }
  }

  let renderMinX = minX - maxNotchDepthMm;
  let renderMinY = minY - maxNotchDepthMm;
  let renderMaxX = maxX + maxNotchDepthMm;
  let renderMaxY = maxY + maxNotchDepthMm;
  const expandRender = (x, y, pad = 0) => {
    if (x - pad < renderMinX) renderMinX = x - pad;
    if (y - pad < renderMinY) renderMinY = y - pad;
    if (x + pad > renderMaxX) renderMaxX = x + pad;
    if (y + pad > renderMaxY) renderMaxY = y + pad;
  };

  if (piece.grainline && typeof piece.grainline === 'object') {
    for (const endKey of ['start', 'end']) {
      const gpt = piece.grainline[endKey];
      if (gpt && Number.isFinite(gpt.x) && Number.isFinite(gpt.y)) {
        const tp = transformPt(gpt);
        expandRender(tp.x, tp.y, 5);
      }
    }
  }

  if (Array.isArray(piece.internalLines)) {
    for (const ln of piece.internalLines) {
      if (!ln || !Array.isArray(ln.points)) continue;
      for (const lpt of ln.points) {
        if (lpt && Number.isFinite(lpt.x) && Number.isFinite(lpt.y)) {
          const tp = transformPt(lpt);
          expandRender(tp.x, tp.y, 0);
        }
      }
    }
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    renderMinX,
    renderMinY,
    renderMaxX,
    renderMaxY,
  };
}

function assertExportPdfOptionsWithinBounds(options = {}) {
  const rawW = options.pageWidthMm ?? options.widthMm;
  const rawH = options.pageHeightMm ?? options.heightMm;
  if (rawW !== undefined && (!Number.isFinite(rawW) || rawW <= MIN_PDF_PAGE_DIM_MM)) {
    throw new HttpError(
      400,
      `Invalid PDF page width (${rawW} mm): must be greater than ${MIN_PDF_PAGE_DIM_MM} mm.`,
      'INVALID_OPTIONS'
    );
  }
  if (rawH !== undefined && (!Number.isFinite(rawH) || rawH <= MIN_PDF_PAGE_DIM_MM)) {
    throw new HttpError(
      400,
      `Invalid PDF page height (${rawH} mm): must be greater than ${MIN_PDF_PAGE_DIM_MM} mm.`,
      'INVALID_OPTIONS'
    );
  }

  const rawFmt = options.pageFormat ?? options.format;
  let canonicalFmt = null;
  if (rawFmt !== undefined && rawFmt !== null) {
    if (typeof rawFmt !== 'string' || rawFmt.trim().length === 0) {
      throw new HttpError(
        400,
        'Invalid PDF pageFormat: expected a non-empty format string.',
        'INVALID_OPTIONS'
      );
    }
    const fmtUpper = rawFmt.trim().toUpperCase();
    canonicalFmt = Object.keys(PAGE_FORMATS).find((k) => k.toUpperCase() === fmtUpper) || null;
    if (fmtUpper !== 'CUSTOM' && !canonicalFmt) {
      throw new HttpError(
        400,
        `Unsupported PDF pageFormat "${rawFmt}". Valid formats: ${Object.keys(PAGE_FORMATS).join(', ')}, custom.`,
        'INVALID_OPTIONS'
      );
    }
  }

  const fmtKey = options.pageFormat ?? options.format ?? 'LETTER';
  let base = null;
  if (typeof fmtKey === 'string') {
    const upper = fmtKey.trim().toUpperCase();
    const resolvedKey = canonicalFmt || Object.keys(PAGE_FORMATS).find((k) => k.toUpperCase() === upper) || null;
    base = resolvedKey ? PAGE_FORMATS[resolvedKey] : null;
  }
  let pageW = rawW ?? base?.widthMm ?? PAGE_FORMATS.LETTER.widthMm;
  let pageH = rawH ?? base?.heightMm ?? PAGE_FORMATS.LETTER.heightMm;
  if (options.orientation === 'landscape' && pageH > pageW) {
    [pageW, pageH] = [pageH, pageW];
  }

  const rawMargin = options.marginMm ?? 10;
  const rawOverlap = options.overlapMm ?? 15;
  if (rawMargin < 0 || rawOverlap < 0) {
    throw new HttpError(
      400,
      'Invalid PDF options: marginMm and overlapMm must be non-negative.',
      'INVALID_OPTIONS'
    );
  }

  const rawPrintableW = pageW - 2 * rawMargin;
  const rawPrintableH = pageH - 2 * rawMargin;
  if (
    rawPrintableW <= 1 ||
    rawPrintableH <= 1 ||
    rawPrintableW - rawOverlap <= 1 ||
    rawPrintableH - rawOverlap <= 1
  ) {
    throw new HttpError(
      400,
      'Invalid PDF options: printable page area after marginMm and overlapMm must exceed 1 mm.',
      'INVALID_OPTIONS'
    );
  }

  const marginMm = Math.max(0, Math.min(pageW * 0.25, pageH * 0.25, rawMargin));
  const printableW = Math.max(10, pageW - 2 * marginMm);
  const printableH = Math.max(10, pageH - 2 * marginMm);
  const overlapMm = Math.max(0, Math.min(printableW * 0.45, printableH * 0.45, rawOverlap));
  const stepX = Math.max(1, printableW - overlapMm);
  const stepY = Math.max(1, printableH - overlapMm);
  return { printableW, printableH, stepX, stepY };
}

function assertExportPdfWithinBounds(safePattern, options = {}) {
  const { printableW, printableH, stepX, stepY } = assertExportPdfOptionsWithinBounds(options);

  const unitScale =
    safePattern.unit && Object.hasOwn(UNIT_FACTORS, safePattern.unit)
      ? UNIT_FACTORS[safePattern.unit]
      : 1;
  const pieces = Array.isArray(safePattern.pieces) ? safePattern.pieces : [];
  if (pieces.length === 0) return;

  const pieceBounds = pieces.map((pc) => estimatePieceCutBoundsMm(pc, unitScale));
  const pieceMeta = pieces.map((pc) => {
    const ilCount = countPieceInternalLinePoints(pc);
    const notchCount = Array.isArray(pc?.notches) ? pc.notches.length : 0;
    const dartCount = pieceCountActiveDartsServer(pc);
    const hasSa = pieceHasAnySeamAllowanceServer(pc);
    const { segsPerCurve, curvedEdges } = estimateAdaptiveCurveSegmentsServer(pc, unitScale, 0.01);
    const rawPoints = Array.isArray(pc?.points) ? pc.points.length : 0;
    const sampledVerts = rawPoints + curvedEdges * (segsPerCurve - 1);
    const contourVerts = (hasSa ? 2 : 1) * sampledVerts + 3 * dartCount;
    return { ilCount, notchCount, dartCount, contourVerts };
  });
  const pieceBoundMap = new Map();
  const pieceMetaMap = new Map();
  pieces.forEach((p, idx) => {
    const key = resolveServerPieceId(p, idx);
    if (!pieceBoundMap.has(key)) {
      pieceBoundMap.set(key, pieceBounds[idx]);
      pieceMetaMap.set(key, pieceMeta[idx]);
    }
  });
  const resolvePlacementPieceInfo = (pl) => {
    if (Number.isInteger(pl.pieceIndex) && pl.pieceIndex >= 0 && pl.pieceIndex < pieceBounds.length) {
      const candidate = pieces[pl.pieceIndex];
      if (!pl.pieceId || resolveServerPieceId(candidate, pl.pieceIndex) === pl.pieceId) {
        return { pb: pieceBounds[pl.pieceIndex], meta: pieceMeta[pl.pieceIndex] };
      }
    }
    if (typeof pl.pieceId === 'string') {
      const byId = pieceBoundMap.get(pl.pieceId);
      if (byId) {
        return {
          pb: byId,
          meta: pieceMetaMap.get(pl.pieceId) || { ilCount: 0, notchCount: 0, dartCount: 0, contourVerts: 0 },
        };
      }
      const idxByName = pieces.findIndex((p) => p.name === pl.pieceId);
      if (idxByName >= 0) {
        return { pb: pieceBounds[idxByName], meta: pieceMeta[idxByName] };
      }
    }
    return { pb: null, meta: { ilCount: 0, notchCount: 0, dartCount: 0, contourVerts: 0 } };
  };
  const projectPlacedRenderBox = (pl, pb, sheetOffsetY, clientW, clientH) => {
    const px = Number.isFinite(pl.x) ? pl.x : 0;
    const py = sheetOffsetY + (Number.isFinite(pl.y) ? pl.y : 0);
    if (!pb) {
      return {
        minX: px,
        minY: py,
        maxX: px + Math.max(0, clientW),
        maxY: py + Math.max(0, clientH),
      };
    }
    const dx0 = pb.renderMinX - pb.minX;
    const dx1 = pb.renderMaxX - pb.minX;
    const dy0 = pb.renderMinY - pb.minY;
    const dy1 = pb.renderMaxY - pb.minY;
    if (pl.rotated90) {
      return {
        minX: px + Math.min(0, pb.height - dy1),
        minY: py + Math.min(0, dx0),
        maxX: px + Math.max(pb.height - dy0, clientW),
        maxY: py + Math.max(dx1, clientH),
      };
    }
    return {
      minX: px + Math.min(0, dx0),
      minY: py + Math.min(0, dy0),
      maxX: px + Math.max(dx1, clientW),
      maxY: py + Math.max(dy1, clientH),
    };
  };

  let contentW = 0;
  let contentH = 0;
  let globalMinX = 0;
  let globalMinY = 0;
  const placedRenderBoxes = [];
  const contentPad = 4;

  const providedNest = options.nestingResult;
  if (providedNest) {
    if (Array.isArray(providedNest.placements) && providedNest.placements.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const sheetLen = Number.isFinite(providedNest.sheetLengthMm) ? providedNest.sheetLengthMm : 0;
      if (sheetLen < 0) {
        throw new HttpError(
          400,
          'Invalid options.nestingResult.sheetLengthMm: must be >= 0.',
          'INVALID_NESTING_RESULT'
        );
      }
      for (const pl of providedNest.placements) {
        const { pb, meta } = resolvePlacementPieceInfo(pl);
        const clientW = Number.isFinite(pl.widthMm)
          ? pl.widthMm
          : Number.isFinite(pl.width)
            ? pl.width
            : 0;
        const clientH = Number.isFinite(pl.heightMm)
          ? pl.heightMm
          : Number.isFinite(pl.height)
            ? pl.height
            : 0;
        const sheetIdx = Number.isFinite(pl.sheetIndex) && pl.sheetIndex > 0 ? pl.sheetIndex : 0;
        const sheetOffsetY = sheetIdx > 0 && sheetLen > 0 ? sheetIdx * (sheetLen + 20) : 0;
        const box = projectPlacedRenderBox(pl, pb, sheetOffsetY, clientW, clientH);
        placedRenderBoxes.push({ box, meta });
        if (box.minX < minX) minX = box.minX;
        if (box.minY < minY) minY = box.minY;
        if (box.maxX > maxX) maxX = box.maxX;
        if (box.maxY > maxY) maxY = box.maxY;
      }
      if (Number.isFinite(minX) && Number.isFinite(maxX)) {
        globalMinX = minX;
        globalMinY = minY;
        contentW = Math.max(0, maxX - minX) + 2 * contentPad;
        contentH = Math.max(0, maxY - minY) + 2 * contentPad;
      }
    }
  } else if (options.layout === 'nested') {
    const {
      widthMm: _w,
      heightMm: _h,
      format: _f,
      pageWidthMm: _pw,
      pageHeightMm: _ph,
      pageFormat: _pf,
      ...rest
    } = options;
    const nestOpts = isPlainObject(options.nestingOptions) ? { ...rest, ...options.nestingOptions } : rest;
    const nest = nestPatternPieces(safePattern, nestOpts);
    const placements = Array.isArray(nest?.placements) ? nest.placements : [];
    if (placements.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const sheetLen = Number.isFinite(nest?.sheetLengthMm) ? nest.sheetLengthMm : 0;
      for (const pl of placements) {
        const { pb, meta } = resolvePlacementPieceInfo(pl);
        const clientW = Number.isFinite(pl.widthMm) ? pl.widthMm : 0;
        const clientH = Number.isFinite(pl.heightMm) ? pl.heightMm : 0;
        const sheetIdx = Number.isFinite(pl.sheetIndex) && pl.sheetIndex > 0 ? pl.sheetIndex : 0;
        const sheetOffsetY = sheetIdx > 0 && sheetLen > 0 ? sheetIdx * (sheetLen + 20) : 0;
        const box = projectPlacedRenderBox(pl, pb, sheetOffsetY, clientW, clientH);
        placedRenderBoxes.push({ box, meta });
        if (box.minX < minX) minX = box.minX;
        if (box.minY < minY) minY = box.minY;
        if (box.maxX > maxX) maxX = box.maxX;
        if (box.maxY > maxY) maxY = box.maxY;
      }
      if (Number.isFinite(minX) && Number.isFinite(maxX)) {
        globalMinX = minX;
        globalMinY = minY;
        contentW = Math.max(0, maxX - minX) + 2 * contentPad;
        contentH = Math.max(0, maxY - minY) + 2 * contentPad;
      }
    }
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let idx = 0; idx < pieceBounds.length; idx++) {
      const pb = pieceBounds[idx];
      const meta = pieceMeta[idx];
      placedRenderBoxes.push({
        box: {
          minX: pb.renderMinX,
          minY: pb.renderMinY,
          maxX: pb.renderMaxX,
          maxY: pb.renderMaxY,
        },
        meta,
      });
      if (pb.renderMinX < minX) minX = pb.renderMinX;
      if (pb.renderMinY < minY) minY = pb.renderMinY;
      if (pb.renderMaxX > maxX) maxX = pb.renderMaxX;
      if (pb.renderMaxY > maxY) maxY = pb.renderMaxY;
    }
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      globalMinX = minX;
      globalMinY = minY;
      contentW = Math.max(0, maxX - minX) + 2 * contentPad;
      contentH = Math.max(0, maxY - minY) + 2 * contentPad;
    }
  }

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
    throw new HttpError(
      400,
      `PDF export exceeds maximum tile limit (${cols}x${rows} = ${cols * rows} pages, max ${MAX_PDF_TILES}).`,
      'EXPORT_TOO_LARGE'
    );
  }

  if (placedRenderBoxes.length > 0) {
    let totalTileInternalLineEmissions = 0;
    let totalTileNotches = 0;
    let totalTileDarts = 0;
    let totalTileContourVertices = 0;
    let totalTilePieceIntersections = 0;
    for (const { box, meta } of placedRenderBoxes) {
      const x0 = box.minX - globalMinX + contentPad;
      const x1 = box.maxX - globalMinX + contentPad;
      const y0 = box.minY - globalMinY + contentPad;
      const y1 = box.maxY - globalMinY + contentPad;
      const colMin = Math.max(0, Math.ceil((x0 - printableW - 2) / stepX));
      const colMax = Math.min(cols - 1, Math.floor((x1 + 2) / stepX));
      const rowMin = Math.max(0, Math.ceil((y0 - printableH - 2) / stepY));
      const rowMax = Math.min(rows - 1, Math.floor((y1 + 2) / stepY));
      const overlapCols = Math.max(0, colMax - colMin + 1);
      const overlapRows = Math.max(0, rowMax - rowMin + 1);
      const overlap = overlapCols * overlapRows;
      if (overlap === 0) continue;
      totalTileInternalLineEmissions += meta.ilCount * overlap;
      if (totalTileInternalLineEmissions > MAX_PDF_TILE_INTERNAL_LINE_POINTS) {
        throw new HttpError(
          400,
          `PDF export internal-line complexity across tiles (${totalTileInternalLineEmissions}) exceeds maximum allowed (${MAX_PDF_TILE_INTERNAL_LINE_POINTS}).`,
          'EXPORT_TOO_LARGE'
        );
      }
      totalTileNotches += meta.notchCount * overlap;
      if (totalTileNotches > MAX_PDF_TILE_NOTCHES) {
        throw new HttpError(
          400,
          `PDF export notch complexity across tiles (${totalTileNotches}) exceeds maximum allowed (${MAX_PDF_TILE_NOTCHES}).`,
          'EXPORT_TOO_LARGE'
        );
      }
      totalTileDarts += meta.dartCount * overlap;
      if (totalTileDarts > MAX_PDF_TILE_DARTS) {
        throw new HttpError(
          400,
          `PDF export dart complexity across tiles (${totalTileDarts}) exceeds maximum allowed (${MAX_PDF_TILE_DARTS}).`,
          'EXPORT_TOO_LARGE'
        );
      }
      totalTileContourVertices += meta.contourVerts * overlap;
      if (totalTileContourVertices > MAX_PDF_TILE_CONTOUR_VERTICES) {
        throw new HttpError(
          400,
          `PDF export contour-vertex complexity across tiles (${totalTileContourVertices}) exceeds maximum allowed (${MAX_PDF_TILE_CONTOUR_VERTICES}).`,
          'EXPORT_TOO_LARGE'
        );
      }
      totalTilePieceIntersections += overlap;
      if (totalTilePieceIntersections > MAX_PDF_TILE_PIECE_INTERSECTIONS) {
        throw new HttpError(
          400,
          `PDF export piece-tile intersections (${totalTilePieceIntersections}) exceed maximum allowed (${MAX_PDF_TILE_PIECE_INTERSECTIONS}).`,
          'EXPORT_TOO_LARGE'
        );
      }
    }
  }
}

function resolveEffectiveRollDims(options = {}) {
  const effective = isPlainObject(options.nestingOptions)
    ? { ...options, ...options.nestingOptions }
    : options;
  const presetKey = effective.rollPreset ?? effective.preset ?? effective.rollId ?? null;
  let preset = null;
  if (typeof presetKey === 'string' && presetKey.trim().length > 0) {
    const keyLower = presetKey.trim().toLowerCase();
    preset =
      FABRIC_ROLL_PRESETS.find((r) => r.id.toLowerCase() === keyLower) ||
      FABRIC_ROLL_PRESETS.find((r) => r.name.toLowerCase() === keyLower) ||
      null;
  }
  const explicitWidth = effective.fabricWidthMm ?? effective.rollWidthMm ?? effective.widthMm;
  const hasExplicitWidth = Number.isFinite(explicitWidth);
  const fabricWidthMm = hasExplicitWidth ? explicitWidth : (preset?.widthMm ?? 1371.6);

  const explicitLength = effective.sheetLengthMm ?? effective.rollLengthMm ?? effective.lengthMm;
  let sheetLengthMm = null;
  if (explicitLength !== undefined && explicitLength !== null) {
    sheetLengthMm = explicitLength > 0 ? explicitLength : null;
  } else if (
    preset &&
    preset.lengthMm !== null &&
    effective.paginateSheets !== false &&
    !hasExplicitWidth
  ) {
    sheetLengthMm = preset.lengthMm;
  }
  const marginMm = Number.isFinite(effective.marginMm) ? effective.marginMm : 10;
  return { fabricWidthMm, sheetLengthMm, marginMm };
}

function assertNestingMarginWithinWidth(options = {}, fieldPath = 'options') {
  const { fabricWidthMm, sheetLengthMm, marginMm } = resolveEffectiveRollDims(options);
  if (2 * marginMm >= fabricWidthMm) {
    throw new HttpError(
      400,
      `Invalid ${fieldPath}: 2 * marginMm (${2 * marginMm} mm) must be less than fabricWidthMm (${fabricWidthMm} mm).`,
      'INVALID_OPTIONS'
    );
  }
  if (sheetLengthMm !== null && 2 * marginMm >= sheetLengthMm) {
    throw new HttpError(
      400,
      `Invalid ${fieldPath}: 2 * marginMm (${2 * marginMm} mm) must be less than sheetLengthMm (${sheetLengthMm} mm).`,
      'INVALID_OPTIONS'
    );
  }
}

function estimateAdaptiveCurveSegmentsServer(piece, unitScale = 1, maxErrMm = 0.01) {
  const pts = Array.isArray(piece?.points) ? piece.points : [];
  const edges = Array.isArray(piece?.edges) ? piece.edges : [];
  const n = pts.length;
  let maxSegs = 48;
  let curvedEdges = 0;
  for (let i = 0; i < n; i++) {
    const curve = edges[i]?.curve;
    if (!curve) continue;
    curvedEdges += 1;
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    if (!p0 || !p1) continue;
    const p0x = p0.x * unitScale;
    const p0y = p0.y * unitScale;
    const p1x = p1.x * unitScale;
    const p1y = p1.y * unitScale;
    let dMax = 0;
    if (curve.cp1 && curve.cp2) {
      const c1x = curve.cp1.x * unitScale;
      const c1y = curve.cp1.y * unitScale;
      const c2x = curve.cp2.x * unitScale;
      const c2y = curve.cp2.y * unitScale;
      const d1 = Math.hypot(p0x - 2 * c1x + c2x, p0y - 2 * c1y + c2y);
      const d2 = Math.hypot(c1x - 2 * c2x + p1x, c1y - 2 * c2y + p1y);
      dMax = Math.max(d1, d2);
    } else if (curve.cp) {
      const cx = curve.cp.x * unitScale;
      const cy = curve.cp.y * unitScale;
      dMax = (2 / 3) * Math.hypot(p0x - 2 * cx + p1x, p0y - 2 * cy + p1y);
    }
    if (dMax > 1e-6) {
      const segs = Math.ceil(Math.sqrt((0.75 * dMax) / maxErrMm));
      if (segs > maxSegs) maxSegs = segs;
    }
    if (Math.hypot(p1x - p0x, p1y - p0y) > 200) {
      maxSegs = Math.max(maxSegs, 64);
    }
  }
  return {
    segsPerCurve: Math.min(256, Math.max(48, maxSegs)),
    curvedEdges,
  };
}

function pieceHasAnySeamAllowanceServer(piece) {
  const rawDefault = piece?.seamAllowance;
  const parsedDefault =
    rawDefault !== undefined && rawDefault !== null && Number.isFinite(Number(rawDefault))
      ? Number(rawDefault)
      : 10;
  const defaultSa = parsedDefault;
  const edges = Array.isArray(piece?.edges) ? piece.edges : [];
  if (edges.length === 0) return defaultSa > 1e-6;
  const n = Array.isArray(piece?.points) ? piece.points.length : 0;
  for (let i = 0; i < n; i++) {
    const edgeSa = edges[i]?.seamAllowance;
    const eff =
      edgeSa !== undefined && edgeSa !== null && Number.isFinite(Number(edgeSa))
        ? Number(edgeSa)
        : defaultSa;
    if (eff > 1e-6) return true;
  }
  return false;
}

function pieceCountActiveDartsServer(piece) {
  if (!Array.isArray(piece?.darts)) return 0;
  let count = 0;
  for (const d of piece.darts) {
    if (isPlainObject(d) && Number(d.widthMm) > 0 && Number(d.depthMm) > 0) {
      count += 1;
    }
  }
  return count;
}

function pieceHasAnyDartServer(piece) {
  return pieceCountActiveDartsServer(piece) > 0;
}

function countPieceInternalLinePoints(piece) {
  if (!Array.isArray(piece?.internalLines)) return 0;
  let total = 0;
  for (const ln of piece.internalLines) {
    if (ln && Array.isArray(ln.points)) {
      total += ln.points.length;
    }
  }
  return total;
}

function analyzePatternComplexity(pattern) {
  const pieces = Array.isArray(pattern?.pieces) ? pattern.pieces : [];
  const unitScale =
    pattern?.unit && Object.hasOwn(UNIT_FACTORS, pattern.unit) ? UNIT_FACTORS[pattern.unit] : 1;

  let totalSaRawPoints = 0;
  let totalPatternSampledVerts = 0;
  let patternSaQuadraticWork = 0;
  let patternCurvedSaWork = 0;
  let saRawFourthWork = 0;
  let patternDartWork = 0;
  let totalPatternInternalLinePoints = 0;
  const pieceStats = [];

  for (let i = 0; i < pieces.length; i++) {
    const pc = pieces[i];
    const pts = Array.isArray(pc?.points) ? pc.points : [];
    const rawPoints = pts.length;
    const { segsPerCurve, curvedEdges } = estimateAdaptiveCurveSegmentsServer(pc, unitScale, 0.01);
    const sampledVerts = rawPoints + curvedEdges * (segsPerCurve - 1);
    const hasSa = pieceHasAnySeamAllowanceServer(pc);
    const activeDarts = pieceCountActiveDartsServer(pc);
    const requiresCutClip = hasSa || activeDarts > 0;
    const internalLinePoints = countPieceInternalLinePoints(pc);
    const rawQty = Number(pc?.quantity);
    const qty = Number.isFinite(rawQty) && rawQty >= 1 ? Math.trunc(rawQty) : 1;

    if (requiresCutClip) {
      if (rawPoints > MAX_SA_PIECE_POINTS) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} with seam allowance or darts has ${rawPoints} points, exceeding maximum allowed (${MAX_SA_PIECE_POINTS}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      if (curvedEdges > MAX_SA_PIECE_CURVED_EDGES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} with seam allowance or darts has ${curvedEdges} curved edges, exceeding maximum allowed (${MAX_SA_PIECE_CURVED_EDGES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      if (sampledVerts > MAX_SA_PIECE_SAMPLED_VERTICES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} with seam allowance or darts expands to ${sampledVerts} sampled vertices, exceeding maximum allowed (${MAX_SA_PIECE_SAMPLED_VERTICES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      totalSaRawPoints += rawPoints;
      if (totalSaRawPoints > MAX_SA_PATTERN_POINTS) {
        throw new HttpError(
          400,
          `Pattern total seam-allowance/dart vertex count (${totalSaRawPoints}) exceeds maximum allowed (${MAX_SA_PATTERN_POINTS}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      patternSaQuadraticWork += sampledVerts * sampledVerts;
      if (patternSaQuadraticWork > MAX_PATTERN_SA_QUADRATIC_WORK) {
        throw new HttpError(
          400,
          `Pattern seam-allowance/dart complexity exceeds maximum quadratic budget (${MAX_PATTERN_SA_QUADRATIC_WORK}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      if (curvedEdges > 0) {
        patternCurvedSaWork += curvedEdges * sampledVerts * sampledVerts;
        if (patternCurvedSaWork > MAX_PATTERN_CURVED_SA_WORK) {
          throw new HttpError(
            400,
            `Pattern curved seam-allowance/dart complexity (${patternCurvedSaWork}) exceeds maximum budget (${MAX_PATTERN_CURVED_SA_WORK}).`,
            'PATTERN_TOO_COMPLEX'
          );
        }
      }
      if (rawPoints > 24) {
        saRawFourthWork += rawPoints ** 4;
        if (saRawFourthWork > MAX_SA_RAW_POINTS_FOURTH) {
          throw new HttpError(
            400,
            `Pattern seam-allowance/dart polygon complexity exceeds maximum budget (${MAX_SA_RAW_POINTS_FOURTH}).`,
            'PATTERN_TOO_COMPLEX'
          );
        }
      }
    } else {
      if (curvedEdges > MAX_PIECE_CURVED_EDGES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} has ${curvedEdges} curved edges, exceeding maximum allowed (${MAX_PIECE_CURVED_EDGES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      if (sampledVerts > MAX_PIECE_SAMPLED_VERTICES) {
        throw new HttpError(
          400,
          `Pattern piece at index ${i} expands to ${sampledVerts} sampled vertices, exceeding maximum allowed (${MAX_PIECE_SAMPLED_VERTICES}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
    }

    if (activeDarts > 0) {
      patternDartWork += activeDarts * (sampledVerts + activeDarts * 32);
      if (patternDartWork > MAX_PATTERN_DART_WORK) {
        throw new HttpError(
          400,
          `Pattern dart-apex complexity (${patternDartWork}) exceeds maximum allowed (${MAX_PATTERN_DART_WORK}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
    }

    if (internalLinePoints > 0) {
      totalPatternInternalLinePoints += internalLinePoints;
      if (totalPatternInternalLinePoints > MAX_PATTERN_INTERNAL_LINE_POINTS) {
        throw new HttpError(
          400,
          `Pattern total internalLine points (${totalPatternInternalLinePoints}) exceeds maximum allowed (${MAX_PATTERN_INTERNAL_LINE_POINTS}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
    }

    totalPatternSampledVerts += sampledVerts;
    if (totalPatternSampledVerts > MAX_PATTERN_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Pattern total sampled vertex count (${totalPatternSampledVerts}) exceeds maximum allowed (${MAX_PATTERN_SAMPLED_VERTICES}).`,
        'PATTERN_TOO_COMPLEX'
      );
    }

    pieceStats.push({
      piece: pc,
      id: resolveServerPieceId(pc, i),
      rawPoints,
      curvedEdges,
      sampledVerts,
      hasSa,
      requiresCutClip,
      activeDarts,
      internalLinePoints,
      qty,
    });
  }

  return { pieceStats };
}

function assertNestingComplexityWithinBounds(pattern) {
  const { pieceStats } = analyzePatternComplexity(pattern);
  let nestedTotalSampledVerts = 0;
  for (const st of pieceStats) {
    nestedTotalSampledVerts += st.sampledVerts * st.qty;
    if (nestedTotalSampledVerts > MAX_EXPORT_TOTAL_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Nested pattern total sampled vertices (${nestedTotalSampledVerts}) exceeds maximum allowed (${MAX_EXPORT_TOTAL_SAMPLED_VERTICES}).`,
        'PATTERN_TOO_COMPLEX'
      );
    }
  }
}

function assertExportComplexityWithinBounds(pattern, options = {}) {
  const { pieceStats } = analyzePatternComplexity(pattern);
  let totalExportVerts = 0;
  let totalExportSaQuadraticWork = 0;
  let totalExportSaRawQuadWork = 0;
  let totalExportCurvedSaWork = 0;
  let totalExportSaFourthWork = 0;
  let totalExportDartWork = 0;
  let totalExportInternalLinePoints = 0;

  const accountPlacementWork = (st, copies = 1) => {
    totalExportVerts += st.sampledVerts * copies;
    if (totalExportVerts > MAX_EXPORT_TOTAL_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Export total sampled vertices (${totalExportVerts}) exceeds maximum allowed (${MAX_EXPORT_TOTAL_SAMPLED_VERTICES}).`,
        'PATTERN_TOO_COMPLEX'
      );
    }
    if (st.requiresCutClip) {
      totalExportSaQuadraticWork += copies * st.sampledVerts * st.sampledVerts;
      if (totalExportSaQuadraticWork > MAX_EXPORT_SA_QUADRATIC_WORK) {
        throw new HttpError(
          400,
          `Export seam-allowance/dart complexity exceeds maximum budget (${MAX_EXPORT_SA_QUADRATIC_WORK}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      totalExportSaRawQuadWork += copies * st.rawPoints * st.rawPoints;
      if (totalExportSaRawQuadWork > MAX_EXPORT_SA_RAW_QUAD_WORK) {
        throw new HttpError(
          400,
          `Export seam-allowance/dart placement multiplicity (${totalExportSaRawQuadWork}) exceeds maximum budget (${MAX_EXPORT_SA_RAW_QUAD_WORK}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
      if (st.curvedEdges > 0) {
        totalExportCurvedSaWork += copies * st.curvedEdges * st.sampledVerts * st.sampledVerts;
        if (totalExportCurvedSaWork > MAX_EXPORT_CURVED_SA_WORK) {
          throw new HttpError(
            400,
            `Export curved seam-allowance/dart complexity (${totalExportCurvedSaWork}) exceeds maximum budget (${MAX_EXPORT_CURVED_SA_WORK}).`,
            'PATTERN_TOO_COMPLEX'
          );
        }
      }
      if (st.rawPoints > 24) {
        totalExportSaFourthWork += copies * (st.rawPoints ** 4);
        if (totalExportSaFourthWork > MAX_SA_RAW_POINTS_FOURTH) {
          throw new HttpError(
            400,
            `Export seam-allowance/dart polygon complexity exceeds maximum budget (${MAX_SA_RAW_POINTS_FOURTH}).`,
            'PATTERN_TOO_COMPLEX'
          );
        }
      }
    }
    if (st.activeDarts > 0) {
      totalExportDartWork += copies * st.activeDarts * (st.sampledVerts + st.activeDarts * 32);
      if (totalExportDartWork > MAX_EXPORT_DART_WORK) {
        throw new HttpError(
          400,
          `Export dart-apex complexity (${totalExportDartWork}) exceeds maximum allowed (${MAX_EXPORT_DART_WORK}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
    }
    if (st.internalLinePoints > 0) {
      totalExportInternalLinePoints += copies * st.internalLinePoints;
      if (totalExportInternalLinePoints > MAX_EXPORT_INTERNAL_LINE_POINTS) {
        throw new HttpError(
          400,
          `Export total internalLine points (${totalExportInternalLinePoints}) exceeds maximum allowed (${MAX_EXPORT_INTERNAL_LINE_POINTS}).`,
          'PATTERN_TOO_COMPLEX'
        );
      }
    }
  };

  const providedNest = options?.nestingResult;
  if (providedNest) {
    const placements = Array.isArray(providedNest.placements) ? providedNest.placements : [];
    const byId = new Map();
    for (let i = 0; i < pieceStats.length; i++) {
      if (!byId.has(pieceStats[i].id)) {
        byId.set(pieceStats[i].id, pieceStats[i]);
      }
    }
    for (const pl of placements) {
      let st = null;
      if (Number.isInteger(pl.pieceIndex) && pl.pieceIndex >= 0 && pl.pieceIndex < pieceStats.length) {
        const cand = pieceStats[pl.pieceIndex];
        if (!pl.pieceId || cand.id === pl.pieceId) st = cand;
      }
      if (!st && pl.pieceId && byId.has(pl.pieceId)) {
        st = byId.get(pl.pieceId);
      }
      if (!st) continue;
      accountPlacementWork(st, 1);
    }
    return;
  }

  const isNested = options?.layout === 'nested';
  for (const st of pieceStats) {
    const copies = isNested ? st.qty : 1;
    accountPlacementWork(st, copies);
  }
}

function assertExportPlacementSpanWithinBounds(options = {}) {
  const providedNest = options?.nestingResult;
  if (!providedNest || !Array.isArray(providedNest.placements)) return;
  const sheetLen = Number.isFinite(providedNest.sheetLengthMm) ? providedNest.sheetLengthMm : 0;
  for (let i = 0; i < providedNest.placements.length; i++) {
    const pl = providedNest.placements[i];
    const sheetIdx = Number.isFinite(pl.sheetIndex) && pl.sheetIndex > 0 ? pl.sheetIndex : 0;
    const sheetOffsetY = sheetIdx > 0 && sheetLen > 0 ? sheetIdx * (sheetLen + 20) : 0;
    const x = Number.isFinite(pl.x) ? pl.x : Number.isFinite(pl.offsetX) ? pl.offsetX : 0;
    const y = Number.isFinite(pl.y) ? pl.y : Number.isFinite(pl.offsetY) ? pl.offsetY : 0;
    if (
      Math.abs(sheetOffsetY) > MAX_PATTERN_COORD_MM ||
      Math.abs(x) > MAX_PATTERN_COORD_MM ||
      Math.abs(sheetOffsetY + y) > MAX_PATTERN_COORD_MM
    ) {
      throw new HttpError(
        400,
        `Export placement at index ${i} exceeds maximum allowed coordinate span (${MAX_PATTERN_COORD_MM} mm).`,
        'EXPORT_TOO_LARGE'
      );
    }
  }
}

function assertPreParseStlWithinBounds(input, name = 'model.stl') {
  if (input === null || input === undefined) return;
  const checkAsciiText = (text) => {
    const facetRe = /\bfacet\b/gi;
    let facetCount = 0;
    while (facetRe.exec(text) !== null) {
      facetCount += 1;
      if (facetCount > MAX_STL_TRIANGLES) {
        throw new HttpError(
          400,
          `STL "${name}" triangle count exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
          'STL_TOO_LARGE'
        );
      }
    }
    const vertexRe = /\bvertex\b/gi;
    let vertexCount = 0;
    while (vertexRe.exec(text) !== null) {
      vertexCount += 1;
      if (vertexCount > MAX_STL_TRIANGLES * 3) {
        throw new HttpError(
          400,
          `STL "${name}" vertex count exceeds maximum allowed (${MAX_STL_TRIANGLES * 3}).`,
          'STL_TOO_LARGE'
        );
      }
    }
  };

  if (typeof input === 'string') {
    checkAsciiText(input);
    return;
  }

  let bytes = null;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (!bytes || bytes.byteLength < 15) return;

  const previewLen = Math.min(512, bytes.byteLength);
  const preview = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, previewLen));
  const looksLikeAscii =
    /^\s*solid\b/i.test(preview) && /\bfacet\b/i.test(preview) && /\bvertex\b/i.test(preview);
  const tailStart =
    bytes.byteLength >= 84
      ? Math.max(80, bytes.byteLength - 512)
      : Math.max(0, bytes.byteLength - 512);
  const tailText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(tailStart));
  const hasEndsolid = /\bendsolid\b/i.test(tailText);

  if (bytes.byteLength >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);
    const expectedBytes = 84 + triCount * 50;
    if (triCount > 0 && expectedBytes === bytes.byteLength && !hasEndsolid) {
      if (triCount > MAX_STL_TRIANGLES) {
        throw new HttpError(
          400,
          `Binary STL "${name}" triangle count (${triCount}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
          'STL_TOO_LARGE'
        );
      }
      return;
    }
    if (!looksLikeAscii) {
      if (triCount > MAX_STL_TRIANGLES && expectedBytes <= bytes.byteLength) {
        throw new HttpError(
          400,
          `Binary STL "${name}" triangle count (${triCount}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
          'STL_TOO_LARGE'
        );
      }
      const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (/\bfacet\b/i.test(fullText) && /\bvertex\b/i.test(fullText)) {
        checkAsciiText(fullText);
      }
      return;
    }
  }

  const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/\bfacet\b/i.test(fullText) && /\bvertex\b/i.test(fullText)) {
    checkAsciiText(fullText);
  }
}

function validateSimulationStlMesh(rawMesh) {
  if (rawMesh === undefined || rawMesh === null) return null;
  if (!isPlainObject(rawMesh)) {
    throw new HttpError(400, 'Invalid stlMesh: expected an object.', 'INVALID_STL');
  }
  const safeMesh = {};
  if (rawMesh.name !== undefined) {
    if (typeof rawMesh.name !== 'string') {
      throw new HttpError(400, 'Invalid stlMesh.name: expected a string.', 'INVALID_STL');
    }
    safeMesh.name = rawMesh.name;
  }
  if (rawMesh.scale !== undefined) {
    if (typeof rawMesh.scale !== 'number' || !Number.isFinite(rawMesh.scale) || rawMesh.scale <= 0) {
      throw new HttpError(400, 'Invalid stlMesh.scale: expected a finite positive number.', 'INVALID_STL');
    }
    safeMesh.scale = rawMesh.scale;
  }
  if (rawMesh.centerAtOrigin !== undefined) {
    if (typeof rawMesh.centerAtOrigin !== 'boolean') {
      throw new HttpError(400, 'Invalid stlMesh.centerAtOrigin: expected a boolean.', 'INVALID_STL');
    }
    safeMesh.centerAtOrigin = rawMesh.centerAtOrigin;
  }

  const assertVec3 = (v, pathStr) => {
    if (Array.isArray(v)) {
      if (
        v.length < 3 ||
        !Number.isFinite(v[0]) ||
        !Number.isFinite(v[1]) ||
        !Number.isFinite(v[2])
      ) {
        throw new HttpError(400, `Invalid ${pathStr}: expected 3 finite coordinates.`, 'INVALID_STL');
      }
      if (
        Math.abs(v[0]) > MAX_PATTERN_COORD_MM ||
        Math.abs(v[1]) > MAX_PATTERN_COORD_MM ||
        Math.abs(v[2]) > MAX_PATTERN_COORD_MM
      ) {
        throw new HttpError(
          400,
          `Invalid ${pathStr}: coordinate magnitude exceeds ${MAX_PATTERN_COORD_MM} mm.`,
          'STL_TOO_LARGE'
        );
      }
      return { x: v[0], y: v[1], z: v[2] };
    }
    if (!isPlainObject(v) || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
      throw new HttpError(400, `Invalid ${pathStr}: expected {x, y, z} with finite numbers.`, 'INVALID_STL');
    }
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      throw new HttpError(400, `Invalid ${pathStr}: expected finite {x, y, z} coordinates.`, 'INVALID_STL');
    }
    if (
      Math.abs(v.x) > MAX_PATTERN_COORD_MM ||
      Math.abs(v.y) > MAX_PATTERN_COORD_MM ||
      Math.abs(v.z) > MAX_PATTERN_COORD_MM
    ) {
      throw new HttpError(
        400,
        `Invalid ${pathStr}: coordinate magnitude exceeds ${MAX_PATTERN_COORD_MM} mm.`,
        'STL_TOO_LARGE'
      );
    }
    return { x: v.x, y: v.y, z: v.z };
  };

  if (rawMesh.triangles !== undefined && (rawMesh.faces !== undefined || rawMesh.vertices !== undefined)) {
    throw new HttpError(
      400,
      'Invalid stlMesh: cannot specify both triangles and faces/vertices.',
      'INVALID_STL'
    );
  }

  if (rawMesh.triangles !== undefined) {
    if (!Array.isArray(rawMesh.triangles)) {
      throw new HttpError(400, 'Invalid stlMesh.triangles: expected an array.', 'INVALID_STL');
    }
    if (rawMesh.triangles.length === 0) {
      throw new HttpError(400, 'Invalid stlMesh.triangles: expected at least 1 triangle.', 'INVALID_STL');
    }
    if (rawMesh.triangles.length > MAX_STL_TRIANGLES) {
      throw new HttpError(
        400,
        `stlMesh triangle count (${rawMesh.triangles.length}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
        'STL_TOO_LARGE'
      );
    }
    const cleanTris = [];
    for (let i = 0; i < rawMesh.triangles.length; i++) {
      const t = rawMesh.triangles[i];
      if (Array.isArray(t)) {
        if (t.length < 3) {
          throw new HttpError(400, `Invalid stlMesh.triangles[${i}]: expected 3 vertices.`, 'INVALID_STL');
        }
        cleanTris.push([
          assertVec3(t[0], `stlMesh.triangles[${i}][0]`),
          assertVec3(t[1], `stlMesh.triangles[${i}][1]`),
          assertVec3(t[2], `stlMesh.triangles[${i}][2]`),
        ]);
      } else if (isPlainObject(t)) {
        const cleanT = stripUnsafeKeys(t);
        const k0 = t.a !== undefined ? 'a' : 'v0';
        const k1 = t.b !== undefined ? 'b' : 'v1';
        const k2 = t.c !== undefined ? 'c' : 'v2';
        cleanT[k0] = assertVec3(t[k0], `stlMesh.triangles[${i}].${k0}`);
        cleanT[k1] = assertVec3(t[k1], `stlMesh.triangles[${i}].${k1}`);
        cleanT[k2] = assertVec3(t[k2], `stlMesh.triangles[${i}].${k2}`);
        cleanTris.push(cleanT);
      } else {
        throw new HttpError(400, `Invalid stlMesh.triangles[${i}]: expected triangle array or object.`, 'INVALID_STL');
      }
    }
    safeMesh.triangles = cleanTris;
    return safeMesh;
  }

  if (rawMesh.faces !== undefined) {
    if (!Array.isArray(rawMesh.faces)) {
      throw new HttpError(400, 'Invalid stlMesh.faces: expected an array.', 'INVALID_STL');
    }
    if (rawMesh.faces.length === 0) {
      throw new HttpError(400, 'Invalid stlMesh.faces: expected at least 1 face.', 'INVALID_STL');
    }
    if (rawMesh.faces.length > MAX_STL_TRIANGLES) {
      throw new HttpError(
        400,
        `stlMesh face count (${rawMesh.faces.length}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
        'STL_TOO_LARGE'
      );
    }
    if (!Array.isArray(rawMesh.vertices)) {
      throw new HttpError(
        400,
        'Invalid stlMesh.vertices: expected an array when stlMesh.faces is provided.',
        'INVALID_STL'
      );
    }
    if (rawMesh.vertices.length < 3) {
      throw new HttpError(
        400,
        'Invalid stlMesh.vertices: expected at least 3 vertices.',
        'INVALID_STL'
      );
    }
    if (rawMesh.vertices.length > MAX_STL_TRIANGLES * 3) {
      throw new HttpError(
        400,
        `stlMesh vertex count (${rawMesh.vertices.length}) exceeds maximum allowed (${MAX_STL_TRIANGLES * 3}).`,
        'STL_TOO_LARGE'
      );
    }
    safeMesh.vertices = rawMesh.vertices.map((v, i) => assertVec3(v, `stlMesh.vertices[${i}]`));
    const vLen = safeMesh.vertices.length;
    const cleanFaces = [];
    for (let i = 0; i < rawMesh.faces.length; i++) {
      const f = rawMesh.faces[i];
      let idxArr = null;
      if (Array.isArray(f)) {
        idxArr = f;
      } else if (isPlainObject(f)) {
        idxArr = Array.isArray(f.indices) ? f.indices : [f.a, f.b, f.c];
      }
      if (!Array.isArray(idxArr) || idxArr.length < 3) {
        throw new HttpError(400, `Invalid stlMesh.faces[${i}]: expected 3 vertex indices.`, 'INVALID_STL');
      }
      for (let k = 0; k < 3; k++) {
        const vi = idxArr[k];
        if (!Number.isInteger(vi) || vi < 0 || vi >= vLen) {
          throw new HttpError(
            400,
            `Invalid stlMesh.faces[${i}][${k}]: vertex index out of bounds.`,
            'INVALID_STL'
          );
        }
      }
      cleanFaces.push(
        Array.isArray(f)
          ? [idxArr[0], idxArr[1], idxArr[2]]
          : {
              ...stripUnsafeKeys(f),
              ...(Array.isArray(f.indices)
                ? { indices: [idxArr[0], idxArr[1], idxArr[2]] }
                : { a: idxArr[0], b: idxArr[1], c: idxArr[2] }),
            }
      );
    }
    safeMesh.faces = cleanFaces;
    return safeMesh;
  }

  throw new HttpError(400, 'Invalid stlMesh: expected triangles array.', 'INVALID_STL');
}

const PARAM_LENGTH_KEYS = new Set([
  'bustMm',
  'underbustMm',
  'highHipMm',
  'bustSpanMm',
  'shoulderToBustMm',
  'bodiceLengthMm',
  'skirtLengthMm',
  'flareMm',
  'taperMm',
  'bustCupEaseMm',
  'chestMm',
  'waistMm',
  'hipMm',
  'lengthMm',
  'shoulderWidthMm',
  'sleeveLengthMm',
  'hoodHeightMm',
  'hoodDepthMm',
  'inseamMm',
  'outseamMm',
  'riseMm',
  'frontRiseMm',
  'backRiseMm',
  'thighMm',
  'kneeMm',
  'ankleWidthMm',
  'hemWidthMm',
  'widthMm',
  'heightMm',
  'depthMm',
  'gussetMm',
  'gussetDepthMm',
  'strapLengthMm',
  'strapWidthMm',
  'neckWidthMm',
  'neckDropMm',
  'frontNeckDropMm',
  'backNeckDropMm',
  'ribHeightMm',
  'waistbandHeightMm',
  'wedgeHeightMm',
  'wedgeLengthMm',
  'wedgeTipMm',
  'wedgeWidthMm',
  'armholeDepthMm',
  'bicepMm',
  'bicepWidthMm',
  'cuffMm',
  'sizeMm',
  'chest',
  'length',
  'shoulderWidth',
  'sleeveLength',
  'hoodHeight',
  'hoodDepth',
  'waist',
  'hip',
  'inseam',
  'outseam',
  'frontRise',
  'backRise',
  'ankleWidth',
  'width',
  'height',
  'depth',
  'gusset',
  'strapLength',
  'strapWidth',
]);

const PARAM_EASE_KEYS = new Set(['easeMm', 'ease']);
const PARAM_THICKNESS_OR_SA_KEYS = new Set([
  'seamAllowance',
  'seamAllowanceMm',
  'thicknessMm',
  'hemAllowanceMm',
  'cuffWidthMm',
  'pocketWidthMm',
  'pocketHeightMm',
]);

function coerceStrictFiniteParam(val, fieldPath) {
  if (typeof val === 'symbol' || typeof val === 'bigint' || typeof val === 'boolean' || val === null || (typeof val === 'object')) {
    throw new HttpError(400, `Invalid ${fieldPath}: expected a finite number.`, 'INVALID_PARAMS');
  }
  if (typeof val === 'string' && val.trim() === '') {
    throw new HttpError(400, `Invalid ${fieldPath}: expected a finite number.`, 'INVALID_PARAMS');
  }
  const n = Number(val);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, `Invalid ${fieldPath}: expected a finite number.`, 'INVALID_PARAMS');
  }
  return n;
}

function validateTemplateParams(rawParams) {
  if (rawParams === undefined || rawParams === null) return {};
  if (!isPlainObject(rawParams)) {
    throw new HttpError(400, 'Invalid params: expected a plain object.', 'INVALID_PARAMS');
  }
  const clean = stripUnsafeKeys(rawParams);
  for (const key of Object.keys(clean)) {
    const val = clean[key];
    if (val === undefined) continue;
    if (PARAM_LENGTH_KEYS.has(key)) {
      const n = coerceStrictFiniteParam(val, `params.${key}`);
      if (n < 1 || n > 25_000) {
        throw new HttpError(
          400,
          `Invalid params.${key}: must be between 1 and 25000 mm.`,
          'INVALID_PARAMS'
        );
      }
      clean[key] = n;
    } else if (PARAM_EASE_KEYS.has(key)) {
      const n = coerceStrictFiniteParam(val, `params.${key}`);
      if (n < 0 || n > 5_000) {
        throw new HttpError(
          400,
          `Invalid params.${key}: must be between 0 and 5000 mm.`,
          'INVALID_PARAMS'
        );
      }
      clean[key] = n;
    } else if (PARAM_THICKNESS_OR_SA_KEYS.has(key)) {
      const n = coerceStrictFiniteParam(val, `params.${key}`);
      if (n < 0 || n > 1_000) {
        throw new HttpError(
          400,
          `Invalid params.${key}: must be between 0 and 1000 mm.`,
          'INVALID_PARAMS'
        );
      }
      clean[key] = n;
    } else if (key === 'scale') {
      const n = coerceStrictFiniteParam(val, 'params.scale');
      if (n < 0.01 || n > 100) {
        throw new HttpError(
          400,
          'Invalid params.scale: must be between 0.01 and 100.',
          'INVALID_PARAMS'
        );
      }
      clean[key] = n;
    }
  }
  return clean;
}

function validateUnwrapOptions(body) {
  const easeMm = assertOptionalFiniteInput(body.easeMm, 'easeMm', 'INVALID_PARAMS');
  const seamAllowance = assertOptionalFiniteInput(body.seamAllowance, 'seamAllowance', 'INVALID_PARAMS');
  const scale = assertOptionalFiniteInput(body.scale, 'scale', 'INVALID_PARAMS');
  const thicknessMm = assertOptionalFiniteInput(body.thicknessMm, 'thicknessMm', 'INVALID_PARAMS');
  const dihedralThresholdDeg = assertOptionalFiniteInput(
    body.dihedralThresholdDeg,
    'dihedralThresholdDeg',
    'INVALID_PARAMS'
  );
  const angleThresholdDeg = assertOptionalFiniteInput(
    body.angleThresholdDeg,
    'angleThresholdDeg',
    'INVALID_PARAMS'
  );
  const angleThreshold = assertOptionalFiniteInput(
    body.angleThreshold,
    'angleThreshold',
    'INVALID_PARAMS'
  );
  const minChartAreaMm2 = assertOptionalFiniteInput(
    body.minChartAreaMm2,
    'minChartAreaMm2',
    'INVALID_PARAMS'
  );

  if (scale !== undefined && (scale < 0.01 || scale > 100)) {
    throw new HttpError(400, 'Invalid scale: must be between 0.01 and 100.', 'INVALID_PARAMS');
  }
  if (easeMm !== undefined && (easeMm < 0 || easeMm > 1_000)) {
    throw new HttpError(400, 'Invalid easeMm: must be between 0 and 1000 mm.', 'INVALID_PARAMS');
  }
  if (thicknessMm !== undefined && (thicknessMm < 0 || thicknessMm > 1_000)) {
    throw new HttpError(
      400,
      'Invalid thicknessMm: must be between 0 and 1000 mm.',
      'INVALID_PARAMS'
    );
  }
  if (seamAllowance !== undefined && (seamAllowance < 0 || seamAllowance > 1_000)) {
    throw new HttpError(
      400,
      'Invalid seamAllowance: must be between 0 and 1000 mm.',
      'INVALID_PARAMS'
    );
  }
  for (const [k, v] of [
    ['dihedralThresholdDeg', dihedralThresholdDeg],
    ['angleThresholdDeg', angleThresholdDeg],
    ['angleThreshold', angleThreshold],
  ]) {
    if (v !== undefined && (v < 0.1 || v > 179.9)) {
      throw new HttpError(
        400,
        `Invalid ${k}: must be between 0.1 and 179.9 degrees.`,
        'INVALID_PARAMS'
      );
    }
  }
  if (minChartAreaMm2 !== undefined && (minChartAreaMm2 < 1 || minChartAreaMm2 > 1e8)) {
    throw new HttpError(
      400,
      'Invalid minChartAreaMm2: must be between 1 and 100000000 mm^2.',
      'INVALID_PARAMS'
    );
  }

  return {
    easeMm,
    seamAllowance,
    scale,
    thicknessMm,
    dihedralThresholdDeg,
    angleThresholdDeg,
    angleThreshold,
    minChartAreaMm2,
  };
}

function countExactClothTris(points, maxEdgeLengthMm, maxBudgetTris) {
  const safeMaxEdge = Math.max(2, Number.isFinite(maxEdgeLengthMm) ? maxEdgeLengthMm : 35);
  const base = triangulatePolygon(points);
  if (!base || base.triangles.length === 0) return 0;
  if (base.triangles.length > maxBudgetTris) return base.triangles.length;

  const vertices = base.vertices.map((p) => ({ x: p.x, y: p.y }));
  let triangles = base.triangles;
  const area = polygonArea(base.vertices);
  const maxVertices = Math.max(
    32000,
    Math.min(100000, Math.ceil((area / (safeMaxEdge * safeMaxEdge)) * 6) + 4096)
  );

  for (let iter = 0; iter < 10; iter++) {
    if (vertices.length >= maxVertices) break;

    let splitCount = 0;
    const edgeMidpointCache = new Map();
    const nextTriangles = [];

    const getMidpointIndex = (i0, i1) => {
      const key = i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`;
      if (edgeMidpointCache.has(key)) return edgeMidpointCache.get(key);
      const p0 = vertices[i0];
      const p1 = vertices[i1];
      const idx = vertices.length;
      vertices.push({ x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 });
      edgeMidpointCache.set(key, idx);
      return idx;
    };

    const dist = (i0, i1) =>
      Math.hypot(vertices[i1].x - vertices[i0].x, vertices[i1].y - vertices[i0].y);

    for (let ti = 0; ti < triangles.length; ti++) {
      const [a, b, c] = triangles[ti];
      const sab = dist(a, b) > safeMaxEdge;
      const sbc = dist(b, c) > safeMaxEdge;
      const sca = dist(c, a) > safeMaxEdge;
      const numSplit = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0);

      if (numSplit === 0) {
        nextTriangles.push([a, b, c]);
      } else {
        splitCount++;
        if (numSplit === 3) {
          const mab = getMidpointIndex(a, b);
          const mbc = getMidpointIndex(b, c);
          const mca = getMidpointIndex(c, a);
          nextTriangles.push(
            [a, mab, mca],
            [mab, b, mbc],
            [mca, mbc, c],
            [mab, mbc, mca]
          );
        } else if (numSplit === 2) {
          let v0 = a;
          let v1 = b;
          let v2 = c;
          if (sbc && sca) {
            v0 = b;
            v1 = c;
            v2 = a;
          } else if (sca && sab) {
            v0 = c;
            v1 = a;
            v2 = b;
          }
          const m01 = getMidpointIndex(v0, v1);
          const m12 = getMidpointIndex(v1, v2);
          nextTriangles.push([m01, v1, m12]);
          if (dist(m01, v2) <= dist(v0, m12)) {
            nextTriangles.push([v0, m01, v2], [m01, m12, v2]);
          } else {
            nextTriangles.push([v0, m01, m12], [v0, m12, v2]);
          }
        } else {
          let v0 = a;
          let v1 = b;
          let v2 = c;
          if (sbc) {
            v0 = b;
            v1 = c;
            v2 = a;
          } else if (sca) {
            v0 = c;
            v1 = a;
            v2 = b;
          }
          const m01 = getMidpointIndex(v0, v1);
          nextTriangles.push([v0, m01, v2], [m01, v1, v2]);
        }
      }

      const lowerBound = nextTriangles.length + (triangles.length - 1 - ti);
      if (lowerBound > maxBudgetTris) {
        return lowerBound;
      }
    }

    triangles = nextTriangles;
    if (splitCount === 0) break;
  }

  return triangles.length;
}

function assertSimulationWithinBounds(pattern, maxEdgeLengthMm = 38, steps = 120, substeps = 6) {
  const pieces = Array.isArray(pattern?.pieces) ? pattern.pieces : [];
  if (pieces.length === 0) return;

  const unitScale =
    pattern.unit && Object.hasOwn(UNIT_FACTORS, pattern.unit)
      ? UNIT_FACTORS[pattern.unit]
      : 1;
  const edgeLen = Math.max(8, Math.min(500, Number.isFinite(maxEdgeLengthMm) ? maxEdgeLengthMm : 38));
  const eqTriArea = (Math.sqrt(3) / 4) * edgeLen * edgeLen;
  const clampedSteps = Math.max(0, Math.min(600, Number.isFinite(steps) ? Math.trunc(steps) : 120));
  const clampedSubsteps = Math.max(4, Math.min(24, Number.isFinite(substeps) ? Math.trunc(substeps) : 6));
  const maxAllowedTris = Math.min(
    MAX_SIM_TRIANGLES,
    Math.floor(MAX_SIM_WORK_UNITS / (Math.max(1, clampedSteps) * clampedSubsteps))
  );

  let patRawMinX = Infinity;
  let patRawMinY = Infinity;
  let patRawMaxX = -Infinity;
  let patRawMaxY = -Infinity;
  let patScaledMinX = Infinity;
  let patScaledMinY = Infinity;
  let patScaledMaxX = -Infinity;
  let patScaledMaxY = -Infinity;

  let estTotalSampledVerts = 0;
  let simDartWork = 0;
  let totalSampledVertices = 0;
  let minTrisTotal = 0;

  for (let i = 0; i < pieces.length; i++) {
    const pc = pieces[i];
    if (!pc || !Array.isArray(pc.points) || pc.points.length < 3) continue;

    const rawPoints = pc.points.length;
    const edgesArr = Array.isArray(pc.edges) ? pc.edges : [];
    let validCurvedEdges = 0;
    const edgeCheckLimit = Math.min(rawPoints, edgesArr.length);
    for (let ei = 0; ei < edgeCheckLimit; ei++) {
      const cv = edgesArr[ei]?.curve;
      if (cv && (cv.cp || (cv.cp1 && cv.cp2))) {
        validCurvedEdges++;
      }
    }
    const estSampledVerts = rawPoints + validCurvedEdges * 7;
    if (estSampledVerts > MAX_SIM_PIECE_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Simulation piece at index ${i} expands to ~${estSampledVerts} outline vertices, exceeding maximum allowed (${MAX_SIM_PIECE_SAMPLED_VERTICES}).`,
        'SIMULATION_TOO_LARGE'
      );
    }
    estTotalSampledVerts += estSampledVerts;
    if (estTotalSampledVerts > MAX_SIM_TOTAL_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Simulation pattern total outline vertices (~${estTotalSampledVerts}) exceeds maximum allowed (${MAX_SIM_TOTAL_SAMPLED_VERTICES}).`,
        'SIMULATION_TOO_LARGE'
      );
    }
    const activeDarts = pieceCountActiveDartsServer(pc);
    if (activeDarts > 0) {
      simDartWork += activeDarts * (estSampledVerts + activeDarts * 32);
      if (simDartWork > MAX_SIM_DART_WORK) {
        throw new HttpError(
          400,
          `Simulation dart-apex complexity (${simDartWork}) exceeds maximum allowed (${MAX_SIM_DART_WORK}).`,
          'SIMULATION_TOO_LARGE'
        );
      }
    }

    const sampled = samplePieceOutline(pc, 8);
    if (sampled.length > MAX_SIM_PIECE_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Simulation piece at index ${i} expands to ${sampled.length} outline vertices, exceeding maximum allowed (${MAX_SIM_PIECE_SAMPLED_VERTICES}).`,
        'SIMULATION_TOO_LARGE'
      );
    }
    totalSampledVertices += sampled.length;
    if (totalSampledVertices > MAX_SIM_TOTAL_SAMPLED_VERTICES) {
      throw new HttpError(
        400,
        `Simulation pattern total outline vertices (${totalSampledVertices}) exceeds maximum allowed (${MAX_SIM_TOTAL_SAMPLED_VERTICES}).`,
        'SIMULATION_TOO_LARGE'
      );
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let rawPerim = 0;
    for (let j = 0; j < sampled.length; j++) {
      const p0 = sampled[j];
      const p1 = sampled[(j + 1) % sampled.length];
      if (p0.x < minX) minX = p0.x;
      if (p0.y < minY) minY = p0.y;
      if (p0.x > maxX) maxX = p0.x;
      if (p0.y > maxY) maxY = p0.y;
      rawPerim += Math.hypot(p1.x - p0.x, p1.y - p0.y);
    }

    const rawSpan = Math.max(0, maxX - minX, maxY - minY);
    const scaledSpan = rawSpan * unitScale;
    const pieceSpan = Math.max(rawSpan, scaledSpan);
    if (pieceSpan > MAX_SIM_PIECE_SPAN_MM) {
      throw new HttpError(
        400,
        `Simulation piece at index ${i} span (${Math.round(pieceSpan)} mm) exceeds maximum allowed (${MAX_SIM_PIECE_SPAN_MM} mm).`,
        'SIMULATION_TOO_LARGE'
      );
    }

    if (minX < patRawMinX) patRawMinX = minX;
    if (minY < patRawMinY) patRawMinY = minY;
    if (maxX > patRawMaxX) patRawMaxX = maxX;
    if (maxY > patRawMaxY) patRawMaxY = maxY;

    const sx0 = minX * unitScale;
    const sy0 = minY * unitScale;
    const sx1 = maxX * unitScale;
    const sy1 = maxY * unitScale;
    if (sx0 < patScaledMinX) patScaledMinX = sx0;
    if (sy0 < patScaledMinY) patScaledMinY = sy0;
    if (sx1 > patScaledMaxX) patScaledMaxX = sx1;
    if (sy1 > patScaledMaxY) patScaledMaxY = sy1;

    const perimEdges = Math.max(
      Math.ceil(rawPerim / edgeLen),
      Math.ceil((rawPerim * unitScale) / edgeLen)
    );
    if (perimEdges > MAX_SIM_PIECE_PERIM_EDGES) {
      throw new HttpError(
        400,
        `Simulation piece at index ${i} boundary subdivisions (${perimEdges}) exceed maximum allowed (${MAX_SIM_PIECE_PERIM_EDGES}).`,
        'SIMULATION_TOO_LARGE'
      );
    }

    const rawArea = Math.abs(polygonArea(sampled));
    const effectiveArea = Math.max(rawArea, rawArea * unitScale * unitScale);
    const areaMinTris = Math.ceil(effectiveArea / eqTriArea);
    const polyMinTris = Math.max(1, sampled.length - 2);
    const remainingBudget = Math.max(0, maxAllowedTris - minTrisTotal);
    const exactTris = countExactClothTris(sampled, edgeLen, remainingBudget);
    minTrisTotal += Math.max(polyMinTris, areaMinTris, exactTris);
  }

  if (Number.isFinite(patRawMinX)) {
    const rawPatSpan = Math.max(patRawMaxX - patRawMinX, patRawMaxY - patRawMinY);
    const scaledPatSpan = Math.max(patScaledMaxX - patScaledMinX, patScaledMaxY - patScaledMinY);
    if (Math.max(rawPatSpan, scaledPatSpan) > MAX_SIM_PATTERN_SPAN_MM) {
      throw new HttpError(
        400,
        `Simulation pattern span exceeds maximum allowed (${MAX_SIM_PATTERN_SPAN_MM} mm).`,
        'SIMULATION_TOO_LARGE'
      );
    }
  }

  if (!Number.isFinite(minTrisTotal) || minTrisTotal > MAX_SIM_PREMESH_MIN_TRIS) {
    throw new HttpError(
      400,
      `Simulation minimum mesh estimate (${Math.round(minTrisTotal)} triangles) exceeds maximum allowed (${MAX_SIM_PREMESH_MIN_TRIS}).`,
      'SIMULATION_TOO_LARGE'
    );
  }

  const minWorkUnits = minTrisTotal * Math.max(1, clampedSteps) * clampedSubsteps;
  if (!Number.isFinite(minWorkUnits) || minWorkUnits > MAX_SIM_WORK_UNITS) {
    throw new HttpError(
      400,
      `Simulation work budget (${Math.round(minWorkUnits)} units) exceeds maximum allowed (${MAX_SIM_WORK_UNITS}).`,
      'SIMULATION_TOO_LARGE'
    );
  }
}

function executeGuardedSimulation(pattern, simOptions = {}) {
  const opts = simOptions && typeof simOptions === 'object' ? simOptions : {};
  const steps = Number.isFinite(opts.steps)
    ? Math.max(0, Math.min(600, Math.trunc(opts.steps)))
    : 120;

  const sim = new ClothSimulation(pattern, opts);

  if (sim.triangles.length > MAX_SIM_TRIANGLES) {
    throw new HttpError(
      400,
      `Simulation actual triangle count (${sim.triangles.length}) exceeds maximum allowed (${MAX_SIM_TRIANGLES}).`,
      'SIMULATION_TOO_LARGE'
    );
  }
  if (sim.particles.length > MAX_SIM_PARTICLES) {
    throw new HttpError(
      400,
      `Simulation actual particle count (${sim.particles.length}) exceeds maximum allowed (${MAX_SIM_PARTICLES}).`,
      'SIMULATION_TOO_LARGE'
    );
  }
  const actualWorkUnits = sim.triangles.length * Math.max(1, steps) * sim.substeps;
  if (!Number.isFinite(actualWorkUnits) || actualWorkUnits > MAX_SIM_WORK_UNITS) {
    throw new HttpError(
      400,
      `Simulation work budget (${Math.round(actualWorkUnits)} units) exceeds maximum allowed (${MAX_SIM_WORK_UNITS}).`,
      'SIMULATION_TOO_LARGE'
    );
  }

  const strainReport = steps > 0 ? sim.step(steps) : sim.computeStrainAnalysis();
  const finiteOk =
    sim.particles.every(
      (p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)
    ) &&
    Number.isFinite(strainReport.meanStrainPct) &&
    Number.isFinite(strainReport.maxStrainPct);

  return {
    stepCount: sim.stepCount,
    particles: sim.particles.map((p) => ({
      index: p.index,
      pieceId: p.pieceId,
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      rest2D: { x: p.rest2D.x, y: p.rest2D.y },
      strainPct: p.strainPct,
      color: p.color,
    })),
    triangles: sim.triangles,
    piecesMeta: sim.pieceMeshes,
    seams3D: sim.sewingConstraints.map((s) => {
      const pa = sim.particles[s.a].pos;
      const pb = sim.particles[s.b].pos;
      return {
        seamId: s.seamId,
        a: s.a,
        b: s.b,
        posA: { ...pa },
        posB: { ...pb },
        gapMm: Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z),
      };
    }),
    strainReport,
    avgSewGapMm: strainReport.avgSewGapMm,
    finiteOk,
    avatar: sim.avatar,
    stlBounds: sim.stlCollider ? sim.stlCollider.bounds : null,
  };
}

function createWorkerOptions(workerData) {
  const hasEvalOrInputType = (process.execArgv || []).some(
    (arg) =>
      arg === '--input-type' ||
      arg.startsWith('--input-type=') ||
      arg === '-e' ||
      arg === '--eval' ||
      arg.startsWith('--eval=')
  );
  return hasEvalOrInputType ? { workerData, execArgv: [] } : { workerData };
}

const SUPPORTED_UNWRAP_MODES = new Set(['form_shell_cover', 'surface_panels', 'chart_unfold']);

function assertKnownMaterialId(rawMaterialId, fieldPath = 'materialId') {
  if (typeof rawMaterialId === 'string') {
    const trimmed = rawMaterialId.trim();
    if (trimmed.length === 0 || !Object.hasOwn(MATERIAL_PRESETS, trimmed)) {
      throw new HttpError(
        400,
        `Unknown ${fieldPath} "${rawMaterialId}". Valid materials: ${Object.keys(MATERIAL_PRESETS).join(', ')}.`,
        'INVALID_MATERIAL'
      );
    }
    return trimmed;
  }
  return null;
}

const MATERIAL_NUMERIC_BOUNDS = Object.freeze({
  gsm: [10, 5000],
  thicknessMm: [0, 50],
  stretchStiffness: [0, 1],
  warpStiffness: [0, 1],
  weftStiffness: [0, 1],
  stretchWarp: [0, 1],
  stretchWeft: [0, 1],
  shearStiffness: [0, 1],
  bendStiffness: [0, 1],
  damping: [0, 1],
  friction: [0, 1],
  maxSafeStrainPct: [0.1, 300],
  roughness: [0, 1],
  metallic: [0, 1],
  ao: [0, 1],
  sheen: [0, 1],
  normal: [0, 2],
  threadScaleMm: [0.1, 20],
  weaveScale: [0.1, 20],
});

const MATERIAL_STRING_FIELDS = [
  'id',
  'name',
  'category',
  'baseColor',
  'warpColor',
  'weftColor',
  'stitchColor',
  'albedo',
  'grainColor',
];

function validateMaterialSpec(rawVal, fieldPath = 'materialOverrides', { allowString = false } = {}) {
  if (rawVal === undefined || rawVal === null) return undefined;
  if (typeof rawVal === 'string') {
    if (allowString) {
      return assertKnownMaterialId(rawVal, fieldPath);
    }
    throw new HttpError(400, `Invalid ${fieldPath}: expected a plain object.`, 'INVALID_MATERIAL');
  }
  if (!isPlainObject(rawVal)) {
    throw new HttpError(
      400,
      allowString
        ? `Invalid ${fieldPath}: expected a material preset ID string or material object.`
        : `Invalid ${fieldPath}: expected a plain object.`,
      'INVALID_MATERIAL'
    );
  }
  const clean = stripUnsafeKeys(rawVal);
  for (const sk of MATERIAL_STRING_FIELDS) {
    if (clean[sk] !== undefined && clean[sk] !== null) {
      assertOptionalString(clean[sk], `${fieldPath}.${sk}`, 'INVALID_MATERIAL');
    }
  }
  if (clean.id !== undefined && clean.id !== null) {
    clean.id = assertKnownMaterialId(clean.id, `${fieldPath}.id`);
  }
  if (clean.weaveType !== undefined && clean.weaveType !== null) {
    if (typeof clean.weaveType !== 'string' || !WEAVE_TYPES.includes(clean.weaveType)) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.weaveType "${clean.weaveType}": expected one of ${WEAVE_TYPES.join(', ')}.`,
        'INVALID_MATERIAL'
      );
    }
  }
  for (const [nk, [minVal, maxVal]] of Object.entries(MATERIAL_NUMERIC_BOUNDS)) {
    if (clean[nk] === undefined) continue;
    const rawNum = clean[nk];
    if (
      typeof rawNum === 'symbol' ||
      typeof rawNum === 'bigint' ||
      typeof rawNum === 'boolean' ||
      rawNum === null ||
      typeof rawNum === 'object' ||
      (typeof rawNum === 'string' && rawNum.trim() === '')
    ) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.${nk}: expected a finite number.`,
        'INVALID_MATERIAL'
      );
    }
    const n = Number(rawNum);
    if (!Number.isFinite(n)) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.${nk}: expected a finite number.`,
        'INVALID_MATERIAL'
      );
    }
    if (n < minVal || n > maxVal) {
      throw new HttpError(
        400,
        `Invalid ${fieldPath}.${nk} (${n}): must be between ${minVal} and ${maxVal}.`,
        'INVALID_MATERIAL'
      );
    }
    clean[nk] = n;
  }
  return clean;
}

function validateAndResolvePatternMaterial(safePattern) {
  if (safePattern.materialId !== undefined && safePattern.materialId !== null) {
    assertOptionalString(safePattern.materialId, 'pattern.materialId', 'INVALID_MATERIAL');
    assertKnownMaterialId(safePattern.materialId, 'pattern.materialId');
  }
  if (safePattern.material !== undefined && safePattern.material !== null) {
    const matSpec = validateMaterialSpec(safePattern.material, 'pattern.material', {
      allowString: true,
    });
    if (typeof matSpec === 'string') {
      safePattern.materialId = safePattern.materialId || matSpec;
      safePattern.material = getMaterialConfig(matSpec);
    } else {
      if (
        !safePattern.materialId &&
        typeof matSpec.id === 'string' &&
        Object.hasOwn(MATERIAL_PRESETS, matSpec.id)
      ) {
        safePattern.materialId = matSpec.id;
      }
      safePattern.material = matSpec;
    }
  }
}

function resolveRequestMaterialConfig(body, defaultMatId = 'cotton_jersey') {
  const rawMaterialId = assertOptionalString(body.materialId, 'materialId');
  const validatedMatId = assertKnownMaterialId(rawMaterialId, 'materialId');
  const safeBodyMaterial = validateMaterialSpec(body.material, 'material', { allowString: true });
  const bodyMaterialPresetId = typeof safeBodyMaterial === 'string' ? safeBodyMaterial : null;
  const bodyMaterialObj = isPlainObject(safeBodyMaterial) ? safeBodyMaterial : undefined;
  const matOverrides = validateMaterialSpec(body.materialOverrides, 'materialOverrides') || {};
  const mergedOverrides = bodyMaterialObj ? { ...bodyMaterialObj, ...matOverrides } : matOverrides;
  const hasMaterial = Boolean(
    validatedMatId ||
    bodyMaterialPresetId ||
    (typeof bodyMaterialObj?.id === 'string' && bodyMaterialObj.id.length > 0)
  );
  const matId =
    validatedMatId ||
    bodyMaterialPresetId ||
    (typeof bodyMaterialObj?.id === 'string' && Object.hasOwn(MATERIAL_PRESETS, bodyMaterialObj.id)
      ? bodyMaterialObj.id
      : null) ||
    defaultMatId;
  const material = getMaterialConfig(matId, mergedOverrides);
  return {
    validatedMatId,
    bodyMaterialPresetId,
    bodyMaterialObj,
    matOverrides,
    mergedOverrides,
    hasMaterial,
    material,
  };
}

function prepareAndExecuteSimulation(body, projectRoot, workspaceRoot) {
  const rawTemplateId = assertOptionalString(body.templateId, 'templateId');
  if (body.templateId !== undefined && body.templateId !== null && rawTemplateId.trim().length === 0) {
    throw new HttpError(
      400,
      'Invalid templateId: expected a non-empty template ID string.',
      'INVALID_TEMPLATE'
    );
  }
  const rawMaterialId = assertOptionalString(body.materialId, 'materialId');
  const validatedMatId = assertKnownMaterialId(rawMaterialId, 'materialId');
  const safeBodyMaterial = validateMaterialSpec(body.material, 'material', { allowString: true });
  const bodyMaterialPresetId = typeof safeBodyMaterial === 'string' ? safeBodyMaterial : null;
  const bodyMaterialObj = isPlainObject(safeBodyMaterial) ? safeBodyMaterial : undefined;
  const safeMaterialOverrides = validateMaterialSpec(body.materialOverrides, 'materialOverrides');
  const wsFile = assertOptionalString(body.workspaceFile, 'workspaceFile');
  const stlBase64 = assertOptionalString(body.stlBase64, 'stlBase64');
  const stlText = assertOptionalString(body.stlText, 'stlText');
  const stlName = assertOptionalString(body.stlName, 'stlName');
  const rawThickness = assertOptionalFiniteInput(body.thicknessMm, 'thicknessMm', 'INVALID_PARAMS');
  if (rawThickness !== undefined && (rawThickness < 0 || rawThickness > 1_000)) {
    throw new HttpError(
      400,
      'Invalid thicknessMm: must be between 0 and 1000 mm.',
      'INVALID_PARAMS'
    );
  }
  const avatarInput = body.avatar !== undefined ? body.avatar : body.avatarMeasurements;
  if (avatarInput !== undefined && avatarInput !== null && !isPlainObject(avatarInput)) {
    throw new HttpError(
      400,
      'Invalid avatar: expected a plain object or null.',
      'INVALID_AVATAR'
    );
  }
  const rawSteps = assertOptionalFiniteInput(body.steps, 'steps');
  if (rawSteps !== undefined && (!Number.isInteger(rawSteps) || rawSteps < 0 || rawSteps > 600)) {
    throw new HttpError(
      400,
      `Invalid steps (${rawSteps}): must be an integer between 0 and 600.`,
      'INVALID_PARAMS'
    );
  }
  const rawMaxEdgeLengthMm = assertOptionalFiniteInput(body.maxEdgeLengthMm, 'maxEdgeLengthMm');
  const rawSubsteps = assertOptionalFiniteInput(body.substeps, 'substeps');
  const rawDt = assertOptionalFiniteInput(body.dt, 'dt');
  const rawGravityMmS2 = assertOptionalFiniteInput(body.gravityMmS2, 'gravityMmS2');

  const parseSimulationStl = () => {
    let mesh = null;
    const meshLabel = (typeof stlName === 'string' && stlName.trim()) || 'mesh.stl';
    if (body.stlMesh !== undefined && body.stlMesh !== null) {
      mesh = validateSimulationStlMesh(body.stlMesh);
    } else if (typeof wsFile === 'string' && wsFile.trim().length > 0) {
      const { entry, buffer } = resolveNamedWorkspaceStl(
        wsFile.trim(),
        projectRoot,
        workspaceRoot
      );
      assertPreParseStlWithinBounds(buffer, entry.name);
      mesh = parseSTL(buffer, entry.name);
    } else if (typeof stlBase64 === 'string' && stlBase64.trim().length > 0) {
      const buf = Buffer.from(stlBase64, 'base64');
      assertPreParseStlWithinBounds(buf, meshLabel);
      mesh = parseSTL(buf, meshLabel);
    } else if (typeof stlText === 'string' && stlText.trim().length > 0) {
      assertPreParseStlWithinBounds(stlText, meshLabel);
      mesh = parseSTL(stlText, meshLabel);
    } else if (
      (wsFile !== undefined && wsFile !== null) ||
      (stlBase64 !== undefined && stlBase64 !== null) ||
      (stlText !== undefined && stlText !== null)
    ) {
      throw new HttpError(400, 'STL input payload is empty.', 'EMPTY_STL');
    }
    if (mesh && Array.isArray(mesh.triangles) && mesh.triangles.length > MAX_STL_TRIANGLES) {
      throw new HttpError(
        400,
        `STL triangle count (${mesh.triangles.length}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
        'STL_TOO_LARGE'
      );
    }
    return mesh;
  };

  let pattern = null;
  let stlMesh = null;
  if (body.pattern !== undefined && body.pattern !== null) {
    const { safePattern } = validateAndSanitizePattern(
      body.pattern,
      'INVALID_PATTERN',
      'POST /api/simulate requires pattern (with pieces array) or templateId.'
    );
    if (safePattern.pieces.length === 0) {
      throw new HttpError(
        400,
        'POST /api/simulate requires pattern.pieces to contain at least 1 piece.',
        'INVALID_PATTERN'
      );
    }
    validateAndResolvePatternMaterial(safePattern);
    if (safePattern.seams !== undefined) {
      if (!Array.isArray(safePattern.seams) || safePattern.seams.some((s) => !isPlainObject(s))) {
        throw new HttpError(
          400,
          'Invalid pattern.seams: expected an array of seam objects.',
          'INVALID_SEAM'
        );
      }
    }
    pattern = safePattern;
    stlMesh = parseSimulationStl();
  } else if (typeof rawTemplateId === 'string' && rawTemplateId.length > 0) {
    const simParams = validateTemplateParams(body.params ?? body.parameters);
    stlMesh = parseSimulationStl();
    if (rawTemplateId === 'stl_cover' && stlMesh) {
      const resolvedMatId =
        validatedMatId ||
        bodyMaterialPresetId ||
        (typeof bodyMaterialObj?.id === 'string' && Object.hasOwn(MATERIAL_PRESETS, bodyMaterialObj.id)
          ? bodyMaterialObj.id
          : null) ||
        'veg_leather';
      const mergedMatOverrides = bodyMaterialObj
        ? { ...bodyMaterialObj, ...(safeMaterialOverrides || {}) }
        : safeMaterialOverrides || {};
      const coverMat = getMaterialConfig(resolvedMatId, mergedMatOverrides);
      const effectiveThickness =
        simParams.thicknessMm ??
        rawThickness ??
        (mergedMatOverrides.thicknessMm !== undefined
          ? coverMat.thicknessMm
          : undefined);
      pattern = generateTemplatePattern(rawTemplateId, simParams, {
        materialId: coverMat.id,
        stlMesh,
        ...(effectiveThickness !== undefined ? { thicknessMm: effectiveThickness } : {}),
      });
      pattern.materialId = coverMat.id;
      pattern.material = coverMat;
    } else {
      pattern = generateTemplatePattern(rawTemplateId, simParams);
    }
    validateAndSanitizePattern(pattern);
  } else {
    throw new ValidationError(
      'POST /api/simulate requires pattern (with pieces array) or templateId.',
      { code: 'INVALID_PATTERN', path: 'pattern' }
    );
  }

  const effectiveMaxEdgeMm = Math.max(
    8,
    Math.min(500, Number.isFinite(rawMaxEdgeLengthMm) ? rawMaxEdgeLengthMm : 38)
  );
  const steps = Number.isFinite(rawSteps)
    ? Math.max(0, Math.min(600, Math.trunc(rawSteps)))
    : 120;
  const clampedSubsteps = Number.isFinite(rawSubsteps)
    ? Math.max(4, Math.min(24, Math.trunc(rawSubsteps)))
    : 6;
  assertSimulationWithinBounds(pattern, effectiveMaxEdgeMm, steps, clampedSubsteps);

  const simOptions = {
    steps,
    ...(Number.isFinite(rawMaxEdgeLengthMm) ? { maxEdgeLengthMm: rawMaxEdgeLengthMm } : {}),
    ...(Number.isFinite(rawSubsteps) ? { substeps: rawSubsteps } : {}),
    ...(Number.isFinite(rawDt) ? { dt: rawDt } : {}),
    ...(Number.isFinite(rawGravityMmS2) ? { gravityMmS2: rawGravityMmS2 } : {}),
    materialId:
      validatedMatId ??
      bodyMaterialPresetId ??
      (typeof bodyMaterialObj?.id === 'string' && Object.hasOwn(MATERIAL_PRESETS, bodyMaterialObj.id)
        ? bodyMaterialObj.id
        : undefined) ??
      pattern?.materialId ??
      (typeof pattern?.material?.id === 'string' &&
      Object.hasOwn(MATERIAL_PRESETS, pattern.material.id)
        ? pattern.material.id
        : undefined),
    material: bodyMaterialObj,
    materialOverrides: safeMaterialOverrides,
    avatar:
      avatarInput === null
        ? null
        : isPlainObject(avatarInput)
          ? avatarInput
          : undefined,
    stlMesh: stlMesh || undefined,
  };

  return executeGuardedSimulation(pattern, simOptions);
}

function executeGuardedSimulationTask(payload = {}) {
  if (payload.rawJsonBytes || payload.body) {
    const body = payload.rawJsonBytes
      ? parseJsonObjectFromBytes(payload.rawJsonBytes)
      : payload.body;
    const result = prepareAndExecuteSimulation(body, payload.projectRoot, payload.workspaceRoot);
    return { jsonBytes: encodeJsonBytes(result) };
  }
  return executeGuardedSimulation(payload.pattern, payload.simOptions);
}

function createSimulationWorkerPool({
  maxWorkers = MAX_SIM_WORKERS,
  maxQueue = MAX_SIM_QUEUE,
  simTimeoutMs = DEFAULT_SIM_TIMEOUT_MS,
} = {}) {
  const workers = [];
  const queue = [];
  let nextJobId = 1;
  let destroyed = false;

  const effectiveTimeoutMs =
    Number.isFinite(simTimeoutMs) && simTimeoutMs > 0 ? Math.trunc(simTimeoutMs) : DEFAULT_SIM_TIMEOUT_MS;

  const removeWorkerEntry = (entry) => {
    const idx = workers.indexOf(entry);
    if (idx !== -1) workers.splice(idx, 1);
  };

  const spawnWorkerEntry = () => {
    const worker = new Worker(
      new URL(import.meta.url),
      createWorkerOptions({ isSimWorker: true })
    );
    const entry = { worker, busy: false, currentJob: null };

    worker.on('message', (msg) => {
      const job = entry.currentJob;
      if (!job || msg?.id !== job.id) return;
      entry.currentJob = null;
      entry.busy = false;
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      if (!job.settled) {
        job.settled = true;
        if (msg.ok) {
          job.resolve(msg.result);
        } else {
          const e = msg.error || {};
          if (e.name === 'ValidationError' || e.statusCode === 400) {
            job.reject(new HttpError(400, e.message || 'Invalid simulation input.', e.code || 'INVALID_SIMULATION'));
          } else {
            job.reject(new HttpError(e.statusCode || 500, e.message || 'Simulation failed.', e.code || 'SIMULATION_ERROR'));
          }
        }
      }
      pumpQueue();
    });

    worker.on('error', (err) => {
      const job = entry.currentJob;
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      if (job) {
        if (job.timer) {
          clearTimeout(job.timer);
          job.timer = null;
        }
        if (!job.settled) {
          job.settled = true;
          job.reject(new HttpError(500, err?.message || 'Simulation worker error.', 'SIMULATION_ERROR'));
        }
      }
      pumpQueue();
    });

    worker.on('exit', (code) => {
      const job = entry.currentJob;
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      if (job && !job.settled) {
        if (job.timer) {
          clearTimeout(job.timer);
          job.timer = null;
        }
        job.settled = true;
        job.reject(
          new HttpError(
            500,
            `Simulation worker exited unexpectedly (code ${code}).`,
            'SIMULATION_ERROR'
          )
        );
      }
      pumpQueue();
    });

    workers.push(entry);
    return entry;
  };

  const dispatchToEntry = (entry, job) => {
    entry.busy = true;
    entry.currentJob = job;
    job.workerEntry = entry;
    job.timer = setTimeout(() => {
      if (job.settled) return;
      job.settled = true;
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      entry.worker.terminate().catch(() => {});
      job.reject(
        new HttpError(
          504,
          `Simulation timed out after ${effectiveTimeoutMs} ms.`,
          'SIMULATION_TIMEOUT'
        )
      );
      pumpQueue();
    }, effectiveTimeoutMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
    const transferList = [];
    if (job.payload?.rawJsonBytes instanceof Uint8Array) {
      transferList.push(job.payload.rawJsonBytes.buffer);
    }
    entry.worker.postMessage(
      {
        id: job.id,
        payload: job.payload,
      },
      transferList
    );
  };

  const pumpQueue = () => {
    if (destroyed) return;
    while (queue.length > 0) {
      let entry = workers.find((w) => !w.busy);
      if (!entry && workers.length < maxWorkers) {
        entry = spawnWorkerEntry();
      }
      if (!entry) break;
      const job = queue.shift();
      if (!job || job.settled) continue;
      dispatchToEntry(entry, job);
    }
  };

  const abortJob = (job, err) => {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const qIdx = queue.indexOf(job);
    if (qIdx !== -1) queue.splice(qIdx, 1);
    const entry = job.workerEntry;
    if (entry && entry.currentJob === job) {
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      entry.worker.terminate().catch(() => {});
      pumpQueue();
    }
    job.reject(err);
  };

  return {
    run(payload, signal) {
      if (destroyed) {
        return Promise.reject(
          new HttpError(503, 'Server is shutting down.', 'SERVER_SHUTTING_DOWN')
        );
      }
      if (signal?.aborted) {
        return Promise.reject(
          new HttpError(499, 'Simulation request aborted by client.', 'CLIENT_ABORTED')
        );
      }
      const hasIdleOrSlot = workers.some((w) => !w.busy) || workers.length < maxWorkers;
      if (!hasIdleOrSlot && queue.length >= maxQueue) {
        return Promise.reject(
          new HttpError(
            503,
            `Simulation queue is full (max ${maxQueue}); please retry shortly.`,
            'SERVER_BUSY'
          )
        );
      }

      return new Promise((resolve, reject) => {
        const job = {
          id: nextJobId++,
          payload,
          resolve: (resVal) => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            resolve(resVal);
          },
          reject: (err) => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            reject(err);
          },
          timer: null,
          workerEntry: null,
          settled: false,
        };
        const onAbort = () => {
          abortJob(
            job,
            new HttpError(499, 'Simulation request aborted by client.', 'CLIENT_ABORTED')
          );
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        queue.push(job);
        pumpQueue();
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      while (queue.length > 0) {
        const job = queue.shift();
        if (job && !job.settled) {
          job.settled = true;
          if (job.timer) clearTimeout(job.timer);
          job.reject(new HttpError(503, 'Server is closing.', 'SERVER_SHUTTING_DOWN'));
        }
      }
      const toTerminate = workers.splice(0, workers.length);
      for (const entry of toTerminate) {
        const job = entry.currentJob;
        entry.currentJob = null;
        if (job && !job.settled) {
          job.settled = true;
          if (job.timer) clearTimeout(job.timer);
          job.reject(new HttpError(503, 'Server is closing.', 'SERVER_SHUTTING_DOWN'));
        }
        entry.worker.terminate().catch(() => {});
      }
    },
  };
}

function prepareGenerateTemplateResult(body, projectRoot, workspaceRoot) {
  const rawTemplateId = assertOptionalString(body.templateId, 'templateId');
  if (body.templateId !== undefined && body.templateId !== null && rawTemplateId.trim().length === 0) {
    throw new HttpError(
      400,
      'Invalid templateId: expected a non-empty template ID string.',
      'INVALID_TEMPLATE'
    );
  }
  const templateId =
    typeof rawTemplateId === 'string' && rawTemplateId.length > 0
      ? rawTemplateId
      : 'tshirt';
  const params = validateTemplateParams(body.params ?? body.parameters);
  const tplMeta = TEMPLATE_CATALOG.find((t) => t.id === templateId);
  const { material } = resolveRequestMaterialConfig(
    body,
    tplMeta?.defaultMaterial || 'cotton_jersey'
  );
  const avatarInput = body.avatar !== undefined ? body.avatar : body.avatarMeasurements;
  if (avatarInput !== undefined && avatarInput !== null && !isPlainObject(avatarInput)) {
    throw new HttpError(
      400,
      'Invalid avatar: expected a plain object or null.',
      'INVALID_AVATAR'
    );
  }

  const wsFile = assertOptionalString(body.workspaceFile, 'workspaceFile');
  const stlBase64 = assertOptionalString(body.stlBase64, 'stlBase64');
  const stlText = assertOptionalString(body.stlText, 'stlText');
  const stlName = assertOptionalString(body.stlName, 'stlName');
  const rawThickness = assertOptionalFiniteInput(body.thicknessMm, 'thicknessMm', 'INVALID_PARAMS');
  if (rawThickness !== undefined && (rawThickness < 0 || rawThickness > 1_000)) {
    throw new HttpError(
      400,
      'Invalid thicknessMm: must be between 0 and 1000 mm.',
      'INVALID_PARAMS'
    );
  }
  const explicitFabricWidthMm = assertOptionalFiniteInput(
    body.fabricWidthMm,
    'fabricWidthMm',
    'INVALID_OPTIONS'
  );
  if (
    explicitFabricWidthMm !== undefined &&
    (explicitFabricWidthMm < MIN_FABRIC_DIM_MM || explicitFabricWidthMm > MAX_FABRIC_WIDTH_MM)
  ) {
    throw new HttpError(
      400,
      `Invalid fabricWidthMm: must be between ${MIN_FABRIC_DIM_MM} and ${MAX_FABRIC_WIDTH_MM} mm.`,
      'INVALID_OPTIONS'
    );
  }

  let stlMesh = null;
  if (templateId === 'stl_cover') {
    if (typeof wsFile === 'string' && wsFile.trim().length > 0) {
      const { entry, buffer } = resolveNamedWorkspaceStl(
        wsFile.trim(),
        projectRoot,
        workspaceRoot
      );
      assertPreParseStlWithinBounds(buffer, entry.name);
      stlMesh = parseSTL(buffer, entry.name);
    } else if (typeof stlBase64 === 'string' && stlBase64.trim().length > 0) {
      const buf = Buffer.from(stlBase64, 'base64');
      assertPreParseStlWithinBounds(buf, stlName || 'upload.stl');
      stlMesh = parseSTL(buf, stlName || 'upload.stl');
    } else if (typeof stlText === 'string' && stlText.trim().length > 0) {
      assertPreParseStlWithinBounds(stlText, stlName || 'upload.stl');
      stlMesh = parseSTL(stlText, stlName || 'upload.stl');
    } else if (
      (wsFile !== undefined && wsFile !== null) ||
      (stlBase64 !== undefined && stlBase64 !== null) ||
      (stlText !== undefined && stlText !== null)
    ) {
      throw new HttpError(400, 'STL input payload is empty.', 'EMPTY_STL');
    }
    if (stlMesh && stlMesh.triangles.length > MAX_STL_TRIANGLES) {
      throw new HttpError(
        400,
        `STL triangle count (${stlMesh.triangles.length}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
        'STL_TOO_LARGE'
      );
    }
  }

  const pattern = generateTemplatePattern(templateId, params, {
    materialId: material.id,
    stlMesh: stlMesh || undefined,
    thicknessMm: params.thicknessMm ?? rawThickness,
  });

  pattern.materialId = material.id;
  pattern.material = material;

  const avatarVal = body.avatar !== undefined ? body.avatar : body.avatarMeasurements;
  if (isPlainObject(avatarVal)) {
    pattern.avatar = createParametricAvatar(avatarVal);
  }

  validateAndSanitizePattern(pattern);
  const seamReport = validatePatternSeams(pattern);
  assertCutPieceBudget(pattern);
  assertNestingComplexityWithinBounds(pattern);
  const nestOpts = { ...validateNestingAndExportOptions(body.nestingOptions, 'nestingOptions') };
  if (
    nestOpts.fabricWidthMm === undefined &&
    Number.isFinite(explicitFabricWidthMm)
  ) {
    nestOpts.fabricWidthMm = explicitFabricWidthMm;
  }
  assertNestingMarginWithinWidth(nestOpts, 'nestingOptions');
  const nesting = nestPatternPieces(pattern, nestOpts);

  return {
    pattern,
    seamReport,
    nesting,
    ...(stlMesh ? { stlSummary: buildStlSummary(stlMesh), mesh: buildPublicMesh(stlMesh) } : {}),
  };
}

function prepareUnwrapStlResult(body, projectRoot, workspaceRoot) {
  const rawName = assertOptionalString(body.name, 'name');
  const wsFile = assertOptionalString(body.workspaceFile, 'workspaceFile');
  const stlBase64 = assertOptionalString(body.stlBase64, 'stlBase64');
  const stlText = assertOptionalString(body.stlText, 'stlText');
  const rawMode = assertOptionalString(body.mode, 'mode');
  let unwrapMode;
  if (rawMode !== undefined && rawMode !== null) {
    const trimmedMode = rawMode.trim();
    if (trimmedMode.length === 0 || !SUPPORTED_UNWRAP_MODES.has(trimmedMode)) {
      throw new HttpError(
        400,
        `Unsupported unwrap mode "${rawMode}". Expected one of: form_shell_cover, surface_panels, chart_unfold.`,
        'INVALID_MODE'
      );
    }
    unwrapMode = trimmedMode;
  }
  const { hasMaterial, mergedOverrides, material } = resolveRequestMaterialConfig(
    body,
    'veg_leather'
  );
  const unwrapOpts = validateUnwrapOptions(body);
  const rawThickness = unwrapOpts.thicknessMm;

  let stlInput = null;
  let stlName = typeof rawName === 'string' && rawName.trim().length > 0
    ? rawName.trim()
    : 'model.stl';

  if (typeof wsFile === 'string' && wsFile.trim().length > 0) {
    const { entry, buffer } = resolveNamedWorkspaceStl(
      wsFile.trim(),
      projectRoot,
      workspaceRoot
    );
    stlInput = buffer;
    if (!rawName) stlName = entry.name;
  } else if (typeof stlBase64 === 'string' && stlBase64.trim().length > 0) {
    stlInput = Buffer.from(stlBase64, 'base64');
    if (stlInput.byteLength === 0) {
      throw new ValidationError('Decoded stlBase64 payload is empty.', {
        code: 'EMPTY_STL',
        path: 'stlBase64',
      });
    }
  } else if (typeof stlText === 'string') {
    stlInput = stlText;
  } else {
    throw new ValidationError(
      'Missing STL payload. Provide stlText, stlBase64, or workspaceFile.',
      { code: 'EMPTY_STL', path: 'stl' }
    );
  }

  assertPreParseStlWithinBounds(stlInput, stlName);
  const mesh = parseSTL(stlInput, stlName);
  if (mesh.triangles.length > MAX_STL_TRIANGLES) {
    throw new HttpError(
      400,
      `STL triangle count (${mesh.triangles.length}) exceeds maximum allowed (${MAX_STL_TRIANGLES}).`,
      'STL_TOO_LARGE'
    );
  }

  const hasExplicitThickness = Number.isFinite(rawThickness);
  const hasMaterialThicknessOverride =
    mergedOverrides.thicknessMm !== undefined && mergedOverrides.thicknessMm !== null;
  const thicknessMm = hasExplicitThickness
    ? rawThickness
    : hasMaterialThicknessOverride || hasMaterial
      ? material.thicknessMm
      : 0;

  const pattern = unwrapSTLToPattern(mesh, {
    name: typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : undefined,
    mode: unwrapMode,
    easeMm: unwrapOpts.easeMm,
    thicknessMm,
    seamAllowance: unwrapOpts.seamAllowance,
    scale: unwrapOpts.scale,
    ...(unwrapOpts.dihedralThresholdDeg !== undefined
      ? { dihedralThresholdDeg: unwrapOpts.dihedralThresholdDeg }
      : {}),
    ...(unwrapOpts.angleThresholdDeg !== undefined
      ? { angleThresholdDeg: unwrapOpts.angleThresholdDeg }
      : {}),
    ...(unwrapOpts.angleThreshold !== undefined
      ? { angleThreshold: unwrapOpts.angleThreshold }
      : {}),
    ...(unwrapOpts.minChartAreaMm2 !== undefined
      ? { minChartAreaMm2: unwrapOpts.minChartAreaMm2 }
      : {}),
    materialId: material.id,
  });
  pattern.materialId = material.id;
  pattern.material = material;

  validateAndSanitizePattern(pattern);
  const seamReport = validatePatternSeams(pattern);
  assertCutPieceBudget(pattern);
  assertNestingComplexityWithinBounds(pattern);
  const nestOpts = validateNestingAndExportOptions(body.nestingOptions, 'nestingOptions');
  assertNestingMarginWithinWidth(nestOpts, 'nestingOptions');
  const nesting = nestPatternPieces(pattern, nestOpts);

  return {
    stlSummary: buildStlSummary(mesh),
    mesh: buildPublicMesh(mesh),
    pattern,
    seamReport,
    nesting,
  };
}

function validateNestRequestBody(body) {
  const { safePattern } = validateAndSanitizePattern(
    body.pattern,
    'INVALID_PATTERN',
    'POST /api/nest requires a pattern object with a pieces array.',
    { validateSeamRefs: false }
  );
  if (safePattern.pieces.length === 0) {
    throw new HttpError(
      400,
      'POST /api/nest requires pattern.pieces to contain at least 1 piece.',
      'INVALID_PATTERN'
    );
  }
  validateAndResolvePatternMaterial(safePattern);
  if (body.options !== undefined && body.options !== null && !isPlainObject(body.options)) {
    throw new HttpError(400, 'Invalid options: expected a plain object.', 'INVALID_OPTIONS');
  }
  const topOpts = validateNestingAndExportOptions(extractTopLevelOptions(body), 'body');
  const options = isPlainObject(body.options)
    ? { ...topOpts, ...validateNestingAndExportOptions(body.options, 'options') }
    : topOpts;
  assertNestingMarginWithinWidth(options, 'options');
  assertNestingComplexityWithinBounds(safePattern);
  return { safePattern, options };
}

function validateExportRequestBody(body, { runPdfBoundsOnMain = false } = {}) {
  const { safeName, safePattern } = validateAndSanitizePattern(
    body.pattern,
    'INVALID_PATTERN',
    'POST /api/export requires a pattern object with a pieces array.'
  );
  if (safePattern.pieces.length === 0) {
    throw new HttpError(
      400,
      'POST /api/export requires pattern.pieces to contain at least 1 piece.',
      'INVALID_PATTERN'
    );
  }
  validateAndResolvePatternMaterial(safePattern);
  if (body.options !== undefined && body.options !== null && !isPlainObject(body.options)) {
    throw new HttpError(400, 'Invalid options: expected a plain object.', 'INVALID_OPTIONS');
  }
  const topOpts = validateNestingAndExportOptions(extractTopLevelOptions(body), 'body');
  const options = isPlainObject(body.options)
    ? { ...topOpts, ...validateNestingAndExportOptions(body.options, 'options') }
    : topOpts;
  const rawFormat = assertOptionalString(body.format, 'format', 'UNSUPPORTED_FORMAT');
  const format = typeof rawFormat === 'string' ? rawFormat.trim().toLowerCase() : '';
  const slug = makeFileSlug(safeName, 'pattern');

  if (format !== 'svg' && format !== 'pdf' && format !== 'dxf' && format !== 'json') {
    throw new HttpError(
      400,
      `Unsupported export format "${format}". Expected svg, pdf, dxf, or json.`,
      'UNSUPPORTED_FORMAT'
    );
  }

  assertExportComplexityWithinBounds(safePattern, options);
  if (format !== 'json') {
    if (options.layout === 'nested' && !options.nestingResult) {
      if (format === 'pdf') {
        const {
          widthMm: _w,
          heightMm: _h,
          format: _f,
          pageWidthMm: _pw,
          pageHeightMm: _ph,
          pageFormat: _pf,
          ...nestMarginOpts
        } = options;
        assertNestingMarginWithinWidth(nestMarginOpts, 'options');
      } else {
        assertNestingMarginWithinWidth(options, 'options');
      }
    }
    if (format === 'pdf') {
      assertExportPdfOptionsWithinBounds(options);
      assertExportPlacementSpanWithinBounds(options);
      if (runPdfBoundsOnMain && options.layout !== 'nested' && !options.nestingResult) {
        assertExportPdfWithinBounds(safePattern, options);
      }
    } else {
      assertExportPlacementSpanWithinBounds(options);
    }
  }

  return { format, safePattern, options, slug };
}

function executeFormatExport(format, safePattern, options = {}, slug = 'pattern') {
  switch (format) {
    case 'svg': {
      const text = exportSVG(safePattern, options);
      return { contentType: 'image/svg+xml; charset=utf-8', ext: 'svg', slug, text };
    }
    case 'pdf': {
      assertExportPdfWithinBounds(safePattern, options);
      const pdfRes = exportTiledPDF(safePattern, options);
      const raw = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
      const bytes = toTransferableUint8Array(raw);
      return { contentType: 'application/pdf', ext: 'pdf', slug, bytes };
    }
    case 'dxf': {
      const text = exportDXF(safePattern, options);
      return { contentType: 'application/dxf; charset=utf-8', ext: 'dxf', slug, text };
    }
    case 'json': {
      const jsonStr = exportPatternJSON(safePattern);
      const bytes = toTransferableUint8Array(Buffer.from(jsonStr, 'utf8'));
      return { contentType: 'application/json; charset=utf-8', ext: 'json', slug, bytes };
    }
    default:
      throw new HttpError(
        400,
        `Unsupported export format "${format}". Expected svg, pdf, dxf, or json.`,
        'UNSUPPORTED_FORMAT'
      );
  }
}

function executeGuardedExportTask(payload = {}) {
  const { task } = payload;
  if (task === 'generateTemplate') {
    const body = payload.rawJsonBytes
      ? parseJsonObjectFromBytes(payload.rawJsonBytes)
      : payload.body;
    const result = prepareGenerateTemplateResult(body, payload.projectRoot, payload.workspaceRoot);
    return { jsonBytes: encodeJsonBytes(result) };
  }
  if (task === 'unwrapStl') {
    const body = payload.rawJsonBytes
      ? parseJsonObjectFromBytes(payload.rawJsonBytes)
      : payload.body;
    const result = prepareUnwrapStlResult(body, payload.projectRoot, payload.workspaceRoot);
    return { jsonBytes: encodeJsonBytes(result) };
  }
  if (task === 'nest') {
    let safePattern = payload.safePattern;
    let options = payload.options || {};
    if (payload.rawJsonBytes) {
      const body = parseJsonObjectFromBytes(payload.rawJsonBytes);
      const validated = validateNestRequestBody(body);
      safePattern = validated.safePattern;
      options = validated.options;
    }
    const nesting = nestPatternPieces(safePattern, options);
    return { jsonBytes: encodeJsonBytes({ nesting }) };
  }
  if (payload.rawJsonBytes) {
    const body = parseJsonObjectFromBytes(payload.rawJsonBytes);
    const { format, safePattern, options, slug } = validateExportRequestBody(body);
    return executeFormatExport(format, safePattern, options, slug);
  }
  return executeFormatExport(payload.format, payload.safePattern, payload.options, payload.slug);
}

function createExportWorkerPool({
  maxWorkers = MAX_EXPORT_WORKERS,
  maxQueue = MAX_EXPORT_QUEUE,
  exportTimeoutMs = DEFAULT_EXPORT_TIMEOUT_MS,
} = {}) {
  const workers = [];
  const queue = [];
  let nextJobId = 1;
  let destroyed = false;

  const effectiveTimeoutMs =
    Number.isFinite(exportTimeoutMs) && exportTimeoutMs > 0
      ? Math.trunc(exportTimeoutMs)
      : DEFAULT_EXPORT_TIMEOUT_MS;

  const removeWorkerEntry = (entry) => {
    const idx = workers.indexOf(entry);
    if (idx !== -1) workers.splice(idx, 1);
  };

  const spawnWorkerEntry = () => {
    const worker = new Worker(
      new URL(import.meta.url),
      createWorkerOptions({ isExportWorker: true })
    );
    const entry = { worker, busy: false, currentJob: null };

    worker.on('message', (msg) => {
      const job = entry.currentJob;
      if (!job || msg?.id !== job.id) return;
      entry.currentJob = null;
      entry.busy = false;
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      if (!job.settled) {
        job.settled = true;
        if (msg.ok) {
          job.resolve(msg.result);
        } else {
          const e = msg.error || {};
          if (e.name === 'ValidationError' || e.statusCode === 400) {
            job.reject(
              new HttpError(400, e.message || 'Invalid export input.', e.code || 'INVALID_EXPORT')
            );
          } else {
            job.reject(
              new HttpError(e.statusCode || 500, e.message || 'Export failed.', e.code || 'EXPORT_ERROR')
            );
          }
        }
      }
      pumpQueue();
    });

    worker.on('error', (err) => {
      const job = entry.currentJob;
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      if (job) {
        if (job.timer) {
          clearTimeout(job.timer);
          job.timer = null;
        }
        if (!job.settled) {
          job.settled = true;
          job.reject(new HttpError(500, err?.message || 'Export worker error.', 'EXPORT_ERROR'));
        }
      }
      pumpQueue();
    });

    worker.on('exit', (code) => {
      const job = entry.currentJob;
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      if (job && !job.settled) {
        if (job.timer) {
          clearTimeout(job.timer);
          job.timer = null;
        }
        job.settled = true;
        job.reject(
          new HttpError(500, `Export worker exited unexpectedly (code ${code}).`, 'EXPORT_ERROR')
        );
      }
      pumpQueue();
    });

    workers.push(entry);
    return entry;
  };

  const dispatchToEntry = (entry, job) => {
    entry.busy = true;
    entry.currentJob = job;
    job.workerEntry = entry;
    job.timer = setTimeout(() => {
      if (job.settled) return;
      job.settled = true;
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      entry.worker.terminate().catch(() => {});
      job.reject(
        new HttpError(504, `Export timed out after ${effectiveTimeoutMs} ms.`, 'EXPORT_TIMEOUT')
      );
      pumpQueue();
    }, effectiveTimeoutMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
    const transferList = [];
    if (job.payload?.rawJsonBytes instanceof Uint8Array) {
      transferList.push(job.payload.rawJsonBytes.buffer);
    }
    entry.worker.postMessage(
      {
        id: job.id,
        payload: job.payload,
      },
      transferList
    );
  };

  const pumpQueue = () => {
    if (destroyed) return;
    while (queue.length > 0) {
      let entry = workers.find((w) => !w.busy);
      if (!entry && workers.length < maxWorkers) {
        entry = spawnWorkerEntry();
      }
      if (!entry) break;
      const job = queue.shift();
      if (!job || job.settled) continue;
      dispatchToEntry(entry, job);
    }
  };

  const abortJob = (job, err) => {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const qIdx = queue.indexOf(job);
    if (qIdx !== -1) queue.splice(qIdx, 1);
    const entry = job.workerEntry;
    if (entry && entry.currentJob === job) {
      entry.currentJob = null;
      entry.busy = false;
      removeWorkerEntry(entry);
      entry.worker.terminate().catch(() => {});
      pumpQueue();
    }
    job.reject(err);
  };

  return {
    run(payload, signal) {
      if (destroyed) {
        return Promise.reject(
          new HttpError(503, 'Server is shutting down.', 'SERVER_SHUTTING_DOWN')
        );
      }
      if (signal?.aborted) {
        return Promise.reject(
          new HttpError(499, 'Export request aborted by client.', 'CLIENT_ABORTED')
        );
      }
      const hasIdleOrSlot = workers.some((w) => !w.busy) || workers.length < maxWorkers;
      if (!hasIdleOrSlot && queue.length >= maxQueue) {
        return Promise.reject(
          new HttpError(
            503,
            `Export queue is full (max ${maxQueue}); please retry shortly.`,
            'SERVER_BUSY'
          )
        );
      }

      return new Promise((resolve, reject) => {
        const job = {
          id: nextJobId++,
          payload,
          resolve: (resVal) => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            resolve(resVal);
          },
          reject: (err) => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            reject(err);
          },
          timer: null,
          workerEntry: null,
          settled: false,
        };
        const onAbort = () => {
          abortJob(
            job,
            new HttpError(499, 'Export request aborted by client.', 'CLIENT_ABORTED')
          );
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        queue.push(job);
        pumpQueue();
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      while (queue.length > 0) {
        const job = queue.shift();
        if (job && !job.settled) {
          job.settled = true;
          if (job.timer) clearTimeout(job.timer);
          job.reject(new HttpError(503, 'Server is closing.', 'SERVER_SHUTTING_DOWN'));
        }
      }
      const toTerminate = workers.splice(0, workers.length);
      for (const entry of toTerminate) {
        const job = entry.currentJob;
        entry.currentJob = null;
        if (job && !job.settled) {
          job.settled = true;
          if (job.timer) clearTimeout(job.timer);
          job.reject(new HttpError(503, 'Server is closing.', 'SERVER_SHUTTING_DOWN'));
        }
        entry.worker.terminate().catch(() => {});
      }
    },
  };
}

export function parseServerArgs(argv = process.argv.slice(2), env = process.env) {
  let host = typeof env.HOST === 'string' && env.HOST.trim().length > 0 ? env.HOST.trim() : '0.0.0.0';
  let port =
    typeof env.PORT === 'string' && env.PORT.trim().length > 0
      ? Number(env.PORT.trim())
      : 4174;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --host.');
      }
      host = String(argv[++i]).trim();
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length).trim();
    } else if (arg === '--port') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --port. Expected integer 0..65535.');
      }
      const rawPort = String(argv[++i]);
      if (rawPort.trim() === '') {
        throw new Error('Invalid port specified: empty value for --port. Expected integer 0..65535.');
      }
      port = Number(rawPort);
    } else if (arg.startsWith('--port=')) {
      const rawPort = arg.slice('--port='.length);
      if (rawPort.trim() === '') {
        throw new Error('Invalid port specified: empty value for --port=. Expected integer 0..65535.');
      }
      port = Number(rawPort);
    }
  }

  if (!host) host = '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port specified: ${port}. Expected integer 0..65535.`);
  }

  return { host, port };
}

export function createStudioServer(config = {}) {
  const projectRoot = config.projectRoot || DEFAULT_PROJECT_ROOT;
  const workspaceRoot = config.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const publicDir = config.publicDir || path.join(projectRoot, 'public');
  const coreDir = config.coreDir || path.join(projectRoot, 'src', 'core');
  const threeVendorDir = fs.existsSync(path.join(projectRoot, 'node_modules', 'three'))
    ? path.join(projectRoot, 'node_modules', 'three')
    : path.join(DEFAULT_PROJECT_ROOT, 'node_modules', 'three');
  const bindHost = config.host || '0.0.0.0';

  let activeServer = null;
  const simPool = createSimulationWorkerPool({
    simTimeoutMs: config.simTimeoutMs,
  });
  const exportPool = createExportWorkerPool({
    exportTimeoutMs: config.exportTimeoutMs,
  });

  const runExportPoolTask = async (res, payload) => {
    const abortController = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on('close', onResClose);
    try {
      const result = await exportPool.run(payload, abortController.signal);
      if (abortController.signal.aborted || res.writableEnded) {
        return null;
      }
      return result;
    } finally {
      res.off('close', onResClose);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const rawUrl = req.url || '/';
      if (rawUrl.startsWith('//') || rawUrl.startsWith('/\\') || rawUrl.startsWith('\\\\')) {
        throw new HttpError(400, 'Malformed request URL.', 'BAD_URL');
      }
      let url;
      try {
        url = new URL(rawUrl, 'http://127.0.0.1');
      } catch {
        throw new HttpError(400, 'Malformed request URL.', 'BAD_URL');
      }
      if ((rawUrl.startsWith('/') || rawUrl.startsWith('\\')) && url.hostname !== '127.0.0.1') {
        throw new HttpError(400, 'Malformed request URL.', 'BAD_URL');
      }
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      // ------------------------------------------------------------------
      // REST API Endpoints
      // ------------------------------------------------------------------
      const API_ROUTE_METHODS = {
        '/api/health': ['GET', 'HEAD'],
        '/api/catalog': ['GET', 'HEAD'],
        '/api/workspace-stls': ['GET', 'HEAD'],
        '/api/stl-content': ['GET', 'HEAD'],
        '/api/generate-template': ['POST'],
        '/api/patterns/generate': ['POST'],
        '/api/unwrap-stl': ['POST'],
        '/api/simulate': ['POST'],
        '/api/nest': ['POST'],
        '/api/export': ['POST'],
      };
      if (pathname.startsWith('/api/')) {
        const allowedMethods = Object.hasOwn(API_ROUTE_METHODS, pathname)
          ? API_ROUTE_METHODS[pathname]
          : null;
        if (!allowedMethods) {
          sendJson(res, 404, { error: `Unknown API route: ${method} ${pathname}` });
          return;
        }
        if (method === 'OPTIONS') {
          res.writeHead(204, {
            Allow: [...allowedMethods, 'OPTIONS'].join(', '),
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        if (!allowedMethods.includes(method)) {
          sendJson(
            res,
            405,
            {
              error: `Method ${method} not allowed for ${pathname}. Allowed: ${allowedMethods.join(', ')}`,
            },
            { Allow: allowedMethods.join(', ') }
          );
          return;
        }
      }

      const isHead = method === 'HEAD';
      if (pathname === '/api/health' && (method === 'GET' || isHead)) {
        const addr = activeServer?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : config.port ?? 4174;
        sendJson(
          res,
          200,
          {
            ok: true,
            version: SCHEMA_VERSION,
            host: bindHost,
            port: actualPort,
          },
          {},
          isHead
        );
        return;
      }

      if (pathname === '/api/catalog' && (method === 'GET' || isHead)) {
        const workspaceStls = toPublicStlList(
          discoverWorkspaceSTLFiles(projectRoot, workspaceRoot)
        );
        sendJson(
          res,
          200,
          {
            templates: TEMPLATE_CATALOG,
            materials: Object.values(MATERIAL_PRESETS),
            rolls: FABRIC_ROLL_PRESETS,
            pageFormats: PAGE_FORMATS,
            defaultAvatar: DEFAULT_AVATAR,
            workspaceStls,
          },
          {},
          isHead
        );
        return;
      }

      if (pathname === '/api/workspace-stls' && (method === 'GET' || isHead)) {
        const files = toPublicStlList(discoverWorkspaceSTLFiles(projectRoot, workspaceRoot));
        sendJson(res, 200, { files }, {}, isHead);
        return;
      }

      if (pathname === '/api/stl-content' && (method === 'GET' || isHead)) {
        const rawFile = url.searchParams.get('file') || '';
        const { buffer } = resolveNamedWorkspaceStl(rawFile, projectRoot, workspaceRoot);
        sendRaw(
          res,
          200,
          buffer,
          'model/stl',
          {
            'Cache-Control': 'no-store',
          },
          isHead
        );
        return;
      }

      if (
        (pathname === '/api/generate-template' || pathname === '/api/patterns/generate') &&
        method === 'POST'
      ) {
        const rawBuf = await readRawBody(req);
        if (rawBuf.byteLength >= RAW_JSON_OFFLOAD_THRESHOLD_BYTES) {
          const taskRes = await runExportPoolTask(res, {
            task: 'generateTemplate',
            rawJsonBytes: toTransferableUint8Array(rawBuf),
            projectRoot,
            workspaceRoot,
          });
          if (!taskRes) return;
          const payload = Buffer.from(
            taskRes.jsonBytes.buffer,
            taskRes.jsonBytes.byteOffset,
            taskRes.jsonBytes.byteLength
          );
          sendRaw(res, 200, payload, 'application/json; charset=utf-8', {
            'Cache-Control': 'no-store',
          });
          return;
        }
        const body = parseJsonObjectFromBytes(rawBuf);
        const rawTemplateId = assertOptionalString(body.templateId, 'templateId');
        const templateId =
          typeof rawTemplateId === 'string' && rawTemplateId.length > 0
            ? rawTemplateId
            : 'tshirt';
        const hasStlPayload =
          (typeof body.workspaceFile === 'string' && body.workspaceFile.trim().length > 0) ||
          (typeof body.stlBase64 === 'string' && body.stlBase64.trim().length > 0) ||
          (typeof body.stlText === 'string' && body.stlText.trim().length > 0);
        if (templateId === 'stl_cover' || hasStlPayload) {
          const taskRes = await runExportPoolTask(res, {
            task: 'generateTemplate',
            body,
            projectRoot,
            workspaceRoot,
          });
          if (!taskRes) return;
          const payload = Buffer.from(
            taskRes.jsonBytes.buffer,
            taskRes.jsonBytes.byteOffset,
            taskRes.jsonBytes.byteLength
          );
          sendRaw(res, 200, payload, 'application/json; charset=utf-8', {
            'Cache-Control': 'no-store',
          });
          return;
        }
        const result = prepareGenerateTemplateResult(body, projectRoot, workspaceRoot);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/unwrap-stl' && method === 'POST') {
        const rawBuf = await readRawBody(req);
        const payloadSpec =
          rawBuf.byteLength >= RAW_JSON_OFFLOAD_THRESHOLD_BYTES
            ? {
                task: 'unwrapStl',
                rawJsonBytes: toTransferableUint8Array(rawBuf),
                projectRoot,
                workspaceRoot,
              }
            : {
                task: 'unwrapStl',
                body: parseJsonObjectFromBytes(rawBuf),
                projectRoot,
                workspaceRoot,
              };
        const taskRes = await runExportPoolTask(res, payloadSpec);
        if (!taskRes) return;
        const payload = Buffer.from(
          taskRes.jsonBytes.buffer,
          taskRes.jsonBytes.byteOffset,
          taskRes.jsonBytes.byteLength
        );
        sendRaw(res, 200, payload, 'application/json; charset=utf-8', {
          'Cache-Control': 'no-store',
        });
        return;
      }

      if (pathname === '/api/simulate' && method === 'POST') {
        const rawBuf = await readRawBody(req);
        const payloadSpec =
          rawBuf.byteLength >= RAW_JSON_OFFLOAD_THRESHOLD_BYTES
            ? {
                rawJsonBytes: toTransferableUint8Array(rawBuf),
                projectRoot,
                workspaceRoot,
              }
            : {
                body: parseJsonObjectFromBytes(rawBuf),
                projectRoot,
                workspaceRoot,
              };

        const abortController = new AbortController();
        const onResClose = () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        };
        res.on('close', onResClose);
        let taskRes;
        try {
          taskRes = await simPool.run(payloadSpec, abortController.signal);
        } finally {
          res.off('close', onResClose);
        }
        if (abortController.signal.aborted || res.writableEnded) {
          return;
        }
        const payload = Buffer.from(
          taskRes.jsonBytes.buffer,
          taskRes.jsonBytes.byteOffset,
          taskRes.jsonBytes.byteLength
        );
        sendRaw(res, 200, payload, 'application/json; charset=utf-8', {
          'Cache-Control': 'no-store',
        });
        return;
      }

      if (pathname === '/api/nest' && method === 'POST') {
        const rawBuf = await readRawBody(req);
        let payloadSpec;
        if (rawBuf.byteLength >= RAW_JSON_OFFLOAD_THRESHOLD_BYTES) {
          payloadSpec = {
            task: 'nest',
            rawJsonBytes: toTransferableUint8Array(rawBuf),
          };
        } else {
          const body = parseJsonObjectFromBytes(rawBuf);
          const { safePattern, options } = validateNestRequestBody(body);
          payloadSpec = { task: 'nest', safePattern, options };
        }
        const taskRes = await runExportPoolTask(res, payloadSpec);
        if (!taskRes) return;
        const payload = Buffer.from(
          taskRes.jsonBytes.buffer,
          taskRes.jsonBytes.byteOffset,
          taskRes.jsonBytes.byteLength
        );
        sendRaw(res, 200, payload, 'application/json; charset=utf-8', {
          'Cache-Control': 'no-store',
        });
        return;
      }

      if (pathname === '/api/export' && method === 'POST') {
        const rawBuf = await readRawBody(req);
        let payloadSpec;
        let fallbackSlug = 'pattern';
        if (rawBuf.byteLength >= RAW_JSON_OFFLOAD_THRESHOLD_BYTES) {
          payloadSpec = {
            task: 'export',
            rawJsonBytes: toTransferableUint8Array(rawBuf),
          };
        } else {
          const body = parseJsonObjectFromBytes(rawBuf);
          const { format, safePattern, options, slug } = validateExportRequestBody(body, {
            runPdfBoundsOnMain: true,
          });
          fallbackSlug = slug;
          payloadSpec = { task: 'export', format, safePattern, options, slug };
        }
        const exportRes = await runExportPoolTask(res, payloadSpec);
        if (!exportRes) return;
        const slug = exportRes.slug || fallbackSlug;
        const payload = exportRes.bytes
          ? Buffer.from(
              exportRes.bytes.buffer,
              exportRes.bytes.byteOffset,
              exportRes.bytes.byteLength
            )
          : exportRes.text;
        sendRaw(res, 200, payload, exportRes.contentType, {
          'Content-Disposition': `attachment; filename="${slug}.${exportRes.ext}"`,
        });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: `Unknown API route: ${method} ${pathname}` });
        return;
      }

      // ------------------------------------------------------------------
      // Static Files & Isomorphic /src/core/*.mjs Serving
      // ------------------------------------------------------------------
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        sendJson(
          res,
          405,
          { error: `Method ${method} not allowed` },
          { Allow: 'GET, HEAD, OPTIONS' }
        );
        return;
      }

      if (pathname === '/favicon.ico') {
        if (method === 'OPTIONS') {
          res.writeHead(204, {
            Allow: 'GET, HEAD, OPTIONS',
            'Content-Length': '0',
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        res.writeHead(204, {
          'Content-Length': '0',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (pathname.startsWith('/vendor/three/')) {
        const relThree = pathname.slice('/vendor/three/'.length);
        if (!relThree || (!relThree.endsWith('.js') && !relThree.endsWith('.mjs'))) {
          throw new HttpError(403, 'Only .js/.mjs vendor modules may be served.', 'FORBIDDEN');
        }
        const resolvedThree = safeResolveInside(threeVendorDir, relThree);
        if (method === 'OPTIONS') {
          if (!fs.existsSync(resolvedThree) || !fs.statSync(resolvedThree).isFile()) {
            throw new HttpError(404, 'Vendor module not found.', 'NOT_FOUND');
          }
          res.writeHead(204, {
            Allow: 'GET, HEAD, OPTIONS',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end();
          return;
        }
        const content = fs.readFileSync(resolvedThree);
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(content.length),
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(method === 'HEAD' ? undefined : content);
        return;
      }

      if (pathname.startsWith('/src/core/')) {
        const relCore = pathname.slice('/src/core/'.length);
        if (!relCore || !relCore.endsWith('.mjs')) {
          throw new HttpError(403, 'Only .mjs core modules may be served.', 'FORBIDDEN');
        }
        const resolved = safeResolveInside(coreDir, relCore);
        if (method === 'OPTIONS') {
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            throw new HttpError(404, 'Core module not found.', 'NOT_FOUND');
          }
          res.writeHead(204, {
            Allow: 'GET, HEAD, OPTIONS',
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        const content = fs.readFileSync(resolved);
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(content.length),
          'Cache-Control': 'no-store',
        });
        res.end(method === 'HEAD' ? undefined : content);
        return;
      }

      const staticRel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const resolvedStatic = safeResolveInside(publicDir, staticRel);
      const ext = path.extname(resolvedStatic).toLowerCase();
      const mime = STATIC_MIME_TYPES[ext];
      if (!mime) {
        throw new HttpError(404, 'Unsupported static file type.', 'NOT_FOUND');
      }
      if (method === 'OPTIONS') {
        if (!fs.existsSync(resolvedStatic) || !fs.statSync(resolvedStatic).isFile()) {
          throw new HttpError(404, 'Static file not found.', 'NOT_FOUND');
        }
        res.writeHead(204, {
          Allow: 'GET, HEAD, OPTIONS',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      const content = fs.readFileSync(resolvedStatic);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': String(content.length),
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : content);
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }

      let statusCode = 500;
      let message = err?.message || 'Internal Server Error';
      if (err instanceof HttpError) {
        statusCode = err.statusCode;
      } else if (err instanceof ValidationError || err?.name === 'ValidationError') {
        statusCode = 400;
      } else if (err instanceof SyntaxError) {
        statusCode = 400;
      }

      const headers = statusCode === 413 ? { Connection: 'close' } : {};
      sendJson(res, statusCode, { error: message }, headers);
      if (statusCode === 413) {
        res.on('finish', () => {
          if (!req.destroyed) req.destroy();
        });
      }
    }
  });

  activeServer = server;
  server.on('close', () => {
    simPool.destroy();
    exportPool.destroy();
  });
  return server;
}

export async function startServer(options = {}) {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 4174;
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const remoteHost =
    (options.remoteHost || process.env.REMOTE_HOST || '').trim() ||
    os.hostname() ||
    'localhost';

  const server = createStudioServer({
    host,
    port,
    projectRoot,
    workspaceRoot,
    publicDir: options.publicDir,
    coreDir: options.coreDir,
    simTimeoutMs: options.simTimeoutMs,
    exportTimeoutMs: options.exportTimeoutMs,
  });

  if (typeof options.onServerCreated === 'function') {
    options.onServerCreated(server);
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        err.message = `Port ${port} on ${host} is already in use (EADDRINUSE).`;
      } else if (err.code === 'EACCES') {
        err.message = `Permission denied binding ${host}:${port} (EACCES).`;
      }
      reject(err);
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;

      if (!options.quiet) {
        const stls = discoverWorkspaceSTLFiles(projectRoot, workspaceRoot);
        const stlList = stls.length > 0 ? stls.map((s) => s.name).join(', ') : '(none)';
        console.log('====================================================================');
        console.log(' pattern_studio_v2 — 2D/3D Pattern CAD & Cut-and-Sew Studio');
        console.log(` Local:      http://127.0.0.1:${actualPort}`);
        console.log(` Remote:     http://${remoteHost}:${actualPort}`);
        console.log(` SSH Tunnel: ssh -L ${actualPort}:localhost:${actualPort} ${remoteHost}`);
        console.log(` Bind:       ${host}:${actualPort}`);
        console.log(` Workspace STLs: ${stlList}`);
        console.log('====================================================================');
      }

      resolve({ server, host, port: actualPort });
    });
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (!isMainThread && workerData?.isSimWorker && parentPort) {
  parentPort.on('message', (msg) => {
    const id = msg?.id;
    try {
      const result = executeGuardedSimulationTask(msg.payload);
      const transferList = [];
      if (result?.jsonBytes instanceof Uint8Array) {
        transferList.push(result.jsonBytes.buffer);
      }
      if (transferList.length > 0) {
        parentPort.postMessage({ id, ok: true, result }, transferList);
      } else {
        parentPort.postMessage({ id, ok: true, result });
      }
    } catch (err) {
      const statusCode =
        err instanceof HttpError
          ? err.statusCode
          : err instanceof ValidationError || err?.name === 'ValidationError' || err instanceof SyntaxError
            ? 400
            : 500;
      parentPort.postMessage({
        id,
        ok: false,
        error: {
          message: err?.message || 'Simulation failed.',
          statusCode,
          code: err?.code || 'SIMULATION_ERROR',
          name: err?.name || 'Error',
        },
      });
    }
  });
} else if (!isMainThread && workerData?.isExportWorker && parentPort) {
  parentPort.on('message', (msg) => {
    const id = msg?.id;
    try {
      const result = executeGuardedExportTask(msg.payload);
      const transferList = [];
      if (result?.bytes instanceof Uint8Array) {
        transferList.push(result.bytes.buffer);
      }
      if (result?.jsonBytes instanceof Uint8Array) {
        transferList.push(result.jsonBytes.buffer);
      }
      if (transferList.length > 0) {
        parentPort.postMessage({ id, ok: true, result }, transferList);
      } else {
        parentPort.postMessage({ id, ok: true, result });
      }
    } catch (err) {
      const statusCode =
        err instanceof HttpError
          ? err.statusCode
          : err instanceof ValidationError || err?.name === 'ValidationError' || err instanceof SyntaxError
            ? 400
            : 500;
      parentPort.postMessage({
        id,
        ok: false,
        error: {
          message: err?.message || 'Export failed.',
          statusCode,
          code: err?.code || 'EXPORT_ERROR',
          name: err?.name || 'Error',
        },
      });
    }
  });
} else if (isMainThread && isMain) {
  let parsed;
  try {
    parsed = parseServerArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  let cliServer = null;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!cliServer || !cliServer.listening) {
      if (cliServer) {
        try {
          cliServer.close(() => {});
        } catch {
          // ignore if server is not listening yet
        }
      }
      process.exit(0);
      return;
    }
    cliServer.close(() => process.exit(0));
    if (typeof cliServer.closeIdleConnections === 'function') {
      cliServer.closeIdleConnections();
    }
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  startServer({
    ...parsed,
    onServerCreated: (server) => {
      cliServer = server;
    },
  })
    .then(({ server }) => {
      cliServer = server;
      server.on('error', (err) => {
        if (shuttingDown) return;
        console.error(`Server error: ${err.message}`);
        process.exit(1);
      });
      if (shuttingDown) {
        server.close(() => process.exit(0));
      }
    })
    .catch((err) => {
      if (shuttingDown) {
        process.exit(0);
        return;
      }
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    });
}
