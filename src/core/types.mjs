/**
 * Canonical PatternProject Schema, Validation, Factories, and Unit Conversion.
 * Pure leaf module: zero imports from other src/core/*.mjs modules.
 * All internal spatial coordinates, curves, seam allowances, and measurements use canonical 'mm'.
 */

export const SCHEMA_VERSION = '2.0.0';
export const CANONICAL_UNIT = 'mm';
export const SUPPORTED_UNITS = Object.freeze(['mm', 'cm', 'in']);
export const UNIT_FACTORS = Object.freeze({
  mm: 1.0,
  cm: 10.0,
  in: 25.4,
});
export const NOTCH_TYPES = Object.freeze(['single', 'double', 'v', 't']);
export const INTERNAL_LINE_TYPES = Object.freeze(['fold', 'stitch', 'pocket', 'grain', 'balance', 'guide']);
const MAX_PIECE_QUANTITY = 10000;

export const DEFAULT_AVATAR_MEASUREMENTS = Object.freeze({
  chestMm: 980,
  waistMm: 820,
  hipMm: 1000,
  shoulderWidthMm: 440,
  heightMm: 1750,
});

export class ValidationError extends Error {
  constructor(message, { code = 'VALIDATION_ERROR', path = '', details = null } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function safeString(val) {
  try {
    return String(val);
  } catch {
    try {
      return Object.prototype.toString.call(val);
    } catch {
      return '[object Unknown]';
    }
  }
}

function toSafeNumber(val) {
  if (typeof val === 'symbol' || typeof val === 'bigint') return NaN;
  try {
    return Number(val);
  } catch {
    return NaN;
  }
}

function coerceUnexpectedValidationError(err, path = '') {
  if (err instanceof ValidationError) return err;
  let msg;
  try {
    msg = err && typeof err === 'object' && 'message' in err ? safeString(err.message) : safeString(err);
  } catch {
    msg = 'Unexpected validation error';
  }
  return new ValidationError(msg, {
    code: 'VALIDATION_ERROR',
    path,
    details: { cause: err },
  });
}

export function isValidUnit(unit) {
  return typeof unit === 'string' && Object.hasOwn(UNIT_FACTORS, unit);
}

export function mmToUnit(valueMm, unit = 'mm') {
  if (!Number.isFinite(valueMm)) {
    throw new ValidationError(`Expected finite number for mmToUnit, got ${safeString(valueMm)}`, {
      code: 'NON_FINITE_NUMBER',
      path: 'valueMm',
      details: { valueMm },
    });
  }
  if (!isValidUnit(unit)) {
    throw new ValidationError(`Unsupported unit "${safeString(unit)}". Expected one of: ${SUPPORTED_UNITS.join(', ')}`, {
      code: 'INVALID_UNIT',
      path: 'unit',
      details: { unit },
    });
  }
  const result = valueMm / UNIT_FACTORS[unit];
  if (!Number.isFinite(result)) {
    throw new ValidationError(
      `Converted value overflows finite bounds for mmToUnit (${safeString(valueMm)} mm -> ${unit})`,
      {
        code: 'INVALID_DIMENSIONS',
        path: 'valueMm',
        details: { valueMm, unit },
      }
    );
  }
  return result;
}

export function unitToMm(value, unit = 'mm') {
  if (!Number.isFinite(value)) {
    throw new ValidationError(`Expected finite number for unitToMm, got ${safeString(value)}`, {
      code: 'NON_FINITE_NUMBER',
      path: 'value',
      details: { value },
    });
  }
  if (!isValidUnit(unit)) {
    throw new ValidationError(`Unsupported unit "${safeString(unit)}". Expected one of: ${SUPPORTED_UNITS.join(', ')}`, {
      code: 'INVALID_UNIT',
      path: 'unit',
      details: { unit },
    });
  }
  const result = value * UNIT_FACTORS[unit];
  if (!Number.isFinite(result)) {
    throw new ValidationError(
      `Converted value overflows finite millimeter bounds for unitToMm (${safeString(value)} ${unit})`,
      {
        code: 'INVALID_DIMENSIONS',
        path: 'value',
        details: { value, unit },
      }
    );
  }
  return result;
}

export function formatUnitValue(valueMm, unit = 'mm', decimals = 1) {
  const converted = mmToUnit(valueMm, unit);
  const rawDec =
    decimals === null || (typeof decimals === 'string' && decimals.trim() === '')
      ? NaN
      : toSafeNumber(decimals);
  const safeDec = Number.isFinite(rawDec) ? Math.max(0, Math.min(20, Math.trunc(rawDec))) : 1;
  return `${converted.toFixed(safeDec)} ${unit}`;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
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

function assertFiniteNumber(val, path, label = 'number', code = 'NON_FINITE_NUMBER') {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new ValidationError(`Expected finite ${label} at ${path}, got ${safeString(val)}`, {
      code,
      path,
      details: { value: val },
    });
  }
  return val;
}

function cloneVec2(pt, path = 'point', scaleFactor = 1, code = 'INVALID_POINTS', coordCode = code) {
  if (!isPlainObject(pt)) {
    throw new ValidationError(`Expected 2D point object at ${path}`, {
      code,
      path,
    });
  }
  const x = assertFiniteNumber(pt.x, `${path}.x`, 'x coordinate', coordCode);
  const y = assertFiniteNumber(pt.y, `${path}.y`, 'y coordinate', coordCode);
  return { x: x * scaleFactor, y: y * scaleFactor };
}

function cloneVec3(pt, path = 'vec3', scaleFactor = 1, code = 'INVALID_PLACEMENT_3D', coordCode = code) {
  if (!isPlainObject(pt)) {
    throw new ValidationError(`Expected 3D vector object at ${path}`, {
      code,
      path,
    });
  }
  const x = assertFiniteNumber(pt.x, `${path}.x`, 'x coordinate', coordCode);
  const y = assertFiniteNumber(pt.y, `${path}.y`, 'y coordinate', coordCode);
  const z = assertFiniteNumber(pt.z, `${path}.z`, 'z coordinate', coordCode);
  return { x: x * scaleFactor, y: y * scaleFactor, z: z * scaleFactor };
}

// ============================================================================
// Schema Factories
// ============================================================================

export function createEdgeSpec(input = {}, index = 0, defaultSeamAllowance = 10) {
  const src = isPlainObject(input) ? input : {};
  const sa =
    src.seamAllowance !== undefined && src.seamAllowance !== null
      ? toSafeNumber(src.seamAllowance)
      : toSafeNumber(defaultSeamAllowance);

  const edge = {
    name: typeof src.name === 'string' && src.name.length > 0 ? src.name : `Edge ${index + 1}`,
    seamAllowance: Number.isFinite(sa) && sa >= 0 ? sa : 10,
  };

  if (src.curve && isPlainObject(src.curve)) {
    if (src.curve.cp1 && src.curve.cp2) {
      edge.curve = {
        cp1: { x: toSafeNumber(src.curve.cp1.x), y: toSafeNumber(src.curve.cp1.y) },
        cp2: { x: toSafeNumber(src.curve.cp2.x), y: toSafeNumber(src.curve.cp2.y) },
      };
    } else if (src.curve.cp) {
      edge.curve = {
        cp: { x: toSafeNumber(src.curve.cp.x), y: toSafeNumber(src.curve.cp.y) },
      };
    }
  } else if (src.curve === null) {
    edge.curve = null;
  }

  return edge;
}

export function createNotchSpec(input = {}, edgeCount = 4, index = 0) {
  const src = isPlainObject(input) ? input : {};
  const rawCount = toSafeNumber(edgeCount);
  const safeCount = Number.isFinite(rawCount) ? Math.max(1, Math.trunc(rawCount)) : 1;
  const rawIdx = toSafeNumber(src.edgeIndex ?? 0);
  const modIdx = Number.isInteger(rawIdx) ? ((rawIdx % safeCount) + safeCount) % safeCount : 0;
  const edgeIndex = Number.isInteger(modIdx) && modIdx >= 0 && modIdx < safeCount ? modIdx : 0;
  const rawT = toSafeNumber(src.t ?? 0.5);
  const t = Number.isFinite(rawT) ? Math.max(0, Math.min(1, rawT)) : 0.5;
  const type = NOTCH_TYPES.includes(src.type) ? src.type : 'single';
  const depthMm = src.depthMm !== undefined ? toSafeNumber(src.depthMm) : 5;

  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : `notch_${index + 1}`,
    edgeIndex,
    t,
    type,
    depthMm: Number.isFinite(depthMm) && depthMm > 0 ? depthMm : 5,
  };
}

export function createDartSpec(input = {}, edgeCount = 4, index = 0) {
  const src = isPlainObject(input) ? input : {};
  const rawCount = toSafeNumber(edgeCount);
  const safeCount = Number.isFinite(rawCount) ? Math.max(1, Math.trunc(rawCount)) : 1;
  const rawIdx = toSafeNumber(src.edgeIndex ?? 0);
  const modIdx = Number.isInteger(rawIdx) ? ((rawIdx % safeCount) + safeCount) % safeCount : 0;
  const edgeIndex = Number.isInteger(modIdx) && modIdx >= 0 && modIdx < safeCount ? modIdx : 0;
  const rawT = toSafeNumber(src.t ?? 0.5);
  const t = Number.isFinite(rawT) ? Math.max(0.05, Math.min(0.95, rawT)) : 0.5;
  const widthMm = toSafeNumber(src.widthMm ?? 20);
  const depthMm = toSafeNumber(src.depthMm ?? 80);

  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : `dart_${index + 1}`,
    edgeIndex,
    t,
    widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 20,
    depthMm: Number.isFinite(depthMm) && depthMm > 0 ? depthMm : 80,
    folded: parseBoolFlag(src.folded ?? false),
  };
}

export function createInternalLineSpec(input = {}, index = 0) {
  const src = isPlainObject(input) ? input : {};
  const type = INTERNAL_LINE_TYPES.includes(src.type) ? src.type : 'guide';
  const points = Array.isArray(src.points)
    ? Array.from(src.points, (pt) => ({ x: toSafeNumber(pt?.x), y: toSafeNumber(pt?.y) }))
    : [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ];

  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : `internal_${index + 1}`,
    name: typeof src.name === 'string' && src.name.length > 0 ? src.name : `Internal Line ${index + 1}`,
    type,
    points,
  };
}

export function createPatternPiece(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const defaultPoints = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const points = Array.isArray(src.points)
    ? Array.from(src.points, (pt) => ({ x: toSafeNumber(pt?.x), y: toSafeNumber(pt?.y) }))
    : defaultPoints;
  const seamAllowance = src.seamAllowance !== undefined ? toSafeNumber(src.seamAllowance) : 10;

  const edges = points.map((_, i) =>
    Array.isArray(src.edges) && i < src.edges.length
      ? createEdgeSpec(src.edges[i], i, seamAllowance)
      : createEdgeSpec({}, i, seamAllowance)
  );

  const notches = Array.isArray(src.notches)
    ? Array.from(src.notches, (n, i) => createNotchSpec(n, points.length, i))
    : [];

  const darts = Array.isArray(src.darts)
    ? Array.from(src.darts, (d, i) => createDartSpec(d, points.length, i))
    : [];

  const internalLines = Array.isArray(src.internalLines)
    ? Array.from(src.internalLines, (il, i) => createInternalLineSpec(il, i))
    : [];

  const rawGrain = isPlainObject(src.grainline) ? src.grainline : {};
  const grainline = {
    angleDeg: rawGrain.angleDeg !== undefined ? toSafeNumber(rawGrain.angleDeg) : 90,
  };
  if (rawGrain.start) {
    grainline.start = { x: toSafeNumber(rawGrain.start.x), y: toSafeNumber(rawGrain.start.y) };
  }
  if (rawGrain.end) {
    grainline.end = { x: toSafeNumber(rawGrain.end.x), y: toSafeNumber(rawGrain.end.y) };
  }

  const rawPlace = isPlainObject(src.placement3D) ? src.placement3D : {};
  const placement3D = {
    offset: rawPlace.offset
      ? { x: toSafeNumber(rawPlace.offset.x), y: toSafeNumber(rawPlace.offset.y), z: toSafeNumber(rawPlace.offset.z) }
      : { x: 0, y: 120, z: 140 },
    normal: rawPlace.normal
      ? { x: toSafeNumber(rawPlace.normal.x), y: toSafeNumber(rawPlace.normal.y), z: toSafeNumber(rawPlace.normal.z) }
      : { x: 0, y: 0, z: 1 },
    up: rawPlace.up
      ? { x: toSafeNumber(rawPlace.up.x), y: toSafeNumber(rawPlace.up.y), z: toSafeNumber(rawPlace.up.z) }
      : { x: 0, y: 1, z: 0 },
  };

  const rawPos = isPlainObject(src.position) ? src.position : { x: 0, y: 0 };
  const quantity = src.quantity !== undefined ? toSafeNumber(src.quantity) : 1;
  if (quantity === Infinity || (Number.isFinite(quantity) && quantity > MAX_PIECE_QUANTITY)) {
    throw new ValidationError(`Piece quantity must be <= ${MAX_PIECE_QUANTITY}`, {
      code: 'INVALID_PIECE',
      path: 'quantity',
    });
  }
  const rotation = src.rotation !== undefined ? toSafeNumber(src.rotation) : 0;

  const piece = {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : `piece_${Date.now()}`,
    name: typeof src.name === 'string' && src.name.length > 0 ? src.name : 'Pattern Piece',
    role: typeof src.role === 'string' && src.role.length > 0 ? src.role : 'custom',
    quantity,
    onFold: parseBoolFlag(src.onFold ?? false),
    position: { x: toSafeNumber(rawPos.x ?? 0), y: toSafeNumber(rawPos.y ?? 0) },
    rotation,
    seamAllowance,
    points,
    edges,
    notches,
    darts,
    internalLines,
    grainline,
    placement3D,
  };

  if (src.rotationOrigin && isPlainObject(src.rotationOrigin)) {
    piece.rotationOrigin = { x: toSafeNumber(src.rotationOrigin.x), y: toSafeNumber(src.rotationOrigin.y) };
  }
  if (src.grainLock !== undefined) piece.grainLock = parseBoolFlag(src.grainLock);
  if (src.distortionPct !== undefined) piece.distortionPct = src.distortionPct;
  if (src.chartId !== undefined) piece.chartId = src.chartId;

  return piece;
}

export function createSeam(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const seam = {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : `seam_${Date.now()}`,
    name: typeof src.name === 'string' && src.name.length > 0 ? src.name : 'Seam',
    pieceA: typeof src.pieceA === 'string' ? src.pieceA : '',
    edgeA: src.edgeA !== undefined ? toSafeNumber(src.edgeA) : 0,
    pieceB: typeof src.pieceB === 'string' ? src.pieceB : '',
    edgeB: src.edgeB !== undefined ? toSafeNumber(src.edgeB) : 0,
    reversed: parseBoolFlag(src.reversed ?? false),
    allowEase: parseBoolFlag(src.allowEase ?? false),
    tStartA: src.tStartA !== undefined ? toSafeNumber(src.tStartA) : 0,
    tEndA: src.tEndA !== undefined ? toSafeNumber(src.tEndA) : 1,
    tStartB: src.tStartB !== undefined ? toSafeNumber(src.tStartB) : 0,
    tEndB: src.tEndB !== undefined ? toSafeNumber(src.tEndB) : 1,
  };
  if (typeof src.internalLineIdB === 'string' && src.internalLineIdB.length > 0) {
    seam.internalLineIdB = src.internalLineIdB;
    seam.internalSegmentIndexB = src.internalSegmentIndexB !== undefined ? toSafeNumber(src.internalSegmentIndexB) : 0;
  }
  return seam;
}

export function createPatternProject(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const params = isPlainObject(src.params)
    ? { ...src.params }
    : isPlainObject(src.parameters)
      ? { ...src.parameters }
      : {};

  const pieces = Array.isArray(src.pieces) ? Array.from(src.pieces, (p) => createPatternPiece(p)) : [];
  const seams = Array.isArray(src.seams) ? Array.from(src.seams, (s) => createSeam(s)) : [];

  const project = {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : `project_${Date.now()}`,
    name: typeof src.name === 'string' && src.name.length > 0 ? src.name : 'Pattern Project',
    templateId: typeof src.templateId === 'string' && src.templateId.length > 0 ? src.templateId : 'custom',
    version: typeof src.version === 'string' && src.version.length > 0 ? src.version : SCHEMA_VERSION,
    unit: typeof src.unit === 'string' ? src.unit : CANONICAL_UNIT,
    displayUnit: isValidUnit(src.displayUnit) ? src.displayUnit : CANONICAL_UNIT,
    params,
    materialId: typeof src.materialId === 'string' && src.materialId.length > 0 ? src.materialId : 'cotton_jersey',
    material: isPlainObject(src.material) ? { ...src.material } : null,
    avatar: isPlainObject(src.avatar) ? { ...src.avatar } : null,
    stlMetadata: isPlainObject(src.stlMetadata) ? { ...src.stlMetadata } : null,
    pieces,
    seams,
  };

  if (src.isStub !== undefined) project.isStub = parseBoolFlag(src.isStub);
  if (src.stubReason !== undefined) project.stubReason = safeString(src.stubReason);

  return project;
}

// ============================================================================
// Validators
// ============================================================================

export function validatePatternPiece(piece, path = 'piece', options = {}) {
  const safeOpts = isPlainObject(options) ? options : {};
  const throwOnError = safeOpts.throwOnError !== undefined ? parseBoolFlag(safeOpts.throwOnError) : true;
  const errors = [];
  const record = (err) => {
    errors.push(err);
    if (throwOnError) throw err;
  };

  try {
    if (!isPlainObject(piece)) {
      record(
        new ValidationError(`Piece at ${path} must be an object`, {
          code: 'INVALID_PIECE',
          path,
        })
      );
      return { valid: false, errors };
    }

    if (typeof piece.id !== 'string' || piece.id.trim().length === 0) {
      record(
        new ValidationError(`Piece at ${path} must have a non-empty string id`, {
          code: 'INVALID_PIECE',
          path: `${path}.id`,
        })
      );
    }

    if (!Array.isArray(piece.points) || piece.points.length < 3) {
      record(
        new ValidationError(`Piece at ${path} must have at least 3 points`, {
          code: 'INVALID_POINTS',
          path: `${path}.points`,
        })
      );
      return { valid: false, errors };
    }

    const n = piece.points.length;
    for (let i = 0; i < n; i++) {
      const pt = piece.points[i];
      if (!(i in piece.points) || !isPlainObject(pt) || typeof pt.x !== 'number' || !Number.isFinite(pt.x) || typeof pt.y !== 'number' || !Number.isFinite(pt.y)) {
        record(
          new ValidationError(`Point ${i} at ${path}.points[${i}] must have finite numeric x and y`, {
            code: 'INVALID_POINTS',
            path: `${path}.points[${i}]`,
            details: { point: pt },
          })
        );
      }
    }

    if (piece.position !== undefined) {
      if (!isPlainObject(piece.position) || typeof piece.position.x !== 'number' || !Number.isFinite(piece.position.x) || typeof piece.position.y !== 'number' || !Number.isFinite(piece.position.y)) {
        record(
          new ValidationError(`Invalid piece.position at ${path}.position`, {
            code: 'INVALID_PIECE',
            path: `${path}.position`,
          })
        );
      }
    }

    if (piece.rotation !== undefined && (typeof piece.rotation !== 'number' || !Number.isFinite(piece.rotation))) {
      record(
        new ValidationError(`Invalid piece.rotation at ${path}.rotation`, {
          code: 'INVALID_PIECE',
          path: `${path}.rotation`,
        })
      );
    }

    if (piece.rotationOrigin !== undefined) {
      if (
        !isPlainObject(piece.rotationOrigin) ||
        typeof piece.rotationOrigin.x !== 'number' ||
        !Number.isFinite(piece.rotationOrigin.x) ||
        typeof piece.rotationOrigin.y !== 'number' ||
        !Number.isFinite(piece.rotationOrigin.y)
      ) {
        record(
          new ValidationError(`Invalid piece.rotationOrigin at ${path}.rotationOrigin`, {
            code: 'INVALID_PIECE',
            path: `${path}.rotationOrigin`,
          })
        );
      }
    }

    if (
      piece.quantity !== undefined &&
      (!Number.isInteger(piece.quantity) || piece.quantity < 1 || piece.quantity > MAX_PIECE_QUANTITY)
    ) {
      record(
        new ValidationError(
          `Piece quantity must be an integer between 1 and ${MAX_PIECE_QUANTITY} at ${path}.quantity`,
          {
            code: 'INVALID_PIECE',
            path: `${path}.quantity`,
          }
        )
      );
    }

    if (piece.seamAllowance !== undefined && (typeof piece.seamAllowance !== 'number' || !Number.isFinite(piece.seamAllowance) || piece.seamAllowance < 0)) {
      record(
        new ValidationError(`Piece seamAllowance must be >= 0 at ${path}.seamAllowance`, {
          code: 'INVALID_PIECE',
          path: `${path}.seamAllowance`,
        })
      );
    }

    if (!Array.isArray(piece.edges) || piece.edges.length !== n) {
      record(
        new ValidationError(`Piece edges length (${safeString(piece.edges?.length)}) must equal points length (${n}) at ${path}.edges`, {
          code: 'INVALID_EDGES',
          path: `${path}.edges`,
          details: { edgesLength: piece.edges?.length, pointsLength: n },
        })
      );
    } else {
      for (let i = 0; i < n; i++) {
        const edge = piece.edges[i];
        if (!(i in piece.edges) || !isPlainObject(edge)) {
          record(
            new ValidationError(`Edge ${i} at ${path}.edges[${i}] must be an object`, {
              code: 'INVALID_EDGES',
              path: `${path}.edges[${i}]`,
            })
          );
          continue;
        }
        if (edge.seamAllowance !== undefined && edge.seamAllowance !== null) {
          if (typeof edge.seamAllowance !== 'number' || !Number.isFinite(edge.seamAllowance) || edge.seamAllowance < 0) {
            record(
              new ValidationError(`Invalid edge seamAllowance at ${path}.edges[${i}].seamAllowance`, {
                code: 'INVALID_EDGES',
                path: `${path}.edges[${i}].seamAllowance`,
              })
            );
          }
        }
        if (edge.curve !== undefined && edge.curve !== null) {
          if (!isPlainObject(edge.curve)) {
            record(
              new ValidationError(`Invalid curve object at ${path}.edges[${i}].curve`, {
                code: 'INVALID_CURVE',
                path: `${path}.edges[${i}].curve`,
              })
            );
          } else if (edge.curve.cp1 !== undefined || edge.curve.cp2 !== undefined) {
            const c1 = edge.curve.cp1;
            const c2 = edge.curve.cp2;
            if (
              !isPlainObject(c1) || !isPlainObject(c2) ||
              typeof c1.x !== 'number' || !Number.isFinite(c1.x) ||
              typeof c1.y !== 'number' || !Number.isFinite(c1.y) ||
              typeof c2.x !== 'number' || !Number.isFinite(c2.x) ||
              typeof c2.y !== 'number' || !Number.isFinite(c2.y)
            ) {
              record(
                new ValidationError(`Invalid cubic Bezier control points at ${path}.edges[${i}].curve`, {
                  code: 'INVALID_CURVE',
                  path: `${path}.edges[${i}].curve`,
                })
              );
            }
          } else if (edge.curve.cp !== undefined) {
            const c = edge.curve.cp;
            if (!isPlainObject(c) || typeof c.x !== 'number' || !Number.isFinite(c.x) || typeof c.y !== 'number' || !Number.isFinite(c.y)) {
              record(
                new ValidationError(`Invalid quadratic Bezier control point at ${path}.edges[${i}].curve.cp`, {
                  code: 'INVALID_CURVE',
                  path: `${path}.edges[${i}].curve.cp`,
                })
              );
            }
          } else {
            record(
              new ValidationError(`Curve at ${path}.edges[${i}].curve must specify cp or cp1/cp2`, {
                code: 'INVALID_CURVE',
                path: `${path}.edges[${i}].curve`,
              })
            );
          }
        }
      }
    }

    if (piece.notches !== undefined) {
      if (!Array.isArray(piece.notches)) {
        record(
          new ValidationError(`notches must be an array at ${path}.notches`, {
            code: 'INVALID_NOTCH',
            path: `${path}.notches`,
          })
        );
      } else {
        for (let i = 0; i < piece.notches.length; i++) {
          const notch = piece.notches[i];
          const np = `${path}.notches[${i}]`;
          if (!(i in piece.notches) || !isPlainObject(notch) || !Number.isInteger(notch.edgeIndex) || notch.edgeIndex < 0 || notch.edgeIndex >= n) {
            record(
              new ValidationError(`Notch edgeIndex out of range [0, ${n - 1}] at ${np}.edgeIndex`, {
                code: 'INVALID_NOTCH',
                path: `${np}.edgeIndex`,
              })
            );
          }
          if (typeof notch?.t !== 'number' || !Number.isFinite(notch.t) || notch.t < 0 || notch.t > 1) {
            record(
              new ValidationError(`Notch t must be finite in [0, 1] at ${np}.t`, {
                code: 'INVALID_NOTCH',
                path: `${np}.t`,
              })
            );
          }
          if (notch?.type !== undefined && !NOTCH_TYPES.includes(notch.type)) {
            record(
              new ValidationError(`Unsupported notch type "${safeString(notch.type)}" at ${np}.type`, {
                code: 'INVALID_NOTCH',
                path: `${np}.type`,
              })
            );
          }
          if (notch?.depthMm !== undefined && (typeof notch.depthMm !== 'number' || !Number.isFinite(notch.depthMm) || notch.depthMm <= 0)) {
            record(
              new ValidationError(`Notch depthMm must be finite > 0 at ${np}.depthMm`, {
                code: 'INVALID_NOTCH',
                path: `${np}.depthMm`,
              })
            );
          }
        }
      }
    }

    if (piece.darts !== undefined) {
      if (!Array.isArray(piece.darts)) {
        record(
          new ValidationError(`darts must be an array at ${path}.darts`, {
            code: 'INVALID_DART',
            path: `${path}.darts`,
          })
        );
      } else {
        for (let i = 0; i < piece.darts.length; i++) {
          const dart = piece.darts[i];
          const dp = `${path}.darts[${i}]`;
          if (!(i in piece.darts) || !isPlainObject(dart) || !Number.isInteger(dart.edgeIndex) || dart.edgeIndex < 0 || dart.edgeIndex >= n) {
            record(
              new ValidationError(`Dart edgeIndex out of range [0, ${n - 1}] at ${dp}.edgeIndex`, {
                code: 'INVALID_DART',
                path: `${dp}.edgeIndex`,
              })
            );
          }
          if (typeof dart?.t !== 'number' || !Number.isFinite(dart.t) || dart.t <= 0 || dart.t >= 1) {
            record(
              new ValidationError(`Dart t must be finite in (0, 1) at ${dp}.t`, {
                code: 'INVALID_DART',
                path: `${dp}.t`,
              })
            );
          }
          if (typeof dart?.widthMm !== 'number' || !Number.isFinite(dart.widthMm) || dart.widthMm <= 0) {
            record(
              new ValidationError(`Dart widthMm must be finite > 0 at ${dp}.widthMm`, {
                code: 'INVALID_DART',
                path: `${dp}.widthMm`,
              })
            );
          }
          if (typeof dart?.depthMm !== 'number' || !Number.isFinite(dart.depthMm) || dart.depthMm <= 0) {
            record(
              new ValidationError(`Dart depthMm must be finite > 0 at ${dp}.depthMm`, {
                code: 'INVALID_DART',
                path: `${dp}.depthMm`,
              })
            );
          }
        }
      }
    }

    if (piece.internalLines !== undefined) {
      if (!Array.isArray(piece.internalLines)) {
        record(
          new ValidationError(`internalLines must be an array at ${path}.internalLines`, {
            code: 'INVALID_INTERNAL_LINE',
            path: `${path}.internalLines`,
          })
        );
      } else {
        for (let i = 0; i < piece.internalLines.length; i++) {
          const il = piece.internalLines[i];
          const ip = `${path}.internalLines[${i}]`;
          if (!(i in piece.internalLines) || !isPlainObject(il) || !Array.isArray(il.points) || il.points.length < 2) {
            record(
              new ValidationError(`Internal line must have >= 2 points at ${ip}.points`, {
                code: 'INVALID_INTERNAL_LINE',
                path: `${ip}.points`,
              })
            );
            continue;
          }
          for (let j = 0; j < il.points.length; j++) {
            const p = il.points[j];
            if (!(j in il.points) || !isPlainObject(p) || typeof p.x !== 'number' || !Number.isFinite(p.x) || typeof p.y !== 'number' || !Number.isFinite(p.y)) {
              record(
                new ValidationError(`Internal line point must be finite at ${ip}.points[${j}]`, {
                  code: 'INVALID_INTERNAL_LINE',
                  path: `${ip}.points[${j}]`,
                })
              );
            }
          }
        }
      }
    }

    if (piece.grainline !== undefined) {
      const g = piece.grainline;
      if (!isPlainObject(g) || typeof g.angleDeg !== 'number' || !Number.isFinite(g.angleDeg)) {
        record(
          new ValidationError(`Invalid grainline at ${path}.grainline`, {
            code: 'INVALID_GRAINLINE',
            path: `${path}.grainline`,
          })
        );
      } else {
        for (const key of ['start', 'end']) {
          if (g[key] !== undefined) {
            const gp = g[key];
            if (!isPlainObject(gp) || typeof gp.x !== 'number' || !Number.isFinite(gp.x) || typeof gp.y !== 'number' || !Number.isFinite(gp.y)) {
              record(
                new ValidationError(`Invalid grainline.${key} at ${path}.grainline.${key}`, {
                  code: 'INVALID_GRAINLINE',
                  path: `${path}.grainline.${key}`,
                })
              );
            }
          }
        }
      }
    }

    if (piece.placement3D !== undefined) {
      const pl = piece.placement3D;
      if (!isPlainObject(pl) || !isPlainObject(pl.offset) || !isPlainObject(pl.normal)) {
        record(
          new ValidationError(`Invalid placement3D at ${path}.placement3D`, {
            code: 'INVALID_PLACEMENT_3D',
            path: `${path}.placement3D`,
          })
        );
      } else {
        for (const vecName of ['offset', 'normal', 'up']) {
          if (pl[vecName] !== undefined) {
            const v = pl[vecName];
            if (
              !isPlainObject(v) ||
              typeof v.x !== 'number' || !Number.isFinite(v.x) ||
              typeof v.y !== 'number' || !Number.isFinite(v.y) ||
              typeof v.z !== 'number' || !Number.isFinite(v.z)
            ) {
              record(
                new ValidationError(`Invalid placement3D.${vecName} at ${path}.placement3D.${vecName}`, {
                  code: 'INVALID_PLACEMENT_3D',
                  path: `${path}.placement3D.${vecName}`,
                })
              );
            }
          }
        }
      }
    }
  } catch (err) {
    if (throwOnError) throw err;
    errors.push(coerceUnexpectedValidationError(err, path));
  }

  return { valid: errors.length === 0, errors };
}

export function validateSeam(seam, pieceMap, path = 'seam', options = {}) {
  const safeOpts = isPlainObject(options) ? options : {};
  const throwOnError = safeOpts.throwOnError !== undefined ? parseBoolFlag(safeOpts.throwOnError) : true;
  const errors = [];
  const record = (err) => {
    errors.push(err);
    if (throwOnError) throw err;
  };

  try {
    if (!isPlainObject(seam)) {
      record(
        new ValidationError(`Seam at ${path} must be an object`, {
          code: 'INVALID_SEAM',
          path,
        })
      );
      return { valid: false, errors };
    }

    const getPiece = (id) =>
      pieceMap instanceof Map
        ? pieceMap.get(id)
        : isPlainObject(pieceMap) && typeof id === 'string' && Object.hasOwn(pieceMap, id)
          ? pieceMap[id]
          : undefined;
    const pA = getPiece(seam.pieceA);
    const pB = getPiece(seam.pieceB);

    if (!pA) {
      record(
        new ValidationError(`Seam references missing pieceA "${safeString(seam.pieceA)}" at ${path}.pieceA`, {
          code: 'SEAM_MISSING_PIECE',
          path: `${path}.pieceA`,
          details: { pieceA: seam.pieceA },
        })
      );
    }
    if (!pB) {
      record(
        new ValidationError(`Seam references missing pieceB "${safeString(seam.pieceB)}" at ${path}.pieceB`, {
          code: 'SEAM_MISSING_PIECE',
          path: `${path}.pieceB`,
          details: { pieceB: seam.pieceB },
        })
      );
    }

    if (pA) {
      if (!Number.isInteger(seam.edgeA) || seam.edgeA < 0 || seam.edgeA >= pA.points.length) {
        record(
          new ValidationError(`Seam edgeA (${safeString(seam.edgeA)}) out of range for piece "${safeString(pA.id)}" at ${path}.edgeA`, {
            code: 'INVALID_SEAM',
            path: `${path}.edgeA`,
          })
        );
      }
    }

    if (seam.internalLineIdB !== undefined) {
      if (typeof seam.internalLineIdB !== 'string' || seam.internalLineIdB.length === 0) {
        record(
          new ValidationError(`Invalid internalLineIdB at ${path}.internalLineIdB`, {
            code: 'INVALID_SEAM',
            path: `${path}.internalLineIdB`,
          })
        );
      }
    }

    const hasInternalTarget = typeof seam.internalLineIdB === 'string' && seam.internalLineIdB.length > 0;
    if (pB) {
      if (hasInternalTarget) {
        const il = (Array.isArray(pB.internalLines) ? pB.internalLines : []).find(
          (line) => isPlainObject(line) && line.id === seam.internalLineIdB
        );
        if (!il) {
          record(
            new ValidationError(
              `Seam references missing internalLineIdB "${safeString(seam.internalLineIdB)}" on piece "${safeString(pB.id)}" at ${path}.internalLineIdB`,
              {
                code: 'INVALID_SEAM',
                path: `${path}.internalLineIdB`,
              }
            )
          );
        } else if (seam.internalSegmentIndexB !== undefined) {
          const segIdx = seam.internalSegmentIndexB;
          const segMax = Array.isArray(il.points) ? Math.max(1, il.points.length - 1) : 1;
          if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= segMax) {
            record(
              new ValidationError(`Seam internalSegmentIndexB (${safeString(segIdx)}) out of range at ${path}.internalSegmentIndexB`, {
                code: 'INVALID_SEAM',
                path: `${path}.internalSegmentIndexB`,
              })
            );
          }
        }
      } else if (seam.internalLineIdB === undefined && (!Number.isInteger(seam.edgeB) || seam.edgeB < 0 || seam.edgeB >= pB.points.length)) {
        record(
          new ValidationError(`Seam edgeB (${safeString(seam.edgeB)}) out of range for piece "${safeString(pB.id)}" at ${path}.edgeB`, {
            code: 'INVALID_SEAM',
            path: `${path}.edgeB`,
          })
        );
      }
    }

    const tStartA = seam.tStartA !== undefined ? seam.tStartA : 0;
    const tEndA = seam.tEndA !== undefined ? seam.tEndA : 1;
    const tStartB = seam.tStartB !== undefined ? seam.tStartB : 0;
    const tEndB = seam.tEndB !== undefined ? seam.tEndB : 1;

    if (
      typeof tStartA !== 'number' || !Number.isFinite(tStartA) ||
      typeof tEndA !== 'number' || !Number.isFinite(tEndA) ||
      tStartA < 0 || tEndA > 1 || tStartA >= tEndA
    ) {
      record(
        new ValidationError(`Invalid seam range [${safeString(tStartA)}, ${safeString(tEndA)}] at ${path}.tStartA/tEndA`, {
          code: 'INVALID_SEAM_RANGE',
          path: `${path}.tStartA`,
        })
      );
    }

    if (
      typeof tStartB !== 'number' || !Number.isFinite(tStartB) ||
      typeof tEndB !== 'number' || !Number.isFinite(tEndB) ||
      tStartB < 0 || tEndB > 1 || tStartB >= tEndB
    ) {
      record(
        new ValidationError(`Invalid seam range [${safeString(tStartB)}, ${safeString(tEndB)}] at ${path}.tStartB/tEndB`, {
          code: 'INVALID_SEAM_RANGE',
          path: `${path}.tStartB`,
        })
      );
    }

    if (!hasInternalTarget && seam.pieceA === seam.pieceB && seam.edgeA === seam.edgeB) {
      const overlap = Math.min(tEndA, tEndB) - Math.max(tStartA, tStartB);
      if (overlap > 1e-6) {
        record(
          new ValidationError(`Self-identical seam on ${safeString(seam.pieceA)}:${safeString(seam.edgeA)} at ${path}`, {
            code: 'INVALID_SEAM',
            path,
          })
        );
      }
    }
  } catch (err) {
    if (throwOnError) throw err;
    errors.push(coerceUnexpectedValidationError(err, path));
  }

  return { valid: errors.length === 0, errors };
}

export function validatePatternProject(project, options = {}) {
  const safeOpts = isPlainObject(options) ? options : {};
  const throwOnError = safeOpts.throwOnError !== undefined ? parseBoolFlag(safeOpts.throwOnError) : true;
  const requireNonEmpty = safeOpts.requireNonEmpty !== undefined ? parseBoolFlag(safeOpts.requireNonEmpty) : false;
  const errors = [];
  const record = (err) => {
    errors.push(err);
    if (throwOnError) throw err;
  };

  try {
    if (!isPlainObject(project)) {
      record(
        new ValidationError('PatternProject must be a non-null plain object', {
          code: 'INVALID_PROJECT',
          path: 'project',
        })
      );
      return { valid: false, errors };
    }

    if (project.unit !== CANONICAL_UNIT) {
      record(
        new ValidationError(`Canonical project.unit must be "${CANONICAL_UNIT}", got "${safeString(project.unit)}"`, {
          code: 'INVALID_UNIT',
          path: 'project.unit',
          details: { unit: project.unit },
        })
      );
    }

    if (!Array.isArray(project.pieces)) {
      record(
        new ValidationError('project.pieces must be an array', {
          code: 'MISSING_PIECES',
          path: 'project.pieces',
        })
      );
      return { valid: false, errors };
    }

    if (requireNonEmpty && project.pieces.length === 0) {
      record(
        new ValidationError('project.pieces must not be empty', {
          code: 'EMPTY_PIECES',
          path: 'project.pieces',
        })
      );
    }

    const pieceMap = new Map();
    for (let i = 0; i < project.pieces.length; i++) {
      const piece = project.pieces[i];
      const pRes = validatePatternPiece(piece, `pieces[${i}]`, { throwOnError });
      if (!pRes.valid) errors.push(...pRes.errors);
      if (isPlainObject(piece) && typeof piece.id === 'string' && piece.id.length > 0) {
        if (pieceMap.has(piece.id)) {
          record(
            new ValidationError(`Duplicate piece id "${piece.id}" at pieces[${i}].id`, {
              code: 'DUPLICATE_PIECE_ID',
              path: `pieces[${i}].id`,
              details: { id: piece.id },
            })
          );
        } else {
          pieceMap.set(piece.id, piece);
        }
      }
    }

    if (project.seams !== undefined) {
      if (!Array.isArray(project.seams)) {
        record(
          new ValidationError('project.seams must be an array', {
            code: 'INVALID_SEAMS',
            path: 'project.seams',
          })
        );
      } else {
        const seamIds = new Set();
        const edgeIntervals = new Map();
        const checkIntervalOverlap = (key, seamIdx, seamId, t0, t1) => {
          if (!edgeIntervals.has(key)) edgeIntervals.set(key, []);
          const list = edgeIntervals.get(key);
          for (const existing of list) {
            if (existing.seamIdx === seamIdx) continue;
            if (Math.min(t1, existing.t1) - Math.max(t0, existing.t0) > 1e-3) {
              record(
                new ValidationError(
                  `Overlapping seam intervals on ${key} between seams "${existing.seamId}" and "${seamId}"`,
                  {
                    code: 'INVALID_SEAM',
                    path: `seams[${seamIdx}]`,
                    details: { key, existingSeamId: existing.seamId, seamId },
                  }
                )
              );
              break;
            }
          }
          list.push({ seamIdx, seamId, t0, t1 });
        };

        for (let i = 0; i < project.seams.length; i++) {
          const seam = project.seams[i];
          if (isPlainObject(seam) && typeof seam.id === 'string' && seam.id.length > 0) {
            if (seamIds.has(seam.id)) {
              record(
                new ValidationError(`Duplicate seam id "${seam.id}" at seams[${i}].id`, {
                  code: 'DUPLICATE_SEAM_ID',
                  path: `seams[${i}].id`,
                  details: { id: seam.id },
                })
              );
            }
            seamIds.add(seam.id);
          }
          const sRes = validateSeam(seam, pieceMap, `seams[${i}]`, { throwOnError });
          if (!sRes.valid) errors.push(...sRes.errors);
          if (sRes.valid && isPlainObject(seam)) {
            const seamLabel = typeof seam.id === 'string' && seam.id.length > 0 ? seam.id : `seams[${i}]`;
            checkIntervalOverlap(
              `${seam.pieceA}:${seam.edgeA}`,
              i,
              seamLabel,
              seam.tStartA ?? 0,
              seam.tEndA ?? 1
            );
            const hasInternalTarget = typeof seam.internalLineIdB === 'string' && seam.internalLineIdB.length > 0;
            if (!hasInternalTarget) {
              checkIntervalOverlap(
                `${seam.pieceB}:${seam.edgeB}`,
                i,
                seamLabel,
                seam.tStartB ?? 0,
                seam.tEndB ?? 1
              );
            }
          }
        }
      }
    }
  } catch (err) {
    if (throwOnError) throw err;
    errors.push(coerceUnexpectedValidationError(err, 'project'));
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Project Normalizer (cm / in -> canonical mm, v1 parameters -> params)
// ============================================================================

export function normalizePatternProject(input, options = {}) {
  const safeOpts = isPlainObject(options) ? options : {};
  const allowEmpty = safeOpts.allowEmpty !== undefined ? parseBoolFlag(safeOpts.allowEmpty) : true;
  if (!isPlainObject(input)) {
    throw new ValidationError('Input project must be a non-null plain object', {
      code: 'INVALID_PROJECT',
      path: 'project',
    });
  }

  if (!Array.isArray(input.pieces)) {
    throw new ValidationError('Input project must contain a pieces array', {
      code: 'MISSING_PIECES',
      path: 'project.pieces',
    });
  }

  const srcUnit = input.unit !== undefined ? input.unit : CANONICAL_UNIT;
  if (!isValidUnit(srcUnit)) {
    throw new ValidationError(`Unsupported project unit "${safeString(srcUnit)}"`, {
      code: 'INVALID_UNIT',
      path: 'project.unit',
      details: { unit: srcUnit },
    });
  }

  const scale = UNIT_FACTORS[srcUnit];

  const normalizedPieces = Array.from(input.pieces, (rawPiece, pIdx) => {
    const pPath = `pieces[${pIdx}]`;
    if (!isPlainObject(rawPiece)) {
      throw new ValidationError(`Piece at ${pPath} must be an object`, {
        code: 'INVALID_PIECE',
        path: pPath,
      });
    }
    if (!Array.isArray(rawPiece.points) || rawPiece.points.length < 3) {
      throw new ValidationError(`Piece at ${pPath} must have >= 3 points`, {
        code: 'INVALID_POINTS',
        path: `${pPath}.points`,
      });
    }

    const points = Array.from(rawPiece.points, (pt, ptIdx) =>
      cloneVec2(pt, `${pPath}.points[${ptIdx}]`, scale, 'INVALID_POINTS', 'INVALID_POINTS')
    );

    const rawDefaultSa = rawPiece.seamAllowance !== undefined ? rawPiece.seamAllowance : unitToMm(10, 'mm') / scale;
    const defaultSaMm = unitToMm(
      assertFiniteNumber(rawDefaultSa, `${pPath}.seamAllowance`, 'seamAllowance', 'INVALID_PIECE'),
      srcUnit
    );

    if (rawPiece.edges !== undefined && !Array.isArray(rawPiece.edges)) {
      throw new ValidationError(`Piece edges must be an array at ${pPath}.edges`, {
        code: 'INVALID_EDGES',
        path: `${pPath}.edges`,
      });
    }
    const rawEdges = Array.isArray(rawPiece.edges) ? rawPiece.edges : points.map((_, i) => ({ name: `Edge ${i + 1}` }));
    if (rawEdges.length !== points.length) {
      throw new ValidationError(`Piece edges length (${rawEdges.length}) must match points length (${points.length}) at ${pPath}.edges`, {
        code: 'INVALID_EDGES',
        path: `${pPath}.edges`,
      });
    }

    const edges = Array.from(rawEdges, (rawEdge, eIdx) => {
      const ePath = `${pPath}.edges[${eIdx}]`;
      if (!isPlainObject(rawEdge)) {
        throw new ValidationError(`Edge at ${ePath} must be an object`, {
          code: 'INVALID_EDGES',
          path: ePath,
        });
      }
      const edgeOut = {
        name: typeof rawEdge.name === 'string' && rawEdge.name.length > 0 ? rawEdge.name : `Edge ${eIdx + 1}`,
        seamAllowance:
          rawEdge.seamAllowance !== undefined && rawEdge.seamAllowance !== null
            ? unitToMm(
                assertFiniteNumber(rawEdge.seamAllowance, `${ePath}.seamAllowance`, 'edge seamAllowance', 'INVALID_EDGES'),
                srcUnit
              )
            : defaultSaMm,
      };
      if (rawEdge.curve !== undefined && rawEdge.curve !== null) {
        if (!isPlainObject(rawEdge.curve)) {
          throw new ValidationError(`Invalid curve object at ${ePath}.curve`, {
            code: 'INVALID_CURVE',
            path: `${ePath}.curve`,
          });
        }
        if (rawEdge.curve.cp1 !== undefined || rawEdge.curve.cp2 !== undefined) {
          edgeOut.curve = {
            cp1: cloneVec2(rawEdge.curve.cp1, `${ePath}.curve.cp1`, scale, 'INVALID_CURVE', 'INVALID_CURVE'),
            cp2: cloneVec2(rawEdge.curve.cp2, `${ePath}.curve.cp2`, scale, 'INVALID_CURVE', 'INVALID_CURVE'),
          };
        } else if (rawEdge.curve.cp !== undefined) {
          edgeOut.curve = {
            cp: cloneVec2(rawEdge.curve.cp, `${ePath}.curve.cp`, scale, 'INVALID_CURVE', 'INVALID_CURVE'),
          };
        } else {
          throw new ValidationError(`Invalid curve at ${ePath}.curve`, {
            code: 'INVALID_CURVE',
            path: `${ePath}.curve`,
          });
        }
      }
      return edgeOut;
    });

    if (rawPiece.notches !== undefined && !Array.isArray(rawPiece.notches)) {
      throw new ValidationError(`notches must be an array at ${pPath}.notches`, {
        code: 'INVALID_NOTCH',
        path: `${pPath}.notches`,
      });
    }
    const notches = Array.from(rawPiece.notches ?? [], (n, nIdx) => {
      const np = `${pPath}.notches[${nIdx}]`;
      if (!isPlainObject(n)) {
        throw new ValidationError(`Invalid notch at ${np}`, { code: 'INVALID_NOTCH', path: np });
      }
      const depthMm =
        n.depthMm !== undefined
          ? unitToMm(assertFiniteNumber(n.depthMm, `${np}.depthMm`, 'notch depthMm', 'INVALID_NOTCH'), srcUnit)
          : 5;
      return {
        id: typeof n.id === 'string' && n.id.length > 0 ? n.id : `notch_${nIdx + 1}`,
        edgeIndex: n.edgeIndex,
        t: n.t,
        type: n.type !== undefined ? n.type : 'single',
        depthMm,
      };
    });

    if (rawPiece.darts !== undefined && !Array.isArray(rawPiece.darts)) {
      throw new ValidationError(`darts must be an array at ${pPath}.darts`, {
        code: 'INVALID_DART',
        path: `${pPath}.darts`,
      });
    }
    const darts = Array.from(rawPiece.darts ?? [], (d, dIdx) => {
      const dp = `${pPath}.darts[${dIdx}]`;
      if (!isPlainObject(d)) {
        throw new ValidationError(`Invalid dart at ${dp}`, { code: 'INVALID_DART', path: dp });
      }
      return {
        id: typeof d.id === 'string' && d.id.length > 0 ? d.id : `dart_${dIdx + 1}`,
        edgeIndex: d.edgeIndex,
        t: d.t,
        widthMm: unitToMm(assertFiniteNumber(d.widthMm, `${dp}.widthMm`, 'dart widthMm', 'INVALID_DART'), srcUnit),
        depthMm: unitToMm(assertFiniteNumber(d.depthMm, `${dp}.depthMm`, 'dart depthMm', 'INVALID_DART'), srcUnit),
        folded: parseBoolFlag(d.folded ?? false),
      };
    });

    if (rawPiece.internalLines !== undefined && !Array.isArray(rawPiece.internalLines)) {
      throw new ValidationError(`internalLines must be an array at ${pPath}.internalLines`, {
        code: 'INVALID_INTERNAL_LINE',
        path: `${pPath}.internalLines`,
      });
    }
    const internalLines = Array.from(rawPiece.internalLines ?? [], (il, ilIdx) => {
      const ip = `${pPath}.internalLines[${ilIdx}]`;
      if (!isPlainObject(il) || !Array.isArray(il.points) || il.points.length < 2) {
        throw new ValidationError(`Invalid internal line at ${ip}`, { code: 'INVALID_INTERNAL_LINE', path: ip });
      }
      return {
        id: typeof il.id === 'string' && il.id.length > 0 ? il.id : `internal_${ilIdx + 1}`,
        name: typeof il.name === 'string' && il.name.length > 0 ? il.name : `Internal Line ${ilIdx + 1}`,
        type: INTERNAL_LINE_TYPES.includes(il.type) ? il.type : 'guide',
        points: Array.from(il.points, (pt, ptIdx) =>
          cloneVec2(pt, `${ip}.points[${ptIdx}]`, scale, 'INVALID_INTERNAL_LINE', 'INVALID_INTERNAL_LINE')
        ),
      };
    });

    const position =
      rawPiece.position !== undefined
        ? cloneVec2(rawPiece.position, `${pPath}.position`, scale, 'INVALID_PIECE', 'INVALID_PIECE')
        : { x: 0, y: 0 };
    const rotation =
      rawPiece.rotation !== undefined
        ? assertFiniteNumber(rawPiece.rotation, `${pPath}.rotation`, 'rotation', 'INVALID_PIECE')
        : 0;
    const quantity = rawPiece.quantity !== undefined ? rawPiece.quantity : 1;

    let grainline;
    if (rawPiece.grainline === undefined) {
      grainline = { angleDeg: 90 };
    } else {
      if (!isPlainObject(rawPiece.grainline)) {
        throw new ValidationError(`Invalid grainline at ${pPath}.grainline`, {
          code: 'INVALID_GRAINLINE',
          path: `${pPath}.grainline`,
        });
      }
      const rawGrain = rawPiece.grainline;
      grainline = {
        angleDeg: assertFiniteNumber(rawGrain.angleDeg, `${pPath}.grainline.angleDeg`, 'angleDeg', 'INVALID_GRAINLINE'),
      };
      if (rawGrain.start !== undefined) {
        grainline.start = cloneVec2(
          rawGrain.start,
          `${pPath}.grainline.start`,
          scale,
          'INVALID_GRAINLINE',
          'INVALID_GRAINLINE'
        );
      }
      if (rawGrain.end !== undefined) {
        grainline.end = cloneVec2(
          rawGrain.end,
          `${pPath}.grainline.end`,
          scale,
          'INVALID_GRAINLINE',
          'INVALID_GRAINLINE'
        );
      }
    }

    let placement3D;
    if (rawPiece.placement3D === undefined) {
      placement3D = {
        offset: { x: 0, y: 120, z: 140 },
        normal: { x: 0, y: 0, z: 1 },
        up: { x: 0, y: 1, z: 0 },
      };
    } else {
      if (!isPlainObject(rawPiece.placement3D)) {
        throw new ValidationError(`Invalid placement3D at ${pPath}.placement3D`, {
          code: 'INVALID_PLACEMENT_3D',
          path: `${pPath}.placement3D`,
        });
      }
      const rawPlace = rawPiece.placement3D;
      placement3D = {
        offset: cloneVec3(rawPlace.offset, `${pPath}.placement3D.offset`, scale),
        normal: cloneVec3(rawPlace.normal, `${pPath}.placement3D.normal`, 1),
        up:
          rawPlace.up !== undefined
            ? cloneVec3(rawPlace.up, `${pPath}.placement3D.up`, 1)
            : { x: 0, y: 1, z: 0 },
      };
    }

    const outPiece = {
      id: typeof rawPiece.id === 'string' && rawPiece.id.length > 0 ? rawPiece.id : `piece_${pIdx + 1}`,
      name: typeof rawPiece.name === 'string' && rawPiece.name.length > 0 ? rawPiece.name : `Piece ${pIdx + 1}`,
      role: typeof rawPiece.role === 'string' && rawPiece.role.length > 0 ? rawPiece.role : 'custom',
      quantity,
      onFold: parseBoolFlag(rawPiece.onFold ?? false),
      position,
      rotation,
      seamAllowance: defaultSaMm,
      points,
      edges,
      notches,
      darts,
      internalLines,
      grainline,
      placement3D,
    };

    if (rawPiece.rotationOrigin !== undefined) {
      outPiece.rotationOrigin = cloneVec2(rawPiece.rotationOrigin, `${pPath}.rotationOrigin`, scale, 'INVALID_PIECE');
    }
    if (rawPiece.grainLock !== undefined) outPiece.grainLock = parseBoolFlag(rawPiece.grainLock);
    if (rawPiece.distortionPct !== undefined) outPiece.distortionPct = rawPiece.distortionPct;
    if (rawPiece.chartId !== undefined) outPiece.chartId = rawPiece.chartId;

    return outPiece;
  });

  if (input.seams !== undefined && !Array.isArray(input.seams)) {
    throw new ValidationError('project.seams must be an array', {
      code: 'INVALID_SEAMS',
      path: 'project.seams',
    });
  }

  const normalizedSeams = Array.from(input.seams ?? [], (s, sIdx) => {
    if (!isPlainObject(s)) {
      throw new ValidationError(`Seam at seams[${sIdx}] must be an object`, {
        code: 'INVALID_SEAM',
        path: `seams[${sIdx}]`,
      });
    }
    const hasInternalTargetInput = s.internalLineIdB !== undefined;
    if (hasInternalTargetInput && (typeof s.internalLineIdB !== 'string' || s.internalLineIdB.length === 0)) {
      throw new ValidationError(`Invalid internalLineIdB at seams[${sIdx}].internalLineIdB`, {
        code: 'INVALID_SEAM',
        path: `seams[${sIdx}].internalLineIdB`,
      });
    }
    const seam = {
      id: typeof s.id === 'string' && s.id.length > 0 ? s.id : `seam_${sIdx + 1}`,
      name: typeof s.name === 'string' && s.name.length > 0 ? s.name : 'Seam',
      pieceA: typeof s.pieceA === 'string' ? s.pieceA : '',
      edgeA: s.edgeA,
      pieceB: typeof s.pieceB === 'string' ? s.pieceB : '',
      edgeB: hasInternalTargetInput ? (s.edgeB !== undefined ? s.edgeB : 0) : s.edgeB,
      reversed: parseBoolFlag(s.reversed ?? false),
      allowEase: parseBoolFlag(s.allowEase ?? false),
      tStartA: s.tStartA !== undefined ? s.tStartA : 0,
      tEndA: s.tEndA !== undefined ? s.tEndA : 1,
      tStartB: s.tStartB !== undefined ? s.tStartB : 0,
      tEndB: s.tEndB !== undefined ? s.tEndB : 1,
    };
    if (hasInternalTargetInput) {
      seam.internalLineIdB = s.internalLineIdB;
      seam.internalSegmentIndexB = s.internalSegmentIndexB !== undefined ? s.internalSegmentIndexB : 0;
    }
    return seam;
  });

  if (input.params !== undefined && !isPlainObject(input.params)) {
    throw new ValidationError('project.params must be a plain object', {
      code: 'INVALID_PROJECT',
      path: 'project.params',
    });
  }
  if (input.parameters !== undefined && !isPlainObject(input.parameters)) {
    throw new ValidationError('project.parameters must be a plain object', {
      code: 'INVALID_PROJECT',
      path: 'project.parameters',
    });
  }
  const params =
    input.params !== undefined
      ? { ...input.params }
      : input.parameters !== undefined
        ? { ...input.parameters }
        : {};

  let displayUnit = srcUnit;
  if (input.displayUnit !== undefined) {
    if (!isValidUnit(input.displayUnit)) {
      throw new ValidationError(`Unsupported displayUnit "${safeString(input.displayUnit)}"`, {
        code: 'INVALID_UNIT',
        path: 'project.displayUnit',
        details: { displayUnit: input.displayUnit },
      });
    }
    displayUnit = input.displayUnit;
  }

  for (const metaKey of ['material', 'avatar', 'stlMetadata']) {
    if (input[metaKey] !== undefined && input[metaKey] !== null && !isPlainObject(input[metaKey])) {
      throw new ValidationError(`project.${metaKey} must be a plain object or null`, {
        code: 'INVALID_PROJECT',
        path: `project.${metaKey}`,
      });
    }
  }

  const project = {
    id: typeof input.id === 'string' && input.id.length > 0 ? input.id : `project_${Date.now()}`,
    name: typeof input.name === 'string' && input.name.length > 0 ? input.name : 'Pattern Project',
    templateId: typeof input.templateId === 'string' && input.templateId.length > 0 ? input.templateId : 'custom',
    version: typeof input.version === 'string' && input.version.length > 0 ? input.version : SCHEMA_VERSION,
    unit: CANONICAL_UNIT,
    displayUnit,
    params,
    materialId: typeof input.materialId === 'string' && input.materialId.length > 0 ? input.materialId : 'cotton_jersey',
    material: input.material ? { ...input.material } : null,
    avatar: input.avatar ? { ...input.avatar } : null,
    stlMetadata: input.stlMetadata ? { ...input.stlMetadata } : null,
    pieces: normalizedPieces,
    seams: normalizedSeams,
  };

  if (input.isStub !== undefined) project.isStub = parseBoolFlag(input.isStub);
  if (input.stubReason !== undefined) project.stubReason = safeString(input.stubReason);

  validatePatternProject(project, { throwOnError: true, requireNonEmpty: !allowEmpty });
  return project;
}
